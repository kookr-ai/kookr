/**
 * Telegram remote-chat trigger — orchestration.
 *
 * See `docs/rfc/rfc-remote-chat-trigger.md` for the design rationale and the
 * three-round critic-review trail. The integration is opt-in (off by default);
 * setting KOOKR_TELEGRAM_BOT_TOKEN in .env enables it.
 */

import type { AskAnswerPort, AskNotifier, AskRecord, AnswerRejection } from '../../shared/contracts/asks.js';
import { createHash } from 'node:crypto';
import { DEFAULT_AGENT_TYPE, type AgentType } from '../../core/agent-types.js';
import type { LlmClient } from '../../core/llm-client.js';
import type { LaunchOpts, LaunchResult } from '../../shared/contracts/launch.js';
import { dashboardTaskUrl } from '../../shared/dashboard-task-url.js';
import type { TelegramHandle, TelegramTaskOutcome, TelegramReplyResult } from '../../shared/contracts/telegram.js';
import {
  TelegramApiClient,
  TelegramApiError,
  TelegramDownloadTooLargeError,
  type TelegramUpdate,
  type TelegramMessage,
} from './api-client.js';
import { audioDropDecision, extractAudioAttachment, filenameFromFilePath, MAX_AUDIO_BYTES } from './audio.js';
import { parseTaskCommand } from './parse-task.js';
import { redactCredentials } from './redact.js';
import { fetchTasksSummary, formatTasksReply, isTasksCommand, selectActiveTasks, type TaskSummaryRow } from './tasks-command.js';
import { rephrase } from './rephrase.js';
import { classifyVoiceError, transcribeVoice as defaultTranscribeVoice } from './transcribe.js';
import { TaskSpecBypassSchema, type ProjectInfo, type ValidatedTaskSpec } from './types.js';
import {
  acquireLockOrFail,
  createTokenBucket,
  DailyCap,
  ensureIntegrationDir,
  LockBusyError,
  PendingStore,
  pruneSentNotifications,
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
  /** Actual model selected by the bundled service, including Qwen on GPU. */
  transcriptionModel?: string;
  /**
   * Test seam — overrides the transcription function. Production wiring
   * uses the default `transcribeVoice` from `./transcribe.ts`.
   */
  transcribeVoice?: typeof defaultTranscribeVoice;
  /**
   * Test seam — fetches the active-task summary for the `/tasks` command
   * (issue #1394). Production leaves it unset and the default fetcher GETs
   * `${dashboardBaseUrl}/api/tasks?view=compact`.
   */
  fetchTasksSummary?: (baseUrl: string) => Promise<TaskSummaryRow[]>;
  /** Server-lifecycle abort signal — see `VoiceWarmupOpts.lifecycleSignal` and issue #188. */
  lifecycleSignal?: AbortSignal;
  /**
   * Reply routing (optional). When set, the operator can answer a task from
   * Telegram — a plain-text reply to a notification, or a quick-reply button,
   * is delivered to the running agent without opening the dashboard.
   * `replyToTask` sends free text; `approveTaskPermission` approves the task's
   * current permission prompt (anti-stale, keystroke-based). When unset, the
   * bot behaves exactly as before (notifications are read-only).
   */
  replyToTask?: (taskId: string, text: string) => Promise<TelegramReplyResult>;
  approveTaskPermission?: (taskId: string, expectedPromptId?: string) => Promise<TelegramReplyResult>;
  /** Short identity of a task's current permission prompt (for the Approve button). */
  permissionPromptId?: (taskId: string) => string | null;
  /**
   * `kookr ask` (docs/rfc/rfc-kookr-ask.md). When set, the handle exposes an
   * `ask` notifier AND the callback/reply handlers below are active — the two
   * are registered together so a question is never sent that cannot be answered.
   */
  asks?: AskAnswerPort;
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
    case 'grok-build':
      return 'Grok Build';
    case 'opencode':
      return 'opencode';
    case 'hermes-fleet':
      return 'Hermes fleet';
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
    'Use /tasks to see active tasks and their blockers.',
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

  // Reply-routing constants (used by notification senders, the callback handler,
  // and the correlation GC — declared once, up front).
  const SENT_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
  /** callback_data namespaces (kept distinct from the spawn `hash:y|n` shape). */
  const CB_APPROVE = 'approve:'; // approve:<taskId>[:<promptId>]
  const CB_REPLY = 'reply:'; // reply:<taskId>:continue
  const CB_ASK = 'ask:'; // ask:<askId 12 hex>:<option index>:<mac 16 hex> (kookr ask)
  const ASK_CALLBACK = /^ask:([0-9a-f]{12}):([0-3]):([0-9a-f]{16})$/;

  // Initial GC pass; schedule periodic GC.
  const pruneSentNotificationState = async (): Promise<void> => {
    const current = state.get().sentNotifications;
    if (!current || Object.keys(current).length === 0) return;
    const pruned = pruneSentNotifications(current, Date.now(), SENT_NOTIFICATION_TTL_MS);
    if (Object.keys(pruned).length !== Object.keys(current).length) {
      await state.update((s) => { s.sentNotifications = pruned; });
    }
  };
  await pending.gc(24 * 60 * 60 * 1000);
  await pruneSentNotificationState();
  const gcTimer = setInterval(() => {
    void pending.gc(24 * 60 * 60 * 1000);
    void pruneSentNotificationState();
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
      model: deps.transcriptionModel,
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
        const audioBytes = await api.downloadFile(file.file_path, remaining(), MAX_AUDIO_BYTES);
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
          model: deps.transcriptionModel,
          timeoutMs: remaining(),
          filename: filenameFromFilePath(file.file_path, audio.fallbackFilename),
          mimeType: audio.mimeType,
          capture: { durationSeconds: audio.durationSec, kind: audio.source },
        });
        audit({
          kind: 'transcribed',
          source: audio.source,
          durationSec: audio.durationSec,
          len: text?.length ?? 0,
        });
      } catch (err) {
        if (err instanceof TelegramDownloadTooLargeError) {
          const drop = audioDropDecision(audio, err.bytesRead);
          if (drop) {
            audit(drop.event);
            await sendMessageSafe(m.chat.id, drop.reply);
            return;
          }
        }
        audit({ kind: 'transcription_failed', err: String(err) });
        await sendMessageSafe(m.chat.id, classifyVoiceError(err));
        return;
      }
    }

    if (!text || text.length === 0 || text.length > 4096) { audit({ kind: 'dropped_non_text' }); return; }

    audit({ kind: 'message_received', sender: userId, text, len: text.length });

    // Reply routing: if this is a reply to a notification we sent about a task,
    // deliver the text to that running agent instead of treating it as a new
    // task request. Unmatched replies fall through to the normal flow.
    const replyToId = m.reply_to_message?.message_id;
    // `kookr ask`: a free-text reply to a question message is the operator's
    // answer. A reply to a question that is already closed gets a hint and never
    // falls through to the spawn flow. Commands (`/…`) are not answers.
    if (replyToId !== undefined && deps.asks && !text.startsWith('/')) {
      const hit = deps.asks.findByMessage(m.chat.id, replyToId);
      if (hit) {
        await handleAskText(m.chat.id, userId, replyToId, hit, text);
        return;
      }
    }
    // A reply that is itself a command (/tasks, /agent, …) is executed, not sent
    // to the agent — only route genuine free-text replies.
    if (replyToId !== undefined && deps.replyToTask && !text.startsWith('/')) {
      const mapped = state.get().sentNotifications?.[String(replyToId)];
      // message_id is unique only per chat — only route when the reply came from
      // the chat the notification was sent to (correctness finding #2).
      if (mapped && mapped.chatId === m.chat.id) {
        const result = await deps.replyToTask(mapped.taskId, text);
        if (result.ok) {
          // Keep the operator subscribed to this task's alerts after answering
          // (a completion_ready had cleared its origin — finding #3).
          await state.update((s) => { s.origin[mapped.taskId] = m.chat.id; });
          audit({ kind: 'reply_routed', taskId: mapped.taskId, sender: userId, via: 'text' });
          await sendMessageSafe(m.chat.id, `✅ Sent to task ${mapped.taskId}.`);
        } else {
          audit({ kind: 'reply_route_failed', taskId: mapped.taskId, sender: userId, via: 'text', reason: result.reason ?? 'unknown' });
          await sendMessageSafe(m.chat.id, `Could not deliver: ${result.reason ?? 'unknown error'}.`);
        }
        return;
      }
    }

    if (isHelpCommand(text)) {
      audit({ kind: 'help_replied', sender: userId });
      await sendMessageSafe(m.chat.id, helpText(deps.allowedProjects));
      return;
    }

    if (isTasksCommand(text)) {
      await handleTasksCommand(m.chat.id, userId);
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

  /**
   * `/tasks` read-back (issue #1394): fetch the compact task listing and reply
   * with a length-bounded, secret-redacted summary of active tasks and each
   * task's most-relevant blocker. A fetch failure replies with a short error
   * rather than a misleading "no tasks" message.
   */
  async function handleTasksCommand(chatId: number, userId: number): Promise<void> {
    const fetcher = deps.fetchTasksSummary ?? fetchTasksSummary;
    let rows: TaskSummaryRow[];
    try {
      rows = await fetcher(deps.dashboardBaseUrl);
    } catch (err) {
      audit({ kind: 'tasks_query_failed', sender: userId, err: String(err) });
      await sendMessageSafe(chatId, 'Could not read task state right now — try again shortly.');
      return;
    }
    // Scope the read-back to the projects this user may spawn against so the
    // reply cannot leak out-of-scope task names/blockers (issue #1394 Risks).
    const opts = { allowedCwds: deps.allowedProjects.map((p) => p.cwd) };
    audit({ kind: 'tasks_replied', sender: userId, count: selectActiveTasks(rows, opts).length });
    await sendMessageSafe(chatId, formatTasksReply(rows, opts));
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

  const ASK_REJECTION_TEXT: Record<AnswerRejection, string> = {
    not_found: 'This question no longer exists.',
    forged: 'Invalid button.',
    already_answered: 'Already answered.',
    expired: 'This question expired.',
    cancelled: 'This question was cancelled.',
    wrong_chat: 'This button does not belong to this chat.',
    bad_option: 'Invalid answer.',
    text_not_allowed: 'This question only accepts the buttons.',
    task_gone: 'The task is no longer running, so the answer was not delivered.',
  };

  /**
   * `kookr ask` button tap. Order (docs/rfc/rfc-kookr-ask.md): allowlist, rate
   * limit, strict pattern, then the ask service (lookup, MAC, state, chat and
   * message binding). Audit events never carry the callback data (it holds the MAC).
   */
  async function handleAskCallback(cb: NonNullable<TelegramUpdate['callback_query']>, data: string): Promise<void> {
    if (!deps.allowedUserIds.has(cb.from.id)) {
      audit({ kind: 'dropped_unauthorized' });
      await api.answerCallbackQuery(cb.id).catch(() => undefined);
      return;
    }
    if (!limiter.allow(cb.from.id)) {
      audit({ kind: 'rate_limited', sender: cb.from.id });
      await api.answerCallbackQuery(cb.id, 'Rate limited. Try again in a minute.').catch(() => undefined);
      return;
    }
    const match = ASK_CALLBACK.exec(data);
    const message = cb.message;
    if (!deps.asks || !match || !message || message.chat.type !== 'private') {
      audit({ kind: 'ask_rejected', sender: cb.from.id, via: 'button', reason: !deps.asks ? 'unavailable' : !match ? 'malformed' : 'wrong_chat' });
      await api.answerCallbackQuery(cb.id, !deps.asks ? 'Questions are unavailable.' : 'Invalid button.').catch(() => undefined);
      return;
    }
    const [, askId, index, mac] = match;
    const result = await deps.asks.answer({
      askId,
      senderId: cb.from.id,
      chatId: message.chat.id,
      messageId: message.message_id,
      option: { index: Number(index), mac },
    });
    if (result.ok) {
      audit({ kind: 'ask_answered', askId, taskId: result.ask.taskId, sender: cb.from.id, via: 'button', taskDelivery: result.ask.taskDelivery });
      await api.answerCallbackQuery(cb.id, result.ask.taskDelivery === 'failed' ? 'Recorded, but could not reach the task' : 'Sent').catch(() => undefined);
    } else {
      audit({ kind: 'ask_rejected', askId, sender: cb.from.id, via: 'button', reason: result.reason });
      await api.answerCallbackQuery(cb.id, ASK_REJECTION_TEXT[result.reason]).catch(() => undefined);
    }
  }

  /** `kookr ask` free-text reply to a question message. */
  async function handleAskText(
    chatId: number,
    userId: number,
    replyToId: number,
    hit: { id: string; state: AskRecord['state'] },
    text: string,
  ): Promise<void> {
    if (!deps.asks) return;
    if (hit.state !== 'pending') {
      audit({ kind: 'ask_rejected', askId: hit.id, sender: userId, via: 'text', reason: 'closed' });
      await sendMessageSafe(chatId, 'This question is already closed.');
      return;
    }
    const result = await deps.asks.answer({ askId: hit.id, senderId: userId, chatId, messageId: replyToId, text });
    if (result.ok) {
      audit({ kind: 'ask_answered', askId: hit.id, taskId: result.ask.taskId, sender: userId, via: 'text', taskDelivery: result.ask.taskDelivery });
    } else {
      audit({ kind: 'ask_rejected', askId: hit.id, sender: userId, via: 'text', reason: result.reason });
      await sendMessageSafe(chatId, ASK_REJECTION_TEXT[result.reason]);
    }
  }

  async function handleCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const data = cb.data ?? '';

    // `kookr ask` buttons. Handled first and returns before every legacy path,
    // in particular before `callback_invalid`, which would log the raw data.
    if (data.startsWith(CB_ASK)) {
      await handleAskCallback(cb, data);
      return;
    }

    // Quick-reply buttons on notifications (approve a block / continue a task).
    // These drive a LIVE agent, so they are allowlist-checked and rate-limited
    // (the spawn-confirmation path below has its own cap instead).
    if (data.startsWith(CB_APPROVE) || data.startsWith(CB_REPLY)) {
      if (!deps.allowedUserIds.has(cb.from.id)) {
        audit({ kind: 'dropped_unauthorized' });
        await api.answerCallbackQuery(cb.id).catch(() => undefined);
        return;
      }
      if (!limiter.allow(cb.from.id)) {
        audit({ kind: 'rate_limited', sender: cb.from.id });
        await api.answerCallbackQuery(cb.id, 'Rate limited. Try again in a minute.').catch(() => undefined);
        return;
      }

      if (data.startsWith(CB_APPROVE)) {
        // `approve:<taskId>[:<promptId>]` — taskId is a uuid (no colon), so the
        // first ':' separates the optional prompt-identity token.
        const payload = data.slice(CB_APPROVE.length);
        const ci = payload.indexOf(':');
        const taskId = ci >= 0 ? payload.slice(0, ci) : payload;
        const expectedPromptId = ci >= 0 ? payload.slice(ci + 1) : undefined;
        const result = deps.approveTaskPermission
          ? await deps.approveTaskPermission(taskId, expectedPromptId)
          : { ok: false, reason: 'approval not available' };
        if (result.ok) {
          audit({ kind: 'permission_decision_sent', taskId, sender: cb.from.id });
          if (cb.message) {
            await api.editMessageText(cb.message.chat.id, cb.message.message_id, `✅ Approved task ${taskId}.`).catch(() => undefined);
          }
          await api.answerCallbackQuery(cb.id, 'Approved').catch(() => undefined);
        } else {
          audit({ kind: 'permission_decision_failed', taskId, sender: cb.from.id, reason: result.reason ?? 'unknown' });
          await api.answerCallbackQuery(cb.id, result.reason ?? 'Could not approve').catch(() => undefined);
        }
        return;
      }

      // CB_REPLY — `reply:<taskId>:<preset>` (only `continue` is accepted).
      const rest = data.slice(CB_REPLY.length);
      const sep = rest.lastIndexOf(':');
      const taskId = sep >= 0 ? rest.slice(0, sep) : rest;
      const preset = sep >= 0 ? rest.slice(sep + 1) : 'continue';
      if (preset !== 'continue') {
        audit({ kind: 'reply_route_failed', taskId, sender: cb.from.id, via: 'button', reason: `unknown preset: ${preset}` });
        await api.answerCallbackQuery(cb.id, 'Unknown action').catch(() => undefined);
        return;
      }
      const result = deps.replyToTask
        ? await deps.replyToTask(taskId, 'continue')
        : { ok: false, reason: 'reply not available' };
      if (result.ok) {
        // Resuming a completed task re-subscribes the operator to its alerts
        // (completion_ready had cleared its origin — finding #3).
        await state.update((s) => { s.origin[taskId] = cb.from.id; });
        audit({ kind: 'reply_routed', taskId, sender: cb.from.id, via: 'button' });
        if (cb.message) {
          await api.editMessageText(cb.message.chat.id, cb.message.message_id, `▶️ Told task ${taskId} to continue.`).catch(() => undefined);
        }
        await api.answerCallbackQuery(cb.id, 'Sent').catch(() => undefined);
      } else {
        audit({ kind: 'reply_route_failed', taskId, sender: cb.from.id, via: 'button', reason: result.reason ?? 'unknown' });
        await api.answerCallbackQuery(cb.id, result.reason ?? 'Could not deliver').catch(() => undefined);
      }
      return;
    }

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
      body = `Duplicate of existing task: ${result.task.id}\n${dashboardTaskUrl(deps.dashboardBaseUrl, result.task.id)}`;
    } else if (result.queued) {
      body = `Queued (concurrency cap). Task: ${result.task.id}\n${dashboardTaskUrl(deps.dashboardBaseUrl, result.task.id)}`;
    } else {
      body = `Spawned: ${result.task.id}\n${dashboardTaskUrl(deps.dashboardBaseUrl, result.task.id)}`;
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
  // Reply routing — correlate a sent notification's message_id back to its task
  // so a plain-text reply can be delivered to the running agent.
  // -------------------------------------------------------------------------

  async function recordSentNotification(
    messageId: number | undefined,
    taskId: string,
    chatId: number,
  ): Promise<void> {
    // Only worth storing when replies can actually be routed back.
    if (messageId === undefined || !deps.replyToTask) return;
    await state.update((s) => {
      const map = s.sentNotifications ?? {};
      map[String(messageId)] = { taskId, at: Date.now(), chatId };
      s.sentNotifications = pruneSentNotifications(map, Date.now(), SENT_NOTIFICATION_TTL_MS);
    });
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
    const url = dashboardTaskUrl(deps.dashboardBaseUrl, taskId);
    // Quick-reply: an Approve button (one tap) when approval routing is wired.
    // The operator can also just reply to this message to tell the agent what
    // to do instead.
    const canReply = Boolean(deps.replyToTask);
    const replyHint = deps.approveTaskPermission || canReply
      ? '\nTap ✅ to approve, or reply to this message to instruct the agent.'
      : '';
    // Bind the Approve button to THIS prompt's identity so a stale button can't
    // approve a different prompt that appeared since (correctness finding #1).
    const promptId = deps.permissionPromptId?.(taskId) ?? null;
    const approveData = promptId ? `${CB_APPROVE}${taskId}:${promptId}` : `${CB_APPROVE}${taskId}`;
    const markup = deps.approveTaskPermission
      ? { inline_keyboard: [[{ text: '✅ Approve', callback_data: approveData }]] }
      : undefined;
    void sendMessageSafe(chatId, `Task ${taskId} blocked: ${safe}\nApprove: ${url}${replyHint}`, markup)
      .then(async (sent) => {
        if (sent) {
          audit({ kind: 'block_alert_sent', taskId, chatId });
          await recordSentNotification(sent.message_id, taskId, chatId);
        }
      })
      .catch((err) => audit({ kind: 'spawn_failed', reason: `block_alert: ${String(err)}` }));
  };

  const formatTaskOutcomeMessage = (taskId: string, outcome: TelegramTaskOutcome): string => {
    const url = dashboardTaskUrl(deps.dashboardBaseUrl, taskId);
    switch (outcome.kind) {
      case 'completion_ready': {
        const safeNote = outcome.note ? `\nNote: ${truncate(redactCredentials(outcome.note), 200)}` : '';
        return `Task ${taskId} is ready for completion.${safeNote}\nReview: ${url}`;
      }
      case 'completed':
        return `Task ${taskId} completed.\nReview: ${url}`;
      case 'failed':
        return `Task ${taskId} failed.\nReview: ${url}`;
      case 'cancelled':
        return `Task ${taskId} was cancelled.\nReview: ${url}`;
    }
  };

  const onTaskOutcome = async (taskId: string, outcome: TelegramTaskOutcome): Promise<void> => {
    const chatId = state.get().origin[taskId];
    if (chatId === undefined) {
      // Not remote-spawned, or already notified and cleaned up — silently skip
      // so ordinary local task completions do not spam the Telegram audit path.
      return;
    }

    try {
      await state.update((s) => { delete s.origin[taskId]; });
      // `completion_ready` means the agent declared done and is still live,
      // awaiting the operator. Offer a one-tap "Continue" (keep working) and
      // let a plain reply reach the agent. Fully terminal outcomes get no
      // buttons (no live session to route to).
      const markup = outcome.kind === 'completion_ready' && deps.replyToTask
        ? { inline_keyboard: [[{ text: '▶️ Continue', callback_data: `${CB_REPLY}${taskId}:continue` }]] }
        : undefined;
      const sent = await sendMessageSafe(chatId, formatTaskOutcomeMessage(taskId, outcome), markup);
      if (sent) {
        audit({ kind: 'task_outcome_sent', taskId, chatId, outcome: outcome.kind });
        if (outcome.kind === 'completion_ready') {
          await recordSentNotification(sent.message_id, taskId, chatId);
        }
      }
    } catch (err) {
      audit({ kind: 'spawn_failed', reason: `task_outcome: ${String(err)}` });
    }
  };

  const stop = async () => {
    polling = false;
    clearInterval(gcTimer);
    await warmup?.stop();
    await audit.close();
    await lock.release();
  };

  // `kookr ask` transport. Present only together with the answer port above.
  const askNotifier: AskNotifier | undefined = deps.asks
    ? {
      async sendAsk(ask, callbackData) {
        const chatId = state.get().origin[ask.taskId] ?? deps.allowedUserIds.values().next().value;
        if (chatId === undefined) throw new Error('no Telegram chat to send the question to');
        const lines = [`❓ Task ${ask.taskId} asks:`, '', ask.question];
        if (ask.context) lines.push('', ask.context);
        if (ask.allowText) lines.push('', 'Or reply to this message with text.');
        const sent = await api.sendMessage(chatId, lines.join('\n'), {
          inline_keyboard: ask.options.map((label, i) => [{ text: label, callback_data: callbackData(i) }]),
        });
        audit({ kind: 'ask_sent', askId: ask.id, taskId: ask.taskId, chatId });
        return { chatId, messageId: sent.message_id };
      },
      async finalizeAsk(ask, text) {
        if (!ask.delivery) return;
        await api.editMessageText(ask.delivery.chatId, ask.delivery.messageId, text);
        audit({ kind: 'ask_finalized', askId: ask.id, taskId: ask.taskId, state: ask.state, resolution: ask.resolution });
      },
    }
    : undefined;

  return { stop, onPermissionBlocked, onTaskOutcome, ...(askNotifier ? { ask: askNotifier } : {}) };
}
