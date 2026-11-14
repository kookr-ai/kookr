// @vitest-environment happy-dom
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

describe('happy-dom offline setup', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('rejects a relative fetch the way jsdom (Node fetch) does', async () => {
    await expect(fetch('/api/health')).rejects.toBeInstanceOf(TypeError);
  });

  it('never reaches a listening local server', async () => {
    let hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    await expect(fetch(`http://127.0.0.1:${port}/api/tasks`)).rejects.toBeInstanceOf(TypeError);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `http://127.0.0.1:${port}/api/sync`, false);
    try {
      xhr.send();
    } catch {
      // happy-dom may surface the refused request as a throw or as status 0.
    }
    expect(xhr.status).toBe(0);
    expect(hits).toBe(0);
  });
});
