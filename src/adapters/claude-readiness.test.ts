import { describe, expect, test } from 'vitest';
import { asTerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import {
  compactClaudePane,
  detectClaudeBlockingStartupDialog,
  dismissClaudeStartupDialog,
  isClaudeStartupDialogBlocking,
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

describe('isClaudeStartupDialogBlocking', () => {
  test('is true for trust and bypass dialogs, false for the composer', () => {
    const enc = new TextEncoder();
    expect(isClaudeStartupDialogBlocking(enc.encode(TRUST_PANE_SPACED))).toBe(true);
    expect(isClaudeStartupDialogBlocking(enc.encode(BYPASS_PANE))).toBe(true);
    expect(isClaudeStartupDialogBlocking(enc.encode('\x1b[?2004hClaudeCode\n❯ ? for shortcuts'))).toBe(false);
  });
});

describe('dismissClaudeStartupDialog', () => {
  test('sends Down then Enter', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's', command: 'claude', args: [], cwd: '/tmp' });
    const writes: Uint8Array[] = [];
    const orig = backend.writeInput.bind(backend);
    backend.writeInput = async (id, data, meta) => {
      writes.push(data);
      return orig(id, data, meta);
    };
    await dismissClaudeStartupDialog('s', {
      inputWriter: asTerminalInputWriterPort(backend),
      sleep: async () => {},
    });
    expect(writes.length).toBe(2);
    expect(Buffer.from(writes[0]!).equals(Buffer.from(translateKeystroke('Down')))).toBe(true);
    expect(Buffer.from(writes[1]!).equals(Buffer.from(ENTER_BYTES))).toBe(true);
  });
});
