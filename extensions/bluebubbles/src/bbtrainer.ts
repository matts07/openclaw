import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { BlueBubblesRuntimeEnv } from "./monitor-shared.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { sendMessageBlueBubbles } from "./send.js";

export type TrainerMode = "reply" | "training" | "supervised";

interface PendingMessage {
  id: string;
  from: string;
  fromName?: string;
  content: string;
  draft: string;
  draftFailed?: boolean;
  timestamp: number;
  mode: TrainerMode;
  expiresAt: number;
}

interface PendingStore {
  messages: Record<string, PendingMessage>;
  lastUpdated: number;
}

/** Last 4 hex chars of a GUID, uppercased. Consistent with BlueBubbles reply cache pattern. */
function makeShortId(guid: string): string {
  const clean = guid.replace(/-/g, "");
  return clean.slice(-4).toUpperCase();
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DRAFT_TIMEOUT_MS = 10_000;

/** Strips all non-digit characters from a string for phone number comparison. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function resolveTrainerStateDirs(
  env: NodeJS.ProcessEnv = process.env,
  cfg?: OpenClawConfig,
): {
  stateDir: string;
  workspaceDir: string;
} {
  const home = env.HOME ?? "";
  return {
    stateDir: env.OPENCLAW_STATE_DIR ?? `${home}/.openclaw/state`,
    workspaceDir:
      env.OPENCLAW_WORKSPACE_DIR ??
      cfg?.agents?.defaults?.workspace ??
      `${home}/.openclaw/workspace`,
  };
}

function getPendingStorePath(stateDir: string): string {
  return join(stateDir, "bluebubbles-trainer-pending.json");
}

function parsePendingStore(raw: unknown): PendingStore {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>).messages !== "object" ||
    (raw as Record<string, unknown>).messages === null
  ) {
    return { messages: {}, lastUpdated: Date.now() };
  }
  return raw as PendingStore;
}

async function loadPendingStore(stateDir: string): Promise<PendingStore> {
  try {
    return parsePendingStore(JSON.parse(await readFile(getPendingStorePath(stateDir), "utf-8")));
  } catch {
    return { messages: {}, lastUpdated: Date.now() };
  }
}

async function savePendingStore(stateDir: string, store: PendingStore): Promise<void> {
  const path = getPendingStorePath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  store.lastUpdated = Date.now();
  await writeFile(path, JSON.stringify(store, null, 2), "utf-8");
}

async function addPending(stateDir: string, msg: Omit<PendingMessage, "expiresAt">): Promise<void> {
  const store = await loadPendingStore(stateDir);
  // shortIds are 4 hex chars (65 536 values, 6 h TTL). Collision silently overwrites
  // the previous entry — accepted risk for single-owner low-concurrency use.
  store.messages[msg.id] = { ...msg, expiresAt: Date.now() + DEFAULT_TTL_MS };
  await savePendingStore(stateDir, store);
}

async function removePending(stateDir: string, shortId: string): Promise<void> {
  const store = await loadPendingStore(stateDir);
  delete store.messages[shortId];
  await savePendingStore(stateDir, store);
}

/** Expire stale pending entries and notify the owner for each. Call on gateway startup. */
export async function expireTrainerPending(params: {
  stateDir: string;
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
}): Promise<number> {
  const { stateDir, account, config, runtime } = params;
  const notifyNumber = account.config.trainerNotifyNumber?.trim() ?? "";
  const store = await loadPendingStore(stateDir);
  const now = Date.now();
  let count = 0;
  for (const [id, msg] of Object.entries(store.messages)) {
    if (now > msg.expiresAt) {
      delete store.messages[id];
      count++;
      if (notifyNumber) {
        await sendMessageBlueBubbles(notifyNumber, `⚠️ msg-${id}: expired`, {
          cfg: config,
          accountId: account.accountId,
        }).catch((err) => {
          runtime.error?.(
            `[bluebubbles/trainer] expiry notification failed for msg-${id}: ${String(err)}`,
          );
        });
      }
    }
  }
  if (count > 0) {
    await savePendingStore(stateDir, store);
  }
  return count;
}

async function appendToMemoryMd(workspaceDir: string, line: string): Promise<void> {
  const path = join(workspaceDir, "MEMORY.md");
  await mkdir(dirname(path), { recursive: true });
  const section = "## Interaction Log";
  let hasSection = false;
  try {
    hasSection = (await readFile(path, "utf-8")).includes(section);
  } catch {
    // file doesn't exist yet — hasSection stays false
  }
  if (!hasSection) {
    await appendFile(path, `\n\n${section}\n`, "utf-8");
  }
  await appendFile(path, `${line}\n`, "utf-8");
}

async function readSoulMd(workspaceDir: string): Promise<string> {
  try {
    return await readFile(join(workspaceDir, "SOUL.md"), "utf-8");
  } catch {
    return "";
  }
}

const EXAMPLE_POOL_SIZE = 30;
const EXAMPLE_INJECT_COUNT = 5;

function scoreExampleRelevance(logLine: string, currentMessage: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
  const msgWords = words(currentMessage);
  let score = 0;
  for (const w of words(logLine)) {
    if (msgWords.has(w)) score++;
  }
  return score;
}

async function selectInteractionExamples(
  workspaceDir: string,
  currentMessage: string,
): Promise<string[]> {
  try {
    const content = await readFile(join(workspaceDir, "MEMORY.md"), "utf-8");
    const sectionIdx = content.indexOf("## Interaction Log");
    if (sectionIdx === -1) return [];
    const logContent = content.slice(sectionIdx + "## Interaction Log".length).trim();
    const pool = logContent
      .split("\n")
      .filter((line) => line.startsWith("- ["))
      .slice(-EXAMPLE_POOL_SIZE);
    // Sort by relevance descending; preserve original order as tiebreaker (stable sort).
    return pool
      .map((line, idx) => ({ line, score: scoreExampleRelevance(line, currentMessage), idx }))
      .sort((a, b) => b.score - a.score || b.idx - a.idx)
      .slice(0, EXAMPLE_INJECT_COUNT)
      .sort((a, b) => a.idx - b.idx) // restore chronological order for the injected set
      .map(({ line }) => line);
  } catch {
    return [];
  }
}

async function generateDraft(params: {
  config: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  fromName: string;
  content: string;
}): Promise<string> {
  const [soul, examples] = await Promise.all([
    readSoulMd(params.workspaceDir),
    selectInteractionExamples(params.workspaceDir, params.content),
  ]);
  const examplesSection =
    examples.length > 0
      ? `\n\nRecent examples of how the owner has replied (use these to match their voice):\n${examples.join("\n")}`
      : "";
  const systemPrompt = soul
    ? `You are drafting a reply on behalf of the owner. Communication style:\n\n${soul}${examplesSection}\n\nDraft a reply in the owner's voice. 1-2 sentences maximum. Return only the draft text, no preamble.`
    : `Draft a short, direct, friendly reply.${examplesSection} 1-2 sentences maximum. Return only the draft text.`;

  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg: params.config,
    agentId: params.agentId,
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    throw new Error(`model not available: ${prepared.error}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);
  try {
    const response = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: `${params.fromName} sent: "${params.content}"\n\nDraft a reply.`,
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: 200,
        signal: controller.signal,
      },
    });
    const text = extractAssistantText(response).trim();
    // Strip surrounding quotes that some models add to their response
    return text.replace(/^["'""]|["'""]$/gu, "").trim();
  } finally {
    clearTimeout(timer);
  }
}

type ParsedOwnerReply =
  | { type: "send-draft"; shortId: string }
  | { type: "send-custom"; shortId: string; customText: string }
  | { type: "unknown" };

export function parseOwnerReply(text: string): ParsedOwnerReply {
  const trimmed = text.trim();
  const sendMatch = trimmed.match(/^send\s+([A-Fa-f0-9]{4})$/i);
  if (sendMatch) {
    return { type: "send-draft", shortId: sendMatch[1].toUpperCase() };
  }
  const customMatch = trimmed.match(/^\[?msg[-_]?([A-Fa-f0-9]{4})\]?\s+(.+)$/i);
  if (customMatch) {
    return {
      type: "send-custom",
      shortId: customMatch[1].toUpperCase(),
      customText: customMatch[2].trim(),
    };
  }
  return { type: "unknown" };
}

export async function handleTrainerInbound(params: {
  message: NormalizedWebhookMessage;
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  trainerMode: TrainerMode;
  agentId: string;
  stateDir: string;
  workspaceDir: string;
}): Promise<void> {
  const { message, account, config, runtime, trainerMode, agentId, stateDir, workspaceDir } =
    params;
  const notifyNumber = account.config.trainerNotifyNumber?.trim() ?? "";
  if (!notifyNumber) {
    return;
  }

  const from = message.senderId ?? "";
  const fromName = message.senderName ?? from;
  const content = message.text?.trim() ?? "";
  const messageId = message.messageId?.trim() ?? "";
  const shortId = messageId
    ? makeShortId(messageId)
    : // messageId absent (rare): random 4-hex fallback.
      // Same collision space as makeShortId — accepted for this edge case.
      Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, "0")
        .toUpperCase();

  runtime.log?.(
    `[bluebubbles/trainer] intercepted msg-${shortId} from ${from} (mode=${trainerMode})`,
  );

  let draft = "(draft unavailable — no model configured for this agent)";
  let draftFailed = true;
  if (content) {
    try {
      const generated = await generateDraft({ config, agentId, workspaceDir, fromName, content });
      if (generated) {
        draft = generated;
        draftFailed = false;
      }
    } catch (err) {
      runtime.error?.(`[bluebubbles/trainer] draft generation failed: ${String(err)}`);
    }
  }

  await addPending(stateDir, {
    id: shortId,
    from,
    fromName,
    content,
    draft,
    draftFailed,
    timestamp: Date.now(),
    mode: trainerMode,
  });

  const displayName = fromName !== from ? fromName : from;
  // content and displayName are user-supplied. Format is display-only;
  // the shortId guards against spoofed approval — send XXXX only matches real pending entries.
  const notification =
    trainerMode === "training"
      ? `📨 [msg-${shortId}] From ${displayName}: "${content}"\n\nMy draft: "${draft}"\n\nReply "send ${shortId}" to approve my draft, or "[msg-${shortId}] your version" to log a correction instead.`
      : `📨 [msg-${shortId}] From ${displayName}: "${content}"\n\nMy draft: "${draft}"\n\nReply "send ${shortId}" to send my draft, or "[msg-${shortId}] your version" to send that instead.`;

  try {
    await sendMessageBlueBubbles(notifyNumber, notification, {
      cfg: config,
      accountId: account.accountId,
    });
    runtime.log?.(`[bluebubbles/trainer] notified owner about msg-${shortId}`);
  } catch (err) {
    runtime.error?.(`[bluebubbles/trainer] owner notification failed: ${String(err)}`);
  }
}

/**
 * Called when a message arrives from trainerNotifyNumber.
 * Returns true if the message was consumed as a trainer reply, false if it
 * should fall through to normal agent session handling.
 */
export async function handleTrainerOwnerReply(params: {
  replyText: string;
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  stateDir: string;
  workspaceDir: string;
}): Promise<boolean> {
  const { replyText, account, config, runtime, stateDir, workspaceDir } = params;
  const parsed = parseOwnerReply(replyText);
  if (parsed.type === "unknown") {
    return false;
  }

  const notifyNumber = account.config.trainerNotifyNumber?.trim() ?? "";
  const store = await loadPendingStore(stateDir);
  const rawPending = store.messages[parsed.shortId];

  if (!rawPending) {
    // Recognized command but no matching entry — already processed or never existed.
    // Consume so the message doesn't reach the agent; notify the owner.
    if (notifyNumber) {
      await sendMessageBlueBubbles(
        notifyNumber,
        `⚠️ msg-${parsed.shortId}: unknown — no pending message with this ID.`,
        { cfg: config, accountId: account.accountId },
      ).catch((err) => {
        runtime.error?.(
          `[bluebubbles/trainer] unknown-id notification failed for msg-${parsed.shortId}: ${String(err)}`,
        );
      });
    }
    return true;
  }

  if (Date.now() > rawPending.expiresAt) {
    // Expired — clean up and notify, consume so it doesn't reach the agent
    delete store.messages[parsed.shortId];
    await savePendingStore(stateDir, store);
    if (notifyNumber) {
      await sendMessageBlueBubbles(notifyNumber, `⚠️ msg-${parsed.shortId}: expired`, {
        cfg: config,
        accountId: account.accountId,
      }).catch((err) => {
        runtime.error?.(
          `[bluebubbles/trainer] expiry notification failed for msg-${parsed.shortId}: ${String(err)}`,
        );
      });
    }
    return true;
  }

  const pending = rawPending;

  // Block send-draft when draft generation failed — in supervised mode it would
  // deliver the error sentinel to the original sender; in training mode it would
  // log the sentinel as a training example. Neither is useful.
  if (parsed.type === "send-draft" && pending.draftFailed) {
    if (notifyNumber) {
      const action = pending.mode === "supervised" ? "send a custom reply" : "log a correction";
      await sendMessageBlueBubbles(
        notifyNumber,
        `⚠️ msg-${parsed.shortId}: no draft available — reply [msg-${parsed.shortId}] your text to ${action}.`,
        { cfg: config, accountId: account.accountId },
      ).catch((err) => {
        runtime.error?.(`[bluebubbles/trainer] draftFailed notification failed: ${String(err)}`);
      });
    }
    return true;
  }

  const textToSend = parsed.type === "send-draft" ? pending.draft : parsed.customText;
  const timestamp = new Date().toISOString();
  const verb =
    pending.mode === "supervised"
      ? "sent"
      : parsed.type === "send-draft"
        ? "approved"
        : "would have sent";
  const logLine = `- [${timestamp}] From ${pending.fromName ?? pending.from}: "${pending.content}" | I drafted: "${pending.draft}" | Owner ${verb}: "${textToSend}"`;

  if (pending.mode === "supervised") {
    try {
      // Tag AI-generated drafts sent as-is. Owner-written custom replies are
      // never tagged — the owner's own words don't need an AI attribution marker.
      // agentTag defaults true here (supervised AI-approved replies); reply mode defaults false.
      const agentTag = account.config.agentTag ?? true;
      const taggedText = agentTag && parsed.type === "send-draft" ? `🦞 ${textToSend}` : textToSend;
      await sendMessageBlueBubbles(pending.from, taggedText, {
        cfg: config,
        accountId: account.accountId,
      });
      runtime.log?.(
        `[bluebubbles/trainer] sent reply to ${pending.from} for msg-${parsed.shortId}`,
      );
    } catch (err) {
      // AbortError means the HTTP response timed out, but BlueBubbles has likely
      // already queued and delivered the message — log at info level, not error.
      if (err instanceof Error && err.name === "AbortError") {
        runtime.log?.(
          `[bluebubbles/trainer] send request timed out for msg-${parsed.shortId} (message likely delivered)`,
        );
      } else {
        runtime.error?.(`[bluebubbles/trainer] reply send failed: ${String(err)}`);
      }
    }
  }

  await appendToMemoryMd(workspaceDir, logLine).catch((err) => {
    runtime.error?.(`[bluebubbles/trainer] MEMORY.md write failed: ${String(err)}`);
  });

  await removePending(stateDir, parsed.shortId);
  runtime.log?.(`[bluebubbles/trainer] logged training entry for msg-${parsed.shortId}`);
  return true;
}
