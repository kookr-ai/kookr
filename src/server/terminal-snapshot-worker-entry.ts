import { parentPort } from 'node:worker_threads';
import { snapshotStreamingAttachSeed, type StreamingAttachSnapshotOptions } from './streaming-attach-snapshot.js';

if (!parentPort) throw new Error('Terminal snapshot requires a worker port');
const port = parentPort;
port.on('message', async (request: { id: number; bytes: Uint8Array; options: StreamingAttachSnapshotOptions }) => {
  try {
    // One job at a time: the module's own slot queues the rest, in this thread.
    port.postMessage({ id: request.id, result: await snapshotStreamingAttachSeed(request.bytes, request.options) });
  } catch {
    port.postMessage({ id: request.id, result: { kind: 'unavailable', reason: 'failed', elapsedMs: 0 } });
  }
});
