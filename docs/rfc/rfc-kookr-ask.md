# RFC: `kookr ask` — agent-to-operator multiple-choice questions over Telegram

**Status:** Draft (v2 — post-review revision)
**Date:** 2026-11-09
**Author:** Jean Ibarz (with Claude)

---

## Problem

Kookr's Telegram integration only carries traffic one way for *commands*: the
operator can spawn tasks and reply to notifications, and Kookr pushes
permission-block alerts and outcome notifications. There is no way for a running
agent (or a supervisor agent) to **ask the operator a question with options and
get the answer back**. `kookr signal completion-ready` is the only agent→user
signal and carries no question; `kookr reply` goes user→agent. Operators are
often away from the terminal and need to unblock agents from a phone.

## Requirements

1. An agent runs `kookr ask --question … --option … [--option …]` and the
   operator receives a Telegram message with one inline button per option.
2. The operator's choice (button tap, or a free-text reply to the message) is
   recorded once and delivered to the asking task's live session as an ordinary
   terminal reply, so it works for any agent type (Claude Code, Codex, Grok,
   opencode).
3. The CLI is non-blocking by default (prints the ask id); `--wait` polls until
   answered/expired and prints the chosen label with distinct exit codes.
4. Only allowlisted Telegram users can answer; callbacks are HMAC-bound to
   (ask id, option index, per-ask nonce); stale, duplicate, forged, wrong-chat
   callbacks are rejected and audited.
5. Feature is inert unless Telegram is configured. No new outbound hosts, no
   tokens in argv or logs, question/context text is credential-scrubbed.
6. Task liveness: an answer for a task that is gone is not delivered blindly;
   the operator is told on Telegram. Expiry edits the message and notifies the task.

## Design

### Contract (`src/shared/contracts/asks.ts`)

```ts
type AskState = 'pending' | 'answered' | 'expired' | 'cancelled';
interface AskRecord {
  id: string;            // 12 hex chars (fits Telegram's 64-byte callback_data)
  taskId: string;
  question: string; context?: string; options: string[]; allowText: boolean;
  state: AskState; createdAt: number; expiresAt: number;
  nonce: string;         // per-ask random, mixed into the callback HMAC; never sent to Telegram
  idempotencyKey?: string;
  delivery?: { chatId: number; messageId: number };   // the Telegram message
  answer?: { kind: 'option'; index: number; label: string } | { kind: 'text'; text: string };
  answeredAt?: number; answeredBy?: number;
  resolution?: 'answered' | 'expired' | 'cancelled' | 'task_gone' | 'delivery_failed';
  taskDelivery?: 'delivered' | 'failed' | 'skipped';
}
```

### Store + service (`src/server/asks/`)

* `ask-store.ts`: durable JSON at `<kookrDir>/asks/asks.json`, mode 0600, atomic
  write (tmp + rename), serialised through a promise chain. Terminal asks are
  pruned after 7 days. A per-install HMAC secret lives in `<kookrDir>/asks/secret`
  (32 random bytes, mode 0600, created on first use).
* `ask-service.ts`: owns the state machine and all policy. Injected ports:
  `notifier` (Telegram), `taskLiveness(taskId)`, `deliverToTask(taskId, text)`,
  `now()`. Methods: `create`, `get`, `list`, `cancel`, `answer`, `findByMessage`,
  `sweepExpired`, `callbackData(ask, idx)`.
* State machine: `pending → answered | expired | cancelled`. Every transition is
  a compare-and-set on `state === 'pending'` inside the store's serialised
  section, so concurrent taps yield exactly one winner; losers get
  `already_answered`.
* Limits (constants, not env vars): ≤4 options (Telegram rows stay legible),
  label ≤48 chars, question ≤600, context ≤1500, ≤3 pending per task, ≤6 asks
  per task per hour, ≤20 asks/hour globally, timeout default 30 min, max 24 h.
* Idempotency: `(taskId, idempotencyKey)` returns the existing ask (HTTP 200,
  `deduped: true`) instead of creating a second Telegram message.
* Scrubbing: question/context pass through `redactCredentials` (existing
  conservative detector; false positives acceptable). A redacted field is
  replaced by the sentinel and the response lists `redacted: [...]` so the agent
  can rephrase. An option label that would be redacted is rejected (422).
* Liveness on answer: the service asks `taskLiveness`; if the task is gone or
  terminal the ask becomes `cancelled/task_gone`, **nothing is typed into any
  session**, and the Telegram message is edited to say so.
* Delivery text: `Operator answered ask <id>: <label>` (or `… (free text): <text>`),
  via the existing `TelegramTaskBridge.sendText` → `submitMessage` path.
* Expiry: a 30 s unref'd sweeper plus lazy check on read. On expiry the message
  is edited to "expired" and the task is told `Ask <id> expired with no answer`.
  Sweeper also runs once at boot so restarts do not leave pending asks forever.

### HTTP API

`POST /api/asks`, `GET /api/asks` (`?taskId=&state=`), `GET /api/asks/:id`,
`POST /api/asks/:id/cancel`. Documented in `docs/reference/api.md`. There is
deliberately **no** HTTP answer route: the only answer channel is the
authenticated Telegram path, so an agent cannot answer its own question.
When Telegram is not configured, `POST` returns `503 { code: "not_configured" }`
and creates nothing (flag-off behaviour unchanged, pinned by a test).

### Telegram

* `TelegramHandle` gains `sendAsk` / `editAsk` (the notifier). The chat is
  `origin[taskId]` if the task was remote-spawned, else the first user in
  `KOOKR_TELEGRAM_ALLOWED_USERS` (a private chat id equals the user id).
* Message: `❓ Task <name/id> asks:\n<question>\n\n<context>`; one button per
  option; footer "Or reply to this message with text" when `allowText`.
* Callback data `ask:<id>:<idx>:<mac>`, `mac = HMAC-SHA256(secret,
  id|idx|nonce)` truncated to 16 hex chars, compared in constant time.
* `handleCallback` checks, in order: allowlisted sender, rate limit, MAC,
  ask exists, `state === pending`, callback's message chat+id equals
  `ask.delivery`. Then `service.answer`. The message is edited to show the
  chosen option (keyboard removed) and the callback is answered with a toast.
* Free text: a reply-to on the ask's message (allowlisted sender, same chat)
  is an answer of kind `text`, checked before the generic notification reply
  routing.
* Audit kinds: `ask_sent`, `ask_answered`, `ask_rejected` (reason: forged,
  stale, duplicate, wrong_chat, unauthorized, task_gone), `ask_expired`,
  `ask_delivery_failed`. Question text is never put in the audit log.

### CLI (`src/cli/kookr-ask.ts`, dispatched from `bin/kookr.js`)

```
kookr ask --question "<text>" --option "<label>" [--option …] [--context "<text>"]
          [--timeout <dur>] [--task-id <uuid>] [--no-other] [--wait[=<s>]] [--json]
```

Default task is `KOOKR_TASK_ID`. A random idempotency key is generated per
invocation so one network retry is safe. Without `--wait`: prints the ask id,
exit 0. With `--wait`: polls `GET /api/asks/:id` (2 s) until terminal and
prints the label. Exit codes: 0 answered/created, 2 user error, 3 no server,
4 server rejected, 5 expired, 6 cancelled, 7 not configured. `--wait` with no
value waits until the ask's own expiry.

### Agent guidance

A plugin skill `asking-the-operator` (when to ask, 2–4 concrete options, one
open ask at a time, don't spam, prefer `--wait` only when nothing else can
proceed) with a `plugin.json` version bump. Documented in `docs/reference/`.

## Slices

1. RFC (this doc). 2. Contract + store + service + routes + docs (no Telegram,
tested with a fake notifier). 3. CLI. 4. Telegram notifier + callback + text
reply + wiring + audit. 5. Skill/doc + live proof with the fake Telegram server.
Each slice ships through the full gate and an independent exact-head review.
Slices 2–3 are inert on their own (503 without a notifier), so any prefix is
safe to ship.

## Files to change

`src/shared/contracts/asks.ts`, `src/server/asks/*`, `src/server/routes/ask-routes.ts`
(+ `routes.ts` / `index.ts` wiring), `src/shared/contracts/telegram.ts`,
`src/integrations/telegram/{index,audit}.ts`, `src/server/bootstrap/start-remote-chat-trigger.ts`,
`src/cli/kookr-ask.ts`, `bin/kookr-ask.js`, `bin/kookr.js`, `docs/reference/{api,cli}.md`,
`plugin/skills/asking-the-operator/SKILL.md`, `plugin/.claude-plugin/plugin.json`.

## Edge cases

* Server restart while pending: store reloads; sweeper expires overdue asks;
  the old Telegram buttons still verify (secret persisted).
* Telegram send fails: ask becomes `cancelled/delivery_failed`, API returns 502.
* Double tap / two phones: CAS gives one winner; the other gets "already answered".
* Task completes while pending: next answer hits the liveness check; the
  sweeper does not cancel eagerly (kept simple).
* Task live but delivery throws: answer is still recorded (`taskDelivery:
  failed`) and the operator is told; `--wait` still returns the label.
* Operator replies with text but `allowText` false: ignored with a hint.
* Callback from the right user but a different chat/message: `wrong_chat`.

## Alternatives considered

* **HTTP answer endpoint** — rejected; lets the asking agent self-answer.
* **Telegram `getUpdates` in the CLI** — rejected; the server already owns the
  single poller (lock-protected) and the token must not reach agents.
* **Reusing `sentNotifications` for correlation** — rejected for buttons (needs
  the nonce/MAC and durable state with a 7 day life vs 24 h), but the free-text
  path mirrors it.
* **Blocking-only CLI** — rejected; agents usually have other work to do.
* **Dashboard pending-ask panel** — deferred; not required for slice 1.

## Critic feedback incorporated

Round 1 (failure-mode-analyst, design-minimalist, delivery-pragmatist; one round
only because the operator asked for autonomous delivery, so the usual 3 rounds
and the consensus attack were not run — recorded as a deliberate scope cut).

Incorporated:

* Boot reconciliation: a `pending` ask with no `delivery` can only be a crash
  between "stored" and "sent"; it is cancelled (`delivery_failed`) at start.
* Idempotency matches only a **pending** ask. The CLI default key is a hash of
  (task, question, options) so an agent re-running the command after a tool
  timeout does not post a second message; an explicit key overrides it.
* Expiry notices to the task are sent only when fresh (<5 min after expiry) and
  only if the task is non-terminal, so a restart does not type a burst of stale
  notices into sessions that moved on.
* Callback order: allowlist → rate limit → strict pattern
  `^ask:[0-9a-f]{12}:[0-3]:[0-9a-f]{16}$` → lookup → MAC → state → chat/message
  binding → private-chat check; each failure has its own audit reason. The ask
  branch sits before the legacy spawn-confirmation `hash:y|n` fallthrough.
* The Telegram send path and the callback handler ship in the same slice, so no
  prefix of the delivery plan sends buttons that do nothing.
* Docs are assigned per slice: `api.md` with the routes, `cli.md` with the CLI,
  the skill + `plugin.json` bump only after the Telegram slice. No env vars are
  added (limits are constants). `KOOKR_REMOTE_CHAT_DISABLED=1` is the kill
  switch; reverting leaves asks that simply expire.
* `asks.json` carries `schemaVersion`; unknown fields are tolerated.
* Free-text answers are capped at 1000 chars.

Rejected / accepted as limits (stated in the RFC rather than engineered away):

* **Trust boundary.** The answer reaches the agent as terminal text, which is
  the requirement (works for any agent type). Anything that can type into that
  session, or read `<kookrDir>/asks/` as the same OS user, can forge the same
  string; the HMAC protects the Telegram side only. The authoritative record is
  the server's `GET /api/asks/:id` (what `--wait` prints). The skill tells
  agents so. Not engineered away: a same-user agent is already inside the
  trust boundary (it can run `kookr reply` and edit files too).
* **API is not per-task scoped** (no per-task credential exists today); the API
  is loopback/bearer protected like the rest of `/api/*`.
* **Session pinning** (deliver only to the session alive at ask time) is
  deferred; a late relaunch could receive the typed answer. The record still
  shows `taskDelivery`.
* **Double delivery with `--wait`** (typed notice + stdout): accepted, both
  carry the same label; the skill says to treat them as one answer.
* HMAC + nonce kept despite the minimalist's note: the operator asked for
  per-install-signed callbacks, and the stored message binding alone would not
  stop a forged callback replayed from another chat of the same user.
* Cut list/cancel routes, extra counters: kept — required by the operator brief.

Ambition vs minimalism: no ambition-amplifier was run; scope follows the brief.
