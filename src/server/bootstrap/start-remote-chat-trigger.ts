import type { LlmClient } from '../../core/llm-client.js';
import type { TelegramHandle } from '../../integrations/telegram/index.js';
import type { LaunchResult, LaunchOpts } from '../launch-service.js';

type Env = Record<string, string | undefined>;

export interface TelegramTriggerModule {
  startTelegramTrigger(deps: {
    token: string;
    allowedUserIds: Set<number>;
    allowedProjects: Array<{ name: string; cwd: string }>;
    dataDir: string;
    dryRun: boolean;
    allowCodexRemoteSpawn?: boolean;
    dashboardBaseUrl: string;
    launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
    llmClient: LlmClient | null;
    whisperUrl?: string;
    lifecycleSignal?: AbortSignal;
  }): Promise<TelegramHandle>;
  probeWhisperReachability(url: string): Promise<
    | { ok: true; modelCount: number | null }
    | { ok: false; reason: string }
  >;
}

export interface RemoteChatTriggerDeps {
  host: string;
  port: number;
  kookrDir: string;
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  llmClient: LlmClient | null;
  lifecycleSignal?: AbortSignal;
  env?: Env;
  loadTelegramModule?: () => Promise<TelegramTriggerModule>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, err?: unknown) => void;
}

export interface RemoteChatTrigger {
  handle: TelegramHandle | null;
  onPermissionBlocked?: (taskId: string, promptText: string) => void;
}

function parseAllowedUserIds(value: string | undefined): Set<number> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n)),
  );
}

function parseAllowedProjects(value: string | undefined): Array<{ name: string; cwd: string }> {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cwd) => ({ name: cwd.split('/').pop() ?? cwd, cwd }));
}

function dashboardBaseUrl(host: string, port: number): string {
  return `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
}

export async function startRemoteChatTrigger(deps: RemoteChatTriggerDeps): Promise<RemoteChatTrigger> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const error = deps.error ?? console.error;

  if (env.KOOKR_REMOTE_CHAT_DISABLED === '1') {
    log('[telegram] disabled via KOOKR_REMOTE_CHAT_DISABLED');
    return { handle: null };
  }

  const token = env.KOOKR_TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { handle: null };
  }

  try {
    const telegramModule = await (deps.loadTelegramModule ?? (async () => await import('../../integrations/telegram/index.js')))();
    const allowedUserIds = parseAllowedUserIds(env.KOOKR_TELEGRAM_ALLOWED_USERS);
    const allowedProjects = parseAllowedProjects(env.KOOKR_REMOTE_CHAT_PROJECTS);

    if (allowedUserIds.size === 0) {
      warn(
        '[telegram] KOOKR_TELEGRAM_BOT_TOKEN set but KOOKR_TELEGRAM_ALLOWED_USERS empty — refusing to start ' +
        '(an unauthenticated bot would be a backdoor).',
      );
      return { handle: null };
    }

    if (allowedProjects.length === 0) {
      warn(
        '[telegram] KOOKR_TELEGRAM_BOT_TOKEN set but KOOKR_REMOTE_CHAT_PROJECTS empty — refusing to start ' +
        '(no projects to spawn against).',
      );
      return { handle: null };
    }

    const handle = await telegramModule.startTelegramTrigger({
      token,
      allowedUserIds,
      allowedProjects,
      dataDir: deps.kookrDir,
      dryRun: env.KOOKR_REMOTE_CHAT_DRY_RUN === '1',
      allowCodexRemoteSpawn: env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1',
      dashboardBaseUrl: dashboardBaseUrl(deps.host, deps.port),
      launchTask: deps.launchTask,
      llmClient: deps.llmClient,
      whisperUrl: env.KOOKR_STT_WHISPER_URL,
      lifecycleSignal: deps.lifecycleSignal,
    });

    log(
      `[telegram] active — allowedUsers=${allowedUserIds.size} projects=${allowedProjects.length} ` +
      `dryRun=${env.KOOKR_REMOTE_CHAT_DRY_RUN === '1'} ` +
      `codex=${env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1' ? 'enabled' : 'disabled'} ` +
      `audio=${env.KOOKR_STT_WHISPER_URL ? 'enabled' : 'disabled'}`,
    );

    if (env.KOOKR_STT_WHISPER_URL) {
      const whisperUrl = env.KOOKR_STT_WHISPER_URL;
      void telegramModule.probeWhisperReachability(whisperUrl).then((probe) => {
        if (probe.ok) {
          const suffix = probe.modelCount !== null ? ` (${probe.modelCount} models)` : '';
          log(`[telegram] voice probe: 200 OK${suffix}`);
        } else {
          warn(
            `[telegram] voice probe FAILED: ${probe.reason} at ${whisperUrl}/v1/models — ` +
            'voice transcription will fail per-message',
          );
        }
      });
    }

    return {
      handle,
      onPermissionBlocked: handle.onPermissionBlocked,
    };
  } catch (err) {
    error('[telegram] Failed to start integration:', err instanceof Error ? err.message : err);
    return { handle: null };
  }
}
