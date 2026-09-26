/**
 * Build the STT service health payload.
 *
 * @param {Object} input
 * @param {boolean} input.modelLoaded
 * @param {string} input.modelName
 * @param {{backend: string, device: string}} input.runtimeInfo
 * @param {import('./backends/types.js').TranscriptionBackend} input.transcriptionBackend
 * @param {{ready: boolean, modelName: string, device: string, runtimeBackend: string, configId?: string}} [input.backendHealth]
 * @returns {{
 *   status: string,
 *   model_loaded: boolean,
 *   model_name: string,
 *   backend: string,
 *   device: string,
 *   runtime_backend: string,
 *   runtime_device: string,
 *   progressive_streaming: boolean,
 *   supported_languages: number,
 *   config_id?: string
 * }}
 */
export function createHealthPayload({
  modelLoaded,
  modelName,
  runtimeInfo,
  transcriptionBackend,
  backendHealth,
}) {
  const activeBackend = transcriptionBackend.name;
  if (activeBackend === 'qwen') {
    return {
      status: backendHealth?.ready ? 'ok' : 'unavailable',
      model_loaded: backendHealth?.ready === true,
      model_name: backendHealth?.modelName ?? 'unknown',
      backend: activeBackend,
      device: backendHealth?.device ?? 'unknown',
      runtime_backend: backendHealth?.runtimeBackend ?? 'unknown',
      runtime_device: backendHealth?.device ?? 'unknown',
      progressive_streaming: true,
      supported_languages: 30,
      config_id: backendHealth?.configId ?? '',
    };
  }
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
