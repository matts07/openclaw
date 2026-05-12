# iMessage Trainer

## What Is This?

The iMessage Trainer is an optional operating mode for the OpenClaw iMessage channel plugin. When active, the agent runs a full session with all configured tools — calendar, contacts, memory, everything — and drafts a reply exactly as it normally would. The reply is then captured before delivery: the owner receives a notification containing the original message and the agent's draft, and can approve the draft, override it, or provide a correction — all from their phone. Nothing is ever sent to the original sender automatically.

The goal is two-fold:

1. **Supervised deployment** — keep a human in the loop on every response while still getting context-aware AI draft assistance, before fully trusting the agent to respond autonomously.
2. **Training data collection** — build a personal log of (message, my-actual-reply) pairs written into `MEMORY.md` to tune the agent's voice over time.

---

## Why This Approach?

The only control surface the owner has over their iMessage account is their own phone. The design works entirely through iMessage itself:

- The owner's phone number (`trainerNotifyNumber`) receives a notification with the agent's draft embedded inline.
- The owner replies with a simple command (`send XXXX` or `[msg-XXXX] custom text`) from any iMessage-capable device.
- No external app, no web UI, no push service — just iMessage.

This means the owner can approve or correct responses from any device that has iMessage, including Apple Watch, without installing anything new.

Because the agent runs a complete session before capture occurs, the draft reflects the full context the agent has: SOUL.md (the owner's voice profile) and MEMORY.md (past interaction examples) are injected automatically by the OpenClaw core runtime into every agent session — no special trainer setup required. Calendar, contacts, and any other configured tools are also fully available. Draft quality improves naturally as MEMORY.md grows.

An earlier approach intercepted messages before any agent session ran and generated drafts through a stripped-down simple-completion call. That design came up short because the draft had no tool access — it couldn't consult calendar, contacts, or prior conversation state — producing responses that were often contextually wrong in ways the agent would never make.

---

## Modes

### `reply` (default)

No change to existing behaviour. Inbound messages are processed normally by the agent. The trainer is completely inactive.

### `training`

Every inbound DM that passes the allowlist/dmPolicy gate reaches the agent for a full session. After the agent produces a reply, the send is captured:

1. A short ID is derived from the last 4 hex chars of the message GUID.
2. The pending entry (original message + agent draft) is saved to the state store (JSON file, 6-hour TTL).
3. A notification is sent to `trainerNotifyNumber`:

   ```
   📨 [msg-XXXX] From Alice: "hey, are you free tonight?"

   My draft: "Hey! Should be free after 7, what did you have in mind?"

   Reply "send XXXX" to approve my draft, or "[msg-XXXX] your version" to log a correction instead.
   ```

4. The owner has two choices — both log to `MEMORY.md`; nothing is sent to the original sender in either case:
   - `send XXXX` — logs the agent draft as approved (`Owner approved: "…"`).
   - `[msg-XXXX] Actually I'm busy tonight` — logs the correction (`Owner would have sent: "…"`).

### `supervised`

Identical to training but the owner can also trigger sends:

- `send XXXX` — sends the agent's draft to the original sender.
- `[msg-XXXX] custom text` — sends a custom reply to the original sender.

The MEMORY.md log line verb reflects the action taken:

| Mode         | Command        | Verb in log              |
| ------------ | -------------- | ------------------------ |
| `training`   | `send XXXX`    | `Owner approved:`        |
| `training`   | `[msg-XXXX] …` | `Owner would have sent:` |
| `supervised` | `send XXXX`    | `Owner sent:`            |
| `supervised` | `[msg-XXXX] …` | `Owner sent:`            |

---

## Owner Reply Commands

Both commands are parsed case-insensitively from `trainerNotifyNumber`.

| Command                | Action                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| `send XXXX`            | Send agent draft (supervised) or log draft approval to MEMORY.md (training) |
| `[msg-XXXX] your text` | Send custom reply (supervised) or log correction to MEMORY.md (training)    |
| `msg-XXXX your text`   | Same, without brackets                                                      |
| `msgXXXX your text`    | Same, without separator                                                     |

Where `XXXX` is the 4-character hex short ID shown in the notification.

Replies that don't match either pattern fall through to normal agent session handling, so the owner can still use the notify number as a regular chat thread.

**Status notifications** sent back to the owner use the `⚠️ msg-XXXX:` prefix (e.g. `⚠️ msg-ED86: unknown — no pending message with this ID.`). iMessage marks outgoing sends with `is_from_me: true`, so notification echoes are dropped at the inbound processing layer automatically — no prefix check or special handling is required.

---

## Configuration

Add to your `channels.imessage` config (or per-account block):

```yaml
channels:
  imessage:
    trainerMode: supervised
    trainerNotifyNumber: "+12025550100"
    agentTag: true
```

| Key                   | Type                                    | Required              | Default   | Description                                              |
| --------------------- | --------------------------------------- | --------------------- | --------- | -------------------------------------------------------- |
| `trainerMode`         | `"reply" \| "training" \| "supervised"` | No                    | `"reply"` |                                                          |
| `trainerNotifyNumber` | E.164 string                            | Yes (if mode ≠ reply) | —         | Phone number to receive notifications                    |
| `agentTag`            | boolean                                 | No                    | `true`    | Prefix AI-approved drafts with 🦞 (supervised mode only) |

Schema validation enforces that `trainerNotifyNumber` is present whenever `trainerMode` is `"training"` or `"supervised"`.

**`trainerNotifyNumber` is automatically allowlisted.** When trainer mode is active, the gateway injects `trainerNotifyNumber` into the effective `allowFrom` set at the allowlist gate. You do **not** need to add the owner's number to `allowFrom` manually — doing so could cause the owner's unrelated messages to be routed to the agent session instead of falling through to the owner-reply handler.

### `agentTag`

In supervised mode, when the owner approves the agent draft as-is (`send XXXX`), the message is prefixed with 🦞 before delivery. This makes AI-generated sends visually distinct from owner-written custom replies. Owner-written custom replies (`[msg-XXXX] your text`) are never tagged regardless of this setting.

### Environment Variables

| Variable                 | Default                 | Description                        |
| ------------------------ | ----------------------- | ---------------------------------- |
| `OPENCLAW_STATE_DIR`     | `~/.openclaw/state`     | Where the pending store JSON lives |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Where SOUL.md and MEMORY.md live   |

---

## Architecture

### File Layout

```
extensions/imessage/
  IMSGTRAINER.md                        # This document

extensions/imessage/src/
  trainer.ts                            # All trainer logic: pending store, owner reply handling, expiry, send interceptor
  trainer.test.ts                       # Unit tests
  monitor/
    monitor-provider.ts                 # Three integration touch points

src/config/
  zod-schema.providers-core.ts          # trainerMode/trainerNotifyNumber/agentTag in IMessageAccountSchemaBase
```

### Intercept Architecture

There are three touch points in `handleMessageNow` inside `monitor-provider.ts`:

**Touch point A — early intercept (pre-allowlist):**
Checks whether the incoming message is from `trainerNotifyNumber`. This runs before the allowlist gate because the owner's effective allowlist entry is injected dynamically (touch point B). Steps:

1. If the message matches a recognised trainer command (`send XXXX` or `[msg-XXXX] …`), it is consumed here and never reaches the agent.
2. If not recognised as a trainer command, the message falls through to normal allowlist → agent handling. The owner can still use the notify number as a regular chat thread.

Note: unlike similar designs that route through a BlueBubbles webhook, native iMessage marks all gateway-sent messages with `is_from_me: true`. The inbound processing layer (`resolveIMessageInboundDecision`) drops those at the "from me" check automatically, so no special echo prefix detection is needed.

**Touch point B — allowFrom injection:**
After the early intercept, `trainerNotifyNumber` is appended to the effective `allowFrom` list before `resolveIMessageInboundDecision` is called. This ensures the owner's number passes the DM policy gate without requiring a manual config entry.

**Touch point C — deliver callback intercept:**
Runs after the agent has completed its full session and produced a reply. `createTrainerSendInterceptor` wraps the send function so that any outbound message to the original sender is captured rather than delivered. Sends to any other number (e.g. status messages to the owner) pass through unchanged. The captured draft is stored as a pending entry and the owner is notified.

A `senderIsOwner` guard is applied before wrapping: if the original sender is the notify number (digits-only comparison), the interceptor is skipped entirely. This prevents owner messages processed by the agent from being re-captured as if they were agent output.

All three touch points are DM-only (`isGroup === false`). Group chats are unaffected.

```
incoming message
      │
      ▼
  [A] early intercept ──── is from trainerNotifyNumber? ──── YES ──► parse command
      │                                                                  │
      NO                                                     recognized ──► consumed
      │                                                                  │
      │                                                     unrecognized ──► fall-through to agent
      ▼
  [B] allowFrom injection (trainerNotifyNumber → effectiveAllowFrom)
      │
      ▼
  dmPolicy / allowlist gate
      │
      ▼
  full agent session (all tools, SOUL.md + MEMORY.md via core runtime)
      │
      ▼
  [C] deliver callback ─── training or supervised? ──► capture draft
      │                                                    │
      NO                                               store pending, notify owner
      │                                                    │
      ▼                                                return (no delivery)
  normal send (reply mode)
```

### Pending Store

Messages awaiting owner replies are serialised to JSON at:

```
$OPENCLAW_STATE_DIR/imessage-trainer-pending.json
```

Writes are atomic: the store is written to a `.tmp` sibling file and then renamed into place, so a concurrent read never sees a partial write.

Schema:

```typescript
interface PendingMessage {
  id: string; // 4-char hex short ID
  from: string; // original sender phone number or handle
  fromName?: string; // display name if available
  content: string; // original message text
  draft: string; // agent's captured reply draft
  draftFailed?: boolean; // true when draft is a placeholder; blocks "send XXXX" approval
  timestamp: number; // Unix ms
  mode: TrainerMode;
  expiresAt: number; // Unix ms (timestamp + DEFAULT_TTL_MS)
}
```

### TTL and Expiry

Pending messages expire after **6 hours** (`DEFAULT_TTL_MS`). Two expiry paths:

1. **On gateway startup** — `expireTrainerPending()` is called as a fire-and-forget alongside the catchup sweep. Stale entries are deleted and the owner is notified with `⚠️ msg-XXXX: expired`.
2. **On owner reply** — `handleTrainerOwnerReply` checks `expiresAt` before acting. Expired entries are cleaned up inline and the owner is notified.

If the startup notification itself fails to deliver (e.g. the iMessage RPC is not yet available), the entry is flagged `notificationFailed: true`. On the next startup, the gateway retries those notifications.

### Workspace Directory Resolution

`resolveTrainerStateDirs()` resolves `stateDir` and `workspaceDir` using the following priority order:

| Directory      | 1st priority                 | 2nd priority                       | Fallback                |
| -------------- | ---------------------------- | ---------------------------------- | ----------------------- |
| `stateDir`     | `OPENCLAW_STATE_DIR` env     | —                                  | `~/.openclaw/state`     |
| `workspaceDir` | `OPENCLAW_WORKSPACE_DIR` env | `config.agents.defaults.workspace` | `~/.openclaw/workspace` |

The config fallback means SOUL.md and MEMORY.md are automatically resolved from the same workspace the agent uses, with no extra environment variable required.

### MEMORY.md Format

Training entries are appended under an `## Interaction Log` section:

```markdown
## Interaction Log

- [2026-04-26T12:00:00.000Z] From Alice: "hey, are you free tonight?" | I drafted: "Should be around after 7!" | Owner would have sent: "I'm slammed this week sorry"
- [2026-04-26T12:15:00.000Z] From Carol: "quick question about tomorrow" | I drafted: "Sure, what's up?" | Owner approved: "Sure, what's up?"
- [2026-04-26T12:30:00.000Z] From Bob: "can we reschedule?" | I drafted: "Sure, when works for you?" | Owner sent: "Yep, Thursday afternoon?"
```

As the log grows, SOUL.md and MEMORY.md together form the agent's voice model. The core runtime injects both files into every agent session automatically, so draft quality improves with no additional configuration.

**Exit signal for supervised mode:** watch whether you're approving the draft without modification most of the time. When that becomes the norm, the agent has learned your voice well enough to switch to `reply` mode.

---

## Testing

```bash
pnpm test extensions/imessage/src/trainer.test.ts
```

**64 tests across 10 suites:**

| Suite                                                            | Cases                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseOwnerReply`                                                | send/custom/unknown, case normalisation, bracket variants, edge cases                                                                                                                                   |
| `resolveTrainerStateDirs`                                        | env overrides, HOME fallback, missing HOME, config workspace fallback, env takes precedence over config                                                                                                 |
| `expireTrainerPending`                                           | empty store, within-TTL, expired+notify, silent expiry                                                                                                                                                  |
| `handleTrainerOwnerReply`                                        | unknown text, unknown shortId, expired entries, draftFailed guard, custom send bypasses draftFailed, supervised send, custom send, training correction, training approval, store cleanup                |
| `createTrainerSendInterceptor — reply mode`                      | returns original send unwrapped, pending store remains empty                                                                                                                                            |
| `createTrainerSendInterceptor — supervised mode`                 | does not call originalSend, stores pending entry, correct fields, draftFailed not set, short ID derivation, expiresAt, notification format, pass-through to owner thread, pass-through to third parties |
| `createTrainerSendInterceptor — training mode`                   | does not call originalSend, pending mode field, notification mentions both commands, 📨 prefix and draft included                                                                                       |
| `createTrainerSendInterceptor — no notifyNumber`                 | passes send through when notifyNumber is empty                                                                                                                                                          |
| `createTrainerSendInterceptor — forceDraftFailed`                | draftFailed=true stored, media notification text, no "send XXXX" approval path, no delivery to sender                                                                                                   |
| `createTrainerSendInterceptor — notification failure resilience` | AbortError retried once then recorded as notificationFailed, pending entry saved even when notification throws                                                                                          |

Tests use real temp directories (`mkdtemp`). `sendMessageIMessage` is mocked at the module level.

---

## Security

The trainer operates entirely within the owner's own gateway instance, consistent with OpenClaw's personal assistant trust model. Key points:

- `trainerNotifyNumber` is a config value set by the owner — not user-supplied input.
- No new network endpoints are introduced; all communication uses the existing iMessage `sendMessage` path.
- The pending store is a local JSON file in `OPENCLAW_STATE_DIR`, accessible only to the gateway process.
- Short IDs are derived from message GUIDs (last 4 hex chars), not from user-supplied text, so they cannot be forged by crafting a message to match an existing pending entry.

---

## Known Limitations & Future Work

- **Group chat support is intentionally excluded.** The intercept only fires on DMs (`isGroup === false`). Group training is a more complex problem (multiple participants, reply threading) and is deferred.
- **Short ID collisions.** The 4-char hex short ID has 65,536 possible values. In practice the pending store is small (at most a handful of entries at a time), so collisions are extremely unlikely but not impossible. A newer message silently overwrites an older one with the same short ID.
- **No auto-send timer.** There is no "if the owner doesn't reply in N minutes, auto-send the draft" option. This is intentional — supervised mode requires explicit human approval.
- **Single workspace directory.** SOUL.md and MEMORY.md are resolved from a single workspace. Multi-agent or per-account workspace isolation is not yet supported.
- **Media replies.** When the agent produces a media attachment, the trainer intercept captures a placeholder description rather than the actual media. The owner can use `[msg-XXXX] your text` to send a custom text reply; approving the placeholder via `send XXXX` is blocked (`draftFailed: true`).
