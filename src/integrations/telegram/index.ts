/**
 * Telegram remote-chat trigger — orchestration.
 *
 * See `docs/rfc/rfc-remote-chat-trigger.md` for the design rationale and the
 * three-round critic-review trail. The integration is opt-in (off by default);
 * setting KOOKR_TELEGRAM_BOT_TOKEN in .env enables it.
 */

import { createHash } from 'node:crypto';
import { DEFAULT_AGENT_TYPE, type AgentType } from '../../core/agent-types.js';
import type { LlmClient } from '../../core/llm-client.js';
import type { LaunchOpts, LaunchResult } from '../../shared/contracts/launch.js';
import type { TelegramHandle } from '../../shared/contracts/telegram.js';
import { TelegramApiClient, TelegramApiError, type TelegramUpdate, type TelegramMessage } from './api-client.js';
import { audioDropDecision, extractAudioAttachment, filenameFromFilePath } from './audio.js';
import { parseTaskCommand } from './parse-task.js';
import { rephrase } from './rephrase.js';
import { classifyVoiceError, redactCredentials, transcribeVoice as defaultTranscribeVoice } from './transcribe.js';
import { TaskSpecBypassSchema, type ProjectInfo, type ValidatedTaskSpec } from './types.js';
import {
  acquireLockOrFail,
  createTokenBucket,
  DailyCap,
  ensureIntegrationDir,
  LockBusyError,
  PendingStore,
  StateStore,
  type LockHandle,
  type RateLimiter,
} from './safety.js';
import { createAuditWriter, type AuditWriter } from './audit.js';
import { startVoiceWarmup } from './warmup.js';

/**
 * Total wall-clock budget for the (download + transcribe) round-trip. The
 * audio branch passes a shared deadline to both legs so a slow CDN download
 * cannot extend the per-message ceiling beyond this — naively passing the
 * full 30 s to each leg independently would allow ~60 s worst-case.
 */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

export interface StartTelegramTriggerDeps {
  /** Bot API token (from BotFather). */
  token: string;
  /** Allowlisted Telegram numeric user IDs. */
  allowedUserIds: Set<number>;
  /** Projects this integration may spawn tasks against. */
  allowedProjects: ProjectInfo[];
  /** Kookr-internal data dir. Integration writes to <dataDir>/telegram/. */
  dataDir: string;
  /** When true, never call launchTask; reply with "[DRY-RUN] would spawn ...". */
  dryRun: boolean;
  /** Enables Codex CLI as a Telegram-selectable remote launch target. */
  allowCodexRemoteSpawn?: boolean;
  /** Per-minute per-sender rate limit (default 10). */
  perMinuteRateLimit?: number;
  /** Daily spawn cap (default 50). */
  maxSpawnsPerDay?: number;
  /** URL the dashboard is reachable at (e.g., http://localhost:4800). */
  dashboardBaseUrl: string;
  /** Function that calls into launch-service. Injected for testability. */
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  /** May be null if no LLM provider is configured. /task bypass still works. */
  llmClient: LlmClient | null;
  /**
   * Base URL of the local faster-whisper-server (e.g. `http://127.0.0.1:8010`).
   * When unset, audio messages are dropped with `dropped_audio_disabled`.
   * See issues #574, #585 and `transcribe.ts`.
   */
  whisperUrl?: string;
  /**
   * Test seam — overrides the transcription function. Production wiring
   * uses the default `transcribeVoice` from `./transcribe.ts`.
   */
  transcribeVoice?: typeof defaultTranscribeVoice;
  /** Server-lifecycle abort signal — see `VoiceWarmupOpts.lifecycleSignal` and issue #188. */
  lifecycleSignal?: AbortSignal;
}

/**
 * Truncate text to N chars without breaking on word boundaries (just hard cut).
 */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Recognize `/start` and `/help`, including the `@botname` suffix Telegram
 * appends in groups (e.g. `/start@kookr_core_bot`).
 */
function isHelpCommand(text: string): boolean {
  return /^\/(start|help)(@\w+)?(\s|$)/.test(text);
}

function parseAgentCommand(text: string): 'status' | 'claude' | 'codex' | 'usage' | null {
  const m = text.match(/^\/agent(?:@\w+)?(?:\s+(\S+))?\s*$/);
  if (!m) return null;
  switch ((m[1] ?? 'status').toLowerCase()) {
    case 'status':
      return 'status';
    case 'claude':
    case 'claude-code':
      return 'claude';
    case 'codex':
    case 'codex-cli':
      return 'codex';
    default:
      return 'usage';
  }
}

function agentLabel(agentType: AgentType): string {
  switch (agentType) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex-cli':
      return 'Codex CLI';
  }
}

/**
 * Friendly first-touch reply for `/start` and `/help`. Lists the configured
 * projects so the user knows what they can spawn against. See issue #583.
 */
function helpText(allowedProjects: ProjectInfo[]): string {
  const projects = allowedProjects.length === 0
    ? '  (no projects configured)'
    : allowedProjects.map((p) => `  • ${p.name} — ${p.cwd}`).join('\n');
  return [
    'Kookr remote-chat trigger.',
    '',
    'Type a free-text request — I will rephrase it into a task spec and ask you to confirm.',
    'Reply ✓ Spawn or ✗ Cancel on the confirmation message.',
    '',
    'Or use /task <project> <prompt> to bypass the LLM.',
    '',
    'Available projects:',
    projects,
  ].join('\n');
}


/**
 * Outcome of probing the local faster-whisper-server's `/v1/models` endpoint.
 * `modelCount` is null when the body is missing or shaped unexpectedly — the
 * 2xx itself is treated as "reachable" regardless of the body shape.
 */
export type WhisperProbeResult =
  | { ok: true; modelCount: number | null }
  | { ok: false; reason: string };

/**
 * One-shot reachability check for `${whisperUrl}/v1/models`. Used at startup
 * to surface misconfig (URL set, container down) in the operator log instead
 * of letting it manifest as per-message timeouts. Never throws — caller logs
 * the result and proceeds either way; the per-message error path (#574/#577)
 * remains the runtime fallback. See issue #576.
 *
 * A 2xx headers response establishes reachability; a subsequent body-stream
 * abort or non-JSON body does NOT flip the verdict back to FAILED — the
 * server replied, which is what the probe is asking. modelCount is null in
 * those cases.
 */
export async function probeWhisperReachability(
  whisperUrl: string,
  timeoutMs = 3000,
): Promise<WhisperProbeResult> {
  const url = `${whisperUrl.replace(/\/+$/, '')}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    let modelCount: number | null = null;
    try {
      const json = (await res.json()) as { data?: unknown };
      if (Array.isArray(json.data)) modelCount = json.data.length;
    } catch {
      // Non-JSON body OR mid-stream abort after headers arrived. Either way
      // the server already proved it's reachable; we just have no count.
    }
    return { ok: true, modelCount };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: `timeout after ${timeoutMs}ms` };
    }
    // undici surfaces ECONNREFUSED / ENOTFOUND on `cause.code`. Guard the
    // property read so a non-object rejection (e.g. `throw null`) can't
    // turn this catch into a re-thrown TypeError.
    if (err !== null && typeof err === 'object' && 'cause' in err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code) return { ok: false, reason: cause.code };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compact sha256-hex of a spec, used as the inline-keyboard callback_data.
 * Truncated to 32 hex chars (128 bits) so `${hash}:y` / `${hash}:n` stays
 * within Telegram's 1-64 byte callback_data limit; full hex (64 chars) plus
 * a 2-byte suffix is 66 bytes and trips BUTTON_DATA_INVALID. See issue #572.
 */
function specHash(spec: ValidatedTaskSpec, chatId: number): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ p: spec.prompt, c: spec.cwd, b: spec.suggestedBranch ?? '', chat: chatId, n: Date.now() }));
  return h.digest('hex').slice(0, 32);
}

function dashboardUrl(base: string, taskId: string): string {
  return `${base.replace(/\/$/, '')}/?task=${encodeURIComponent(taskId)}`;
}

/**
 * Backoff in ms for a poll-loop error. Honors Telegram's `retry_after` on 429.
 */
function backoffMs(err: unknown, attempt: number): number {
  if (err instanceof TelegramApiError && err.retryAfter) {
    return Math.min(60_000, err.retryAfter * 1000);
  }
  return Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt, 5)));
}

export async function startTelegramTrigger(deps: StartTelegramTriggerDeps): Promise<TelegramHandle> {
  const paths = await ensureIntegrationDir(deps.dataDir);
  const audit: AuditWriter = await createAuditWriter(paths.audit);

  // R9: lockfile fail-fast.
  let lock: LockHandle;
  try {
    lock = await acquireLockOrFail(paths.lock);
  } catch (err) {
    if (err instanceof LockBusyError) {
      throw new Error(`[telegram] Cannot start: another Kookr instance holds the lock (PID ${err.holderPid}). ${err.message}`);
    }
    throw err;
  }

  const state = await StateStore.open(paths.state);
  const pending = await PendingStore.open(paths.pendingDir);
  const limiter: RateLimiter = createTokenBucket(deps.perMinuteRateLimit ?? 10);
  const dailyCap = new DailyCap(deps.maxSpawnsPerDay ?? 50, state);
  const api = new TelegramApiClient(deps.token);

  // Initial GC pass; schedule periodic GC.
  await pending.gc(24 * 60 * 60 * 1000);
  const gcTimer = setInterval(() => {
    void pending.gc(24 * 60 * 60 * 1000);
  }, 60 * 60 * 1000);
  // Don't keep Kookr alive just for the GC timer.
  if (typeof gcTimer.unref === 'function') gcTimer.unref();

  audit({
    kind: 'start',
    allowedUserCount: deps.allowedUserIds.size,
    allowedProjectCount: deps.allowedProjects.length,
    dryRun: deps.dryRun,
  });

  // transcribeVoice is a test seam for per-message voice handling; production
  // leaves it unset, so warmup exercises the real multipart whisper request.
  const warmup = deps.whisperUrl && !deps.transcribeVoice
    ? startVoiceWarmup({
      whisperUrl: deps.whisperUrl,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      audit,
      logger: console,
      lifecycleSignal: deps.lifecycleSignal,
    })
    : null;

  let polling = true;
  let pollAttempt = 0;

  // Outer loop body extracted so we can also call it from tests if needed.
  const pollLoop = async () => {
    while (polling) {
      try {
        const updates = await api.getUpdates(state.get().offset, 30);
        pollAttempt = 0;
        for (const u of updates) {
          // INNER guard: per-update errors never escape.
          try {
            await handleUpdate(u);
          } catch (err) {
            try { audit({ kind: 'handle_failed', updateId: u.update_id, err: String(err) }); } catch { /* noop */ }
          }
          // Round-2 N17: persist offset in its own try; on failure halt the loop
          // rather than retry the same batch (which would re-process every update).
          try {
            await state.update((s) => { s.offset = u.update_id + 1; });
          } catch (err) {
            try { audit({ kind: 'offset_persist_failed', err: String(err) }); } catch { /* noop */ }
            polling = false;
            break;
          }
        }
      } catch (err) {
        const ms = backoffMs(err, pollAttempt++);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  };

  // Last-resort sentinel — should never fire because the inner loop catches everything.
  pollLoop().catch((err) => {
    try { audit({ kind: 'loop_died', err: String(err) }); } catch { /* noop */ }
  });

  // -------------------------------------------------------------------------
  // handleUpdate — message and callback_query routing
  // -------------------------------------------------------------------------

  async function handleUpdate(u: TelegramUpdate): Promise<void> {
    if (u.callback_query) {
      await handleCallback(u.callback_query);
      return;
    }

    const m = u.message;
    if (!m) return; // edited_message etc. — skip
    if (m.chat.type !== 'private') { audit({ kind: 'dropped_non_private' }); return; }
    if (m.forward_origin || m.forward_from || m.forward_from_chat) { audit({ kind: 'dropped_forwarded' }); return; }

    const userId = m.from?.id;
    if (!userId || !deps.allowedUserIds.has(userId)) { audit({ kind: 'dropped_unauthorized' }); return; }

    // Rate-limit BEFORE audio download so an attacker (in the unlikely event
    // they bypass the allowlist) can't burn whisper GPU cycles. The text path
    // is identically rated below.
    if (!limiter.allow(userId)) {
      audit({ kind: 'rate_limited', sender: userId });
      await sendMessageSafe(m.chat.id, 'Rate limited. Try again in a minute.');
      return;
    }

    let text = m.text;

    const audio = !text ? extractAudioAttachment(m) : null;

    // Audio branch — transcribe Telegram audio/video attachments into the same
    // text-flow the rephraser/parser already use. See issues #574 and #585.
    if (!text && audio) {
      if (!deps.whisperUrl) {
        audit({ kind: 'dropped_audio_disabled', source: audio.source });
        await sendMessageSafe(
          m.chat.id,
          'Audio messages are not supported by this Kookr instance — please type.',
        );
        return;
      }
      const metadataDrop = audioDropDecision(audio, audio.fileSize);
      if (metadataDrop) {
        audit(metadataDrop.event);
        await sendMessageSafe(m.chat.id, metadataDrop.reply);
        return;
      }
      // Shared deadline so a slow download can't blow past TRANSCRIBE_TIMEOUT_MS.
      const deadlineAt = Date.now() + TRANSCRIBE_TIMEOUT_MS;
      const remaining = (): number => Math.max(1, deadlineAt - Date.now());
      try {
        const file = await api.getFile(audio.fileId);
        if (!file.file_path) {
          throw new Error('Telegram getFile returned no file_path');
        }
        const fileSizeDrop = audioDropDecision(audio, file.file_size);
        if (fileSizeDrop) {
          audit(fileSizeDrop.event);
          await sendMessageSafe(m.chat.id, fileSizeDrop.reply);
          return;
        }
        const audioBytes = await api.downloadFile(file.file_path, remaining());
        const downloadedDrop = audioDropDecision(audio, audioBytes.length);
        if (downloadedDrop) {
          audit(downloadedDrop.event);
          await sendMessageSafe(m.chat.id, downloadedDrop.reply);
          return;
        }
        audit({
          kind: 'audio_received',
          source: audio.source,
          sender: userId,
          durationSec: audio.durationSec,
          bytes: audioBytes.length,
          mimeType: audio.mimeType,
        });
        const transcribe = deps.transcribeVoice ?? defaultTranscribeVoice;
        text = await transcribe(audioBytes, {
          whisperUrl: deps.whisperUrl,
          timeoutMs: remaining(),
          filename: filenameFromFilePath(file.file_path, audio.fallbackFilename),
          mimeType: audio.mimeType,
        });
        audit({
          kind: 'transcribed',
          source: audio.source,
          durationSec: audio.durationSec,
          len: text?.length ?? 0,
        });
      } catch (err) {
        audit({ kind: 'transcription_failed', err: String(err) });
        await sendMessageSafe(m.chat.id, classifyVoiceError(err));
        return;
      }
    }

    if (!text || text.length === 0 || text.length > 4096) { audit({ kind: 'dropped_non_text' }); return; }

    audit({ kind: 'message_received', sender: userId, text, len: text.length });

    if (isHelpCommand(text)) {
      audit({ kind: 'help_replied', sender: userId });
      await sendMessageSafe(m.chat.id, helpText(deps.allowedProjects));
      return;
    }

    const agentCommand = parseAgentCommand(text);
    if (agentCommand) {
      await handleAgentCommand(m.chat.id, userId, agentCommand);
      return;
    }

    if (text.startsWith('/task')) {
      const parsed = parseTaskCommand(text, deps.allowedProjects);
      if (parsed.kind === 'usage_error') {
        await sendMessageSafe(m.chat.id, parsed.message);
        return;
      }
      const defaultAgentType = getDefaultAgentType(userId);
      const agentType = parsed.agentType ?? defaultAgentType;
      const agentSource = parsed.agentType ? 'command' : 'default';
      if (!(await ensureAgentAllowed(m.chat.id, userId, agentType))) {
        return;
      }
      // Same Zod gate as rephrase output (round-3 V12).
      const candidate = { prompt: parsed.prompt, cwd: parsed.project.cwd, agentType };
      const v = TaskSpecBypassSchema.safeParse(candidate);
      if (!v.success) {
        await sendMessageSafe(m.chat.id, `/task validation failed: ${v.error.issues[0]?.message ?? 'unknown'}`);
        return;
      }
      audit({ kind: 'agent_resolved', sender: userId, agentType, source: agentSource });
      audit({ kind: 'task_command', sender: userId, project: parsed.project.name, agentType });
      const spec: ValidatedTaskSpec = { ...v.data, agentType };
      await sendConfirmation(m.chat.id, spec);
      return;
    }

    // Rephrase path.
    const defaultAgentType = getDefaultAgentType(userId);
    const result = await rephrase(text, {
      allowedProjects: deps.allowedProjects,
      llm: deps.llmClient,
      defaultAgentType,
    });
    if (result.kind === 'failed') {
      audit({ kind: 'rephrase_failed', reason: result.reason });
      await sendMessageSafe(m.chat.id, `Rephrase failed: ${result.reason}`);
      return;
    }
    if (result.kind === 'ambiguous') {
      audit({ kind: 'rephrase_ambiguous', reason: result.reason });
      await sendMessageSafe(m.chat.id, `Need more info: ${result.reason}`);
      return;
    }
    audit({
      kind: 'rephrased',
      provider: deps.llmClient?.provider ?? 'unknown',
      model: deps.llmClient?.model ?? 'unknown',
      specCwd: result.spec.cwd,
      agentType: result.spec.agentType,
    });
    if (!(await ensureAgentAllowed(m.chat.id, userId, result.spec.agentType))) {
      return;
    }
    audit({
      kind: 'agent_resolved',
      sender: userId,
      agentType: result.spec.agentType,
      source: result.spec.agentType === defaultAgentType ? 'default' : 'rephrase',
    });
    await sendConfirmation(m.chat.id, result.spec);
  }

  function getDefaultAgentType(userId: number): AgentType {
    return state.get().agentDefaultsByUser[String(userId)] ?? DEFAULT_AGENT_TYPE;
  }

  async function handleAgentCommand(chatId: number, userId: number, command: 'status' | 'claude' | 'codex' | 'usage'): Promise<void> {
    if (command === 'usage') {
      await sendMessageSafe(chatId, 'Usage: /agent status | /agent claude | /agent codex');
      return;
    }
    if (command === 'status') {
      const agentType = getDefaultAgentType(userId);
      audit({ kind: 'agent_status_replied', sender: userId, agentType });
      const suffix = agentType === 'codex-cli' && !deps.allowCodexRemoteSpawn
        ? '\nCodex remote launch is currently disabled on this Kookr instance.'
        : '';
      await sendMessageSafe(chatId, `Default agent: ${agentLabel(agentType)}${suffix}`);
      return;
    }
    const agentType: AgentType = command === 'codex' ? 'codex-cli' : 'claude-code';
    if (!(await ensureAgentAllowed(chatId, userId, agentType))) {
      return;
    }
    await state.update((s) => { s.agentDefaultsByUser[String(userId)] = agentType; });
    audit({ kind: 'agent_default_changed', sender: userId, agentType });
    await sendMessageSafe(chatId, `Default agent set to ${agentLabel(agentType)}.`);
  }

  async function ensureAgentAllowed(chatId: number, userId: number, agentType: AgentType): Promise<boolean> {
    if (agentType !== 'codex-cli' || deps.allowCodexRemoteSpawn) {
      return true;
    }
    audit({
      kind: 'agent_default_rejected',
      sender: userId,
      agentType,
      reason: 'KOOKR_REMOTE_CHAT_ALLOW_CODEX is not enabled',
    });
    await sendMessageSafe(chatId, 'Codex remote launch is disabled. Set KOOKR_REMOTE_CHAT_ALLOW_CODEX=1 to allow Telegram-spawned Codex tasks.');
    return false;
  }

  async function sendConfirmation(chatId: number, spec: ValidatedTaskSpec): Promise<void> {
    const hash = specHash(spec, chatId);
    await pending.write(hash, { createdAt: Date.now(), spec, chatId });
    audit({ kind: 'confirmation_pending', hash, chatId });
    const branchLine = spec.suggestedBranch ? `\nbranch: ${spec.suggestedBranch}` : '';
    const text =
      `Spawn this task?\n` +
      `agent: ${agentLabel(spec.agentType)}\n` +
      `cwd: ${spec.cwd}${branchLine}\n` +
      `prompt: ${truncate(spec.prompt, 500)}`;
    await sendMessageSafe(chatId, text, {
      inline_keyboard: [
        [
          { text: '✓ Spawn', callback_data: `${hash}:y` },
          { text: '✗ Cancel', callback_data: `${hash}:n` },
        ],
      ],
    });
  }

  async function handleCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const data = cb.data ?? '';
    const m = data.match(/^([0-9a-f]{32}):(y|n)$/);
    if (!m) {
      audit({ kind: 'callback_invalid', data });
      await api.answerCallbackQuery(cb.id, 'Invalid callback').catch(() => undefined);
      return;
    }
    const [, hash, action] = m;

    // Round-2 N6: explicit UX for expired/GC'd callback.
    const consumed = await pending.consume(hash);
    if (!consumed) {
      audit({ kind: 'callback_expired', hash });
      await api.answerCallbackQuery(cb.id, 'This confirmation expired. Send the message again.').catch(() => undefined);
      return;
    }

    if (cb.from.id !== consumed.chatId && !deps.allowedUserIds.has(cb.from.id)) {
      // The chatId equality is best-effort; for private chats with the bot, chat.id == from.id
      // for the user's own DM. We additionally allowlist-check the clicker.
      audit({ kind: 'dropped_unauthorized' });
      return;
    }
    audit({ kind: 'callback_received', hash, action, sender: cb.from.id });

    if (action === 'n') {
      if (cb.message) {
        await api.editMessageText(consumed.chatId, cb.message.message_id, '✗ Cancelled.').catch(() => undefined);
      }
      await api.answerCallbackQuery(cb.id, 'Cancelled').catch(() => undefined);
      return;
    }

    // R7 cap check at SPAWN time (round-2 N9).
    const cap = await dailyCap.checkAndReserveSpawn();
    if (!cap.allowed) {
      audit({ kind: 'cap_reached', usage: cap.usage });
      await api.answerCallbackQuery(cb.id, `Daily cap reached (${cap.usage.spawnsLast24h}/24h). Try again later.`).catch(() => undefined);
      return;
    }
    audit({ kind: 'spawn_reserved', capUsage: { spawnsLast24h: cap.usage.spawnsLast24h } });

    // R17 dry-run: never call launchTask.
    if (deps.dryRun) {
      const reply = `[DRY-RUN] would spawn: agent=${consumed.spec.agentType} cwd=${consumed.spec.cwd} prompt="${truncate(consumed.spec.prompt, 80)}"`;
      if (cb.message) {
        await api.editMessageText(consumed.chatId, cb.message.message_id, reply).catch(() => undefined);
      }
      await api.answerCallbackQuery(cb.id, '[DRY-RUN] reply sent').catch(() => undefined);
      audit({ kind: 'spawned', taskId: 'dry-run', chatId: consumed.chatId, dryRun: true });
      return;
    }

    // Real spawn. R8 + R19 enforced server-side.
    let result: LaunchResult;
    try {
      result = await deps.launchTask({
        prompt: consumed.spec.prompt,
        cwd: consumed.spec.cwd,
        agentType: consumed.spec.agentType,
        launchSource: 'remote-chat-telegram',
      });
    } catch (err) {
      audit({ kind: 'spawn_failed', reason: String(err) });
      if (cb.message) {
        await api.editMessageText(consumed.chatId, cb.message.message_id, `Spawn failed: ${truncate(String(err), 200)}`).catch(() => undefined);
      }
      await api.answerCallbackQuery(cb.id, 'Spawn failed').catch(() => undefined);
      return;
    }

    // Record the (taskId → chatId) mapping for R16 routing.
    await state.update((s) => { s.origin[result.task.id] = consumed.chatId; });
    audit({ kind: 'spawned', taskId: result.task.id, chatId: consumed.chatId, dryRun: false });

    let body: string;
    if (result.duplicate) {
      body = `Duplicate of existing task: ${result.task.id}\n${dashboardUrl(deps.dashboardBaseUrl, result.task.id)}`;
    } else if (result.queued) {
      body = `Queued (concurrency cap). Task: ${result.task.id}\n${dashboardUrl(deps.dashboardBaseUrl, result.task.id)}`;
    } else {
      body = `Spawned: ${result.task.id}\n${dashboardUrl(deps.dashboardBaseUrl, result.task.id)}`;
    }
    if (cb.message) {
      await api.editMessageText(consumed.chatId, cb.message.message_id, body).catch(() => undefined);
    }
    await api.answerCallbackQuery(cb.id).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // sendMessageSafe — never throws into the caller.
  // -------------------------------------------------------------------------

  async function sendMessageSafe(chatId: number, text: string, replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] }): Promise<TelegramMessage | null> {
    try {
      return await api.sendMessage(chatId, text, replyMarkup);
    } catch (err) {
      try { audit({ kind: 'spawn_failed', reason: `sendMessage: ${String(err)}` }); } catch { /* noop */ }
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // R16 callback exposed to wireEventPipeline.
  // -------------------------------------------------------------------------

  const onPermissionBlocked = (taskId: string, promptText: string): void => {
    const chatId = state.get().origin[taskId];
    if (chatId === undefined) {
      // Not remote-spawned — silently skip. Don't audit every non-remote
      // permission-blocked event (would dwarf the real signal).
      return;
    }
    // Redact BEFORE truncating: a credential that lives past char 200 would
    // be silently dropped by the truncate, hiding the redaction signal.
    const safe = truncate(redactCredentials(promptText), 200);
    const url = dashboardUrl(deps.dashboardBaseUrl, taskId);
    void api
      .sendMessage(chatId, `Task ${taskId} blocked: ${safe}\nApprove: ${url}`)
      .then(() => audit({ kind: 'block_alert_sent', taskId, chatId }))
      .catch((err) => audit({ kind: 'spawn_failed', reason: `block_alert: ${String(err)}` }));
  };

  const stop = async () => {
    polling = false;
    clearInterval(gcTimer);
    await warmup?.stop();
    await audit.close();
    await lock.release();
  };

  return { stop, onPermissionBlocked };
}
