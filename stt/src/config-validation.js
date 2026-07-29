/**
 * Validation for the STT WebSocket `config` control message.
 *
 * The client can send `{"type":"config","language":"en","progressive":true}`.
 * Without validation an arbitrary `language` is reflected back and a non-boolean
 * `progressive` (e.g. the string `"false"`) stays truthy. This helper clamps
 * both fields to trusted values so `config_ack` never echoes unvalidated input.
 *
 * FR-STT-010: Parakeet STT Backend
 */

/** Languages the sidecar accepts by default (the Parakeet model is English). */
export const DEFAULT_SUPPORTED_LANGUAGES = ['en'];

/**
 * Normalize a client `config` message against trusted defaults.
 *
 * A field is only overridden when it is present in `data`. A present-but-invalid
 * `language` (non-string or not in the allow-list) falls back to `defaultLanguage`;
 * a present-but-non-boolean `progressive` falls back to `defaultProgressive`.
 *
 * @param {Record<string, unknown>} data Parsed client message.
 * @param {object} [options]
 * @param {string} [options.currentLanguage] Value to keep when `language` is absent.
 * @param {boolean} [options.currentProgressive] Value to keep when `progressive` is absent.
 * @param {string} [options.defaultLanguage] Fallback for an invalid `language`.
 * @param {boolean} [options.defaultProgressive] Fallback for an invalid `progressive`.
 * @param {string[]} [options.supportedLanguages] Allow-list of accepted languages.
 * @returns {{ language: string, progressive: boolean }}
 */
export function normalizeConfigMessage(data, options = {}) {
  const {
    currentLanguage,
    currentProgressive,
    defaultLanguage = 'en',
    defaultProgressive = true,
    supportedLanguages = DEFAULT_SUPPORTED_LANGUAGES,
  } = options;

  let language = currentLanguage ?? defaultLanguage;
  let progressive = currentProgressive ?? defaultProgressive;

  if (data && typeof data === 'object' && 'language' in data) {
    const candidate = data.language;
    language =
      typeof candidate === 'string' && supportedLanguages.includes(candidate)
        ? candidate
        : defaultLanguage;
  }

  if (data && typeof data === 'object' && 'progressive' in data) {
    progressive = typeof data.progressive === 'boolean' ? data.progressive : defaultProgressive;
  }

  return { language, progressive };
}
