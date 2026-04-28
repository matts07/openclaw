# BBTrainer — Supervised Message Training for BlueBubbles

> Tracking issue: [openclaw/openclaw#72181](https://github.com/openclaw/openclaw/issues/72181)

## What Is This?

BBTrainer is an optional operating mode for the OpenClaw BlueBubbles channel
plugin. When active, the agent runs a full session with all configured tools
— calendar, contacts, memory, everything — and drafts a reply exactly as it
normally would. The reply is then captured before delivery: the owner receives a
forwarded notification containing the original message and the agent's draft,
and can approve the draft, override it, or provide a correction — all through
iMessage. Nothing is ever sent to the original sender automatically.

The goal is two-fold:

1. **Supervised deployment** — keep a human in the loop on every response
   while still getting context-aware AI draft assistance, before fully trusting
   the agent to respond autonomously.
2. **Training data collection** — build a personal log of
   (message, my-actual-reply) pairs written into `MEMORY.md` to tune the
   agent's voice over time.

---

## Why This Approach?

iMessage via BlueBubbles has no native "draft" or "approve before send"
affordance. The only control surface the owner has is their own phone. The
design therefore works entirely through iMessage itself:

- The owner's phone number (`trainerNotifyNumber`) receives a notification with
  the agent's draft embedded inline.
- The owner replies with a simple command (`send XXXX` or
  `[msg-XXXX] custom text`) to the same number/thread.
- No external app, no web UI, no push service — just iMessage.

This means the owner can approve or correct responses from any device that has
iMessage, including Apple Watch, without installing anything new.

Because the agent runs a complete session before any capture occurs, the draft
reflects the full context the agent has: SOUL.md (the owner's voice profile)
and MEMORY.md (past interaction examples) are injected automatically by the
OpenClaw core runtime into every agent session — no special trainer setup
required. Calendar, contacts, and any other configured tools are also fully
available. The draft quality improves naturally as MEMORY.md grows.

An earlier approach intercepted messages before any agent session ran and
generated drafts through a stripped-down simple-completion call. That design
came up short because the draft had no tool access — it couldn't consult
calendar, contacts, or prior conversation state — producing responses that were
often contextually wrong in ways the agent would never make.

---

## Modes

### `reply` (default)

No change to existing behaviour. Inbound messages are processed normally by the
agent. BBTrainer is completely inactive.

### `training`

Every inbound DM that passes the allowlist/dmPolicy gate reaches the agent for
a full session. After the agent produces a reply, the send is captured:

1. A short-ID is derived from the last 4 hex chars of the message GUID.
2. The pending entry (original message + agent draft) is saved to the state
   store (JSON file, 6-hour TTL).
3. A notification is sent to `trainerNotifyNumber`:

   ```
   📨 [msg-XXXX] From Alice: "hey, are you free tonight?"

   My draft: "Hey! Should be free after 7, what did you have in mind?"

   Reply "send XXXX" to approve my draft, or "[msg-XXXX] your version" to log a correction instead.
   ```

4. The owner has two choices — both log to `MEMORY.md`; nothing is sent to the
   original sender in either case:
   - `send XXXX` — logs the agent draft as approved (`Owner approved: "…"`).
   - `[msg-XXXX] Actually I'm busy tonight` — logs the correction
     (`Owner would have sent: "…"`).

### `supervised`

Identical to training but the owner can also approve sends:

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

Replies that don't match either pattern fall through to normal agent session
handling, so the owner can still use the notify number as a regular chat
thread.

**Status notifications** sent back to the owner use the `⚠️ msg-XXXX:` prefix
(e.g. `⚠️ msg-ED86: unknown — no pending message with this ID.`). This format
deliberately does not match the command parser, so BlueBubbles webhook echoes of
these outgoing messages are silently dropped rather than triggering an infinite
notification loop.

---

## Configuration

Add to your `channels.bluebubbles` config (or per-account block):

```json
{
  "trainerMode": "supervised",
  "trainerNotifyNumber": "+12025550100"
}
```

| Key                   | Type                                    | Required              | Description                           |
| --------------------- | --------------------------------------- | --------------------- | ------------------------------------- |
| `trainerMode`         | `"reply" \| "training" \| "supervised"` | No                    | Default: `"reply"`                    |
| `trainerNotifyNumber` | E.164 string                            | Yes (if mode ≠ reply) | Phone number to receive notifications |

Schema validation enforces that `trainerNotifyNumber` is present whenever
`trainerMode` is not `"reply"`.

**`trainerNotifyNumber` is automatically allowlisted.** When trainer mode is
active (`training` or `supervised`), the gateway injects `trainerNotifyNumber`
into the effective `allowFrom` set at the allowlist gate. You do **not** need
to add the owner's number to `allowFrom` manually — doing so would be redundant
and could cause the owner's unrelated messages to be routed to the agent
session instead of falling through to normal handling.

### `agentTag`

In supervised mode, when the owner approves the agent draft as-is (`send XXXX`),
the message is prefixed with 🦞 before delivery. This makes AI-generated sends
visually distinct from owner-written custom replies. Owner-written custom
replies (`[msg-XXXX] your text`) are never tagged regardless of this setting.

| Key        | Type    | Default | Description                                              |
| ---------- | ------- | ------- | -------------------------------------------------------- |
| `agentTag` | boolean | `true`  | Prefix AI-generated sends with 🦞 (supervised mode only) |

### Environment Variables

| Variable                 | Default                 | Description                        |
| ------------------------ | ----------------------- | ---------------------------------- |
| `OPENCLAW_STATE_DIR`     | `~/.openclaw/state`     | Where the pending store JSON lives |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Where SOUL.md and MEMORY.md live   |

---

## Architecture

### File Layout

```
extensions/bluebubbles/src/
  bbtrainer.ts               # All trainer logic: pending store, owner reply handling, expiry, send interceptor
  bbtrainer.test.ts          # Tests: 57 covering shared utilities and send interceptor
  monitor-processing.ts      # Two intercept points + auto-allowlist injection
  monitor.ts                 # Startup expiry sweep
  types.ts                   # trainerMode/trainerNotifyNumber/agentTag in config type
  config-schema.ts           # Zod schema + cross-field validation
```

### Intercept Architecture

There are two intercept points in `processMessageAfterDedupe`:

**Early intercept (pre-allowlist):**
Checks whether the incoming message is from `trainerNotifyNumber`. This runs
before the allowlist gate because the owner's effective allowlist entry is
injected dynamically (see auto-allowlist above). Steps:

1. If the message is a recognised trainer command (`send XXXX` or
   `[msg-XXXX] …`), it is consumed here and never reaches the agent.
2. If not recognised as a trainer command, the text is checked for the
   `📨 [msg-` or `⚠️ msg-` prefixes. BlueBubbles fires a webhook for every
   API-sent outgoing message without an `is_from_me` flag, so trainer
   notifications sent to the owner echo back as inbound webhooks. These
   reflected echoes are silently dropped here to prevent the agent from seeing
   its own notification text.
3. If neither condition matches, the message falls through to normal
   allowlist → agent handling.

**Post-generation send intercept:**
Runs after the agent has completed its full session and produced a reply.
`createTrainerSendInterceptor` wraps the send function so that any outbound
message to the original sender is captured rather than delivered. Sends to
any other number (e.g. status messages to the owner) pass through unchanged.
The captured draft is stored as a pending entry and the owner is notified.

A `senderIsOwner` guard is applied before wrapping: if the original sender
is the notify number (digits-only comparison), the interceptor is skipped
entirely. This prevents owner messages processed by the agent from being
re-captured as if they were agent output to the owner.

Both intercepts are DM-only (`isGroup === false`). Group chats are unaffected.

### Bypass Route Guards

Three additional hard stops prevent the trainer from being circumvented:

1. **Media path in `monitor-processing.ts`** — media sends (attachments, voice) are intercepted _before_ the existing `if (mediaList.length > 0)` delivery path. Without this guard a media reply would escape the post-generation interceptor because the media code returns early. The captured draft is stored with `draftFailed: true` so the owner cannot accidentally approve-send the placeholder text; the notification instructs `[msg-XXXX] your text` as the only approval command.

2. **`channel.ts` `sendText` / `sendMedia` guards** — the channel's outbound adapter throws immediately in `training` or `supervised` mode. This closes the path where the agent uses the `message` tool (`action=send`) which routes through `deliverOutboundPayloads` → `channel.ts` entirely bypassing the `deliver` callback.

3. **Unconditional deliver entry log** — a `[bluebubbles/deliver]` log line fires at the very top of the `deliver` callback, before any trainer check. This records `trainerMode`, `isGroup`, sender, and outbound target even if the mode is unexpectedly `"reply"`, making any future bypass visible in logs without needing to reproduce the incident.

```
incoming message
      │
      ▼
  early intercept ──── is from trainerNotifyNumber? ──── YES ──► parse command
      │                                                              │
      NO                                               recognized ──► consumed
      │                                                              │
      │                                               unrecognized ──► 📨 or ⚠️ echo? ──► drop
      │                                                              │
      │                                               not echo ──────► fall-through
      ▼
  auto-allowlist injection (trainerNotifyNumber → configuredAllowFrom)
      │
      ▼
  dmPolicy / allowlist gate
      │
      ▼
  full agent session (all tools, SOUL.md + MEMORY.md via core runtime)
      │
      ▼
  post-generation send intercept ─── training or supervised? ──► capture draft
      │                                                              │
      NO                                                         store pending, notify owner
      │                                                              │
      ▼                                                          return (no delivery)
  normal send (reply mode)
```

### Pending Store

Messages awaiting owner replies are serialised to JSON at:

```
$OPENCLAW_STATE_DIR/bluebubbles-trainer-pending.json
```

Writes are atomic: the store is written to a `.tmp` sibling file and then
renamed into place, so a concurrent read never sees a partial write.

Schema:

```typescript
interface PendingMessage {
  id: string; // 4-char hex short ID
  from: string; // original sender phone number
  fromName?: string; // display name if available
  content: string; // original message text
  draft: string; // agent's captured reply draft
  draftFailed?: boolean; // true when the stored draft is a placeholder (e.g. media intercept); blocks "send XXXX" approval
  timestamp: number; // Unix ms
  mode: TrainerMode;
  expiresAt: number; // Unix ms (timestamp + DEFAULT_TTL_MS)
}
```

### TTL and Expiry

Pending messages expire after **6 hours** (`DEFAULT_TTL_MS`). Two expiry paths:

1. **On gateway startup** — `expireTrainerPending()` is called as a
   fire-and-forget alongside the catchup sweep. Any stale entries are deleted
   and the owner is notified with `⚠️ msg-XXXX: expired`.
2. **On owner reply** — `handleTrainerOwnerReply` checks `expiresAt` before
   acting. Expired entries are cleaned up inline and the owner is notified.

### Workspace Directory Resolution

`resolveTrainerStateDirs()` resolves `stateDir` and `workspaceDir` using the
following priority order:

| Directory      | 1st priority                 | 2nd priority                       | Fallback                |
| -------------- | ---------------------------- | ---------------------------------- | ----------------------- |
| `stateDir`     | `OPENCLAW_STATE_DIR` env     | —                                  | `~/.openclaw/state`     |
| `workspaceDir` | `OPENCLAW_WORKSPACE_DIR` env | `config.agents.defaults.workspace` | `~/.openclaw/workspace` |

The config fallback means SOUL.md and MEMORY.md are automatically resolved from
the same workspace the agent uses, with no extra environment variable required.

### MEMORY.md Format

Training entries are appended under an `## Interaction Log` section:

```markdown
## Interaction Log

- [2026-04-26T12:00:00.000Z] From Alice: "hey, are you free tonight?" | I drafted: "Should be around after 7!" | Owner would have sent: "I'm slammed this week sorry"
- [2026-04-26T12:15:00.000Z] From Carol: "quick question about tomorrow" | I drafted: "Sure, what's up?" | Owner approved: "Sure, what's up?"
- [2026-04-26T12:30:00.000Z] From Bob: "can we reschedule?" | I drafted: "Sure, when works for you?" | Owner sent: "Yep, Thursday afternoon?"
```

As the log grows, SOUL.md and MEMORY.md together form the agent's voice model.
The core runtime injects both files into every agent session automatically, so
draft quality improves with no additional configuration.

**Exit signal for supervised mode:** watch whether you're approving the draft
without modification most of the time. When that becomes the norm, the agent
has learned your voice well enough to switch to `reply` mode.

---

## Testing

```bash
pnpm test extensions/bluebubbles/src/bbtrainer.test.ts extensions/bluebubbles/src/channel.trainer.test.ts
```

**70 tests across two files:**

`bbtrainer.test.ts` (64 tests):

| Suite                                                            | Cases                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseOwnerReply`                                                | send/custom/unknown, case normalisation, edge cases                                                                                                                                                                                                                                                                          |
| `resolveTrainerStateDirs`                                        | env overrides, HOME fallback, missing HOME, config workspace fallback, env takes precedence over config                                                                                                                                                                                                                      |
| `expireTrainerPending`                                           | empty store, within-TTL, expired+notify, silent expiry                                                                                                                                                                                                                                                                       |
| `handleTrainerOwnerReply`                                        | unknown text, unknown shortId, expired entries, draftFailed guard, custom send bypasses draftFailed, supervised send, custom send, training correction (would have sent), training approval (approved verb), store cleanup, echo texts return false                                                                          |
| `createTrainerSendInterceptor — reply mode`                      | returns original send unwrapped, pending store remains empty                                                                                                                                                                                                                                                                 |
| `createTrainerSendInterceptor — supervised mode`                 | does not call originalSend, stores pending entry, correct fields, draftFailed not set, short ID derivation, expiresAt, notification format, approval command wording, sends to notifyNumber not sender, pass-through to owner thread, pass-through to third parties, notification failure is fire-and-forget, multiple sends |
| `createTrainerSendInterceptor — training mode`                   | does not call originalSend, pending mode field, `send XXXX` and `[msg-XXXX]` both mentioned in notification, 📨 prefix and draft included                                                                                                                                                                                    |
| `createTrainerSendInterceptor — no notifyNumber`                 | passes send through when notifyNumber is empty                                                                                                                                                                                                                                                                               |
| `createTrainerSendInterceptor — forceDraftFailed`                | draftFailed=true stored, media notification text uses "Agent wanted to send", no "send XXXX" approval path, no delivery to sender, training mode stores draftFailed                                                                                                                                                          |
| `createTrainerSendInterceptor — notification failure resilience` | AbortError retried once then recorded as notificationFailed, second message still intercepted after first notification AbortErrors, pending entry saved even when notification throws non-AbortError                                                                                                                         |

`channel.trainer.test.ts` (6 tests):

| Suite                                                        | Cases                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `bluebubblesPlugin.outbound.attachedResults — trainer block` | sendText throws in training/supervised, passes in reply; sendMedia throws in training/supervised, passes in reply |

Tests use real temp directories (via `mkdtemp`). `sendMessageBlueBubbles` is
mocked at the module level.

---

## Security

BBTrainer operates entirely within the owner's own gateway instance, consistent
with OpenClaw's personal assistant trust model. Key points:

- `trainerNotifyNumber` is a config value set by the owner — not user-supplied
  input.
- No new network endpoints are introduced; all communication uses the existing
  BlueBubbles `sendMessage` path.
- The pending store is a local JSON file in `OPENCLAW_STATE_DIR`, accessible
  only to the gateway process.

---

## Known Limitations & Future Work

- **Group chat support is intentionally excluded.** The intercept only fires on
  DMs (`isGroup === false`). Group training is a more complex problem (multiple
  participants, reply threading) and is deferred.
- **Short ID collisions.** The 4-char hex short ID has 65,536 possible values.
  In practice the pending store is small (at most a handful of entries at a
  time), so collisions are extremely unlikely but not impossible. A newer
  message would overwrite an older one with the same short ID.
- **No auto-send timer.** There is no "if the owner doesn't reply in N minutes,
  auto-send the draft" option. This is intentional — supervised mode requires
  explicit human approval.
- **Single workspace directory.** SOUL.md and MEMORY.md are resolved from a
  single workspace (env `OPENCLAW_WORKSPACE_DIR` → `config.agents.defaults.workspace`
  → `~/.openclaw/workspace`). Multi-agent or per-account workspace isolation is
  not yet supported.
