const PARSE_CHUNK_BYTES = 8 * 1024;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_ENTRIES = 512;
const MAX_PENDING_CONTROLS = 64;
const PARSER_STALL_MS = 2000;

type ScheduledTask = () => void;

/** One task per turn avoids both recursive parsing and animation-frame throttling. */
function browserTaskDispatcher(): (task: ScheduledTask) => void {
  if (typeof window === 'undefined' || typeof MessageChannel === 'undefined') {
    return (task) => { setTimeout(task, 0); };
  }
  const channel = new MessageChannel();
  const tasks: ScheduledTask[] = [];
  channel.port1.onmessage = () => tasks.shift()?.();
  return (task) => { tasks.push(task); channel.port2.postMessage(null); };
}

export function createTerminalWriteScheduler(defer = browserTaskDispatcher()) {
  const ready = new Set<ScheduledTask>();
  let scheduled = false;
  function schedule() {
    if (scheduled || ready.size === 0) return;
    scheduled = true;
    defer(() => {
      scheduled = false;
      const next = ready.values().next().value;
      if (next) {
        ready.delete(next);
        try { next(); } finally { schedule(); }
      }
    });
  }
  return {
    request(task: ScheduledTask) { ready.add(task); schedule(); },
    cancel(task: ScheduledTask) { ready.delete(task); },
  };
}

// Shared across panes: a slow parser is absent from the ready set until it
// completes, so it cannot monopolize or block another pane's next turn.
const sharedScheduler = createTerminalWriteScheduler();

export interface TerminalWriteSession {
  write(bytes: Uint8Array, onParsed?: (bytes: number) => void): boolean;
  barrier(callback: () => void): boolean;
  reset(): boolean;
  retire(): void;
}

type QueueEntry =
  | { kind: 'bytes'; data: Uint8Array; onParsed?: () => void }
  | { kind: 'control'; callback: () => void };

interface TerminalWriterOptions {
  terminal: { write(data: Uint8Array, callback: () => void): void; reset(): void };
  scheduler?: ReturnType<typeof createTerminalWriteScheduler>;
  /** The caller must dispose/recreate xterm and its addons, never reset in place. */
  onStall(): void;
}

/** Sole write/reset authority for one xterm instance across connection changes. */
export function createTerminalWriter(options: TerminalWriterOptions) {
  const scheduler = options.scheduler ?? sharedScheduler;
  const queue: QueueEntry[] = [];
  let generation = 0;
  let disposed = false;
  let pendingReset = false;
  let pendingBytes = 0;
  let pendingControls = 0;
  let inFlight: { generation: number; bytes: number } | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  function request() {
    if (!disposed && !inFlight && (pendingReset || queue.length)) scheduler.request(run);
  }

  function dropQueued() {
    queue.length = 0;
    pendingBytes = inFlight?.bytes ?? 0;
    pendingControls = 0;
    pendingReset = false;
    scheduler.cancel(run);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    dropQueued();
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = null;
  }

  function run() {
    try { runTask(); } catch {
      // A failed parser can have partially mutated its buffer. Retire the
      // entire instance just as for a stall; do not retry these input bytes.
      dispose();
      options.onStall();
    }
  }

  function runTask() {
    if (disposed || inFlight) return;
    if (pendingReset) {
      options.terminal.reset();
      pendingReset = false;
    }
    const entry = queue[0];
    if (!entry) return;
    if (entry.kind === 'control') {
      queue.shift();
      pendingControls--;
      try { entry.callback(); } finally { request(); }
      return;
    }
    const data = entry.data;
    const active = { generation, bytes: data.byteLength };
    inFlight = active;
    stallTimer = setTimeout(() => {
      dispose();
      options.onStall();
    }, PARSER_STALL_MS);
    options.terminal.write(data, () => {
      if (disposed || inFlight !== active) return;
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = null;
      inFlight = null;
      pendingBytes -= active.bytes;
      if (active.generation === generation) {
        queue.shift();
        try { entry.onParsed?.(); }
        catch { dispose(); options.onStall(); }
        finally { request(); }
        return;
      }
      // Stale parses still release the transition barrier. They cannot run
      // acknowledgements or readiness callbacks from the retired connection.
      request();
    });
  }

  return {
    get hasInFlight() { return inFlight !== null; },
    begin(reset = true): TerminalWriteSession {
      generation++;
      dropQueued();
      const sessionGeneration = generation;
      pendingReset = reset;
      const current = () => !disposed && generation === sessionGeneration;
      return {
        write(bytes, onParsed) {
          if (!current() || bytes.byteLength > MAX_PENDING_BYTES - pendingBytes
            || Math.ceil(bytes.byteLength / PARSE_CHUNK_BYTES) > MAX_PENDING_ENTRIES - queue.length) return false;
          if (!bytes.byteLength) return this.barrier(() => onParsed?.(0));
          // Own a bounded payload, not a view retaining an arbitrarily large
          // source allocation. Admission is checked before making the copy.
          for (let offset = 0; offset < bytes.byteLength; offset += PARSE_CHUNK_BYTES) {
            const end = Math.min(offset + PARSE_CHUNK_BYTES, bytes.byteLength);
            queue.push({
              kind: 'bytes', data: bytes.slice(offset, end),
              onParsed: end === bytes.byteLength ? () => onParsed?.(bytes.byteLength) : undefined,
            });
          }
          pendingBytes += bytes.byteLength;
          request();
          return true;
        },
        barrier(callback) {
          if (!current() || pendingControls >= MAX_PENDING_CONTROLS
            || queue.length >= MAX_PENDING_ENTRIES) return false;
          queue.push({ kind: 'control', callback });
          pendingControls++;
          request();
          return true;
        },
        reset() { return this.barrier(() => options.terminal.reset()); },
        retire() {
          if (!current()) return;
          generation++;
          dropQueued();
        },
      };
    },
    dispose,
  };
}
