# RFC: Requesty LLM Gateway Provider

## Status

**Draft (v2 - post-review revision)**

## Date

2026-06-06

## Author

Jean Ibarz (with Codex)

---

## Problem

Kookr already uses a provider-neutral LLM boundary for low-risk helper features:

- AI task naming (`src/core/task-naming.ts`)
- AI response suggestions (`src/core/response-suggest.ts`)
- Telegram remote-chat rephrase
- finding-evidence review diagnostics and background sampling when explicitly enabled

The current provider factory supports Groq, Gemini, Anthropic, and OpenRouter. OpenRouter is implemented as a direct OpenAI-compatible Chat Completions HTTP client, but the configuration is named around OpenRouter rather than the broader class of OpenAI-compatible gateways.

Requesty is an API gateway with an OpenAI-compatible endpoint at `https://router.requesty.ai/v1`. Requesty's documentation shows standard Chat Completions requests under `/v1/chat/completions` and provider-prefixed model ids such as `openai/gpt-4o-mini`, `openai/gpt-4o`, and `anthropic/claude-sonnet-4-20250514`.

This is a close fit for Kookr's existing OpenRouter transport shape, but today a user cannot explicitly select Requesty or configure a Requesty-scoped key. Pretending Requesty is OpenRouter through `KOOKR_LLM_BASE_URL` works only as an undocumented escape hatch and produces misleading provider names, logs, docs, and fallback behavior.

Requesty references used for this RFC:

- https://docs.requesty.ai/
- https://docs.requesty.ai/frameworks/openai
- https://docs.requesty.ai/api-reference/overview
- https://docs.requesty.ai/api-reference/inference-apis
- https://docs.requesty.ai/api-reference/endpoint/chat-completions-create

## Requirements

- Kookr SHALL support `KOOKR_LLM_PROVIDER=requesty`.
- Kookr SHALL keep the existing `LlmClient` consumer interface unchanged.
- Kookr SHALL keep Requesty explicit-only in v1. `auto` provider selection SHALL preserve the existing order and SHALL NOT include Requesty.
- Kookr SHALL support a Requesty-scoped API key without requiring OpenRouter key variables.
- Kookr SHALL call Requesty's OpenAI-compatible Chat Completions endpoint at `https://router.requesty.ai/v1/chat/completions`.
- Kookr SHALL allow users to override the Requesty model with a Requesty-scoped model variable.
- Kookr SHALL preserve existing OpenRouter behavior and environment variable compatibility.
- Kookr SHALL document provider selection, model naming, data sent to the provider, and Requesty setup in the user-facing configuration docs and environment-variable reference.
- Kookr SHALL keep failures non-fatal: missing Requesty configuration returns no client, and runtime Requesty failures degrade through the existing caller behavior.

## Non-goals

- Do not add Requesty to `auto` fallback.
- Do not add Requesty-specific analytics UI, cost reporting, routing-policy management, or model catalog browsing.
- Do not migrate existing Groq, Gemini, Anthropic, or OpenRouter users.
- Do not change task-name, response-suggestion, rephrase, or finding-review prompts.
- Do not use Requesty for agent execution. This RFC covers Kookr's internal helper LLM calls only, not Claude Code or Codex CLI sessions.
- Do not use Requesty for speech STT/TTS.
- Do not require Requesty for local-first Kookr usage.

## Data Sent Through Requesty

When `KOOKR_LLM_PROVIDER=requesty`, runtime provider construction routes through `createLlmClient()` and feature modules receive a provider-neutral `LlmClient`. The following current consumers can therefore route through Requesty:

- `task-naming`: task prompt, cwd, optional success criteria.
- `response-suggest`: the paused agent's last assistant message, task prompt, cwd, and recent tool names.
- remote-chat rephrase: the remote chat message and task context used by the existing rephrase path.
- finding-evidence review diagnostics: finding evidence, task/session context, and sampled diagnostic text, only when the existing finding-review feature flags enable that path.
- speech summary / agent speak helpers: task name, status, and selected activity context used by the existing summary prompt.
- task-relation inference: bounded parent/child prompt heads when the relation inference caller provides an LLM client for ambiguous task relationships.

This RFC does not add new LLM consumers. It only changes which configured provider can serve existing consumers. Any future high-volume, sensitive, or telemetry-like LLM consumer requires its own boundary decision before using the global provider factory.

Implementation should preserve the current single runtime factory construction point in `src/server/bootstrap/create-core-stores.ts`. If a future change adds another non-test `createLlmClient()` callsite or sends a new data category through the shared `LlmClient`, that change must update this section in the same PR.

## Design

### 1. Extract a Shared Chat Completions Transport

Introduce a shared transport in `src/core/openai-compatible-client.ts`.

The name is intentionally implementation-facing, not a user-facing provider. Kookr is not committing to arbitrary OpenAI-compatible gateway support; it is sharing protocol mechanics between OpenRouter and Requesty.

The shared transport owns only protocol behavior:

- trim `baseUrl` and POST to `${baseUrl}/chat/completions`
- send `Authorization: Bearer <apiKey>`
- send OpenAI-style `messages`, `model`, `max_tokens`, and optional `response_format`
- preserve `json_schema` structured-output hints as best-effort with `strict: false`
- honor caller aborts
- implement internal timeout handling without confusing internal timeout with caller cancellation
- parse the first `choices[0].message.content` string
- include provider-named, sanitized, bounded HTTP error detail without logging secrets or full prompt echoes

Provider wrappers own policy:

- default model
- default base URL
- attribution or metadata headers
- timeout floor
- environment variable interpretation

Suggested transport options:

```ts
export type OpenAiCompatibleProvider = 'openrouter' | 'requesty';

export interface OpenAiCompatibleClientOptions {
  provider: OpenAiCompatibleProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  defaultTimeoutMs?: number;
}
```

### 2. Keep OpenRouter Behavior Stable

Refactor `src/core/openrouter-client.ts` into a thin wrapper over the shared transport.

OpenRouter keeps:

- `provider: 'openrouter'`
- default model `deepseek/deepseek-v4-flash`
- default base URL `https://openrouter.ai/api/v1`
- existing `KOOKR_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY` resolution
- existing `KOOKR_LLM_MODEL`, `KOOKR_LLM_BASE_URL`, `KOOKR_LLM_HTTP_REFERER`, `KOOKR_LLM_APP_TITLE`, and `KOOKR_LLM_TIMEOUT_MS` behavior
- existing timeout floor semantics unless tests show the current client incorrectly treats its own timeout as caller cancellation

Golden compatibility tests should prove the refactor preserves:

- default model
- endpoint
- headers
- request body
- structured-output request shape
- timeout floor
- error message provider prefix
- empty-response behavior
- environment precedence

### 3. Add Requesty as an Explicit Provider

Add `src/core/requesty-client.ts` as a thin wrapper over the shared transport.

Defaults:

- `provider: 'requesty'`
- `baseUrl: 'https://router.requesty.ai/v1'`
- `model: 'openai/gpt-4o-mini'`
- no Requesty-specific attribution or metadata headers in v1
- timeout behavior matching OpenRouter unless empirical implementation testing shows a different floor is needed

Requesty model ids are passed through exactly because Requesty uses provider-prefixed ids and policy ids.

`RequestyClientOptions` should stay small:

```ts
export interface RequestyClientOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}
```

Base URL override is deferred. A user who needs a custom OpenAI-compatible endpoint that is not Requesty can continue to use the existing OpenRouter escape hatch with `KOOKR_LLM_PROVIDER=openrouter` and `KOOKR_LLM_BASE_URL=...`; Kookr will log it as OpenRouter because that is the compatibility path, not a first-class provider.

### 4. Extend Provider Selection

Extend `LlmProvider`:

```ts
export type LlmProvider =
  | 'openrouter'
  | 'requesty'
  | 'groq'
  | 'gemini'
  | 'anthropic'
  | 'auto';
```

Add `buildRequesty()` to `src/core/llm-factory.ts`.

Key resolution for explicit `requesty`:

1. `KOOKR_REQUESTY_API_KEY`
2. `REQUESTY_API_KEY`

`KOOKR_REQUESTY_API_KEY` allows a Kookr-specific key or credit limit. `REQUESTY_API_KEY` supports simple local setups, but only when the user explicitly selects Requesty.

Model resolution:

1. `KOOKR_REQUESTY_MODEL`
2. Requesty client default `openai/gpt-4o-mini`

`KOOKR_LLM_MODEL` remains OpenRouter-only for this change. This avoids sending an OpenRouter-tuned model id to Requesty by accident.

`auto` fallback remains:

```txt
GROQ > GEMINI > ANTHROPIC > OPENROUTER
```

Requesty is not part of `auto` in v1. A global `REQUESTY_API_KEY` may exist for unrelated tools, and auto-enabling a paid routing gateway would be surprising.

Explicit Requesty behavior:

- `KOOKR_LLM_PROVIDER=requesty` with no `KOOKR_REQUESTY_API_KEY` or `REQUESTY_API_KEY` returns `null` and warns that Requesty has no configured key.
- Explicit Requesty never falls back to OpenRouter key variables.
- `readLlmProvider()` accepts `requesty`, and its unknown-provider warning includes `requesty` in the accepted-values list.
- The startup "AI features disabled" log includes the Requesty key variables.

### 5. Boundary Invariant

Only `src/core/llm-factory.ts` constructs concrete provider clients.

Feature modules should depend on `LlmClient` or `createLlmClient()`, not on `RequestyLlmClient`, `OpenRouterLlmClient`, or the shared transport. The implementation should preserve that boundary in code review.

If implementation adds an import-boundary test, it should reject non-test imports of:

- `src/core/requesty-client.ts`
- `src/core/openrouter-client.ts`
- `src/core/openai-compatible-client.ts`

Its allowlist must permit `src/core/llm-factory.ts` to import provider wrappers and provider wrapper tests to import their subjects. This test is optional for this issue; a simpler code-review check is acceptable because the current feature modules already consume `LlmClient`.

Provider implementations stay in `src/core` for this issue because Kookr's existing LLM helper provider implementations already live there. Moving all provider clients into `src/adapters/llm/` is a separate architecture cleanup, not required to add Requesty safely.

### 6. Failure and Logging Behavior

Runtime failures keep current caller degradation:

- task naming returns `null`, so launch flows fall back to the truncated prompt
- response suggestions return `[]`
- remote-chat rephrase uses its existing fallback behavior
- finding-review and speech-summary callers keep their existing error handling
- task-relation inference returns no LLM verdict for that ambiguous pair and preserves deterministic relation logic only

The shared transport must not turn its internal timeout into a caller `AbortError` that prevents fallback. Caller-supplied aborts still propagate and stop fallback immediately.

HTTP error detail must be sanitized:

- cap length
- redact bearer/key-like strings
- avoid logging full request-derived fields, especially `messages`
- include the provider name so diagnostics distinguish `Requesty request failed` from `OpenRouter request failed`

Sanitization tests should include negative fixtures where a provider error body echoes an `Authorization` field, bearer/key-like strings, a `messages` array, and prompt text. The expected result is redaction or omission of request-derived message content, not merely truncation.

Structured output remains best-effort. If Requesty or an upstream model rejects `response_format`, the client does not retry without it in v1; the existing caller-side parsing and fallback behavior handles failed completions.

### 7. Documentation

Update:

- `docs/configuration.md`
- `docs/reference/environment-variables.md`

Document the minimum setup:

```bash
KOOKR_LLM_PROVIDER=requesty
KOOKR_REQUESTY_API_KEY=req_...
KOOKR_REQUESTY_MODEL=openai/gpt-4o-mini
```

Also document that:

- Requesty model ids use provider prefixes.
- Requesty is explicit-only and not part of `auto`.
- Requesty settings affect only Kookr's helper LLM features, not agent execution or speech STT/TTS.
- `KOOKR_LLM_MODEL` and `KOOKR_LLM_BASE_URL` remain OpenRouter-only in this change.

### 8. Tests

Add focused unit coverage:

- `openai-compatible-client.test.ts`
  - sends OpenAI-style Chat Completions body
  - appends `/chat/completions` after trimming trailing slashes
  - sends Bearer auth
  - forwards best-effort `response_format`
  - distinguishes caller abort from internal timeout
  - includes provider-specific sanitized error detail
- `FallbackLlmClient` or circuit-breaker-adjacent timeout coverage
  - internal provider timeout advances/fails as a provider failure
  - caller-supplied abort still propagates and stops fallback
- `openrouter-client.test.ts`
  - remains green after wrapper refactor
  - verifies golden compatibility for model, endpoint, headers, body, timeout, errors, empty response, and env precedence
- `requesty-client.test.ts`
  - default endpoint, model, and provider
  - model and timeout overrides
  - no Requesty attribution or metadata headers in v1
  - `response_format` rejection propagates to caller fallback without a special retry
- `llm-factory.test.ts`
  - `requesty` provider parsing
  - key precedence
  - explicit provider behavior
  - no Requesty in `auto`
  - OpenRouter key variables are ignored by explicit Requesty
  - unknown-provider warning includes `requesty`
  - disabled startup log mentions Requesty key variables
- consumer fallback tests where needed if existing coverage does not already prove thrown LLM errors degrade safely
- import-boundary or callsite-scope check only if implementation introduces a new provider-construction or `createLlmClient()` callsite

The implementation should extend the existing mocked factory tests and OpenRouter-style mocked-`fetch` tests. Default verification must not make live Requesty calls.

Live Requesty smoke tests are not part of the default suite. If implementation adds an optional live smoke, it must require both a Requesty API key and an explicit opt-in flag such as `KOOKR_LIVE_LLM_TESTS=1`.

## Files to change

- `src/core/openai-compatible-client.ts`
- `src/core/openai-compatible-client.test.ts`
- `src/core/openrouter-client.ts`
- `src/core/openrouter-client.test.ts`
- `src/core/requesty-client.ts`
- `src/core/requesty-client.test.ts`
- `src/core/llm-factory.ts`
- `src/core/llm-factory.test.ts`
- consumer fallback tests, only if current tests do not already cover thrown LLM failures
- optional import-boundary or callsite-scope test, only if the implementation expands provider-construction or `createLlmClient()` callsites
- `docs/configuration.md`
- `docs/reference/environment-variables.md`

## Edge cases

- Requesty key is set but provider is not selected: no behavior changes; Requesty is not included in `auto`.
- `KOOKR_LLM_PROVIDER=requesty` with only `OPENROUTER_API_KEY`: factory returns `null` and warns about missing Requesty key.
- `REQUESTY_API_KEY` exists for another tool: ignored unless `KOOKR_LLM_PROVIDER=requesty`.
- Both OpenRouter and Requesty keys are set: `auto` uses OpenRouter only; explicit Requesty uses Requesty only.
- Requesty returns `usage.cost`: ignore it for now. Kookr's helper LLM consumers only need text.
- Requesty returns valid OpenAI-style JSON with an empty first choice: return `null`.
- Requesty model ids reference policies rather than direct models: pass the configured id through unchanged.
- Requesty structured output support varies by upstream model: keep `response_format` best-effort and rely on caller-side fallback.
- Misconfigured Requesty model id: treat as a normal provider error, sanitize the error detail, and degrade through existing caller behavior.
- API key leakage: never log request headers, full request bodies, or raw prompts from provider error echoes.

## Alternatives considered

### Tell users to configure Requesty through the OpenRouter provider

Rejected. It overloads OpenRouter-specific names, logs, docs, and key variables. It also makes fallback-order behavior confusing when a user has both OpenRouter and Requesty keys.

### Add Requesty to `auto`

Rejected for v1. Requesty is a paid routing gateway, and a global `REQUESTY_API_KEY` may exist for unrelated tools. Explicit selection is clearer and avoids surprise usage.

### Add a Requesty SDK dependency

Rejected. Requesty is OpenAI-compatible for this use case, and Kookr already has a fetch-wrapper pattern that sends the needed Chat Completions payload. A new dependency adds supply-chain and bundle churn without reducing meaningful complexity.

### Add provider-specific base URL and metadata configuration in v1

Rejected. The first useful integration only needs provider selection, key, and model. Base URL overrides and Requesty-specific analytics metadata can be added when there is a concrete user need.

### Rename OpenRouter to `openai-compatible`

Rejected for this issue. A generic provider name could be useful later, but it would be a configuration migration and would obscure which gateway is being billed.

## Critic Feedback Incorporated

- Round 1 boundary review: the shared transport now owns only protocol mechanics; provider wrappers own model, base URL, timeout, and metadata policy. The RFC also adds a boundary invariant that only `llm-factory.ts` constructs concrete clients.
- Round 1 failure-mode review: the RFC now distinguishes missing-key factory behavior from runtime failures, requires sanitized provider-specific error details, calls out caller abort versus internal timeout, and documents the data categories sent through Requesty.
- Round 1 design-minimalist review: Requesty is now explicit-only, `auto` is unchanged, Requesty base URL and metadata overrides are deferred, live tests are opt-in only, and integration/E2E test files were removed from the default file list.
- Round 1 Socratic review: model/base-URL precedence was simplified instead of adding a truth table; explicit Requesty ignores OpenRouter keys, `readLlmProvider()` warning text must include `requesty`, and OpenRouter compatibility has measurable golden-test criteria.
- Empirical checkpoint: official Requesty docs validated the base URL, Chat Completions endpoint, bearer auth, and provider-prefixed model ids; local code validation confirmed runtime provider construction flows through `createLlmClient()` while feature modules depend on `LlmClient`; existing mocked factory/fetch tests are the right verification shape for default tests.
- Round 2 review: the RFC now requires updating the Requesty data-scope section if new runtime `createLlmClient()` callsites or data categories are added, states task-relation LLM failure behavior explicitly, makes error-sanitization fixtures concrete, and keeps import-boundary testing optional to avoid turning the provider addition into a lint project.
