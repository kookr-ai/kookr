import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { TelegramApiClient, TelegramDownloadTooLargeError } from './api-client.js';

async function withServer(handler: Parameters<typeof createServer>[0]): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('TelegramApiClient.downloadFile', () => {
  it('returns streamed file bytes when the payload stays under the cap', async () => {
    const srv = await withServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/file/bottoken/audio/ok.oga');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.write(Buffer.from('hello '));
      res.end(Buffer.from('world'));
    });
    try {
      const client = new TelegramApiClient('token', srv.baseUrl);
      await expect(client.downloadFile('audio/ok.oga', 1000, 64)).resolves.toEqual(Buffer.from('hello world'));
    } finally {
      await srv.close();
    }
  });

  it('aborts streaming once the running byte count crosses the cap', async () => {
    let writes = 0;
    let closed = false;
    const srv = await withServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/file/bottoken/audio/huge.oga');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.on('close', () => { closed = true; });
      const chunks = [Buffer.alloc(4, 1), Buffer.alloc(4, 2), Buffer.alloc(4, 3), Buffer.alloc(4, 4)];
      const writeNext = () => {
        if (closed || writes >= chunks.length) return;
        res.write(chunks[writes++]);
        setTimeout(writeNext, 25);
      };
      writeNext();
    });
    try {
      const client = new TelegramApiClient('token', srv.baseUrl);
      let thrown: unknown;
      try {
        await client.downloadFile('audio/huge.oga', 1000, 5);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TelegramDownloadTooLargeError);
      expect(thrown).toMatchObject({
        limitBytes: 5,
        bytesRead: 8,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(closed).toBe(true);
      expect(writes).toBeLessThan(4);
    } finally {
      await srv.close();
    }
  });
});
