/**
 * Build the STT service health payload.
 *
 * @param {Object} input
 * @param {boolean} input.modelLoaded
 * @param {string} input.modelName
 * @param {{backend: string, device: string}} input.runtimeInfo
 * @param {import('./backends/types.js').TranscriptionBackend} input.transcriptionBackend
 * @returns {{
 *   status: string,
 *   model_loaded: boolean,
 *   model_name: string,
 *   backend: string,
 *   device: string,
 *   runtime_backend: string,
 *   runtime_device: string,
 *   progressive_streaming: boolean,
 *   supported_languages: number
 * }}
 */
export function createHealthPayload({
  modelLoaded,
  modelName,
  runtimeInfo,
  transcriptionBackend,
}) {
  const activeBackend = transcriptionBackend.name;
  const activeDevice = activeBackend === 'whisper' ? 'gpu' : runtimeInfo.device;

  return {
    status: 'ok',
    model_loaded: modelLoaded,
    model_name: modelName,
    backend: activeBackend,
    device: activeDevice,
    runtime_backend: runtimeInfo.backend,
    runtime_device: runtimeInfo.device,
    progressive_streaming: true,
    supported_languages: activeBackend === 'whisper' ? 99 : 25,
  };
}
