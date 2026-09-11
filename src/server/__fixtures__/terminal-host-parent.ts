import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { TerminalHostBackend } from '../terminal-host.js';
import { ViewerConnectionRegistry } from '../viewer-connection-registry.js';

// Unpaid, isolated native fixture: killing this parent must close its host's
// sockets and PTYs, while the exact dtach-backed shell remains recoverable.
async function main() {
  const [directory, dtachBinary] = process.argv.slice(2);
  const backend = await TerminalHostBackend.create({ socketDir: directory, instanceId: 'test', dtachBinary });
  await backend.createSession({ id: 'shell', command: '/bin/bash', args: ['--noprofile', '--norc'] });
  const registry = new ViewerConnectionRegistry();
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (socket instanceof Socket) backend.handoff(req, socket, head, 'shell', { kind: 'owner' }, registry);
    else socket.destroy();
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') process.send?.({ pid: backend.getHostHealth().pid, port: address.port });
  });
}
void main().catch(() => process.exit(1));
