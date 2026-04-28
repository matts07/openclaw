import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import {
  expireTrainerPending,
  handleTrainerInbound,
  handleTrainerOwnerReply,
  parseOwnerReply,
  resolveTrainerStateDirs,
} from "./bbtrainer.js";
import type { OpenClawConfig } from "./runtime-api.js";

vi.mock("./send.js", () => ({
  sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "mock-msg" }),
}));

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  extractAssistantText: vi.fn(),
}));

// Lazy imports so vi.mock hoisting completes before we grab the references.
const getSendMock = async () => {
  const { sendMessageBlueBubbles } = await import("./send.js");
  return vi.mocked(sendMessageBlueBubbles);
};

const getSdkMocks = async () => {
  const sdk = await import("openclaw/plugin-sdk/simple-completion-runtime");
  return {
    prepare: vi.mocked(sdk.prepareSimpleCompletionModelForAgent),
    complete: vi.mocked(sdk.completeWithPreparedSimpleCompletionModel),
    extract: vi.mocked(sdk.extractAssistantText),
  };
};

function makeAccount(
  overrides: Partial<ResolvedBlueBubblesAccount["config"]> = {},
): ResolvedBlueBubblesAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      serverUrl: "http://localhost:1234",
      password: "test-password",
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      trainerMode: "supervised",
      trainerNotifyNumber: "+12025550100",
      ...overrides,
    },
  };
}

function makeConfig(): OpenClawConfig {
  return {
    channels: {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      },
    },
  };
}

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn() };
}

async function mkTmpDir(): Promise<string> {
  return await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "bbtrainer-test-")),
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
    join(stateDir, "bluebubbles-trainer-pending.json"),
    JSON.stringify({ messages, lastUpdated: Date.now() }, null, 2),
    "utf-8",
  );
}

async function readPendingStore(stateDir: string) {
  try {
    return JSON.parse(
      await readFile(join(stateDir, "bluebubbles-trainer-pending.json"), "utf-8"),
    ) as { messages: Record<string, unknown> };
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
// handleTrainerInbound
// ---------------------------------------------------------------------------

describe("handleTrainerInbound", () => {
  let stateDir: string;
  let workspaceDir: string;
  let send: Awaited<ReturnType<typeof getSendMock>>;
  let sdk: Awaited<ReturnType<typeof getSdkMocks>>;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
    workspaceDir = await mkTmpDir();
    send = await getSendMock();
    send.mockClear();
    sdk = await getSdkMocks();
    sdk.prepare.mockReset();
    sdk.complete.mockReset();
    sdk.extract.mockReset();
  });

  afterEach(async () => {
    await Promise.all([rmTmpDir(stateDir), rmTmpDir(workspaceDir)]);
  });

  it("does nothing when notifyNumber is not configured", async () => {
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        text: "hello",
        messageId: "msg-0001",
      },
      account: makeAccount({ trainerNotifyNumber: undefined }),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("notifies owner with unavailable draft when no model configured", async () => {
    sdk.prepare.mockResolvedValueOnce({ error: "no model configured" });
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        senderName: "Alice",
        text: "hey",
        messageId: "GUID-0001",
      },
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    expect(send).toHaveBeenCalledOnce();
    const [notifyNum, notifyText] = send.mock.calls[0] as [string, string, ...unknown[]];
    expect(notifyNum).toBe("+12025550100");
    expect(notifyText).toContain("draft unavailable");
    expect(notifyText).toContain("[msg-");
    expect(notifyText).toContain("Alice");
    expect(notifyText).toContain("hey");
  });

  it("notifies owner with AI draft when model is configured", async () => {
    sdk.prepare.mockResolvedValueOnce({
      model: {} as any,
      auth: {} as any,
      selection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        agentDir: "/tmp/test-agent",
      },
    });
    sdk.complete.mockResolvedValueOnce({} as any);
    sdk.extract.mockReturnValueOnce("Sounds good!");
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        senderName: "Bob",
        text: "can we meet?",
        messageId: "GUID-0002",
      },
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    expect(sdk.prepare).toHaveBeenCalledWith(expect.objectContaining({ agentId: "test-agent" }));
    const [, notifyText] = send.mock.calls[0] as [string, string, ...unknown[]];
    expect(notifyText).toContain("Sounds good!");
  });

  it("strips surrounding quotes from model-generated draft", async () => {
    sdk.prepare.mockResolvedValueOnce({
      model: {} as any,
      auth: {} as any,
      selection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        agentDir: "/tmp/test-agent",
      },
    });
    sdk.complete.mockResolvedValueOnce({} as any);
    sdk.extract.mockReturnValueOnce('"Not much, what\'s going on?"');
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        text: "hey what are you up to?",
        messageId: "GUID-QUOT",
      },
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    const store = await readPendingStore(stateDir);
    const entry = Object.values(store.messages)[0] as { draft: string };
    expect(entry.draft).toBe("Not much, what's going on?");
    expect(entry.draft.startsWith('"')).toBe(false);
  });

  it("saves entry to pending store", async () => {
    sdk.prepare.mockResolvedValueOnce({ error: "no model" });
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        text: "ping",
        messageId: "AAAA-1111-2222-3333-4444",
      },
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "training",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    const store = await readPendingStore(stateDir);
    const entries = Object.values(store.messages);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { from: string; content: string; mode: string };
    expect(entry.from).toBe("+15551234567");
    expect(entry.content).toBe("ping");
    expect(entry.mode).toBe("training");
  });

  it("includes SOUL.md in system prompt when present", async () => {
    sdk.prepare.mockResolvedValueOnce({
      model: {} as any,
      auth: {} as any,
      selection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        agentDir: "/tmp/test-agent",
      },
    });
    sdk.complete.mockResolvedValueOnce({} as any);
    sdk.extract.mockReturnValueOnce("Sure!");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "SOUL.md"), "Be concise and witty.", "utf-8");
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        text: "hi",
        messageId: "GUID-0003",
      },
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    const completeArg = (sdk.complete.mock.calls[0] as [{ context: { systemPrompt: string } }])[0];
    expect(completeArg.context.systemPrompt).toContain("Be concise and witty.");
  });

  it("injects relevant MEMORY.md interaction log examples into system prompt", async () => {
    sdk.prepare.mockResolvedValueOnce({
      model: {} as any,
      auth: {} as any,
      selection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        agentDir: "/tmp/test-agent",
      },
    });
    sdk.complete.mockResolvedValueOnce({} as any);
    sdk.extract.mockReturnValueOnce("Sounds good!");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "MEMORY.md"),
      [
        "## Interaction Log",
        `- [2026-01-01T00:00:00.000Z] From Alice: "dinner tonight?" | I drafted: "sounds good" | Owner sent: "yes dinner sounds great!"`,
        `- [2026-01-02T00:00:00.000Z] From Alice: "work meeting tomorrow" | I drafted: "noted" | Owner sent: "yep calendar blocked"`,
      ].join("\n") + "\n",
      "utf-8",
    );
    await handleTrainerInbound({
      message: {
        senderId: "+15551234567",
        senderIdExplicit: true,
        isGroup: false,
        text: "are you free for dinner?",
        messageId: "GUID-MEM1",
      },
      account: makeAccount(),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    const completeArg = (sdk.complete.mock.calls[0] as [{ context: { systemPrompt: string } }])[0];
    // The dinner entry is more relevant to "free for dinner" — must be included
    expect(completeArg.context.systemPrompt).toContain("yes dinner sounds great!");
  });

  it("never sends to the original sender — only to the owner notify number", async () => {
    sdk.prepare.mockResolvedValueOnce({ error: "no model" });
    await handleTrainerInbound({
      message: {
        senderId: "+15559876543",
        senderIdExplicit: true,
        isGroup: false,
        text: "safety boundary test",
        messageId: "SAFE-0001",
      },
      account: makeAccount({ trainerNotifyNumber: "+12025550100" }),
      config: makeConfig(),
      runtime: makeRuntime(),
      trainerMode: "supervised",
      agentId: "test-agent",
      stateDir,
      workspaceDir,
    });
    const calls = send.mock.calls as Array<[string, string, ...unknown[]]>;
    const sentToOriginal = calls.some(([to]) => to === "+15559876543");
    expect(sentToOriginal).toBe(false);
    expect(send).toHaveBeenCalledOnce(); // only the owner notification
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
