import { float32ToWav } from './whisper-backend.js';
import { sentencesFromQwenAlignment } from './qwen-sentences.js';

const QWEN_ASR_URL = process.env.QWEN_ASR_URL || 'http://kookr-stt-whisper:8010';
const QWEN_ASR_MODEL = process.env.QWEN_ASR_MODEL || 'Qwen/Qwen3-ASR-0.6B';
const configuredTimeout = Number(process.env.QWEN_ASR_TIMEOUT_MS || '60000');
const QWEN_ASR_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout : 60000;
const SAMPLE_RATE = 16000;

/** @type {import('./types.js').TranscriptionBackend} */
export const qwenBackend = {
  name: 'qwen',
  modelName: QWEN_ASR_MODEL,

  async transcribe(audioWindow, { language = 'auto', signal } = {}) {
    const formData = new FormData();
    formData.append('file', new Blob([float32ToWav(audioWindow)], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', QWEN_ASR_MODEL);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    if (language !== 'auto') formData.append('language', language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QWEN_ASR_TIMEOUT_MS);
    try {
      const response = await fetch(`${QWEN_ASR_URL}/v1/audio/transcriptions`, {
        method: 'POST', body: formData,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) throw new Error(`Qwen ASR API error: ${response.status} ${response.statusText}`);
      const data = await response.json();
      if (typeof data?.text !== 'string') throw new Error('Qwen ASR API returned a missing transcript');
      const text = data.text.trim();
      return {
        text,
        recognition: data.recognition ?? null,
        sentences: sentencesFromQwenAlignment(text, data.words, audioWindow.length / SAMPLE_RATE),
      };
    } finally {
      clearTimeout(timeout);
    }
  },

  async getHealth() {
    const response = await fetch(`${QWEN_ASR_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    return {
      ready: response.ok && data?.status === 'ok' && data.model_loaded === true
        && data.model_name === QWEN_ASR_MODEL && data.device === 'cuda',
      modelName: typeof data?.model_name === 'string' ? data.model_name : 'unknown',
      device: typeof data?.device === 'string' ? data.device : 'unknown',
      runtimeBackend: typeof data?.runtime_backend === 'string' ? data.runtime_backend : 'unknown',
      configId: typeof data?.config_id === 'string' ? data.config_id : '',
    };
  },
};
