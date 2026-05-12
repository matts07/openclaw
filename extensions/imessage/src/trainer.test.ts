import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import {
  createTrainerSendInterceptor,
  expireTrainerPending,
  handleTrainerOwnerReply,
  parseOwnerReply,
  resolveTrainerStateDirs,
} from "./trainer.js";

vi.mock("./send.js", () => ({
  sendMessageIMessage: vi.fn().mockResolvedValue({ messageId: "mock-msg", sentText: "" }),
}));

// Lazy imports so vi.mock hoisting completes before we grab the references.
const getSendMock = async () => {
  const { sendMessageIMessage } = await import("./send.js");
  return vi.mocked(sendMessageIMessage);
};

function makeAccount(
  overrides: Partial<ResolvedIMessageAccount["config"]> = {},
): ResolvedIMessageAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      dmPolicy: "open",
      groupPolicy: "allowlist",
      allowFrom: [],
      trainerMode: "supervised",
      trainerNotifyNumber: "+12025550100",
      ...overrides,
    },
  };
}

function makeConfig(): OpenClawConfig {
  return {
    channels: {
      imessage: {},
    },
  };
}

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn() };
}

async function mkTmpDir(): Promise<string> {
  return await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "imsg-trainer-test-")),
  );
}

async function rmTmpDir(dir: string) {
  await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
}

async function writePendingStore(
  stateDir: string,
  messages: Record<
    string,
    {
      id: string;
      from: string;
      fromName?: string;
      content: string;
      draft: string;
      draftFailed?: boolean;
      timestamp: number;
      mode: string;
      expiresAt: number;
    }
  >,
) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "imessage-trainer-pending.json"),
    JSON.stringify({ messages, lastUpdated: Date.now() }, null, 2),
    "utf-8",
  );
}

async function readPendingStore(stateDir: string) {
  try {
    return JSON.parse(await readFile(join(stateDir, "imessage-trainer-pending.json"), "utf-8")) as {
      messages: Record<string, unknown>;
    };
  } catch {
    return { messages: {} };
  }
}

// ---------------------------------------------------------------------------
// parseOwnerReply
// ---------------------------------------------------------------------------

describe("parseOwnerReply", () => {
  it("parses send-draft command", () => {
    expect(parseOwnerReply("send ABCD")).toEqual({ type: "send-draft", shortId: "ABCD" });
  });

  it("normalises send-draft shortId to uppercase", () => {
    expect(parseOwnerReply("send abcd")).toEqual({ type: "send-draft", shortId: "ABCD" });
  });

  it("accepts mixed-case send-draft", () => {
    expect(parseOwnerReply("SEND A1B2")).toEqual({ type: "send-draft", shortId: "A1B2" });
  });

  it("rejects send with extra words", () => {
    expect(parseOwnerReply("send ABCD extra")).toEqual({ type: "unknown" });
  });

  it("rejects send with no shortId", () => {
    expect(parseOwnerReply("send")).toEqual({ type: "unknown" });
  });

  it("parses bracketed custom reply [msg-XXXX]", () => {
    expect(parseOwnerReply("[msg-ABCD] Hello there")).toEqual({
      type: "send-custom",
      shortId: "ABCD",
      customText: "Hello there",
    });
  });

  it("parses unbracketed custom reply msg-XXXX", () => {
    expect(parseOwnerReply("msg-ABCD Hello there")).toEqual({
      type: "send-custom",
      shortId: "ABCD",
      customText: "Hello there",
    });
  });

  it("parses msgXXXX (no separator) custom reply", () => {
    expect(parseOwnerReply("msgABCD Hello")).toEqual({
      type: "send-custom",
      shortId: "ABCD",
      customText: "Hello",
    });
  });

  it("trims whitespace from custom text", () => {
    expect(parseOwnerReply("[msg-ABCD]   trimmed  ")).toEqual({
      type: "send-custom",
      shortId: "ABCD",
      customText: "trimmed",
    });
  });

  it("normalises custom shortId to uppercase", () => {
    expect(parseOwnerReply("[msg-abcd] hi")).toEqual({
      type: "send-custom",
      shortId: "ABCD",
      customText: "hi",
    });
  });

  it("returns unknown for plain text", () => {
    expect(parseOwnerReply("hello world")).toEqual({ type: "unknown" });
  });

  it("returns unknown for empty string", () => {
    expect(parseOwnerReply("")).toEqual({ type: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// resolveTrainerStateDirs
// ---------------------------------------------------------------------------

describe("resolveTrainerStateDirs", () => {
  it("uses env overrides when present", () => {
    const result = resolveTrainerStateDirs({
      OPENCLAW_STATE_DIR: "/custom/state",
      OPENCLAW_WORKSPACE_DIR: "/custom/workspace",
    });
    expect(result).toEqual({ stateDir: "/custom/state", workspaceDir: "/custom/workspace" });
  });

  it("falls back to HOME-based defaults", () => {
    const result = resolveTrainerStateDirs({ HOME: "/home/testuser" });
    expect(result).toEqual({
      stateDir: "/home/testuser/.openclaw/state",
      workspaceDir: "/home/testuser/.openclaw/workspace",
    });
  });

  it("handles missing HOME", () => {
    const result = resolveTrainerStateDirs({});
    expect(result).toEqual({
      stateDir: "/.openclaw/state",
      workspaceDir: "/.openclaw/workspace",
    });
  });

  it("falls back to config workspace when OPENCLAW_WORKSPACE_DIR is not set", () => {
    const result = resolveTrainerStateDirs(
      { HOME: "/home/testuser" },
      { agents: { defaults: { workspace: "/config/workspace" } } },
    );
    expect(result.workspaceDir).toBe("/config/workspace");
  });

  it("env OPENCLAW_WORKSPACE_DIR takes precedence over config workspace", () => {
    const result = resolveTrainerStateDirs(
      { HOME: "/home/testuser", OPENCLAW_WORKSPACE_DIR: "/env/workspace" },
      { agents: { defaults: { workspace: "/config/workspace" } } },
    );
    expect(result.workspaceDir).toBe("/env/workspace");
  });
});

// ---------------------------------------------------------------------------
// expireTrainerPending
// ---------------------------------------------------------------------------

describe("expireTrainerPending", () => {
  let stateDir: string;
  let send: Awaited<ReturnType<typeof getSendMock>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    send = await getSendMock();
    send.mockClear();
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
  });

  it("returns 0 when store is empty", async () => {
    const count = await expireTrainerPending({
      stateDir,
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
    });
    expect(count).toBe(0);
  });

  it("does not expire a message within TTL", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "hi",
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() + 60_000,
      },
    });
    const count = await expireTrainerPending({
      stateDir,
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
    });
    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const store = await readPendingStore(stateDir);
    expect(store.messages["ABCD"]).toBeDefined();
  });

  it("expires a stale message and notifies owner", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "hi",
        timestamp: Date.now() - 100_000,
        mode: "supervised",
        expiresAt: Date.now() - 1,
      },
    });
    const count = await expireTrainerPending({
      stateDir,
      account: makeAccount({ trainerNotifyNumber: "+12025550100" }),
      config: makeConfig(),
      runtime: makeRuntime(),
    });
    expect(count).toBe(1);
    expect(send).toHaveBeenCalledWith("+12025550100", "⚠️ msg-ABCD: expired", expect.anything());
    const store = await readPendingStore(stateDir);
    expect(store.messages["ABCD"]).toBeUndefined();
  });

  it("expires silently when notifyNumber is absent", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "hi",
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() - 1,
      },
    });
    const count = await expireTrainerPending({
      stateDir,
      account: makeAccount({ trainerNotifyNumber: undefined }),
      config: makeConfig(),
      runtime: makeRuntime(),
    });
    expect(count).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleTrainerOwnerReply
// ---------------------------------------------------------------------------

describe("handleTrainerOwnerReply", () => {
  let stateDir: string;
  let workspaceDir: string;
  let send: Awaited<ReturnType<typeof getSendMock>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    workspaceDir = await mkTmpDir();
    send = await getSendMock();
    send.mockClear();
  });

  afterEach(async () => {
    await Promise.all([rmTmpDir(stateDir), rmTmpDir(workspaceDir)]);
  });

  it("returns false for unrecognised text", async () => {
    const result = await handleTrainerOwnerReply({
      replyText: "just chatting",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns true and notifies owner for unknown shortId so it never reaches the agent", async () => {
    const result = await handleTrainerOwnerReply({
      replyText: "send FFFF",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const calls = send.mock.calls as Array<[string, string, ...unknown[]]>;
    expect(calls.some(([, body]) => body.includes("⚠️ msg-FFFF: unknown"))).toBe(true);
  });

  it("returns true and notifies on expired shortId", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hey",
        draft: "hi",
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() - 1,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "send ABCD",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    expect(send).toHaveBeenCalledWith("+12025550100", "⚠️ msg-ABCD: expired", expect.anything());
    const store = await readPendingStore(stateDir);
    expect(store.messages["ABCD"]).toBeUndefined();
  });

  it("blocks send-draft in supervised mode when draft failed", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "(draft unavailable — ANTHROPIC_API_KEY not configured)",
        draftFailed: true,
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "send ABCD",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const [, notifyText] = send.mock.calls[0] as [string, string, ...unknown[]];
    expect(notifyText).toContain("no draft available");
    // Must not send to the original sender
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends draft to original sender in supervised mode", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "Hey there!",
        draftFailed: false,
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "send ABCD",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    expect(send).toHaveBeenCalledWith("+15551234567", "🦞 Hey there!", expect.anything());
  });

  it("sends custom text to original sender in supervised mode", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "Hey there!",
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "[msg-ABCD] Custom reply here",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    expect(send).toHaveBeenCalledWith("+15551234567", "Custom reply here", expect.anything());
  });

  it("logs correction to MEMORY.md in training mode with 'would have sent' verb", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        fromName: "Alice",
        content: "hello",
        draft: "Hey there!",
        timestamp: Date.now(),
        mode: "training",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "[msg-ABCD] My correction",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const sendCalls = send.mock.calls as Array<[string, string, ...unknown[]]>;
    expect(sendCalls.some(([to]) => to === "+15551234567")).toBe(false);
    const memory = await readFile(join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("Alice");
    expect(memory).toContain("hello");
    expect(memory).toContain("My correction");
    expect(memory).toContain("would have sent");
  });

  it("logs draft approval to MEMORY.md in training mode with 'approved' verb", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        fromName: "Alice",
        content: "hello",
        draft: "Hey there!",
        timestamp: Date.now(),
        mode: "training",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "send ABCD",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const sendCalls = send.mock.calls as Array<[string, string, ...unknown[]]>;
    expect(sendCalls.some(([to]) => to === "+15551234567")).toBe(false);
    const memory = await readFile(join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("Hey there!");
    expect(memory).toContain("approved");
    expect(memory).not.toContain("would have sent");
  });

  it("removes entry from pending store after processing", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "hi",
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() + 60_000,
      },
    });
    await handleTrainerOwnerReply({
      replyText: "send ABCD",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    const store = await readPendingStore(stateDir);
    expect(store.messages["ABCD"]).toBeUndefined();
  });

  it("never sends to original sender in training mode even if owner issues send command", async () => {
    await writePendingStore(stateDir, {
      BEEF: {
        id: "BEEF",
        from: "+15559876543",
        content: "safety boundary test",
        draft: "A draft reply",
        timestamp: Date.now(),
        mode: "training",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "send BEEF",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const calls = send.mock.calls as Array<[string, string, ...unknown[]]>;
    const sentToOriginal = calls.some(([to]) => to === "+15559876543");
    expect(sentToOriginal).toBe(false);
  });

  it("returns true and notifies owner for unknown shortId via custom command", async () => {
    const result = await handleTrainerOwnerReply({
      replyText: "[msg-FFFF] some custom text",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const calls = send.mock.calls as Array<[string, string, ...unknown[]]>;
    expect(calls.some(([, body]) => body.includes("⚠️ msg-FFFF: unknown"))).toBe(true);
  });

  it("returns true and notifies on expired shortId via custom command", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hey",
        draft: "hi",
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() - 1,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "[msg-ABCD] my text",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    expect(send).toHaveBeenCalledWith("+12025550100", "⚠️ msg-ABCD: expired", expect.anything());
    const store = await readPendingStore(stateDir);
    expect(store.messages["ABCD"]).toBeUndefined();
  });

  it("allows custom send in supervised mode even when draft failed", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "(draft unavailable — no model configured)",
        draftFailed: true,
        timestamp: Date.now(),
        mode: "supervised",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "[msg-ABCD] I wrote my own reply",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    expect(send).toHaveBeenCalledWith("+15551234567", "I wrote my own reply", expect.anything());
  });

  it("blocks send-draft in training mode when draft failed to avoid logging the sentinel", async () => {
    await writePendingStore(stateDir, {
      ABCD: {
        id: "ABCD",
        from: "+15551234567",
        content: "hello",
        draft: "(draft unavailable — no model configured)",
        draftFailed: true,
        timestamp: Date.now(),
        mode: "training",
        expiresAt: Date.now() + 60_000,
      },
    });
    const result = await handleTrainerOwnerReply({
      replyText: "send ABCD",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(true);
    const [, notifyText] = send.mock.calls[0] as [string, string, ...unknown[]];
    expect(notifyText).toContain("no draft available");
    // Must not send to the original sender
    expect(send).toHaveBeenCalledOnce();
  });

  it("returns false for echo of outgoing notification so echo filter can drop it", async () => {
    const result = await handleTrainerOwnerReply({
      replyText: `📨 [msg-ABCD] From Alice: "hello"\n\nMy draft: "hi"\n\nReply...`,
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns false for echo of outgoing status notification so echo filter can drop it", async () => {
    const result = await handleTrainerOwnerReply({
      replyText: "⚠️ msg-ABCD: unknown — no pending message with this ID.",
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      stateDir,
      workspaceDir,
    });
    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createTrainerSendInterceptor
// ---------------------------------------------------------------------------

/** Base context shared across most interceptor tests. */
function makeContext(
  stateDir: string,
  overrides: Partial<Parameters<typeof createTrainerSendInterceptor>[1]> = {},
): Parameters<typeof createTrainerSendInterceptor>[1] {
  return {
    mode: "supervised",
    notifyNumber: "+12025550100",
    accountId: "default",
    config: makeConfig(),
    runtime: makeRuntime(),
    stateDir,
    originalFrom: "+15559998888",
    originalFromName: "Alice",
    originalContent: "hey, are you free tonight?",
    originalMessageId: "550e8400-e29b-41d4-a716-446655ABCD",
    ...overrides,
  };
}

describe("createTrainerSendInterceptor — reply mode", () => {
  let stateDir: string;
  let originalSend: ReturnType<typeof vi.fn<(to: string, text: string) => Promise<void>>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    originalSend = vi
      .fn<(to: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
    vi.clearAllMocks();
  });

  it("returns original send function unwrapped — no interception occurs", async () => {
    const send = getSendMock();
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { mode: "reply" }),
    );

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    expect(originalSend).toHaveBeenCalledWith("+15559998888", "Sure, I'm free after 7!");
    expect((await send).mock.calls.length).toBe(0); // owner not notified
  });

  it("pending store remains empty in reply mode", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { mode: "reply" }),
    );

    await intercepted("+15559998888", "No worries!");

    const store = await readPendingStore(stateDir);
    expect(Object.keys(store.messages)).toHaveLength(0);
  });
});

describe("createTrainerSendInterceptor — supervised mode", () => {
  let stateDir: string;
  let originalSend: ReturnType<typeof vi.fn<(to: string, text: string) => Promise<void>>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    originalSend = vi
      .fn<(to: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
    vi.clearAllMocks();
  });

  it("does NOT call originalSend when sending to original sender", async () => {
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    expect(originalSend).not.toHaveBeenCalled();
  });

  it("stores a pending entry with the agent draft as the draft field", async () => {
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    const store = await readPendingStore(stateDir);
    const entries = Object.values(store.messages) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.draft).toBe("Sure, I'm free after 7!");
  });

  it("pending entry has correct from, fromName, content, and mode fields", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        originalFrom: "+15559998888",
        originalFromName: "Alice",
        originalContent: "hey, are you free tonight?",
        mode: "supervised",
      }),
    );

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as Record<string, unknown>;
    expect(entry.from).toBe("+15559998888");
    expect(entry.fromName).toBe("Alice");
    expect(entry.content).toBe("hey, are you free tonight?");
    expect(entry.mode).toBe("supervised");
  });

  it("draftFailed is not set — agent produced output so the draft is valid", async () => {
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as Record<string, unknown>;
    expect(entry.draftFailed).toBeFalsy();
  });

  it("short ID is derived from last 4 hex chars of originalMessageId", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "550e8400-e29b-41d4-a716-446655ABCD" }),
    );

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    const store = await readPendingStore(stateDir);
    // Last 4 hex of "550e8400e29b41d4a716446655ABCD" (dashes removed) → "ABCD"
    expect(store.messages["ABCD"]).toBeDefined();
  });

  it("expiresAt is approximately 6 hours from now", async () => {
    const before = Date.now();
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+15559998888", "Sure!");

    const after = Date.now();
    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as Record<string, unknown>;
    const sixHoursMs = 6 * 60 * 60 * 1000;
    expect(entry.expiresAt as number).toBeGreaterThanOrEqual(before + sixHoursMs - 100);
    expect(entry.expiresAt as number).toBeLessThanOrEqual(after + sixHoursMs + 100);
  });

  it("notifies owner with 📨 prefix, short-id, sender name, original content, and draft", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "000000000000000000000000ABCD" }),
    );

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    expect(sendMock).toHaveBeenCalledOnce();
    const notificationText = sendMock.mock.calls[0][1];
    expect(notificationText).toMatch(/^📨 \[msg-ABCD\]/);
    expect(notificationText).toContain("Alice");
    expect(notificationText).toContain("hey, are you free tonight?");
    expect(notificationText).toContain("Sure, I'm free after 7!");
  });

  it("supervised notification mentions 'send ABCD' approval command", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "000000000000000000000000ABCD" }),
    );

    await intercepted("+15559998888", "Sure!");

    const notificationText = sendMock.mock.calls[0][1];
    expect(notificationText).toMatch(/send ABCD/i);
  });

  it("owner notification is sent to notifyNumber, not to original sender", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+15559998888", "Sure!");

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0]).toBe("+12025550100");
    expect(sendMock.mock.calls[0][0]).not.toBe("+15559998888");
  });

  it("passes sends to notifyNumber through unchanged — owner chat not intercepted", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+12025550100", "Status update from agent");

    expect(originalSend).toHaveBeenCalledWith("+12025550100", "Status update from agent");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("passes sends to unrecognised numbers through — agent sending to a third party", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await intercepted("+19990000000", "Some third-party message");

    expect(originalSend).toHaveBeenCalledWith("+19990000000", "Some third-party message");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("notification failure does not throw — fire-and-forget", async () => {
    const sendMock = await getSendMock();
    sendMock.mockRejectedValueOnce(new Error("network error"));

    const intercepted = createTrainerSendInterceptor(originalSend, makeContext(stateDir));

    await expect(intercepted("+15559998888", "Sure!")).resolves.not.toThrow();
  });

  it("multiple agent sends each get their own pending entry", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        originalMessageId: "00000000-0000-0000-0000-000000AABB",
      }),
    );

    await intercepted("+15559998888", "First reply");
    await intercepted("+15559998888", "Second reply");

    const store = await readPendingStore(stateDir);
    expect(Object.keys(store.messages).length).toBeGreaterThanOrEqual(1);
  });
});

describe("createTrainerSendInterceptor — training mode", () => {
  let stateDir: string;
  let originalSend: ReturnType<typeof vi.fn<(to: string, text: string) => Promise<void>>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    originalSend = vi
      .fn<(to: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
    vi.clearAllMocks();
  });

  it("does NOT call originalSend when sending to original sender", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { mode: "training" }),
    );

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    expect(originalSend).not.toHaveBeenCalled();
  });

  it("pending entry mode is 'training'", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { mode: "training" }),
    );

    await intercepted("+15559998888", "Sure!");

    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as Record<string, unknown>;
    expect(entry.mode).toBe("training");
  });

  it("training notification mentions 'send ABCD' to approve and '[msg-ABCD]' to correct", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        mode: "training",
        originalMessageId: "000000000000000000000000ABCD",
      }),
    );

    await intercepted("+15559998888", "Sure!");

    const notificationText = sendMock.mock.calls[0][1];
    expect(notificationText).toMatch(/send ABCD/i);
    expect(notificationText).toContain("[msg-ABCD]");
  });

  it("training notification uses 📨 prefix and includes draft", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        mode: "training",
        originalMessageId: "000000000000000000000000ABCD",
        originalFromName: "Alice",
        originalContent: "hey, are you free tonight?",
      }),
    );

    await intercepted("+15559998888", "Sure, I'm free after 7!");

    const notificationText = sendMock.mock.calls[0][1];
    expect(notificationText).toMatch(/^📨 \[msg-ABCD\]/);
    expect(notificationText).toContain("Alice");
    expect(notificationText).toContain("hey, are you free tonight?");
    expect(notificationText).toContain("Sure, I'm free after 7!");
  });
});

describe("createTrainerSendInterceptor — no notifyNumber", () => {
  let stateDir: string;
  let originalSend: ReturnType<typeof vi.fn<(to: string, text: string) => Promise<void>>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    originalSend = vi
      .fn<(to: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
    vi.clearAllMocks();
  });

  it("passes send through when notifyNumber is empty — cannot notify owner", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { notifyNumber: "" }),
    );

    await intercepted("+15559998888", "Sure!");

    expect(originalSend).toHaveBeenCalledWith("+15559998888", "Sure!");
  });
});

describe("createTrainerSendInterceptor — forceDraftFailed (media/tool-send intercept)", () => {
  let stateDir: string;
  let originalSend: ReturnType<typeof vi.fn<(to: string, text: string) => Promise<void>>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    originalSend = vi
      .fn<(to: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
    vi.clearAllMocks();
  });

  it("stores draftFailed=true in pending entry when forceDraftFailed is set", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        mode: "supervised",
        originalMessageId: "000000000000000000000000ABCD",
        forceDraftFailed: true,
      }),
    );

    await intercepted("+15559998888", "<media: 1 attachment>");

    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as Record<string, unknown>;
    expect(entry.draftFailed).toBe(true);
  });

  it("notification text says 'Agent wanted to send' and instructs custom reply only", async () => {
    const sendMock = await getSendMock();
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        mode: "supervised",
        originalMessageId: "000000000000000000000000ABCD",
        originalFromName: "Keri",
        originalContent: "can you send me that file?",
        forceDraftFailed: true,
      }),
    );

    await intercepted("+15559998888", "<media: 2 attachments>");

    const notificationText = sendMock.mock.calls[0][1];
    expect(notificationText).toMatch(/^📨 \[msg-ABCD\]/);
    expect(notificationText).toContain("Keri");
    expect(notificationText).toContain("can you send me that file?");
    expect(notificationText).toContain("Agent wanted to send");
    expect(notificationText).toContain("<media: 2 attachments>");
    expect(notificationText).toContain("[msg-ABCD] your text");
    // Must NOT say "send ABCD to approve" — that path is blocked for media
    expect(notificationText).not.toMatch(/\bsend ABCD\b/i);
  });

  it("does not deliver to original sender — media is still held for owner", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { forceDraftFailed: true }),
    );

    await intercepted("+15559998888", "<media: 1 attachment>");

    expect(originalSend).not.toHaveBeenCalled();
  });

  it("works in training mode too — draftFailed=true stored", async () => {
    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, {
        mode: "training",
        originalMessageId: "000000000000000000000000ABCD",
        forceDraftFailed: true,
      }),
    );

    await intercepted("+15559998888", "<media: 1 attachment>");

    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as Record<string, unknown>;
    expect(entry.draftFailed).toBe(true);
    expect(entry.mode).toBe("training");
  });
});

describe("createTrainerSendInterceptor — notification failure resilience", () => {
  let stateDir: string;
  let originalSend: ReturnType<typeof vi.fn<(to: string, text: string) => Promise<void>>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    originalSend = vi
      .fn<(to: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rmTmpDir(stateDir);
    vi.clearAllMocks();
  });

  it("AbortError on first notification is retried once, then recorded as notificationFailed", async () => {
    const sendMock = await getSendMock();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    sendMock.mockRejectedValueOnce(abortErr).mockRejectedValueOnce(abortErr);

    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "000000000000000000000000ABCD" }),
    );

    await intercepted("+15559998888", "Sure!");

    const store = await readPendingStore(stateDir);
    const entry = store.messages["ABCD"] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(entry.notificationFailed).toBe(true);
  });

  it("second message from same sender is still intercepted after first notification AbortErrors", async () => {
    const sendMock = await getSendMock();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    // First notification attempt aborts (both retry attempts fail)
    sendMock.mockRejectedValueOnce(abortErr).mockRejectedValueOnce(abortErr);
    // Second notification succeeds
    sendMock.mockResolvedValue({ messageId: "mock-notify-2", sentText: "" });

    // Simulate message A — notification fails
    const interceptedA = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "000000000000000000000000MSG1" }),
    );
    await interceptedA("+15559998888", "Reply to msg A");

    // Simulate message B — separate interceptor instance, same stateDir
    const interceptedB = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "000000000000000000000000MSG2" }),
    );
    await interceptedB("+15559998888", "Reply to msg B");

    // Both messages should be held in the pending store
    const store = await readPendingStore(stateDir);
    expect(store.messages["MSG1"]).toBeDefined();
    expect(store.messages["MSG2"]).toBeDefined();

    // Original send must never have been called — no bypass
    expect(originalSend).not.toHaveBeenCalled();

    // Owner was notified about message B
    const notifyCallArgs = sendMock.mock.calls.map((c) => c[1]);
    expect(notifyCallArgs.some((t) => t.includes("MSG2"))).toBe(true);
  });

  it("pending entry is still saved even when notification throws non-AbortError", async () => {
    const sendMock = await getSendMock();
    sendMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const intercepted = createTrainerSendInterceptor(
      originalSend,
      makeContext(stateDir, { originalMessageId: "000000000000000000000000ABCD" }),
    );

    await intercepted("+15559998888", "Sure!");

    const store = await readPendingStore(stateDir);
    const entry = store.messages["ABCD"] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(entry.draft).toBe("Sure!");
    expect(originalSend).not.toHaveBeenCalled();
  });
});
