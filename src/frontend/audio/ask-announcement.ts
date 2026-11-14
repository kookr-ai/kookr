/**
 * Lucy reads out a question a task just asked the operator (`kookr ask`).
 *
 * Everything else Lucy says follows a press on a speaker button. A question is
 * different: the task is waiting, so she says it unprompted, once, the moment
 * it arrives. The rules that keep that from being a nuisance:
 *
 *  - Sound off in Settings, or Do Not Disturb: nothing is played. The clip is
 *    still fetched and kept in her message list, marked unheard, so the
 *    operator can press Replay.
 *  - The browser refuses to start audio because nobody has clicked in the page
 *    yet (autoplay policy): same outcome, the clip waits as unheard. This is
 *    checked up front, so no audio context is created that could never start.
 *  - Several Kookr tabs open: exactly one speaks. Tabs agree through a Web Lock
 *    plus a short list of already-spoken ask ids in `localStorage`; a hidden tab,
 *    or one that may not start audio yet, waits a moment first so a tab that can
 *    be heard wins. A browser without Web Locks
 *    (plain http on a LAN address) falls back to the list alone.
 *  - Lucy is already talking (a summary, a hands-free answer, or an earlier
 *    question): the question waits for her to finish, then plays, unless it was
 *    answered meanwhile. Questions are spoken one at a time, in arrival order.
 *  - A question closed before she got to it is not spoken, and its clip is
 *    taken out of her message list: an unheard marker for a question that is
 *    already answered would only mislead.
 *  - The question is answered, cancelled or expired while she is reading it:
 *    she stops ({@link stopAskAnnouncement}).
 *
 * The audio goes through the remembered-clip path (`last-clip.ts` and
 * `clip-playback.ts`), so the avatar lip-syncs it, it appears in her message
 * list, and "heard" bookkeeping and telemetry work as for any other clip.
 */
import { LUCY_LAUNCH_REPORT_SPEAK_PATH } from '../../shared/contracts/lucy-launch.js';
import type { SpeakAudioResponse } from '../../shared/contracts/speech.js';
import { getDndState } from '../hooks/useDnd.js';
import { replayClip, replayingClipId, reportClipUnheard, stopReplay, type ReplayResult } from './clip-playback.js';
import { captureLastClip, discardLastClip, getClip } from './last-clip.js';
import { getSoundPreferenceState } from './sound-preference.js';
import { subscribeSpeechBus } from './speech-bus.js';

export type AskAnnouncementResult =
  /** Playing now. */
  | 'started'
  /** Another tab is (or was) the one to speak this question. */
  | 'other-tab'
  /** Kept as an unheard clip: sound is off, Do Not Disturb is on, or the browser blocked audio. */
  | 'muted' | 'dnd' | 'blocked'
  /** The question was closed before she could say it. */
  | 'cancelled'
  /** The clip could not be fetched or played. */
  | 'error';

export const SPOKEN_ASKS_STORAGE_KEY = 'kookr.lucy.spokenAsks';
/** How many ask ids the cross-tab list remembers. */
const SPOKEN_ASKS_KEPT = 20;
/** A hidden tab waits this long before claiming a question, so a visible tab gets there first. */
export const HIDDEN_TAB_DELAY_MS = 600;
/** Longest wait for the server to return the clip; a little more than the two 30 s attempts it gives the speech service. */
const SPEAK_FETCH_TIMEOUT_MS = 75_000;
/** Pause before the single retry when another clip started first, so that clip is audible (and on the speech bus) by then. */
const RETRY_PAUSE_MS = 400;
/** How long a question waits for Lucy to stop talking before it is left as an unheard clip. */
const BUSY_WAIT_MS = 45_000;

/** ask id -> clip id, for the questions this tab fetched a clip for. */
const clipByAsk = new Map<string, string>();
/** Questions closed before or while their announcement was being prepared. */
const closedAsks = new Set<string>();

function readSpoken(): string[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SPOKEN_ASKS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** True when this tab is the first to claim `askId`; records the claim for the other tabs. */
function claimLocally(askId: string): boolean {
  const spoken = readSpoken();
  if (spoken.includes(askId)) return false;
  try {
    globalThis.localStorage?.setItem(SPOKEN_ASKS_STORAGE_KEY, JSON.stringify([...spoken, askId].slice(-SPOKEN_ASKS_KEPT)));
  } catch {
    // Storage unavailable (private mode, quota): this tab speaks; a duplicate is the lesser harm.
  }
  return true;
}

/**
 * Give the question back when this tab could not even fetch its clip, so the claim does not
 * silence every tab for a question nobody was able to speak.
 */
function releaseClaim(askId: string): void {
  try {
    const spoken = readSpoken();
    if (spoken.includes(askId)) {
      globalThis.localStorage?.setItem(SPOKEN_ASKS_STORAGE_KEY, JSON.stringify(spoken.filter((id) => id !== askId)));
    }
  } catch {
    // Storage unavailable: there was no shared claim to give back.
  }
}

/** False only when the browser says outright that nobody has interacted with this page yet. */
function pageMayStartAudio(): boolean {
  const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
  return activation ? activation.hasBeenActive : true;
}

async function claim(askId: string): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return claimLocally(askId);
  try {
    return await locks.request('kookr-lucy-ask-claim', () => claimLocally(askId));
  } catch {
    return claimLocally(askId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Resolves true once nothing is speaking, or false after {@link BUSY_WAIT_MS}. */
function waitForSilence(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // The listener is called at once with the current state, possibly before `unsubscribe` is assigned.
    const off = subscribeSpeechBus((event) => { if (event.type === 'idle') finish(true); });
    unsubscribe = off;
    if (done) off();
  });
}

export interface AnnounceAskOptions {
  fetcher?: typeof fetch;
  /** Test seam for the hidden-tab wait and the busy wait. */
  sleep?: (ms: number) => Promise<void>;
  busyWaitMs?: number;
}

/**
 * Clips are played one after another: two that became ready together would both find Lucy
 * silent, and one would be dropped. Only playing waits in this line. Claiming the question
 * and fetching its clip start at once, so a tab that can speak claims a second question
 * while it is still busy with the first, before a tab that cannot speak takes it.
 */
let playLine: Promise<unknown> = Promise.resolve();

/**
 * Fetch Lucy's spoken version of the pending question `askId` and play it,
 * subject to the rules in this file's header. Never throws.
 */
export function announceAsk(askId: string, options: AnnounceAskOptions = {}): Promise<AskAnnouncementResult> {
  return announceKeyed(askId, { url: `/api/asks/${encodeURIComponent(askId)}/speak` }, options);
}

/** Where a clip comes from: the route to POST, and a JSON body when it needs one. */
interface ClipRequest {
  url: string;
  body?: Record<string, unknown>;
}

/**
 * Lucy says the report of a task she launched (issue #3676), under the same rules as a question: sound off,
 * Do Not Disturb or a blocked browser keep it as an unheard clip, one tab speaks, she waits for Lucy to
 * finish, and reports are spoken one at a time. The server speaks the sentence it kept for the task; only
 * the task id is sent. The dedupe key is `report:<taskId>:<kind>`.
 */
export function announceLaunchReport(
  taskId: string,
  kind: string,
  options: AnnounceAskOptions = {},
): Promise<AskAnnouncementResult> {
  return announceKeyed(`report:${taskId}:${kind}`, { url: LUCY_LAUNCH_REPORT_SPEAK_PATH, body: { taskId } }, options);
}

/** Keys whose announcement has started and not yet finished, so they can be cancelled together. */
const inFlight = new Set<string>();

function announceKeyed(askId: string, request: ClipRequest, options: AnnounceAskOptions): Promise<AskAnnouncementResult> {
  inFlight.add(askId);
  return prepareClip(askId, options, request)
    .then((prepared) => {
      if (typeof prepared === 'string') return prepared;
      const run = playLine.then(() => playClip(askId, prepared.clipId, options));
      playLine = run.catch(() => undefined);
      return run;
    })
    .catch((): AskAnnouncementResult => 'error')
    .finally(() => { inFlight.delete(askId); });
}

/**
 * The clip of a question that closed before or while it was read: stop it, and drop it if nobody
 * heard it. `knownClipId` is for a caller that holds the clip id itself; by then the map entry may
 * already have been removed by {@link stopAskAnnouncement}.
 */
function retireClip(askId: string, knownClipId?: string): void {
  const clipId = knownClipId ?? clipByAsk.get(askId);
  clipByAsk.delete(askId);
  if (!clipId) return;
  if (replayingClipId() === clipId) stopReplay('superseded');
  if (getClip(clipId)?.heard === false) discardLastClip(clipId);
}

/** Claim the question for this tab and fetch its clip. A string is a final result; an object means "ready to play". */
async function prepareClip(askId: string, options: AnnounceAskOptions, request: ClipRequest): Promise<AskAnnouncementResult | { clipId: string }> {
  const fetcher = options.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const wait = options.sleep ?? sleep;
  // A tab that is hidden, or that the browser will not let start audio yet, lets the others go first:
  // if it claimed the question at once, a tab that could have spoken it would stand down for nothing.
  const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
  if (hidden || !pageMayStartAudio()) await wait(HIDDEN_TAB_DELAY_MS);
  if (closedAsks.has(askId)) return 'cancelled';
  if (!(await claim(askId))) return 'other-tab';

  let payload: SpeakAudioResponse | null = null;
  let status = 0;
  try {
    const response = await fetcher(request.url, {
      method: 'POST',
      ...(request.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) } : {}),
      // The server gives the speech service two attempts of 30 s; a request that never answers must not hang forever.
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(SPEAK_FETCH_TIMEOUT_MS) }
        : {}),
    });
    status = response.status;
    if (response.ok) payload = (await response.json().catch(() => null)) as SpeakAudioResponse | null;
  } catch {
    // Network failure or timeout: handled as "no clip" below.
  }
  // 409: closed in the meantime. Anything else without a clip (503: no speech service, 502: it
  // failed, offline): the card alone carries the question. Nothing retries; the claim is given back
  // only so a tab that is still about to try (a hidden one, waiting its turn) is not turned away.
  if (status === 409) return 'cancelled';
  if (!payload || typeof payload.audioBase64 !== 'string') {
    releaseClaim(askId);
    return 'error';
  }

  const clip = captureLastClip({
    clipId: payload.clipId,
    text: payload.text,
    subject: payload.subject,
    audio: base64ToArrayBuffer(payload.audioBase64),
    durationMs: payload.durationMs,
  });
  clipByAsk.set(askId, clip.clipId);
  if (closedAsks.has(askId)) {
    retireClip(askId, clip.clipId);
    return 'cancelled';
  }

  if (!getSoundPreferenceState().enabled) {
    reportClipUnheard(clip.clipId, 'muted');
    return 'muted';
  }
  if (getDndState().enabled) {
    reportClipUnheard(clip.clipId, 'dnd');
    return 'dnd';
  }
  if (!pageMayStartAudio()) {
    reportClipUnheard(clip.clipId, 'audio_suspended');
    return 'blocked';
  }
  return { clipId: clip.clipId };
}

/** Play a fetched clip once Lucy is silent, unless its question closed in the meantime. */
async function playClip(askId: string, clipId: string, options: AnnounceAskOptions): Promise<AskAnnouncementResult> {
  const wait = options.sleep ?? sleep;
  const cancelled = (): AskAnnouncementResult => {
    retireClip(askId, clipId);
    return 'cancelled';
  };
  // She may be talking already (a summary, a hands-free answer, an earlier question): say it when she has finished.
  const busyWaitMs = options.busyWaitMs ?? BUSY_WAIT_MS;
  if (closedAsks.has(askId)) return cancelled();
  if (!(await waitForSilence(busyWaitMs))) return 'blocked';
  if (closedAsks.has(askId)) return cancelled();
  let result: ReplayResult = await replayClip(clipId, 'ask');
  if (result === 'busy' || result === 'cancelled') {
    // A replay or a speaker button got in first: one more try once that one has had time to start and finish.
    await wait(RETRY_PAUSE_MS);
    const silent = await waitForSilence(busyWaitMs);
    if (closedAsks.has(askId)) return cancelled();
    if (!silent) return 'blocked';
    result = await replayClip(clipId, 'ask');
  }
  // It may have closed while the audio was being prepared: do not read out an answered question.
  if (result === 'started' && closedAsks.has(askId)) return cancelled();
  if (result === 'started') return 'started';
  if (result === 'muted') return 'muted';
  if (result === 'blocked' || result === 'busy' || result === 'cancelled') return 'blocked';
  return 'error';
}

/**
 * The question `askId` is no longer pending: stop reading it out if she is in
 * the middle of it, and do not start if she had not begun.
 */
export function stopAskAnnouncement(askId: string): void {
  closedAsks.add(askId);
  if (closedAsks.size > 200) closedAsks.delete(closedAsks.values().next().value as string);
  retireClip(askId);
}

/**
 * The avatar panel is gone: stop what is being read out and cancel every announcement still being
 * prepared or waiting its turn, so no clip is played after the operator switched the panel off.
 */
export function stopAllAskAnnouncements(): void {
  for (const key of [...inFlight, ...clipByAsk.keys()]) stopAskAnnouncement(key);
}

export function __resetAskAnnouncementForTests(): void {
  inFlight.clear();
  clipByAsk.clear();
  closedAsks.clear();
  playLine = Promise.resolve();
}
