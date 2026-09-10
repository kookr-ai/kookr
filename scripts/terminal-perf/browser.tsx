import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Terminal } from '@xterm/xterm';
import { TerminalPanel } from '../../src/frontend/components/TerminalPanel.js';
import { App } from '../../src/frontend/App.js';
import { useKookrStore } from '../../src/frontend/store/useStore.js';
import '../../src/frontend/styles.css';

type ProbeWindow = typeof globalThis & {
  __terminalProbe?: (terminal: Terminal) => void;
  terminalMarker?: (sequence: number) => Promise<void>;
  terminalProbeState?: { frames: number[]; longTasks: number[]; terminals: Terminal[]; reset(): void; select(id: string): void; projection(): unknown };
};
const scope = globalThis as ProbeWindow;
const state = { frames: [] as number[], longTasks: [] as number[], terminals: [] as Terminal[],
  reset() { state.frames.length = 0; state.longTasks.length = 0; },
  select(id: string) {
    const store = useKookrStore.getState();
    const agent = store.agents.find((candidate) => candidate.agentId === id);
    store.selectAgent(id, agent?.taskId); store.setNarrowTab('terminal');
  },
  projection() {
    const agents = useKookrStore.getState().agents;
    return { rows: agents.length, eventWindow: Math.max(0, ...agents.map((agent) => agent.events.length)),
      statuses: agents.reduce<Record<string, number>>((out, agent) => {
        const status = agent.taskStatus ?? 'unknown'; out[status] = (out[status] ?? 0) + 1; return out;
      }, {}) };
  } };
scope.terminalProbeState = state;
const observed = new Set<number>();
scope.__terminalProbe = (terminal) => {
  state.terminals.push(terminal);
  // This observer is injected only by the benchmark build. It does not expose
  // a terminal or a parser hook in Kookr's shipped application.
  terminal.onRender(() => {
    const buffer = terminal.buffer.active;
    const visibleText = Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n');
    for (const match of visibleText.matchAll(/KMARK:(\d+):END/g)) {
      const sequence = Number(match[1]);
      if (observed.has(sequence)) continue;
      observed.add(sequence);
      requestAnimationFrame(() => void scope.terminalMarker?.(sequence));
    }
  });
};
let previous: number | null = null;
function frame(now: number) {
  if (previous !== null && state.frames.length < 65_536) state.frames.push(now - previous);
  previous = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) if (state.longTasks.length < 4096) state.longTasks.push(entry.duration);
}).observe({ type: 'longtask', buffered: true });

const params = new URLSearchParams(location.search);
const panes = Math.min(4, Math.max(1, Number(params.get('panes')) || 1));
document.body.style.cssText = 'margin:0;background:#0a0c12;color:#b2bace';
createRoot(document.getElementById('root')!).render(params.has('mixed') ? <App /> : (
  <main style={{ height: '100vh', display: 'grid', gridTemplateColumns: panes > 1 ? '1fr 1fr' : '1fr',
    gridTemplateRows: panes > 2 ? '1fr 1fr' : '1fr' }}>
    {Array.from({ length: panes }, (_, i) => <TerminalPanel key={i} tmuxName={`probe-${i}`} visible />)}
  </main>
));
