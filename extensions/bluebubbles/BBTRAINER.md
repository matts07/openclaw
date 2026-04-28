# BBTrainer — Supervised Message Training for BlueBubbles

> Tracking issue: [openclaw/openclaw#72181](https://github.com/openclaw/openclaw/issues/72181)

## What Is This?

BBTrainer is an optional operating mode for the OpenClaw BlueBubbles channel
plugin. It sits between the raw iMessage webhook and the AI agent, intercepting
inbound direct messages before any LLM session is created. The owner receives
a forwarded copy of each message together with an AI-generated draft reply, and
can approve the draft, override it, or provide a correction — all through
iMessage. Nothing is ever sent to the original sender automatically.

The goal is two-fold:

1. **Supervised deployment** — keep a human in the loop on every response
   while still getting AI draft assistance, before fully trusting the agent to
   respond autonomously.
2. **Training data collection** — build a personal log of
   (message, my-actual-reply) pairs that can be written into `MEMORY.md` and
   used to tune the agent's voice over time.

---

## Why This Approach?

iMessage via BlueBubbles has no native "draft" or "approve before send"
affordance. The only control surface the owner has is their own phone. The
design therefore works entirely through iMessage itself:

- The owner's phone number (`trainerNotifyNumber`) receives a forwarded
  notification with the draft embedded inline.
- The owner replies with a simple command (`send XXXX` or
  `[msg-XXXX] custom text`) to the same number/thread.
- No external app, no web UI, no push service — just iMessage.

This means the owner can approve or correct responses from any device that has
iMessage, including Apple Watch, without installing anything new.

Draft generation routes through OpenClaw's model routing infrastructure via
`prepareSimpleCompletionModelForAgent` and
`completeWithPreparedSimpleCompletionModel` from
`openclaw/plugin-sdk/simple-completion-runtime`. This means whatever model the
owner has configured for the agent (Anthropic, OpenAI, Gemini, etc.) is used
— there is no hardcoded provider. SOUL.md (the agent's voice profile) is read
from the workspace directory and injected as a system prompt so the draft
sounds like the owner's voice.

---

## Modes

### `reply` (default)

No change to existing behaviour. Inbound messages are processed normally by the
agent. BBTrainer is completely inactive.

### `training`

Every inbound DM that passes the allowlist/dmPolicy gate is intercepted before
an agent session is created. The agent never sees the message.

1. A short-ID is derived from the last 4 hex chars of the message GUID.
2. A draft reply is generated via the agent's configured model with SOUL.md as
   the system prompt. Generation has a hard 10-second AbortController timeout.
3. A notification is sent to `trainerNotifyNumber`:

   ```
   📨 [msg-XXXX] From Alice: "hey, are you free tonight?"

   My draft: "Hey! Should be free after 7, what did you have in mind?"

   Reply "send XXXX" to approve my draft, or "[msg-XXXX] your version" to log a correction instead.
   ```

4. The pending entry is saved to the state store (JSON file, 6-hour TTL).
5. The owner has two choices — both log to `MEMORY.md`; nothing is sent to the
   original sender in either case:
   - `send XXXX` — logs the AI draft as approved (`Owner approved: "…"`).
   - `[msg-XXXX] Actually I'm busy tonight` — logs the correction
     (`Owner would have sent: "…"`).

### `supervised`

Identical to training but the owner can also approve sends:

- `send XXXX` — sends the AI draft to the original sender.
- `[msg-XXXX] custom text` — sends a custom reply to the original sender.

If the draft failed (no model configured, timeout, or empty response), `send
XXXX` is blocked with an explanatory notification in both modes — in supervised
mode it would deliver the error sentinel to the original sender, in training
mode it would log the sentinel as a training example. The owner must provide
custom text via `[msg-XXXX] your text`.

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

| Command                | Action                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| `send XXXX`            | Send AI draft (supervised) or log draft approval to MEMORY.md (training) |
| `[msg-XXXX] your text` | Send custom reply (supervised) or log correction to MEMORY.md (training) |
| `msg-XXXX your text`   | Same, without brackets                                                   |
| `msgXXXX your text`    | Same, without separator                                                  |

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

In supervised mode, when the owner approves the AI draft as-is (`send XXXX`),
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

Model credentials are resolved through OpenClaw's standard provider auth
system — configure them the same way as you would for any other agent.

---

## Architecture

### File Layout

```
extensions/bluebubbles/src/
  bbtrainer.ts               # All trainer logic (new file)
  bbtrainer.test.ts          # 45 unit/integration tests
  monitor-processing.ts      # Two intercept points added
  monitor.ts                 # Startup expiry sweep added
  types.ts                   # trainerMode/trainerNotifyNumber added to config type
  config-schema.ts           # Zod schema + cross-field validation added
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
   `📨 [msg-` prefix. BlueBubbles fires a webhook for every API-sent outgoing
   message without an `is_from_me` flag, so trainer notifications sent to the
   owner echo back as inbound webhooks. These reflected echoes are silently
   dropped here to prevent the agent from seeing its own notification text.
3. If neither condition matches, the message falls through to normal
   allowlist → agent handling.

**Late intercept (post-allowlist):**
Runs after `allowFrom` / `dmPolicy` checks pass. Intercepts inbound DMs from
non-owner senders in training/supervised mode. The conversation route is
resolved via `resolveBlueBubblesConversationRoute` (a pure config lookup) to
obtain the `agentId` used for model routing. The message is forwarded to the
owner and blocked from reaching the agent.

Both intercepts are DM-only (`isGroup === false`). Group chats are unaffected.

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
  late intercept ───── training or supervised mode? ──── YES ──► notify owner, return
      │
      NO
      ▼
  normal agent session
```

### Pending Store

Messages awaiting owner replies are serialised to JSON at:

```
$OPENCLAW_STATE_DIR/bluebubbles-trainer-pending.json
```

Schema:

```typescript
interface PendingMessage {
  id: string; // 4-char hex short ID
  from: string; // original sender phone number
  fromName?: string; // display name if available
  content: string; // original message text
  draft: string; // AI-generated draft (or sentinel if unavailable)
  draftFailed?: boolean; // true when draft could not be generated
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

### Draft Generation

`generateDraft()` routes through OpenClaw's model infrastructure:

- Model: resolved via `prepareSimpleCompletionModelForAgent` using the agent's
  configured provider/model (not hardcoded)
- Max tokens: 200
- Timeout: 10 seconds (AbortController)

The system prompt is assembled from three sources, in order:

1. **SOUL.md** — the owner's voice profile (if present)
2. **MEMORY.md interaction examples** — up to 5 past `(message → owner reply)`
   pairs selected from the most recent 30 log entries by word-overlap relevance
   to the current message. This is how the draft quality improves over time: as
   the log grows, the model sees increasingly representative examples of the
   owner's actual voice and uses them as few-shot guidance.
3. A generic "short friendly reply" fallback when neither file is present.

The relevance selection scores each candidate log entry by the number of
content words (>3 chars) it shares with the incoming message, then takes the
top 5, restored to chronological order before injection. When all entries score
zero (no topic overlap), the 5 most recent entries are used as general voice
examples — recency and relevance act as complementary signals.

**Exit signal:** as the log grows, watch whether the draft matches what you
would have sent without editing. When you're approving without modification most
of the time (in `training` mode), or approving sends as-is (in `supervised`
mode), the model has learned your voice well enough to consider switching to
`reply` mode.

If no model is configured for the agent, `draftFailed` is set to `true` and a
sentinel is stored in place of the draft. If generation throws (network error,
timeout, model error), `draftFailed` is also set to `true`. The `draftFailed`
flag blocks `send XXXX` in both modes — supervised (would deliver the sentinel
to the original sender) and training (would log the sentinel as a training
example). The owner receives a `⚠️ msg-XXXX: no draft available` notification
and must use `[msg-XXXX] their text` instead.

Some models wrap their response in surrounding quotation marks (e.g. `"Sure,
sounds good!"`). These are stripped with a Unicode-aware regex before the draft
is stored or sent.

### MEMORY.md Format

Training entries are appended under an `## Interaction Log` section using
direct `readFile`/`writeFile` on `path.join(workspaceDir, "MEMORY.md")`.
There is no SDK-level contract for plugin writes to workspace markdown files
— this is consistent with how `extensions/memory-core` handles its own
workspace file mutations. The `memory-host-markdown.ts` helper in the SDK is
a pure string transformer and is not exported as a plugin-callable entrypoint.

```markdown
## Interaction Log

- [2026-04-26T12:00:00.000Z] From Alice: "hey, are you free tonight?" | I drafted: "Should be around after 7!" | Owner would have sent: "I'm slammed this week sorry"
- [2026-04-26T12:15:00.000Z] From Carol: "quick question about tomorrow" | I drafted: "Sure, what's up?" | Owner approved: "Sure, what's up?"
- [2026-04-26T12:30:00.000Z] From Bob: "can we reschedule?" | I drafted: "Sure, when works for you?" | Owner sent: "Yep, Thursday afternoon?"
```

---

## Testing

```bash
pnpm test extensions/bluebubbles/src/bbtrainer.test.ts
```

45 tests covering:

| Suite                     | Cases                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseOwnerReply`         | send/custom/unknown, case normalisation, edge cases                                                                                                                                                                                                                                                                                                           |
| `resolveTrainerStateDirs` | env overrides, HOME fallback, missing HOME, config workspace fallback, env takes precedence over config                                                                                                                                                                                                                                                       |
| `expireTrainerPending`    | empty store, within-TTL, expired+notify, silent expiry                                                                                                                                                                                                                                                                                                        |
| `handleTrainerInbound`    | no notify number, no model configured, with draft, pending store write, SOUL.md injection, MEMORY.md example injection (relevance-scored), quote stripping, **never sends to original sender**                                                                                                                                                                |
| `handleTrainerOwnerReply` | unknown text, unknown shortId via send + via custom command, expired via send + via custom command, draftFailed guard (supervised + training), custom send bypasses draftFailed, supervised send, custom send, training correction (would have sent), training approval (approved verb), store cleanup, **training mode send guard**, echo texts return false |

The two **bolded** cases are explicit safety boundary tests: one proves only the
owner notify number is ever called by `handleTrainerInbound`; the other proves
that `send XXXX` in training mode consumes and logs the entry without forwarding
anything to the original sender.

The **unknown shortId** case verifies that a recognised command referencing a
non-existent (or already-processed) pending entry is consumed and the owner is
notified, rather than falling through to the agent session.

Tests use real temp directories (via `mkdtemp`) for the pending store and
workspace. `openclaw/plugin-sdk/simple-completion-runtime` is mocked at the
module level via `vi.mock`. `sendMessageBlueBubbles` is mocked at the module
level.

---

## Security

BBTrainer operates entirely within the owner's own gateway instance, consistent
with OpenClaw's personal assistant trust model. Key points:

- `trainerNotifyNumber` is a config value set by the owner — not user-supplied
  input.
- No new network endpoints are introduced; all communication uses the existing
  BlueBubbles `sendMessage` path.
- Draft generation goes through OpenClaw's standard provider auth system,
  subject to the same credential handling as any other agent call.
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
