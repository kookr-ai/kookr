/** CPU-only sidecar fixture: use the shipped protocol, writer and HTTP API.
 * Holding the final directory rename reproduces slow storage without replacing
 * corpus behavior with a mock API or touching an operator's corpus.
 */
import fs from 'node:fs/promises';

let hold = false;
let fail = false;
let release = [];
const rename = fs.rename.bind(fs);
fs.rename = async (from, to) => {
  if (String(from).includes('/.pending-')) {
    if (hold) await new Promise(resolve => release.push(resolve));
    if (fail) throw new Error('Controlled corpus publication failure');
  }
  return rename(from, to);
};
process.on('message', message => {
  if (message.action === 'hold') hold = true;
  if (message.action === 'fail') fail = true;
  if (message.action === 'release') {
    hold = false;
    fail = false;
    const pending = release;
    release = [];
    pending.forEach(resolve => resolve());
  }
  process.send?.({ id: message.id });
});

const { httpServer } = await import('../stt/src/server.js');
// startServer also loads model/VAD resources. The deterministic HTTP inference
// fixture needs neither, and all recognition/capture paths remain real here.
httpServer.listen(0, '127.0.0.1', () => {
  console.log(`CORPUS_STT_PORT=${httpServer.address().port}`);
});
