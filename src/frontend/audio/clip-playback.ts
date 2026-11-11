/**
 * Playback bookkeeping for Lucy's spoken clips, shared by the two ways a clip
 * can be played:
 *
 * - live: the speaker button on a task fetches a summary and plays it
 *   (`hooks/useSpeakAgent.ts`);
 * - replay: the avatar panel's "Replay last message" button plays the clip
 *   remembered in `last-clip.ts` again (`replayLastClip` below).
 *
 * Both announce themselves on the speech bus, so the avatar lip-syncs, shows
 * the caption and the "speaking" state identically. Both also go through
 * `beginClipPlayback`, which owns two things in one place: the rule for when a
 * clip counts as heard, and the `lucy_clip_started` / `lucy_clip_ended`
 * telemetry events.
 */
import { track } from '../telemetry.js';
import { getAvatarPanelPrefs } from '../store/avatar-panel-prefs.js';
import { getSoundPreferenceState } from './sound-preference.js';
import { emitSpeechIdle, emitSpeechPlaying } from './speech-bus.js';
import { getLastClip, markClipHeard } from './last-clip.js';

export type ClipTrigger = 'click' | 'replay';
export type ClipEndedBy = 'finished' | 'user_stop' | 'superseded' | 'error';
export type ClipUnheardReason = 'muted' | 'dnd' | 'audio_suspended' | 'error';

/** A clip counts as heard when at least this share of it played while the tab was visible. */
export const HEARD_FRACTION = 0.8;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function panelState(): 'open' | 'minimized' | 'off' {
  const prefs = getAvatarPanelPrefs();
  if (!prefs.enabled) return 'off';
  return prefs.minimized ? 'minimized' : 'open';
}

/** Report that a clip arrived but the operator did not get to hear it. */
export function reportClipUnheard(clipId: string, reason: ClipUnheardReason): void {
  track({ type: 'lucy_clip_unheard', clipId, reason });
}

export interface ClipPlayback {
  /** Close the playback. Safe to call more than once; only the first call counts. */
  end(endedBy: ClipEndedBy): void;
}

/**
 * Call when a clip's audio has actually started. Emits `lucy_clip_started`,
 * watches how long the tab stays visible while the clip plays, and on `end()`
 * emits `lucy_clip_ended` and marks the clip heard when at least
 * {@link HEARD_FRACTION} of it played with the tab visible. Whether it finished
 * or was stopped does not matter: what counts is how much the operator could
 * have listened to.
 *
 * `totalMs` is the clip length; pass 0 when unknown, in which case only a clip
 * that finished (with some visible time) counts as heard.
 */
export function beginClipPlayback(opts: { clipId: string; totalMs: number; trigger: ClipTrigger }): ClipPlayback {
  const { clipId, trigger } = opts;
  const totalMs = Number.isFinite(opts.totalMs) && opts.totalMs > 0 ? Math.round(opts.totalMs) : 0;
  const startedAt = nowMs();
  let visibleSince: number | null = tabVisible() ? startedAt : null;
  let visibleMs = 0;
  let ended = false;

  const onVisibility = (): void => {
    const at = nowMs();
    if (tabVisible()) {
      if (visibleSince === null) visibleSince = at;
    } else if (visibleSince !== null) {
      visibleMs += at - visibleSince;
      visibleSince = null;
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  track({ type: 'lucy_clip_started', clipId, trigger, panelState: panelState(), tabVisible: tabVisible() });

  return {
    end(endedBy) {
      if (ended) return;
      ended = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      const at = nowMs();
      if (visibleSince !== null) visibleMs += at - visibleSince;
      const wallMs = Math.max(0, at - startedAt);
      const playedMs = Math.round(totalMs > 0 ? Math.min(wallMs, totalMs) : wallMs);
      track({ type: 'lucy_clip_ended', clipId, endedBy, playedMs, totalMs: totalMs > 0 ? totalMs : playedMs });
      const heard = totalMs > 0
        ? visibleMs >= totalMs * HEARD_FRACTION
        : endedBy === 'finished' && visibleMs > 0;
      if (heard) markClipHeard(clipId);
    },
  };
}

// --- replay ---

export type ReplayResult =
  /** Playing now. */
  | 'started'
  | 'no-clip'
  /** Sound is switched off in Settings; replay respects that. */
  | 'muted'
  /** A replay is already starting or playing. */
  | 'busy'
  /** The browser has no audio, or the audio failed to decode/start. */
  | 'error'
  /** The browser refused to start audio (autoplay policy / suspended context). */
  | 'blocked';

interface ActiveReplay {
  clipId: string;
  ctx: AudioContext;
  source: AudioBufferSourceNode;
  playback: ClipPlayback;
}

/** Identifies replay on the speech bus, so only replay can announce its own end (see speech-bus.ts). */
const replayOwner = { name: 'replay' };
let active: ActiveReplay | null = null;
let starting = false;

export function isReplaying(): boolean {
  return active !== null || starting;
}

function release(replay: ActiveReplay): void {
  try { replay.source.stop(); } catch {}
  try { replay.source.disconnect(); } catch {}
  if (replay.ctx.state !== 'closed') void replay.ctx.close();
}

function finishReplay(replay: ActiveReplay, endedBy: ClipEndedBy): void {
  if (active !== replay) return;
  active = null;
  replay.playback.end(endedBy);
  release(replay);
  emitSpeechIdle(replayOwner);
}

/** Cut a replay short, e.g. because a live clip is about to start or the panel went away. No-op when idle. */
export function stopReplay(endedBy: 'user_stop' | 'superseded'): void {
  if (active) finishReplay(active, endedBy);
}

/**
 * Play the remembered clip again. Must be called from a user gesture (a click):
 * the audio context is created and resumed right away so the browser lets it
 * play even if the original clip was blocked for lack of one.
 *
 * Respects an explicit "sound off" in Settings, like the speaker buttons do. It
 * deliberately does not look at Do Not Disturb: that silences unprompted alerts,
 * and this is the operator asking to hear something right now.
 */
export async function replayLastClip(): Promise<ReplayResult> {
  const clip = getLastClip();
  if (!clip) return 'no-clip';
  if (!getSoundPreferenceState().enabled) return 'muted';
  if (isReplaying()) return 'busy';
  if (typeof AudioContext === 'undefined') {
    reportClipUnheard(clip.clipId, 'error');
    return 'error';
  }

  starting = true;
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    // Started inside the click so it counts as user activation; awaited after decoding.
    const unlock = ctx.state === 'suspended' && typeof ctx.resume === 'function' ? ctx.resume() : Promise.resolve();
    // decodeAudioData takes ownership of the bytes it is given, so hand it a copy and keep ours for the next replay.
    const buffer = await ctx.decodeAudioData(clip.audio.slice(0));
    await unlock;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const durationMs = clip.durationMs > 0 ? clip.durationMs : buffer.duration * 1000;
    const replay: ActiveReplay = {
      clipId: clip.clipId,
      ctx,
      source,
      playback: { end() {} },
    };
    source.onended = () => finishReplay(replay, 'finished');
    source.start();

    if (ctx.state !== 'running') {
      release(replay);
      reportClipUnheard(clip.clipId, 'audio_suspended');
      return 'blocked';
    }

    replay.playback = beginClipPlayback({ clipId: clip.clipId, totalMs: durationMs, trigger: 'replay' });
    active = replay;
    emitSpeechPlaying(replayOwner, ctx, source, clip.text);
    return 'started';
  } catch {
    if (ctx && ctx.state !== 'closed') void ctx.close();
    reportClipUnheard(clip.clipId, 'error');
    return 'error';
  } finally {
    starting = false;
  }
}

export function __resetClipPlaybackForTests(): void {
  active = null;
  starting = false;
}
