# Configuration

Kookr starts with optional features disabled. For local configuration, copy `.env.example` to `.env` and uncomment only the values you need.

The complete variable reference is [Environment Variables](reference/environment-variables.md). This page explains the common choices.

## Server

Most users can keep the defaults:

```bash
KOOKR_HOST=127.0.0.1
KOOKR_PORT=4800
```

`pnpm dev` overrides the backend port to `4801` so it does not collide with a stable production-style instance on `4800`.

State directory:

- Port `4800`: `~/.kookr/`
- Other ports: `~/.kookr-<port>/`

## AI Suggestions

AI task naming, response suggestions, and remote-chat rephrase run through a
configurable LLM provider. Set any one provider key to enable them:

```bash
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
KOOKR_OPENROUTER_API_KEY=sk-or-...   # or OPENROUTER_API_KEY
```

By default (`KOOKR_LLM_PROVIDER` unset, i.e. `auto`), Kookr chains every
configured provider for fallback in the order `GROQ > GEMINI > ANTHROPIC >
OPENROUTER`. Requesty and Baseten are not part of `auto`; select either
explicitly when you want helper LLM calls routed through that gateway. To pin a
single provider:

```bash
KOOKR_LLM_PROVIDER=openrouter        # openrouter | requesty | baseten | groq | gemini | anthropic | auto
KOOKR_LLM_MODEL=deepseek/deepseek-v4-flash
KOOKR_LLM_BASE_URL=https://openrouter.ai/api/v1
```

**OpenRouter** is an OpenAI-compatible paid provider; Kookr defaults it to
`deepseek/deepseek-v4-flash`. `KOOKR_OPENROUTER_API_KEY` is preferred over
`OPENROUTER_API_KEY` so a separate OpenRouter credit limit can be scoped to
Kookr. `KOOKR_LLM_MODEL` and `KOOKR_LLM_BASE_URL` apply to the OpenRouter
provider. See [Environment Variables](reference/environment-variables.md#llm-provider)
for the full list.

**Requesty** is an OpenAI-compatible paid gateway and is explicit-only:

```bash
KOOKR_LLM_PROVIDER=requesty
KOOKR_REQUESTY_API_KEY=req_...       # or REQUESTY_API_KEY
KOOKR_REQUESTY_MODEL=openai/gpt-4o-mini
```

Requesty model ids use provider prefixes such as `openai/gpt-4o-mini`.
`KOOKR_REQUESTY_MODEL` applies only to Requesty; `KOOKR_LLM_MODEL` and
`KOOKR_LLM_BASE_URL` remain OpenRouter-only.

**Baseten** exposes OpenAI-compatible Model APIs and is explicit-only:

```bash
KOOKR_LLM_PROVIDER=baseten
KOOKR_BASETEN_API_KEY=...             # or BASETEN_API_KEY
KOOKR_BASETEN_MODEL=nvidia/Nemotron-120B-A12B
```

Baseten defaults to model `nvidia/Nemotron-120B-A12B` at
`https://inference.baseten.co/v1` (override with `KOOKR_BASETEN_BASE_URL`).
`KOOKR_BASETEN_API_KEY` is preferred over `BASETEN_API_KEY` so a Kookr-scoped
credential can be kept separate. `KOOKR_BASETEN_MODEL` applies only to Baseten.

Without any provider key, Kookr still works. It falls back to truncated prompt
names and omits AI suggestions.

> These LLM provider settings are independent of the local speech-to-text and
> text-to-speech models. Voice transcription and synthesis are configured
> separately under [Speech IO](reference/environment-variables.md#speech-io)
> (`KOOKR_STT*`, `KOOKR_TTS*`, `WHISPER_*`) and are not affected by
> `KOOKR_LLM_PROVIDER`.

## Agent Binaries

Override agent binaries when they are not on `PATH`:

```bash
KOOKR_AGENT_BIN=claude
KOOKR_CODEX_BIN=codex
```

Kookr injects its toolkit plugin into spawned Claude Code sessions by default. Override or disable that path with:

```bash
KOOKR_PLUGIN_DIR=/path/to/plugin
KOOKR_PLUGIN_DIR=
```

An empty `KOOKR_PLUGIN_DIR` disables plugin injection for hermetic sessions.

## Permission Bypass

Permission bypass is off by default. Enable it only for controlled local runs:

```bash
KOOKR_BYPASS_ALL_PERMISSIONS=true
```

When enabled, Kookr launches spawned agents with provider-specific bypass flags:

- Claude Code: `--dangerously-skip-permissions`
- Codex CLI: `--dangerously-bypass-approvals-and-sandbox`

These remove important safeguards. Prefer normal permission prompts for day-to-day work.

## Speech IO

Speech-to-text (STT) and text-to-speech (TTS) are optional.

Bundled services:

```bash
KOOKR_STT=true
KOOKR_TTS=true
```

Bundled TTS uses `KOOKR_TTS_DEVICE=auto` by default. On hosts with the
NVIDIA Docker runtime, Kookr applies the GPU compose override so Pocket TTS
can use CUDA; otherwise it stays on CPU. Set `KOOKR_TTS_DEVICE=cpu` or
`KOOKR_TTS_DEVICE=gpu` to force either mode.

External services:

```bash
KOOKR_STT_URL=ws://127.0.0.1:8003
KOOKR_TTS_URL=http://127.0.0.1:8004
```

The bundled STT stack downloads a Whisper model on first boot. Defaults are roughly `150 MB` for CPU (`base`) or about `3 GB` for GPU (`large-v3`).

Useful overrides:

```bash
KOOKR_STT_DEVICE=auto
KOOKR_STT_DEVICE=cpu
KOOKR_STT_DEVICE=gpu
KOOKR_STT_HEALTH_TIMEOUT_S=600
```

Recording the demo video also requires a color emoji font and `ffmpeg >=5.0`; Docker is needed only when recording with bundled TTS.

## Telegram Remote Chat

Telegram is disabled unless all required allowlists are present:

```bash
KOOKR_TELEGRAM_BOT_TOKEN=...
KOOKR_TELEGRAM_ALLOWED_USERS=123456789
KOOKR_REMOTE_CHAT_PROJECTS=/path/to/project-a,/path/to/project-b
```

Set a phone-reachable dashboard origin when Telegram messages should open the
Kookr dashboard from another device:

```bash
KOOKR_REMOTE_CHAT_DASHBOARD_URL=https://kookr.example.com
```

Use dry run mode to validate parsing without launching tasks:

```bash
KOOKR_REMOTE_CHAT_DRY_RUN=1
```

Use the panic switch to disable the integration even if other variables are set:

```bash
KOOKR_REMOTE_CHAT_DISABLED=1
```

## Outbound Finding Webhooks

Set a generic HTTP receiver URL to POST each new attention finding as JSON:

```bash
KOOKR_WEBHOOK_URL=https://example.com/kookr-findings
KOOKR_WEBHOOK_MIN_SEVERITY=warning
KOOKR_WEBHOOK_SECRET=change-me
```

`KOOKR_WEBHOOK_MIN_SEVERITY` is optional and accepts `info`, `warning`, or `critical`.
Repeated re-enqueues of the same finding fingerprint are deduplicated until the
finding resolves; see [Delivery behavior](#delivery-behavior) for the full
receiver contract.

Per-project routing can override whether the outbound finding webhook fires and
the minimum severity for that project:

```json
{
  "project": "github.com/kookr-ai/kookr",
  "webhook": {
    "enabled": true,
    "minSeverity": "critical"
  }
}
```

If a project omits `webhook`, Kookr falls back to `KOOKR_WEBHOOK_MIN_SEVERITY`.
If `webhook.enabled` is `false`, findings for that project are not posted. The
webhook receiver URL and signing secret remain env-only; project settings store
only `enabled` and `minSeverity`.

### Payload body schema

Each POST body is a single JSON object versioned by `schemaVersion`. The current
version string is `kookr.finding.webhook.v1` (the source of truth is
`WEBHOOK_PAYLOAD_SCHEMA_VERSION` and `WebhookFindingPayload` in
[`src/integrations/webhook/index.ts`](../src/integrations/webhook/index.ts)).
Receivers should switch on `schemaVersion` and `event`, ignore unknown fields
for forward compatibility, and treat every optional field as possibly absent.

Top-level fields:

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | string | yes | Payload contract version. Currently the literal `kookr.finding.webhook.v1`. |
| `event` | string | yes | Event discriminator. Currently the literal `finding.admitted` (a finding entered the active attention queue). |
| `fingerprint` | string | yes | Stable dedupe key for this finding. Repeated values are the same logical finding; treat delivery as an idempotent no-op. |
| `sentAt` | string | yes | ISO 8601 timestamp of when Kookr sent this POST. |
| `dashboardUrl` | string | no | Absolute link to the finding in the dashboard. Present only when a dashboard base URL is configured. |
| `finding` | object | yes | The finding details (see below). |
| `task` | object | no | The originating task (see below). Present only when the finding maps to a known task. |

`finding` object:

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `agentId` | string | yes | Session/agent identifier the finding was raised for. |
| `type` | string | yes | Anomaly type (see [Findings Reference](reference/findings.md)), e.g. `needs_input`, `stale_agent`. |
| `severity` | string | yes | One of `info`, `warning`, `critical`. |
| `explanation` | string | yes | Human-readable, per-instance explanation of the finding. |
| `detectedAt` | string | yes | ISO 8601 timestamp of when the anomaly was detected. |
| `count` | number | no | Occurrence count for repeated anomalies, when applicable. |
| `subType` | string | no | Finer classification for some types, e.g. `stop` or `ask_user_question`. |
| `confidence` | string | no | Detection confidence: `high`, `medium`, or `low`. |
| `eventId` | string | no | Correlation id, matching the `correlationId` accepted by the delivery-trace endpoint. |

`task` object:

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Task identifier. |
| `name` | string | no | Human-friendly task name, when set. |
| `prompt` | string | yes | The task's prompt text. |
| `cwd` | string | yes | Working directory the task runs in. |
| `status` | string | yes | Task status: one of `open`, `pending`, `inProgress`, `completed`, `terminated`, `cancelled`. |

Example body:

```json
{
  "schemaVersion": "kookr.finding.webhook.v1",
  "event": "finding.admitted",
  "fingerprint": "sess-42:needs_input:abc123",
  "sentAt": "2026-01-15T09:24:31.000Z",
  "dashboardUrl": "http://127.0.0.1:4801/#/agent/sess-42",
  "finding": {
    "agentId": "sess-42",
    "type": "needs_input",
    "severity": "warning",
    "explanation": "Agent is asking a question and waiting for a reply.",
    "detectedAt": "2026-01-15T09:24:30.000Z",
    "subType": "ask_user_question",
    "confidence": "high",
    "eventId": "evt-7f3c"
  },
  "task": {
    "id": "task-99",
    "name": "Refactor auth module",
    "prompt": "Refactor the auth module to use the new token store.",
    "cwd": "/path/to/project",
    "status": "inProgress"
  }
}
```

### Delivery behavior

Kookr posts each new finding with the retry defaults from
`DEFAULT_MAX_ATTEMPTS` and `DEFAULT_INITIAL_RETRY_DELAY_MS`: 3 attempts with
exponential backoff starting at 1 second, then 2 seconds before the final
attempt. Network errors and non-2xx responses outside the 4xx range are retried
until the attempt budget is exhausted.

Any 4xx response from the receiver is treated as permanent for that finding
delivery and stops retrying immediately. Kookr sends the request with
`redirect: 'manual'`, so receiver redirects are not followed. A 3xx response is
evaluated as the response Kookr received and is retried according to the same
non-4xx failure path.

Duplicate suppression is keyed by `agentId:fingerprint`. Once a finding reaches
the webhook delivery path, later re-enqueues with the same key are suppressed
until the finding resolves and Kookr clears that fingerprint. Receivers should
still treat repeated `fingerprint` values as idempotent no-ops, because
operator restarts or future delivery implementations may replay the same logical
finding.

Delivery decisions are visible through the owner diagnostics endpoint:

```bash
curl http://127.0.0.1:4801/api/diagnostics/delivery-trace
curl 'http://127.0.0.1:4801/api/diagnostics/delivery-trace?correlationId=<event-id>'
```

The trace is a bounded in-memory tail. It records server-observable finding
queue admission/suppression decisions and outbound webhook attempts/results,
including webhook routing suppressions such as disabled project routing,
minimum severity, and duplicate delivery fingerprint hashes. Browser desktop
notification display, hosted relay/web-push outcomes, and Telegram inbound
audit are not included until those channels report server-visible delivery
outcomes.

`KOOKR_WEBHOOK_SECRET` is optional. When set, Kookr signs each POST with:

```text
X-Kookr-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
```

For rotation, set a comma-separated list such as `new-secret,old-secret`. Kookr
signs with the first configured secret; receivers should verify the signature
against any currently accepted secret and reject timestamps outside a short
replay window, for example five minutes.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyKookrWebhook(body: string, header: string, secrets: string[]): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  if (!/^[0-9a-f]{64}$/i.test(parts.v1 ?? '')) return false;

  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret)
      .update(`${parts.t}.${body}`)
      .digest('hex');
    return timingSafeEqual(Buffer.from(parts.v1 ?? '', 'hex'), Buffer.from(expected, 'hex'));
  });
}
```

## Production-Style Instance

`pnpm prod:setup` creates a sibling `../kookr-prod` worktree. The dev checkout's `.env` is symlinked into that worktree, so runtime configuration stays in one place.

After editing `.env`:

```bash
pnpm prod:restart
```

After pulling or building new code:

```bash
pnpm prod:update
```

## Full Reference

See [Environment Variables](reference/environment-variables.md) for every supported `KOOKR_*`, speech, Telegram, and diagnostic variable.
