import { parentPort } from 'node:worker_threads';
import { reconstructAbsoluteTuiScreenResult, getReconstructAbsoluteTuiScreenStats,
  type ReconstructAbsoluteTuiScreenOptions } from './absolute-position-tui-screen.js';

if (!parentPort) throw new Error('Terminal reconstruction requires a worker port');
const port = parentPort;
port.on('message', async (request: { id: number; bytes: Uint8Array; options: ReconstructAbsoluteTuiScreenOptions }) => {
  try {
    // The existing global/per-session scheduler runs here, not again in the
    // host. Cooperatively yielding lets it admit bounded concurrent requests.
    const result = await reconstructAbsoluteTuiScreenResult(request.bytes, { ...request.options, concurrencyCap: true });
    port.postMessage({ id: request.id, result, stats: getReconstructAbsoluteTuiScreenStats() });
  } catch {
    port.postMessage({ id: request.id, result: { kind: 'unavailable', reason: 'busy', bytes: null,
      consumedBytes: 0, totalBytes: request.bytes.length }, stats: getReconstructAbsoluteTuiScreenStats() });
  }
});
