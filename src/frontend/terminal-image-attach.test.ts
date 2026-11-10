import { describe, expect, it, vi } from 'vitest';
import {
  attachImagesToTerminal,
  dragCarriesFiles,
  formatImagePathForPaste,
  imageFilesFromClipboard,
  isSupportedImageFile,
  planImageAttach,
  uploadTerminalImage,
} from './terminal-image-attach.js';
import { TERMINAL_IMAGE_MAX_BYTES, TERMINAL_IMAGE_MAX_PER_DROP } from '../shared/contracts/terminal-image.js';

const file = (name: string, type: string, bytes = 4) => new File([new Uint8Array(bytes)], name, { type });
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe('dragCarriesFiles', () => {
  it('is true only when the drag includes files — not for dragged text or links', () => {
    expect(dragCarriesFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(dragCarriesFiles({ types: ['text/plain', 'Files'] } as unknown as DataTransfer)).toBe(true);
    expect(dragCarriesFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(dragCarriesFiles({ types: ['text/uri-list'] } as unknown as DataTransfer)).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
  });
});

describe('isSupportedImageFile', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('accepts %s', (type) => {
    expect(isSupportedImageFile(file('x', type))).toBe(true);
  });

  it('rejects SVG, PDF and other types the browser positively identified', () => {
    expect(isSupportedImageFile(file('logo.svg', 'image/svg+xml'))).toBe(false);
    expect(isSupportedImageFile(file('a.pdf', 'application/pdf'))).toBe(false);
    // A known-but-wrong type is not rescued by a misleading extension.
    expect(isSupportedImageFile(file('sneaky.png', 'text/html'))).toBe(false);
  });

  it('falls back to the extension only when the browser left the type blank', () => {
    expect(isSupportedImageFile(file('Screenshot.PNG', ''))).toBe(true);
    expect(isSupportedImageFile(file('photo.jpeg', ''))).toBe(true);
    expect(isSupportedImageFile(file('notes.txt', ''))).toBe(false);
    expect(isSupportedImageFile(file('no-extension', ''))).toBe(false);
  });
});

describe('imageFilesFromClipboard', () => {
  const clipboard = (files: File[], text: string) => ({
    files, getData: (type: string) => (type === 'text' ? text : ''),
  }) as unknown as DataTransfer;

  it('returns the images when the clipboard holds no text (a screenshot)', () => {
    const shot = file('image.png', 'image/png');
    expect(imageFilesFromClipboard(clipboard([shot], ''))).toEqual([shot]);
  });

  it('returns nothing when text is present, so a spreadsheet/web copy pastes as text', () => {
    expect(imageFilesFromClipboard(clipboard([file('image.png', 'image/png')], '1\t2\n3\t4'))).toEqual([]);
  });

  it('ignores non-image files and a missing clipboard', () => {
    expect(imageFilesFromClipboard(clipboard([file('a.pdf', 'application/pdf')], ''))).toEqual([]);
    expect(imageFilesFromClipboard(null)).toEqual([]);
  });
});

describe('planImageAttach', () => {
  it('accepts supported images and explains every file it leaves out', () => {
    const plan = planImageAttach([
      file('a.png', 'image/png'),
      file('b.pdf', 'application/pdf'),
      file('huge.png', 'image/png', TERMINAL_IMAGE_MAX_BYTES + 1),
    ]);
    expect(plan.accepted.map((f) => f.name)).toEqual(['a.png']);
    expect(plan.skipped).toEqual([
      'b.pdf: not a PNG, JPEG, GIF or WebP image',
      'huge.png: larger than 10 MB',
    ]);
  });

  it('keeps the first N images of an oversized drop, in order, and reports the rest', () => {
    const many = Array.from({ length: TERMINAL_IMAGE_MAX_PER_DROP + 2 }, (_, i) => file(`i${i}.png`, 'image/png'));
    const plan = planImageAttach(many);
    expect(plan.accepted.map((f) => f.name)).toEqual(many.slice(0, TERMINAL_IMAGE_MAX_PER_DROP).map((f) => f.name));
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0]).toContain(`only ${TERMINAL_IMAGE_MAX_PER_DROP} images`);
  });

  it('accepts an image of exactly the size limit', () => {
    expect(planImageAttach([file('edge.png', 'image/png', TERMINAL_IMAGE_MAX_BYTES)]).accepted).toHaveLength(1);
  });
});

describe('formatImagePathForPaste', () => {
  it('is the path plus a trailing space so the user can keep typing', () => {
    expect(formatImagePathForPaste('/a.png')).toBe('/a.png ');
  });
});

describe('uploadTerminalImage', () => {
  it('POSTs the raw file with its own content type and returns the server response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ path: '/p.png', mime: 'image/png', size: 4 }, 201));
    const image = file('s.png', 'image/png');
    await expect(uploadTerminalImage(image, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      path: '/p.png', mime: 'image/png', size: 4,
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/terminal-images', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image,
    });
  });

  it.each([
    [413, 'larger than 10 MB'],
    [415, 'not a PNG, JPEG, GIF or WebP image'],
    [403, 'not allowed (read-only or signed-out session)'],
    [401, 'not allowed (read-only or signed-out session)'],
  ])('turns HTTP %i into a readable message naming the file', async (status, text) => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}, status));
    await expect(uploadTerminalImage(file('s.png', 'image/png'), fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(`s.png: ${text}`);
  });

  it('prefers the server message for other failures, and survives a non-JSON error body', async () => {
    const withMessage = vi.fn().mockResolvedValue(json({ message: 'The server could not save the image.' }, 500));
    await expect(uploadTerminalImage(file('s.png', 'image/png'), withMessage as unknown as typeof fetch))
      .rejects.toThrow('s.png: The server could not save the image.');
    const htmlBody = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(uploadTerminalImage(file('s.png', 'image/png'), htmlBody as unknown as typeof fetch))
      .rejects.toThrow('s.png: upload failed (HTTP 502)');
  });

  it('reports an unreachable server', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(uploadTerminalImage(file('s.png', 'image/png'), down as unknown as typeof fetch))
      .rejects.toThrow('s.png: could not reach the Kookr server');
  });
});

describe('attachImagesToTerminal', () => {
  const uploadOk = (path: string) => ({ path, mime: 'image/png' as const, size: 4 });

  // One paste PER image: Codex CLI only attaches a paste that is exactly one
  // image path (two paths in one paste stay plain text). Verified on the real TUIs.
  it('pastes each successful upload as its own paste, in drop order, and reports the failures', async () => {
    const paste = vi.fn().mockReturnValue(true);
    const outcome = await attachImagesToTerminal(
      [file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')],
      {
        upload: async (f) => {
          if (f.name === 'b.png') throw new Error('b.png: larger than 10 MB');
          return uploadOk(`/up/${f.name}`);
        },
        isStillTarget: () => true,
        paste,
      },
    );
    expect(outcome).toEqual({ status: 'attached', attached: 2, failures: ['b.png: larger than 10 MB'] });
    expect(paste.mock.calls).toEqual([['/up/a.png '], ['/up/c.png ']]);
  });

  it('pastes nothing and reports failure when every upload fails', async () => {
    const paste = vi.fn();
    const outcome = await attachImagesToTerminal([file('a.png', 'image/png')], {
      upload: async () => { throw new Error('a.png: upload failed (HTTP 500)'); },
      isStillTarget: () => true,
      paste,
    });
    expect(outcome).toEqual({ status: 'failed', failures: ['a.png: upload failed (HTTP 500)'] });
    expect(paste).not.toHaveBeenCalled();
  });

  it('does not paste when the target terminal changed during the upload', async () => {
    const paste = vi.fn().mockReturnValue(true);
    const outcome = await attachImagesToTerminal([file('a.png', 'image/png')], {
      upload: async () => uploadOk('/up/a.png'),
      isStillTarget: () => false,
      paste,
    });
    expect(outcome).toEqual({ status: 'stale' });
    expect(paste).not.toHaveBeenCalled();
  });

  it('reports the images it could not paste when the terminal disconnects partway through', async () => {
    const paste = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const outcome = await attachImagesToTerminal(
      [file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')],
      { upload: async (f) => uploadOk(`/up/${f.name}`), isStillTarget: () => true, paste },
    );
    expect(outcome).toEqual({
      status: 'attached', attached: 1, failures: ['2 images not attached: the terminal disconnected'],
    });
    // It stops at the first refusal instead of pasting later images out of order.
    expect(paste).toHaveBeenCalledTimes(2);
  });

  it('reports stale (not attached) when the terminal refuses the paste', async () => {
    const outcome = await attachImagesToTerminal([file('a.png', 'image/png')], {
      upload: async () => uploadOk('/up/a.png'),
      isStillTarget: () => true,
      paste: () => false,
    });
    expect(outcome).toEqual({ status: 'stale' });
  });
});
