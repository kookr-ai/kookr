/**
 * Grok Build launch argv + allowlisted-environment construction (issue #1343,
 * RFC "Grok Build adapter" + "Authentication, region, privacy, and updates").
 *
 * Pure helpers, unit-testable in isolation. Every value here is anchored to
 * POC-A's empirically-verified interactive launch
 * (docs/poc/009-grok-build-basic-supervision/pty-interactive.py:71 +
 * run-poc.sh:122-124), NOT to the RFC's pre-POC hypotheses.
 */

/** Env var overriding the Grok binary path. */
export const GROK_AGENT_BIN_ENV = 'KOOKR_GROK_BIN';
/** Env var overriding the configured Grok model. */
export const GROK_MODEL_ENV = 'KOOKR_GROK_MODEL';
/**
 * Default model. The 2026-07-15 POC-A requalification ran with `grok-4.5` (the
 * exact string recorded in the reviewed manifest's `selectedModel`); the
 * original `grok-build` model is no longer listed by the chat proxy.
 * Configurable via {@link GROK_MODEL_ENV}.
 */
export const DEFAULT_GROK_MODEL = 'grok-4.5';

/** New-launch kill switch: halts new Grok launches when set to `true`. */
export const GROK_BUILD_KILL_SWITCH_ENV = 'KOOKR_GROK_BUILD_DISABLE_NEW_LAUNCHES';

export interface BuildGrokLaunchArgsOptions {
  model: string;
  /**
   * Explicit permission-bypass opt-in (RFC safety req 4 — mapped independently
   * from any sandbox profile). Default (false) launches in Grok's default
   * permission mode: Kookr's own PreToolUse monitoring hook still fires and can
   * return a deny decision (POC-A gate 3). When true, Kookr maps to
   * `--permission-mode bypassPermissions` — the mode observed in the POC's
   * `pre_tool_use` payload (`permissionMode: "bypassPermissions"`).
   */
  bypassAllPermissions?: boolean;
}

/**
 * Build the interactive-launch argv for the managed dtach session. Mirrors the
 * ONLY interactive invocation POC-A verified: `grok --no-alt-screen --model
 * <MODEL>`. cwd is set on the backend process (not a `--cwd` flag, matching the
 * POC), and the prompt is delivered as terminal bytes after readiness — never
 * on argv (RFC: "Long prompts must not be placed on argv").
 *
 * No `--reasoning-effort` is ever emitted: POC-A did not validate Grok's
 * accepted effort values, so Grok exposes none (see GROK_BUILD_EFFORT_LEVELS).
 */
export function buildGrokLaunchArgs(opts: BuildGrokLaunchArgsOptions): string[] {
  const args = ['--no-alt-screen', '--model', opts.model];
  if (opts.bypassAllPermissions) {
    args.push('--permission-mode', 'bypassPermissions');
  }
  return args;
}

/**
 * Non-secret environment keys safe to pass through to the Grok child so its TUI
 * and any shell tools function. This is an ALLOWLIST: anything not listed here
 * (or added explicitly below) is dropped, so unrelated provider/GitHub/deploy
 * secrets in the Kookr server environment never reach the Grok process
 * (RFC: "Child processes receive an allowlisted environment"). Grok's own
 * credential is delivered via `GROK_AUTH_PATH` pointing at the operator's real
 * `~/.grok/auth.json` (shared OIDC refresh token — never a per-session copy).
 * Pay-per-token API keys (`XAI_API_KEY`) must NOT be forwarded.
 */
export const GROK_SAFE_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'TERM',
  'COLORTERM',
  'TERMINFO',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
];

export interface BuildGrokEnvOptions {
  /** The Kookr server environment (source of safe passthrough values). */
  processEnv: NodeJS.ProcessEnv;
  /**
   * Task-context env from {@link buildAgentLaunchContext} (KOOKR_TASK_ID, port,
   * git-common-dir, PATH-with-launcher, …). These are Kookr-derived, non-secret,
   * and take precedence over the passthrough base.
   */
  launchContextEnv: Record<string, string>;
  /**
   * Caller-supplied env extension (AdapterLaunchOptions.extraEnv). Layered above
   * the allowlist base and task context but BELOW the GROK_* control vars and the
   * XAI_API_KEY scrub, so it can inject Kookr-internal vars (RALPH_VERDICT_FILE,
   * RALPH_ITERATION) without overriding the security-critical redirects or
   * re-introducing a pay-per-token key. Matches the Claude/Codex extraEnv
   * precedence (after launch-context env). See issue #1366.
   */
  extraEnv?: Record<string, string>;
  /** The composed per-session GROK_HOME to redirect Grok's config root to. */
  grokHome: string;
  /**
   * Absolute path of the operator's shared `auth.json`. Set as `GROK_AUTH_PATH`
   * so managed sessions share one OIDC credential store (and its flock) instead
   * of each holding a private copy of a rotating refresh token.
   */
  authPath: string;
}

/**
 * Construct the fully-resolved, allowlisted child environment for a Grok launch.
 * The terminal backend is invoked with `envMode: 'replace'` so THIS object — not
 * the inherited `process.env` — is the baseline child environment. The backend
 * may normalize a missing, blank, or `dumb` TERM before spawning the PTY. `HOME`
 * is preserved (the coding task still needs git/ssh), while `GROK_HOME` redirects
 * Grok's hooks/plugins/state to the isolated session home and `GROK_AUTH_PATH`
 * keeps credentials on the operator's real shared file.
 */
export function buildAllowlistedGrokEnv(opts: BuildGrokEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Safe passthrough base.
  for (const key of GROK_SAFE_ENV_PASSTHROUGH) {
    const value = opts.processEnv[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }

  // 2. Kookr task context (wins over passthrough — its PATH prepends the launcher).
  Object.assign(env, opts.launchContextEnv);

  // 2b. Caller-supplied extraEnv (AdapterLaunchOptions). Applied after the
  //     allowlist base and task context to match Claude/Codex precedence, but
  //     BEFORE the GROK_* control vars and the XAI_API_KEY scrub below so it can
  //     never override the security-critical redirects or reintroduce the
  //     pay-per-token key (issue #1366).
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);

  // 3. Grok control vars (POC-A run-poc.sh:122-124). Redirect config to the
  //    session home; share the real auth.json for multi-agent OIDC refresh;
  //    disable auto-update + workspace data collection for managed sessions;
  //    auto-trust the cwd so no folder-trust prompt blocks byte-level input.
  env.GROK_HOME = opts.grokHome;
  env.GROK_AUTH_PATH = opts.authPath;
  env.GROK_DISABLE_AUTOUPDATER = '1';
  env.GROK_AUTO_UPDATE = '0';
  env.GROK_WORKSPACE_DATA_COLLECTION_DISABLED = '1';
  env.GROK_FOLDER_TRUST = '1';
  // Claude-compat hook discovery (issue #2466). HOME is the operator's real
  // home so the fork can load ~/.claude/settings.json (writing nudges, PR/OSS
  // gates, KB-scout, memory-write guards) without copying hook scripts into
  // the isolated GROK_HOME. Kookr's own monitoring stays a native Grok hook
  // file under that GROK_HOME and is independent of this toggle.
  //
  // Launch-ack tradeoff: a blocking operator UserPromptSubmit hook can delay
  // the initial-prompt acknowledgement. That is accepted over the previous
  // all-or-nothing disable. The adapter already fail-opens on busy chrome
  // (30s confirm timeout + assume-submitted) rather than stranding the launch.
  env.GROK_CLAUDE_HOOKS_ENABLED = '1';
  // Never inherit a pay-per-token key into managed agents (cost hard-rule).
  delete env.XAI_API_KEY;
  if (!env.TERM) env.TERM = 'xterm-256color';

  return env;
}

export interface GrokLaunchGate {
  allowed: boolean;
  reason: string;
}

/**
 * Resolve whether a new Grok launch is permitted: allowed unless the
 * new-launch kill switch is set. Pure + env-injectable so the adapter and
 * tests share one source of truth.
 */
export function resolveGrokLaunchGate(env: NodeJS.ProcessEnv = process.env): GrokLaunchGate {
  if (env[GROK_BUILD_KILL_SWITCH_ENV] === 'true') {
    return {
      allowed: false,
      reason: `New Grok Build launches are halted by the kill switch (${GROK_BUILD_KILL_SWITCH_ENV}=true).`,
    };
  }
  return { allowed: true, reason: 'ok' };
}

/** Resolve the configured model: {@link GROK_MODEL_ENV} → {@link DEFAULT_GROK_MODEL}. */
export function resolveGrokModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[GROK_MODEL_ENV];
  return configured && configured.trim() ? configured.trim() : DEFAULT_GROK_MODEL;
}
