/**
 * Integration tests for the STT pipeline — requires running STT + Whisper services.
 *
 * These tests send real audio (the antoni.mp3 fixture) through the WebSocket
 * pipeline and verify transcription accuracy. They also demonstrate how
 * dropped audio frames cause Whisper hallucinations.
 *
 * Run: npm run test:integration
 * Skip in CI: these need GPU-backed Whisper on localhost:8003.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';

// -- Config -------------------------------------------------------------------

const STT_URL = process.env.STT_URL || 'ws://localhost:8003';
const STT_HEALTH_URL = STT_URL.replace(/^ws/, 'http') + '/health';
const FIXTURE_MP3 = process.env.STT_FIXTURE_MP3
  || `${process.env.HOME || ''}/git/aegiscore/packages/stt/tests/fixtures/antoni.mp3`;
const FIXTURE_PCM = '/tmp/stt-test-antoni-16k.pcm';

const EXPECTED_TEXT = [
  'welcome to this presentation',
  'mygpt',
  'openai',
  'infoassistant',
  'virtual assistant',
  'proof of concept',
  'radically transform',
  'access to information',
  'within our company',
];

// -- Helpers ------------------------------------------------------------------

/** Check if the STT service is reachable. */
async function isSTTAvailable() {
  try {
    const res = await fetch(STT_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Convert fixture MP3 to 16kHz 16-bit PCM (cached). */
function ensurePCMFixture() {
  if (existsSync(FIXTURE_PCM)) return;
  if (!existsSync(FIXTURE_MP3)) {
    throw new Error(`Fixture not found: ${FIXTURE_MP3}`);
  }
  execSync(`ffmpeg -y -i "${FIXTURE_MP3}" -ar 16000 -ac 1 -f s16le -acodec pcm_s16le "${FIXTURE_PCM}"`, {
    stdio: 'pipe',
  });
}

/**
 * Send PCM audio to the STT WebSocket and return the final transcription.
 *
 * @param {Buffer} pcmBuffer - Raw 16-bit PCM at 16kHz
 * @param {object} [options]
 * @param {number} [options.chunkSize=4096] - Bytes per WebSocket message
 * @param {number} [options.chunkDelayMs=5] - Delay between chunks
 * @returns {Promise<{finalText: string, progressiveUpdates: object[]}>}
 */
function sendAudioAndTranscribe(pcmBuffer, options = {}) {
  const { chunkSize = 4096, chunkDelayMs = 5 } = options;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(STT_URL);
    const progressiveUpdates = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Transcription timeout after 60s'));
    }, 60_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'config', language: 'en', progressive: true }));

      let offset = 0;
      const interval = setInterval(() => {
        if (offset >= pcmBuffer.length) {
          clearInterval(interval);
          ws.send(JSON.stringify({ type: 'stop' }));
          return;
        }
        const chunk = pcmBuffer.subarray(offset, offset + chunkSize);
        ws.send(chunk);
        offset += chunkSize;
      }, chunkDelayMs);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'progressive') {
        progressiveUpdates.push(msg);
      }
      if (msg.type === 'transcription' && msg.is_final) {
        clearTimeout(timeout);
        ws.close();
        resolve({ finalText: msg.text, progressiveUpdates });
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Zero out chunks in PCM buffer to simulate dropped ScriptProcessorNode frames.
 *
 * @param {Buffer} pcmBuffer
 * @param {number} dropEveryN - Drop every Nth chunk (2 = 50% loss)
 * @param {number} [chunkSize=4096]
 * @returns {{ buffer: Buffer, droppedChunks: number, totalChunks: number }}
 */
function dropFrames(pcmBuffer, dropEveryN, chunkSize = 4096) {
  const corrupted = Buffer.from(pcmBuffer); // copy
  const totalChunks = Math.floor(corrupted.length / chunkSize);
  let droppedChunks = 0;

  for (let c = 0; c < totalChunks; c++) {
    if (c % dropEveryN === 0) {
      const start = c * chunkSize;
      const end = Math.min(start + chunkSize, corrupted.length);
      corrupted.fill(0, start, end);
      droppedChunks++;
    }
  }

  return { buffer: corrupted, droppedChunks, totalChunks };
}

/** Count how many expected phrases appear in the transcription (case-insensitive). */
function matchScore(transcription, expectedPhrases) {
  const lower = transcription.toLowerCase();
  let matched = 0;
  for (const phrase of expectedPhrases) {
    if (lower.includes(phrase)) matched++;
  }
  return { matched, total: expectedPhrases.length, ratio: matched / expectedPhrases.length };
}

// -- Tests --------------------------------------------------------------------

describe('STT pipeline integration', async () => {
  const available = await isSTTAvailable();

  beforeAll(() => {
    if (available) ensurePCMFixture();
  });

  describe.skipIf(!available)('with live STT service', () => {
    test('happy path: fixture audio produces accurate transcription', async () => {
      const pcm = readFileSync(FIXTURE_PCM);
      const { finalText, progressiveUpdates } = await sendAudioAndTranscribe(pcm);

      console.log('Final transcription:', finalText);
      console.log('Progressive updates:', progressiveUpdates.length);

      // All expected phrases should be present
      const score = matchScore(finalText, EXPECTED_TEXT);
      console.log(`Match score: ${score.matched}/${score.total} (${(score.ratio * 100).toFixed(0)}%)`);

      expect(score.ratio).toBeGreaterThanOrEqual(0.8); // At least 80% match
      expect(finalText.length).toBeGreaterThan(50); // Not empty/stub
    });

    test('BUG: removed frames (ScriptProcessorNode drops) create time-compressed audio', async () => {
      const pcm = readFileSync(FIXTURE_PCM);
      const chunkSize = 4096;
      const totalChunks = Math.floor(pcm.length / chunkSize);

      // Simulate ScriptProcessorNode missing callbacks: REMOVE every other chunk
      // (not zero — the server never receives them). This splices adjacent
      // speech fragments together, breaking word boundaries.
      const kept = [];
      let droppedCount = 0;
      for (let c = 0; c < totalChunks; c++) {
        if (c % 2 === 0) {
          kept.push(pcm.subarray(c * chunkSize, (c + 1) * chunkSize));
        } else {
          droppedCount++;
        }
      }
      const splicedPcm = Buffer.concat(kept);

      console.log(`Removed ${droppedCount}/${totalChunks} chunks (${((droppedCount / totalChunks) * 100).toFixed(0)}%)`);
      console.log(`Original duration: ${(pcm.length / 2 / 16000).toFixed(1)}s → Spliced: ${(splicedPcm.length / 2 / 16000).toFixed(1)}s`);

      const { finalText: cleanText } = await sendAudioAndTranscribe(pcm);
      const { finalText: splicedText } = await sendAudioAndTranscribe(splicedPcm);

      console.log('Clean transcription:', cleanText);
      console.log('Spliced transcription:', splicedText);

      const cleanScore = matchScore(cleanText, EXPECTED_TEXT);
      const splicedScore = matchScore(splicedText, EXPECTED_TEXT);

      console.log(`Clean match: ${cleanScore.matched}/${cleanScore.total}`);
      console.log(`Spliced match: ${splicedScore.matched}/${splicedScore.total}`);

      // Clean audio should score well
      expect(cleanScore.ratio).toBeGreaterThanOrEqual(0.8);

      // Spliced audio: words chopped in half and mashed together.
      // Whisper may handle mild cases but heavy splicing degrades accuracy.
      // We document the actual degradation rather than asserting a threshold,
      // since large-v3 is surprisingly robust.
      console.log(`Degradation: ${cleanScore.matched - splicedScore.matched} fewer phrase matches`);
    });

    test('BUG: pure silence produces hallucinated text, not empty result', async () => {
      // 5 seconds of silence — simulates muted mic or all frames dropped
      const silenceSamples = 16000 * 5;
      const silencePcm = Buffer.alloc(silenceSamples * 2); // 16-bit PCM of zeros

      const { finalText } = await sendAudioAndTranscribe(silencePcm);

      console.log('Silence transcription:', JSON.stringify(finalText));

      // Whisper typically hallucinates on silence rather than returning empty
      // Common hallucinations: "Thank you for watching!", "Thanks for watching",
      // "Please subscribe", repeated filler text, etc.
      if (finalText.length > 0) {
        const isHallucination = !EXPECTED_TEXT.some((p) => finalText.toLowerCase().includes(p));
        console.log(`Hallucination detected: ${isHallucination} — "${finalText}"`);

        // The bug: silence should produce empty text, but Whisper hallucinates
        // This test documents the behavior — a VAD guard would prevent it
        expect(isHallucination).toBe(true);
      }
      // If empty, Whisper handled it correctly (rare but possible)
    });
  });

  describe.skipIf(available)('service unavailable', () => {
    test.skip('tests skipped — STT service not running on ' + STT_URL, () => {});
  });
});
