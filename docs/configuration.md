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
OPENROUTER`. To pin a single provider instead:

```bash
KOOKR_LLM_PROVIDER=openrouter        # openrouter | groq | gemini | anthropic | auto
KOOKR_LLM_MODEL=deepseek/deepseek-v4-flash
KOOKR_LLM_BASE_URL=https://openrouter.ai/api/v1
```

**OpenRouter** is an OpenAI-compatible paid provider; Kookr defaults it to
`deepseek/deepseek-v4-flash`. `KOOKR_OPENROUTER_API_KEY` is preferred over
`OPENROUTER_API_KEY` so a separate OpenRouter credit limit can be scoped to
Kookr. `KOOKR_LLM_MODEL` and `KOOKR_LLM_BASE_URL` apply to the OpenRouter
provider. See [Environment Variables](reference/environment-variables.md#llm-provider)
for the full list.

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

See [Environment Variables](reference/environment-variables.md) for every supported `KOOKR_*`, speech, Telegram, checkpointing, and diagnostic variable.
