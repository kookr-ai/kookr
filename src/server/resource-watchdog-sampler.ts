/**
 * Host sampler for the resource watchdog (issue #1724).
 *
 * Reads `/proc/meminfo`, `/proc/vmstat`, and an injectable process table to
 * build a {@link ResourceWatchdogSample}. All I/O is behind deps so unit tests
 * never touch real `/proc`.
 */

import { readFileSync } from 'node:fs';
import type {
  AgentFamilyProcessCounts,
  ResourceWatchdogSample,
  TopConsumerSnapshot,
} from '../core/resource-watchdog-types.js';
import type { ProcessTableEntry } from '../adapters/dtach-attach-reaper.js';
import { listRealProcesses } from '../adapters/dtach-attach-reaper.js';

export interface MeminfoSnapshot {
  memTotalKb: number | null;
  memAvailableKb: number | null;
  swapTotalKb: number | null;
  swapFreeKb: number | null;
}

export interface ResourceWatchdogSamplerDeps {
  readMeminfo?: () => MeminfoSnapshot;
  readOomKillTotal?: () => number | null;
  listProcesses?: () => ProcessTableEntry[];
  /** Optional RSS reader (pid → kb). Default tries `/proc/<pid>/status`. */
  readProcessRssKb?: (pid: number) => number | null;
  nowIso?: () => string;
  /** Max top consumers to include in the sample. Default 10. */
  topConsumerLimit?: number;
  /** Orphan/terminal-leak counts from the reaper health snapshot (no scan). */
  getSessionPressure?: () => { orphanSessionCount: number; terminalLeakCount: number };
}

export interface ResourceWatchdogHostSampler {
  sample(): ResourceWatchdogSample;
}

const DEFAULT_TOP_LIMIT = 10;

export function parseMeminfo(text: string): MeminfoSnapshot {
  const map = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) map.set(match[1]!, Number(match[2]));
  }
  return {
    memTotalKb: map.get('MemTotal') ?? null,
    memAvailableKb: map.get('MemAvailable') ?? null,
    swapTotalKb: map.get('SwapTotal') ?? null,
    swapFreeKb: map.get('SwapFree') ?? null,
  };
}

export function parseOomKillTotal(vmstatText: string): number | null {
  for (const line of vmstatText.split('\n')) {
    const match = /^oom_kill\s+(\d+)\s*$/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function readMeminfoFromProc(): MeminfoSnapshot {
  try {
    return parseMeminfo(readFileSync('/proc/meminfo', 'utf-8'));
  } catch {
    return { memTotalKb: null, memAvailableKb: null, swapTotalKb: null, swapFreeKb: null };
  }
}

function readOomKillFromProc(): number | null {
  try {
    return parseOomKillTotal(readFileSync('/proc/vmstat', 'utf-8'));
  } catch {
    return null;
  }
}

function readRssKbFromProc(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Classify a process command line into agent-family buckets. A single process
 * may match at most one agent family (checked in priority order) plus
 * independently match `dtach` when the binary is present.
 */
export function classifyProcessCommand(command: string): {
  family: keyof AgentFamilyProcessCounts | null;
  isDtach: boolean;
} {
  const lower = command.toLowerCase();
  const isDtach = /(^|\/|\s)dtach(\s|$)/.test(lower) || lower.includes('dtach -');
  // Prefer more specific agent binaries over generic node wrappers.
  if (/(^|\/|\s)claude(\s|$)/.test(lower) || lower.includes('claude-code')) {
    return { family: 'claude', isDtach };
  }
  if (/(^|\/|\s)codex(\s|$)/.test(lower)) {
    return { family: 'codex', isDtach };
  }
  if (/(^|\/|\s)grok(\s|$)/.test(lower) || lower.includes('grok-build')) {
    return { family: 'grok', isDtach };
  }
  return { family: null, isDtach };
}

export function countAgentFamilies(
  entries: readonly ProcessTableEntry[],
): AgentFamilyProcessCounts {
  const counts: AgentFamilyProcessCounts = { claude: 0, grok: 0, codex: 0, dtach: 0 };
  for (const entry of entries) {
    const { family, isDtach } = classifyProcessCommand(entry.command);
    if (family) counts[family] += 1;
    if (isDtach) counts.dtach += 1;
  }
  return counts;
}

export function collectTopConsumers(
  entries: readonly ProcessTableEntry[],
  readRssKb: (pid: number) => number | null,
  limit: number,
): TopConsumerSnapshot[] {
  // Classify first — only open `/proc/<pid>/status` for agent/dtach candidates
  // (plus a hard cap) so a crowded process table under pressure does not
  // multiply into thousands of status reads.
  const candidates: ProcessTableEntry[] = [];
  for (const entry of entries) {
    const { family, isDtach } = classifyProcessCommand(entry.command);
    if (family || isDtach) candidates.push(entry);
  }
  const scored: TopConsumerSnapshot[] = [];
  const rssBudget = Math.min(candidates.length, Math.max(limit * 4, 40));
  for (let i = 0; i < rssBudget; i++) {
    const entry = candidates[i]!;
    const rssKb = readRssKb(entry.pid);
    if (rssKb === null || rssKb <= 0) continue;
    scored.push({
      pid: entry.pid,
      rssKb,
      command: entry.command.slice(0, 200),
    });
  }
  scored.sort((a, b) => b.rssKb - a.rssKb);
  return scored.slice(0, Math.max(0, limit));
}

export class ResourceWatchdogHostSamplerImpl implements ResourceWatchdogHostSampler {
  private readonly readMeminfo: () => MeminfoSnapshot;
  private readonly readOomKillTotal: () => number | null;
  private readonly listProcesses: () => ProcessTableEntry[];
  private readonly readProcessRssKb: (pid: number) => number | null;
  private readonly nowIso: () => string;
  private readonly topConsumerLimit: number;
  private readonly getSessionPressure: () => {
    orphanSessionCount: number;
    terminalLeakCount: number;
  };

  constructor(deps: ResourceWatchdogSamplerDeps = {}) {
    this.readMeminfo = deps.readMeminfo ?? readMeminfoFromProc;
    this.readOomKillTotal = deps.readOomKillTotal ?? readOomKillFromProc;
    this.listProcesses = deps.listProcesses ?? listRealProcesses;
    this.readProcessRssKb = deps.readProcessRssKb ?? readRssKbFromProc;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.topConsumerLimit = deps.topConsumerLimit ?? DEFAULT_TOP_LIMIT;
    this.getSessionPressure = deps.getSessionPressure
      ?? (() => ({ orphanSessionCount: 0, terminalLeakCount: 0 }));
  }

  sample(): ResourceWatchdogSample {
    const mem = this.readMeminfo();
    let swapUsedPercent: number | null = null;
    if (
      mem.swapTotalKb !== null
      && mem.swapFreeKb !== null
      && mem.swapTotalKb > 0
    ) {
      const used = mem.swapTotalKb - mem.swapFreeKb;
      swapUsedPercent = (used / mem.swapTotalKb) * 100;
    } else if (mem.swapTotalKb === 0) {
      swapUsedPercent = 0;
    }

    const memAvailableMb =
      mem.memAvailableKb !== null ? mem.memAvailableKb / 1024 : null;

    let entries: ProcessTableEntry[] = [];
    try {
      entries = this.listProcesses();
    } catch {
      entries = [];
    }

    const processCounts = countAgentFamilies(entries);
    let topConsumers: TopConsumerSnapshot[] = [];
    try {
      topConsumers = collectTopConsumers(
        entries,
        this.readProcessRssKb,
        this.topConsumerLimit,
      );
    } catch {
      topConsumers = [];
    }

    const pressure = this.getSessionPressure();

    return {
      sampledAt: this.nowIso(),
      swapUsedPercent,
      memAvailableMb,
      oomKillTotal: this.readOomKillTotal(),
      processCounts,
      orphanSessionCount: pressure.orphanSessionCount,
      terminalLeakCount: pressure.terminalLeakCount,
      topConsumers,
    };
  }
}

export function createResourceWatchdogHostSampler(
  deps?: ResourceWatchdogSamplerDeps,
): ResourceWatchdogHostSampler {
  return new ResourceWatchdogHostSamplerImpl(deps);
}
