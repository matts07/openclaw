import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
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
  notificationFailed?: boolean;
  timestamp: number;
  mode: TrainerMode;
  expiresAt: number;
}

interface PendingStore {
  messages: Record<string, PendingMessage>;
  lastUpdated: number;
}

/**
 * A simplified send function type used for injection and testing.
 * In production the wiring in monitor-processing.ts adapts sendMessageBlueBubbles
 * to this shape.
 */
export type SimpleSendFn = (to: string, text: string) => Promise<void>;

export interface TrainerSendInterceptContext {
  mode: TrainerMode;
  /** Resolved and trimmed trainerNotifyNumber, or "" if absent. */
  notifyNumber: string;
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  stateDir: string;
  /**
   * Outbound target for the original inbound message sender, as resolved by
   * monitor-processing (typically the chat GUID string for real iMessage DMs,
   * e.g. "iMessage;-;+number"). Must match the `to` value passed to the
   * interceptor so the to===originalFrom check fires correctly.
   */
  originalFrom: string;
  /** Display name of the original sender, if available. */
  originalFromName?: string;
  /** Text content of the original inbound message. */
  originalContent: string;
  /** GUID of the original inbound message (used to derive short ID). */
  originalMessageId: string;
  /**
   * When true, the pending entry is saved with draftFailed=true so the owner
   * cannot accidentally approve-to-send the placeholder (e.g. for media intercepts
   * where the stored draft is a description, not the actual sendable content).
   */
  forceDraftFailed?: boolean;
}

/** Last 4 hex chars of a GUID, uppercased. Consistent with BlueBubbles reply cache pattern. */
export function makeShortId(guid: string): string {
  const clean = guid.replace(/-/g, "");
  return clean.slice(-4).toUpperCase();
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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

async function loadPendingStore(stateDir: string): Promise<PendingStore> {
  try {
    return JSON.parse(await readFile(getPendingStorePath(stateDir), "utf-8")) as PendingStore;
  } catch {
    return { messages: {}, lastUpdated: Date.now() };
  }
}

async function savePendingStore(stateDir: string, store: PendingStore): Promise<void> {
  const path = getPendingStorePath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  store.lastUpdated = Date.now();
  // Write to a temp file then rename atomically so a concurrent read never
  // sees a partial write. Both paths are on the same filesystem (same dir).
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await rename(tmp, path);
}

export async function addPending(
  stateDir: string,
  msg: Omit<PendingMessage, "expiresAt">,
): Promise<void> {
  const store = await loadPendingStore(stateDir);
  store.messages[msg.id] = { ...msg, expiresAt: Date.now() + DEFAULT_TTL_MS };
  await savePendingStore(stateDir, store);
}

async function removePending(stateDir: string, shortId: string): Promise<void> {
  const store = await loadPendingStore(stateDir);
  delete store.messages[shortId];
  await savePendingStore(stateDir, store);
}

async function markPendingNotificationFailed(stateDir: string, shortId: string): Promise<void> {
  const store = await loadPendingStore(stateDir);
  if (store.messages[shortId]) {
    store.messages[shortId].notificationFailed = true;
    await savePendingStore(stateDir, store);
  }
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
  let changed = false;
  for (const [id, msg] of Object.entries(store.messages)) {
    if (now > msg.expiresAt) {
      delete store.messages[id];
      count++;
      changed = true;
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
    } else if (msg.notificationFailed && notifyNumber) {
      // Initial notification failed; re-notify now that the gateway is back up.
      const displayName = msg.fromName && msg.fromName !== msg.from ? msg.fromName : msg.from;
      const renotification =
        msg.mode === "training"
          ? `📨 [msg-${id}] From ${displayName}: "${msg.content}"\n\nMy draft: "${msg.draft}"\n\nReply "send ${id}" to approve my draft, or "[msg-${id}] your version" to log a correction instead.`
          : `📨 [msg-${id}] From ${displayName}: "${msg.content}"\n\nMy draft: "${msg.draft}"\n\nReply "send ${id}" to send my draft, or "[msg-${id}] your version" to send that instead.`;
      try {
        await sendMessageBlueBubbles(notifyNumber, renotification, {
          cfg: config,
          accountId: account.accountId,
        });
        store.messages[id].notificationFailed = false;
        changed = true;
        runtime.log?.(`[bluebubbles/trainer] re-notified owner about msg-${id}`);
      } catch (err) {
        runtime.error?.(
          `[bluebubbles/trainer] re-notification failed for msg-${id}: ${String(err)}`,
        );
      }
    }
  }
  if (changed) {
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

/**
 * Wraps a send function so that any send to the original message sender is
 * captured rather than delivered. Sends to any other address pass through unchanged.
 *
 * In reply mode, or when notifyNumber is empty, the original send function is
 * returned unwrapped.
 *
 * The returned function is safe to call multiple times; each intercepted send
 * creates its own pending store entry and owner notification.
 */
export function createTrainerSendInterceptor(
  originalSend: SimpleSendFn,
  context: TrainerSendInterceptContext,
): SimpleSendFn {
  if (context.mode === "reply" || !context.notifyNumber) {
    return originalSend;
  }

  const {
    mode,
    notifyNumber,
    account,
    config,
    runtime,
    stateDir,
    originalFrom,
    originalFromName,
    originalContent,
    originalMessageId,
  } = context;

  return async (to: string, text: string): Promise<void> => {
    if (to !== originalFrom) {
      return originalSend(to, text);
    }

    const shortId = originalMessageId
      ? makeShortId(originalMessageId)
      : Math.floor(Math.random() * 0x10000)
          .toString(16)
          .padStart(4, "0")
          .toUpperCase();

    runtime.log?.(
      `[bluebubbles/trainer] intercepted agent draft for msg-${shortId} (mode=${mode})`,
    );

    try {
      await addPending(stateDir, {
        id: shortId,
        from: originalFrom,
        fromName: originalFromName,
        content: originalContent,
        draft: text,
        draftFailed: context.forceDraftFailed ?? false,
        timestamp: Date.now(),
        mode,
      });
    } catch (err) {
      runtime.error?.(
        `[bluebubbles/trainer] failed to save pending draft for msg-${shortId}: ${String(err)}`,
      );
      return;
    }

    const displayName =
      originalFromName && originalFromName !== originalFrom ? originalFromName : originalFrom;

    const notification = context.forceDraftFailed
      ? `📨 [msg-${shortId}] From ${displayName}: "${originalContent}"\n\nAgent wanted to send: ${text}\n\nThis was a media or tool-send reply — "[msg-${shortId}] your text" to send a custom reply instead.`
      : mode === "training"
        ? `📨 [msg-${shortId}] From ${displayName}: "${originalContent}"\n\nMy draft: "${text}"\n\nReply "send ${shortId}" to approve my draft, or "[msg-${shortId}] your version" to log a correction instead.`
        : `📨 [msg-${shortId}] From ${displayName}: "${originalContent}"\n\nMy draft: "${text}"\n\nReply "send ${shortId}" to send my draft, or "[msg-${shortId}] your version" to send that instead.`;

    // Retry once on AbortError — the agent session teardown can abort the first
    // attempt before the 30s send timeout fires. A missed notification means the
    // owner never sees the inbound message, so one retry is worth it.
    let notifyErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sendMessageBlueBubbles(notifyNumber, notification, {
          cfg: config,
          accountId: account.accountId,
        });
        notifyErr = undefined;
        break;
      } catch (err) {
        notifyErr = err;
        if (attempt === 0 && err instanceof Error && err.name === "AbortError") {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        } else {
          break;
        }
      }
    }
    if (notifyErr) {
      runtime.error?.(
        `[bluebubbles/trainer] owner notification failed: ${notifyErr instanceof Error ? String(notifyErr) : JSON.stringify(notifyErr)}`,
      );
      await markPendingNotificationFailed(stateDir, shortId).catch((err) => {
        runtime.error?.(
          `[bluebubbles/trainer] failed to flag notification failure for msg-${shortId}: ${String(err)}`,
        );
      });
    } else {
      runtime.log?.(`[bluebubbles/trainer] notified owner about msg-${shortId}`);
    }
    // Do NOT call originalSend — draft is held for owner approval.
  };
}

// ---------------------------------------------------------------------------
// Integration entry points for monitor-processing.ts
// ---------------------------------------------------------------------------

export type TrainerInboundResult = "consumed" | "echo" | "passthrough";

/**
 * Early intercept for messages from trainerNotifyNumber.
 * Must run before the allowlist gate.
 * Returns "consumed" if the message was a trainer command, "echo" if it was a
 * reflected outgoing notification, or "passthrough" to continue normal handling.
 */
export async function handleTrainerInbound(params: {
  message: { senderId?: string | null; text?: string | null };
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  isGroup: boolean;
}): Promise<TrainerInboundResult> {
  const { message, account, config, runtime, isGroup } = params;
  if (isGroup) {
    return "passthrough";
  }
  const mode = account.config.trainerMode ?? "reply";
  if (mode === "reply") {
    return "passthrough";
  }
  const notifyNumber = account.config.trainerNotifyNumber?.trim() ?? "";
  if (!notifyNumber) {
    return "passthrough";
  }
  if ((message.senderId ?? "").replace(/\D/g, "") !== notifyNumber.replace(/\D/g, "")) {
    return "passthrough";
  }

  const { stateDir, workspaceDir } = resolveTrainerStateDirs(process.env, config);
  const consumed = await handleTrainerOwnerReply({
    replyText: message.text?.trim() ?? "",
    account,
    config,
    runtime,
    stateDir,
    workspaceDir,
  });
  if (consumed) {
    return "consumed";
  }

  // BB fires webhooks for API-sent messages without is_from_me so outgoing
  // trainer notifications echo back as inbound webhooks. Drop them silently.
  const text = message.text?.trim() ?? "";
  if (text.startsWith("📨 [msg-") || text.startsWith("⚠️ msg-")) {
    return "echo";
  }

  return "passthrough";
}

/**
 * Returns the trainer notify number to inject into the effective allowFrom list,
 * or an empty array when trainer is inactive.
 */
export function resolveTrainerAllowFromEntries(account: ResolvedBlueBubblesAccount): string[] {
  const mode = account.config.trainerMode ?? "reply";
  if (mode === "reply") {
    return [];
  }
  const notifyNumber = account.config.trainerNotifyNumber?.trim();
  return notifyNumber ? [notifyNumber] : [];
}

export interface TrainerDeliverContext {
  mode: "training" | "supervised";
  notifyNumber: string;
  stateDir: string;
  originalFrom: string;
  originalFromName?: string;
  originalContent: string;
  originalMessageId: string;
}

/**
 * Resolves the trainer context needed for deliver-time intercepts.
 * Returns null when the trainer is inactive (reply mode, no notifyNumber,
 * group chat, or the sender is the owner messaging the agent directly).
 * Call once at the top of the deliver callback and branch on null.
 */
export function resolveTrainerDeliverContext(params: {
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  isGroup: boolean;
  message: {
    senderId?: string | null;
    senderName?: string | null;
    text?: string | null;
    messageId?: string | null;
  };
  outboundTarget: string;
  runtime?: BlueBubblesRuntimeEnv;
}): TrainerDeliverContext | null {
  const { account, config, isGroup, message, outboundTarget, runtime } = params;
  const mode = account.config.trainerMode ?? "reply";
  if (mode === "reply") {
    return null;
  }
  // Mode is active — any early return below is a skip worth logging.
  if (isGroup) {
    runtime?.log?.(`[bluebubbles/trainer] deliver skipped: isGroup (mode=${mode})`);
    return null;
  }
  const notifyNumber = account.config.trainerNotifyNumber?.trim() ?? "";
  if (!notifyNumber) {
    runtime?.log?.(`[bluebubbles/trainer] deliver skipped: noNotifyNumber (mode=${mode})`);
    return null;
  }
  const senderIsOwner =
    (message.senderId ?? "").replace(/\D/g, "") === notifyNumber.replace(/\D/g, "");
  if (senderIsOwner) {
    runtime?.log?.(`[bluebubbles/trainer] deliver skipped: senderIsOwner (mode=${mode})`);
    return null;
  }
  const { stateDir } = resolveTrainerStateDirs(process.env, config);
  return {
    mode,
    notifyNumber,
    stateDir,
    originalFrom: outboundTarget,
    originalFromName: message.senderName ?? undefined,
    originalContent: message.text?.trim() || "<no text>",
    originalMessageId: message.messageId?.trim() ?? "",
  };
}

/**
 * Intercepts a media send in the deliver callback.
 * Stores a placeholder draft (draftFailed=true) so the owner must send a
 * custom reply rather than accidentally approving the placeholder text.
 */
export async function trainerInterceptMediaSend(params: {
  ctx: TrainerDeliverContext;
  mediaCount: number;
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
}): Promise<void> {
  const { ctx, mediaCount, account, config, runtime } = params;
  const sendFn: SimpleSendFn = async (to, t) => {
    await sendMessageBlueBubbles(to, t, { cfg: config, accountId: account.accountId });
  };
  const mediaDesc = `<media: ${mediaCount} attachment${mediaCount !== 1 ? "s" : ""}>`;
  const intercepted = createTrainerSendInterceptor(sendFn, {
    mode: ctx.mode,
    notifyNumber: ctx.notifyNumber,
    account,
    config,
    runtime,
    stateDir: ctx.stateDir,
    originalFrom: ctx.originalFrom,
    originalFromName: ctx.originalFromName,
    originalContent: ctx.originalContent,
    originalMessageId: ctx.originalMessageId,
    forceDraftFailed: true,
  });
  await intercepted(ctx.originalFrom, mediaDesc);
}

/**
 * Intercepts a text send in the deliver callback.
 * Holds the draft for owner review; does not call the real send.
 */
export async function trainerInterceptTextSend(params: {
  ctx: TrainerDeliverContext;
  text: string;
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
}): Promise<void> {
  const { ctx, text, account, config, runtime } = params;
  const sendFn: SimpleSendFn = async (to, t) => {
    await sendMessageBlueBubbles(to, t, { cfg: config, accountId: account.accountId });
  };
  const intercepted = createTrainerSendInterceptor(sendFn, {
    mode: ctx.mode,
    notifyNumber: ctx.notifyNumber,
    account,
    config,
    runtime,
    stateDir: ctx.stateDir,
    originalFrom: ctx.originalFrom,
    originalFromName: ctx.originalFromName,
    originalContent: ctx.originalContent,
    originalMessageId: ctx.originalMessageId,
  });
  await intercepted(ctx.originalFrom, text);
}

/**
 * Applies the 🦞 agent tag prefix when agentTag is enabled in config.
 * Used in reply mode for outgoing chunks; training/supervised sends are
 * handled separately in handleTrainerOwnerReply.
 */
export function applyTrainerAgentTag(text: string, account: ResolvedBlueBubblesAccount): string {
  return (account.config.agentTag ?? false) ? `🦞 ${text}` : text;
}
