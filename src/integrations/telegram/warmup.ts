/**
 * Startup warmup for faster-whisper-server.
 *
 * faster-whisper-server loads the configured model lazily on the first real
 * transcription request. Sending a tiny silent OGG/Opus clip once at Telegram
 * integration startup shifts that cold-start cost out of the first user voice
 * message. See issue #584.
 */

import type { AuditWriter } from './audit.js';
import { transcribeVoice } from './transcribe.js';

const WARMUP_FILENAME = 'kookr-warmup.ogg';

// 1s mono silent OGG/Opus generated with:
// ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -c:a libopus -b:a 12k -application voip -vbr off -f ogg silent.ogg
const SILENT_OGG_OPUS_BASE64 = [
  'T2dnUwACAAAAAAAAAADkkVcoAAAAAP4KFQYBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAOSRVygBAAAAKr+qDAE/T3B1c1RhZ3MNAAAATGF2',
  'ZjU4Ljc2LjEwMAEAAAAeAAAAZW5jb2Rlcj1MYXZjNTguMTM0LjEwMCBsaWJvcHVzT2dnUwAAgLsAAAAAAADkkVcoAgAAAGJdghkyHh4eHh4eHh4eHh4eHh4e',
  'Hh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh5LQRQL5FXGdNmIAAAAAAAAAAAAAAAAAAAAAAAAAABLQRMG43In4UTqUAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAAAAAAAABLQRQG43nIyVfAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAABPZ2dTAAS4vAAAAAAAAOSRVygDAAAAliY8SQEeS0EUBuN5yMlXwAAAAAAAAAAAAAAAAAAAAAAAAAAA',
].join('');

const SILENT_OGG_OPUS = Buffer.from(SILENT_OGG_OPUS_BASE64, 'base64');

interface WarmupLogger {
  log(message: string): void;
  warn(message: string): void;
}

interface VoiceWarmupOpts {
  whisperUrl: string;
  timeoutMs: number;
  audit: AuditWriter;
  logger?: WarmupLogger;
  /**
   * External shutdown signal. When aborted, in-flight warmup is cancelled
   * before STT containers are torn down and the failure is logged distinctly
   * (info, not warn) so operators don't read it as a user-facing warmup
   * regression. See issue #188.
   */
  lifecycleSignal?: AbortSignal;
}

interface VoiceWarmupHandle {
  done: Promise<void>;
  stop(): Promise<void>;
}

interface WarmupRunOpts {
  whisperUrl: string;
  timeoutMs: number;
  audit: AuditWriter;
  logger?: WarmupLogger;
  signal: AbortSignal;
  lifecycleSignal?: AbortSignal;
}

async function warmupWhisper(opts: WarmupRunOpts): Promise<void> {
  const startedAt = Date.now();
  try {
    await transcribeVoice(SILENT_OGG_OPUS, {
      whisperUrl: opts.whisperUrl,
      timeoutMs: opts.timeoutMs,
      filename: WARMUP_FILENAME,
      signal: opts.signal,
    });
    const okMs = Date.now() - startedAt;
    opts.audit({ kind: 'voice_warmup', okMs });
    opts.logger?.log(`[telegram] voice warmup: ok in ${(okMs / 1000).toFixed(1)} s`);
  } catch (err) {
    if (opts.lifecycleSignal?.aborted) {
      // Shutdown raced the warmup: STT teardown invalidated the in-flight
      // whisper request. Log at info, not warn — this is expected lifecycle
      // behaviour, not a startup health failure. The "first user message
      // will pay the cold-start cost" wording stays out of this branch on
      // purpose: no real user is going to send a message at this point.
      const cancelledMs = Date.now() - startedAt;
      opts.audit({ kind: 'voice_warmup', cancelledMs, cancelled: 'shutdown' });
      opts.logger?.log(
        `[telegram] voice warmup cancelled by shutdown after ${(cancelledMs / 1000).toFixed(1)} s`,
      );
      return;
    }
    if (opts.signal.aborted) return;
    const errMs = Date.now() - startedAt;
    const reason = err instanceof Error ? err.message : String(err);
    opts.audit({ kind: 'voice_warmup', errMs, reason });
    opts.logger?.warn(`[telegram] voice warmup FAILED: ${reason} - first user message will pay the cold-start cost`);
  }
}

export function startVoiceWarmup(opts: VoiceWarmupOpts): VoiceWarmupHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const controller = new AbortController();

  // Cascade external shutdown into the internal controller so the in-flight
  // whisper fetch aborts before STT containers are torn down — transcribeVoice
  // wires its fetch to opts.signal, so the abort propagates end-to-end.
  const onLifecycleAbort = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      resolveDone();
    }
    controller.abort();
  };
  if (opts.lifecycleSignal?.aborted) {
    // Shutdown already in progress before this warmup was scheduled — never
    // run the request at all.
    onLifecycleAbort();
  } else {
    opts.lifecycleSignal?.addEventListener('abort', onLifecycleAbort, { once: true });
  }

  timer = setTimeout(() => {
    timer = null;
    if (controller.signal.aborted) {
      resolveDone();
      return;
    }
    void warmupWhisper({
      whisperUrl: opts.whisperUrl,
      timeoutMs: opts.timeoutMs,
      audit: opts.audit,
      logger: opts.logger,
      signal: controller.signal,
      lifecycleSignal: opts.lifecycleSignal,
    }).finally(() => {
      opts.lifecycleSignal?.removeEventListener('abort', onLifecycleAbort);
      resolveDone();
    });
  }, 0);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    done,
    async stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        opts.lifecycleSignal?.removeEventListener('abort', onLifecycleAbort);
        resolveDone();
      }
      controller.abort();
      await done;
    },
  };
}
