import { describe, expect, test } from 'vitest';
import { asTerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import {
  acceptClaudeStartupDialogsIfPresent,
  ClaudeStartupDialogError,
  compactClaudePane,
  detectClaudeBlockingStartupDialog,
} from './claude-readiness.js';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { ENTER_BYTES, translateKeystroke } from './keystroke.js';

const TRUST_PANE_CUP_COMPACT =
  'Accessingworkspace:/tmp/untrustedQuicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?❯No,exitYes,ItrustthisfolderEntertoconfirm·Esctocancel';

const TRUST_PANE_SPACED = `
Accessing workspace: /tmp/untrusted
Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel
`;

const BYPASS_PANE = `
WARNING: Claude Code running in Bypass Permissions mode
❯ No, exit
  Yes, I accept
Enter to confirm · Esc to cancel
`;

describe('detectClaudeBlockingStartupDialog', () => {
  test('matches the CUP-compacted Claude 2.1.273 trust dialog', () => {
    expect(detectClaudeBlockingStartupDialog(TRUST_PANE_CUP_COMPACT)).toBe('workspace-trust');
    expect(compactClaudePane(TRUST_PANE_CUP_COMPACT)).toContain('yes,itrustthisfolder');
  });

  test('matches the spaced trust dialog', () => {
    expect(detectClaudeBlockingStartupDialog(TRUST_PANE_SPACED)).toBe('workspace-trust');
  });

  test('matches the bypass-permissions warning', () => {
    expect(detectClaudeBlockingStartupDialog(BYPASS_PANE)).toBe('bypass-permissions');
  });

  test('does not trip on a ready composer', () => {
    expect(detectClaudeBlockingStartupDialog('Claude Code\n❯ ')).toBeNull();
    expect(detectClaudeBlockingStartupDialog('Yes, I will look at the folder layout')).toBeNull();
  });
});

describe('acceptClaudeStartupDialogsIfPresent', () => {
  test('is a no-op when the pane is not a blocking dialog', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's', command: 'claude', args: [], cwd: '/tmp' });
    backend.emit('s', 'Claude Code\n❯ ');
    const writes: Uint8Array[] = [];
    const orig = backend.writeInput.bind(backend);
    backend.writeInput = async (id, data, meta) => {
      writes.push(data);
      return orig(id, data, meta);
    };
    await acceptClaudeStartupDialogsIfPresent(backend, 's', {
      inputWriter: asTerminalInputWriterPort(backend),
      timeoutMs: 200,
      pollMs: 5,
      sleep: async () => {},
    });
    expect(writes).toEqual([]);
  });

  test('sends Down then Enter on the trust dialog and stops after it clears', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's', command: 'claude', args: [], cwd: '/tmp' });
    backend.emit('s', TRUST_PANE_SPACED);
    const writes: Uint8Array[] = [];
    const orig = backend.writeInput.bind(backend);
    let accepted = false;
    backend.writeInput = async (id, data, meta) => {
      writes.push(data);
      const result = await orig(id, data, meta);
      if (data === ENTER_BYTES || (data.length === 1 && data[0] === 0x0d)) {
        accepted = true;
        backend.emit('s', '\nClaude Code\n❯ ');
      }
      return result;
    };
    // captureBytes reads paneContent which still contains the dialog text
    // after emit-append. Replace capture so the second poll sees a composer.
    const origCapture = backend.captureBytes.bind(backend);
    backend.captureBytes = async (id, max) => {
      if (accepted) return new TextEncoder().encode('Claude Code\n❯ ');
      return origCapture(id, max);
    };

    await acceptClaudeStartupDialogsIfPresent(backend, 's', {
      inputWriter: asTerminalInputWriterPort(backend),
      timeoutMs: 1_000,
      pollMs: 5,
      sleep: async () => {},
    });

    expect(writes.length).toBe(2);
    expect(Buffer.from(writes[0]!).equals(Buffer.from(translateKeystroke('Down')))).toBe(true);
    expect(Buffer.from(writes[1]!).equals(Buffer.from(ENTER_BYTES))).toBe(true);
  });

  test('fails closed if the dialog is still up at the deadline', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's', command: 'claude', args: [], cwd: '/tmp' });
    backend.emit('s', TRUST_PANE_SPACED);
    await expect(
      acceptClaudeStartupDialogsIfPresent(backend, 's', {
        inputWriter: asTerminalInputWriterPort(backend),
        timeoutMs: 0,
        pollMs: 5,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(ClaudeStartupDialogError);
  });
});
