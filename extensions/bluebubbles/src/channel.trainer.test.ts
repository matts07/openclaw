import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

vi.mock("./channel.runtime.js", () => ({
  blueBubblesChannelRuntime: {
    sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "mock-msg" }),
    sendBlueBubblesMedia: vi.fn().mockResolvedValue({ messageId: "mock-media" }),
    resolveBlueBubblesMessageId: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

let bluebubblesPlugin: typeof import("./channel.js").bluebubblesPlugin;

const baseCfg = (trainerMode: "reply" | "training" | "supervised"): OpenClawConfig => ({
  channels: {
    bluebubbles: {
      serverUrl: "http://localhost:1234",
      password: "test-password",
      trainerMode,
    },
  },
});

describe("bluebubblesPlugin.outbound.attachedResults — trainer block (escape-route guard)", () => {
  beforeAll(async () => {
    ({ bluebubblesPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sendText", () => {
    it("throws in training mode — direct send is blocked", async () => {
      const sendText = bluebubblesPlugin.outbound?.sendText;
      await expect(
        sendText?.({
          cfg: baseCfg("training"),
          to: "+15559998888",
          text: "Shrinking!",
          accountId: null,
          replyToId: null,
        }),
      ).rejects.toThrow(/Direct send blocked.*training/);
    });

    it("throws in supervised mode — direct send is blocked", async () => {
      const sendText = bluebubblesPlugin.outbound?.sendText;
      await expect(
        sendText?.({
          cfg: baseCfg("supervised"),
          to: "+15559998888",
          text: "Sure!",
          accountId: null,
          replyToId: null,
        }),
      ).rejects.toThrow(/Direct send blocked.*supervised/);
    });

    it("does not throw in reply mode — send passes through", async () => {
      const sendText = bluebubblesPlugin.outbound?.sendText;
      await expect(
        sendText?.({
          cfg: baseCfg("reply"),
          to: "+15559998888",
          text: "Sure!",
          accountId: null,
          replyToId: null,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("sendMedia", () => {
    it("throws in training mode — direct media send is blocked", async () => {
      const sendMedia = bluebubblesPlugin.outbound?.sendMedia;
      await expect(
        sendMedia?.({
          cfg: baseCfg("training"),
          to: "+15559998888",
          text: "",
          mediaUrl: "https://example.com/image.png",
          accountId: null,
          replyToId: null,
          audioAsVoice: false,
        }),
      ).rejects.toThrow(/Direct media send blocked.*training/);
    });

    it("throws in supervised mode — direct media send is blocked", async () => {
      const sendMedia = bluebubblesPlugin.outbound?.sendMedia;
      await expect(
        sendMedia?.({
          cfg: baseCfg("supervised"),
          to: "+15559998888",
          text: "",
          mediaUrl: "https://example.com/image.png",
          accountId: null,
          replyToId: null,
          audioAsVoice: false,
        }),
      ).rejects.toThrow(/Direct media send blocked.*supervised/);
    });

    it("does not throw in reply mode — media send passes through", async () => {
      const sendMedia = bluebubblesPlugin.outbound?.sendMedia;
      await expect(
        sendMedia?.({
          cfg: baseCfg("reply"),
          to: "+15559998888",
          text: "",
          mediaUrl: "https://example.com/image.png",
          accountId: null,
          replyToId: null,
          audioAsVoice: false,
        }),
      ).resolves.not.toThrow();
    });
  });
});
