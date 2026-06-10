/**
 * Export matrix — derives every distribution format from the single narrated
 * master WebM so one recording feeds YouTube, X/LinkedIn, Shorts/Reels/TikTok,
 * and the README hero loop.
 *
 * All functions throw on ffmpeg failure; callers decide whether a given
 * format is fatal or skippable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CutSegment } from './timeline.js';

const execFileAsync = promisify(execFile);

const H264_ARGS = ['-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const AAC_ARGS = ['-c:a', 'aac', '-b:a', '160k'];

async function ffmpeg(args: string[], timeoutMs = 600_000): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: timeoutMs });
}

/** Probe a media file's duration in milliseconds. */
export async function probeDurationMs(path: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Math.round(parseFloat(stdout.trim()) * 1000);
}

/** 1080p H.264 + AAC MP4 — native upload format for X and LinkedIn. */
export async function exportSocialMp4(src: string, out: string): Promise<void> {
  await ffmpeg(['-i', src, ...H264_ARGS, '-crf', '20', ...AAC_ARGS, out]);
}

/** 4K lanczos upscale — high-bitrate release asset. */
export async function export4kMp4(src: string, out: string): Promise<void> {
  // AAC (not opus→opus): in ffmpeg 4.4, double-opus encoding silently
  // truncated the trailing ~10s of narration on this pipeline.
  await ffmpeg([
    '-i', src,
    '-vf', 'scale=3840:2160:flags=lanczos',
    ...H264_ARGS, '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k',
    out,
  ]);
}

/**
 * 9:16 1080x1920 vertical cut for Shorts / Reels / TikTok. The 16:9 frame is
 * scaled to full width and centered over a blurred, zoom-filled copy of
 * itself so the vertical canvas has no black bars.
 */
export async function exportVerticalMp4(src: string, out: string): Promise<void> {
  const filter = [
    '[0:v]split=2[bg][fg]',
    '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8[bgb]',
    '[fg]scale=1080:-2[fgs]',
    '[bgb][fgs]overlay=(W-w)/2:(H-h)/2[vout]',
  ].join(';');
  await ffmpeg([
    '-i', src,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '0:a?',
    ...H264_ARGS, '-crf', '21', ...AAC_ARGS,
    out,
  ]);
}

/**
 * Short teaser cut (with audio) concatenated from timeline segments —
 * attention-span format for X/LinkedIn timelines.
 */
export async function exportTeaserMp4(src: string, out: string, segments: CutSegment[]): Promise<void> {
  if (segments.length === 0) throw new Error('exportTeaserMp4: no segments resolved');
  const parts: string[] = [];
  const concatInputs: string[] = [];
  segments.forEach((seg, i) => {
    const start = (seg.startMs / 1000).toFixed(3);
    const end = (seg.endMs / 1000).toFixed(3);
    parts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  parts.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
  await ffmpeg([
    '-i', src,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...H264_ARGS, '-crf', '20', ...AAC_ARGS,
    out,
  ]);
}

/** Silent 1280px-wide MP4 loop of the best moment — README hero / social cards. */
export async function exportLoopMp4(src: string, out: string, startMs: number, durationMs: number): Promise<void> {
  // -ss/-t as OUTPUT options (after -i): decode-accurate cut. As input
  // options they fast-seek to the nearest prior VP8 keyframe, which can
  // shift the loop's start by several seconds.
  await ffmpeg([
    '-i', src,
    '-ss', (startMs / 1000).toFixed(3),
    '-t', (durationMs / 1000).toFixed(3),
    '-vf', 'scale=1280:-2',
    '-an',
    ...H264_ARGS, '-crf', '22',
    out,
  ]);
}

/** GIF of the same loop (GitHub READMEs autoplay GIFs). Palette two-pass in one graph. */
export async function exportLoopGif(src: string, out: string, startMs: number, durationMs: number): Promise<void> {
  const filter = '[0:v]fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
  await ffmpeg([
    '-i', src,
    '-ss', (startMs / 1000).toFixed(3),
    '-t', (durationMs / 1000).toFixed(3),
    '-filter_complex', filter,
    out,
  ]);
}

/** First audio file found in demo/assets/music/, or null. */
export function findMusicBed(musicDir: string): string | null {
  if (!existsSync(musicDir)) return null;
  const file = readdirSync(musicDir)
    .filter((f) => /\.(mp3|wav|m4a|ogg|flac)$/i.test(f))
    .sort()[0];
  return file ? join(musicDir, file) : null;
}

/**
 * Mix a low-volume music bed under the narration. The bed loops to cover the
 * full video, fades in over 2s and out over the final 3s. Narration stays
 * untouched (no normalization).
 */
export async function mixMusicBed(src: string, musicPath: string, out: string, videoDurationMs: number): Promise<void> {
  const fadeOutStart = Math.max(0, videoDurationMs / 1000 - 3);
  const filter = [
    `[1:a]volume=0.09,afade=t=in:d=2,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=3[bed]`,
    '[0:a][bed]amix=inputs=2:duration=first:normalize=0[aout]',
  ].join(';');
  await ffmpeg([
    '-i', src,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'libopus',
    '-shortest',
    out,
  ]);
}
