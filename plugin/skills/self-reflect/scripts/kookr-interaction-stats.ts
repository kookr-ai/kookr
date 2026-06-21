#!/usr/bin/env bun
// Kookr Interaction Stats Analyzer
//
// Parses ~/.kookr/sessions/ interaction JSONL and state.json to produce
// structured statistics for the session-self-reflect playbook.
//
// Replaces manual JSONL counting that was burning ~2000 thinking tokens per run.
//
// Usage:
//   bun kookr-interaction-stats.ts                    # analyze new sessions only
//   bun kookr-interaction-stats.ts --all              # analyze all sessions
//   bun kookr-interaction-stats.ts --session <dir>    # analyze specific session
//   bun kookr-interaction-stats.ts --json             # output raw JSON

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface InteractionEvent {
  type: string;
  agentId?: string;
  taskId?: string;
  taskPrompt?: string;
  content?: string;
  anomalyType?: string;
  method?: string;
  reason?: string;
  durationMs?: number;
  relaunched?: number;
  skipped?: number;
  failed?: number;
  details?: {
    relaunched?: Array<{ mode?: string; fallbackReason?: string }>;
    skipped?: unknown[];
    failed?: unknown[];
  };
  timestamp: string;
}

interface CrashRecoverySummary {
  events: number;
  relaunched: number;
  resumed: number;
  fresh: number;
  skipped: number;
  failed: number;
}

interface SessionSummary {
  sessionDir: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  eventCount: number;
  agentsLaunched: number;
  agentIds: string[];
  launchedPrompts: { agentId: string; prompt: string }[];
  tasksCompleted: number;
  tasksCancelled: number;
  userInputs: number;
  userInputDetails: { agentId: string; content: string; classification: string }[];
  findingsResolved: number;
  findingsSnoozed: number;
  findingsSkipped: number;
  findingsByType: Record<string, { input: number; snooze: number; skip: number }>;
  crashRecovery: CrashRecoverySummary;
  sessionKind: "normal" | "crash_recovery" | "mixed";
  isEmpty: boolean;
}

interface AgentSnoozeProfile {
  agentId: string;
  totalSnoozes: number;
  totalFindings: number;
  anomalyTypes: Record<string, number>;
  sessions: string[];
  firstSeen: string;
  lastSeen: string;
}

interface AggregateStats {
  sessionsAnalyzed: number;
  agentsLaunched: number;
  tasksCompleted: number;
  tasksCancelled: number;
  userInterventions: number;
  interventionsPerLaunch: number;
  findingsResolved: number;
  findingsSnoozed: number;
  findingsSkipped: number;
  findingsByAnomalyType: Record<string, { input: number; snooze: number; skip: number }>;
  avgInputResolutionMs: number;
  emptySessions: number;
  snoozeStorms: AgentSnoozeProfile[];  // agents with 5+ snoozes
  crashRecoverySessions: number;
  crashRecoveryRelaunches: number;
  crashRecoveryResumed: number;
  crashRecoveryFresh: number;
}

interface StateFile {
  analyzed_sessions: string[];
  last_run: string | null;
  run_count: number;
  cumulative_stats: Record<string, number>;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const SESSIONS_DIR = join(homedir(), ".kookr", "sessions");
const STATE_DIR = join(homedir(), ".claude", "session-reflections");
const STATE_FILE = join(STATE_DIR, "state.json");

// ─── Parse CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  all: args.includes("--all"),
  json: args.includes("--json"),
  session: args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined,
  help: args.includes("--help") || args.includes("-h"),
};

if (flags.help) {
  console.log(`
Kookr Interaction Stats Analyzer

Usage:
  bun kookr-interaction-stats.ts                    # new sessions only
  bun kookr-interaction-stats.ts --all              # all sessions
  bun kookr-interaction-stats.ts --session <dir>    # specific session
  bun kookr-interaction-stats.ts --json             # raw JSON output

Output: structured statistics for session-self-reflect playbook
  - Per-session summaries (events, agents, interventions, findings)
  - Aggregate stats (totals, averages, ratios)
  - Snooze storm detection (agents with 5+ snoozes)
  - User input classification (approval/directive/correction/question)
  - Finding breakdown by anomaly type and resolution method
`);
  process.exit(0);
}

// ─── Core parsing ───────────────────────────────────────────────────────────

function readState(): StateFile {
  if (!existsSync(STATE_FILE)) {
    return { analyzed_sessions: [], last_run: null, run_count: 0, cumulative_stats: {} };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

function listSessionDirs(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR).sort();
}

function readInteractions(sessionDir: string): InteractionEvent[] {
  const path = join(SESSIONS_DIR, sessionDir, "interactions.jsonl");
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean) as InteractionEvent[];
}

function classifyInput(content: string): string {
  const lower = content.toLowerCase().trim();
  // Approvals
  if (/^(yes|y|ok|okay|sure|go ahead|looks good|lgtm|perfect|approved|ship it|do it)[\s!.]*$/i.test(lower)) {
    return "approval";
  }
  // Questions
  if (lower.endsWith("?") || /^(what|why|how|did|is|are|can|could|should|do you|have you)/i.test(lower)) {
    return "question";
  }
  // Corrections
  if (/^(no[, ]|don't|stop|actually|instead|not that|wrong|undo|revert|that's not)/i.test(lower)) {
    return "correction";
  }
  // Default: directive
  return "directive";
}

function analyzeSession(sessionDir: string): SessionSummary {
  const events = readInteractions(sessionDir);

  const agentIds = new Set<string>();
  const launchedPrompts: { agentId: string; prompt: string }[] = [];
  const inputDetails: { agentId: string; content: string; classification: string }[] = [];
  const findingsByType: Record<string, { input: number; snooze: number; skip: number }> = {};
  const crashRecovery: CrashRecoverySummary = {
    events: 0,
    relaunched: 0,
    resumed: 0,
    fresh: 0,
    skipped: 0,
    failed: 0,
  };

  let launched = 0, completed = 0, cancelled = 0;
  let inputs = 0, resolved = 0, snoozed = 0, skipped = 0;

  for (const ev of events) {
    if (ev.agentId) agentIds.add(ev.agentId);

    switch (ev.type) {
      case "agent_launched":
        launched++;
        launchedPrompts.push({
          agentId: ev.agentId || "?",
          prompt: (ev.taskPrompt || "").slice(0, 120),
        });
        break;

      case "task_completed":
        completed++;
        break;

      case "task_cancelled":
        cancelled++;
        break;

      case "user_input":
        inputs++;
        inputDetails.push({
          agentId: ev.agentId || "?",
          content: (ev.content || "").slice(0, 200),
          classification: classifyInput(ev.content || ""),
        });
        break;

      case "finding_resolved":
        resolved++;
        const at = ev.anomalyType || "unknown";
        const method = ev.method || "unknown";
        if (!findingsByType[at]) findingsByType[at] = { input: 0, snooze: 0, skip: 0 };
        if (method === "input") {
          findingsByType[at].input++;
        } else if (method === "snooze") {
          findingsByType[at].snooze++;
        } else if (method === "skip") {
          findingsByType[at].skip++;
        }
        break;

      case "finding_snoozed":
        snoozed++;
        break;

      case "finding_skipped":
        skipped++;
        break;

      case "crash_recovery":
        crashRecovery.events++;
        crashRecovery.relaunched += ev.relaunched || ev.details?.relaunched?.length || 0;
        crashRecovery.skipped += ev.skipped || ev.details?.skipped?.length || 0;
        crashRecovery.failed += ev.failed || ev.details?.failed?.length || 0;
        for (const relaunch of ev.details?.relaunched ?? []) {
          if (relaunch.mode === "resumed") {
            crashRecovery.resumed++;
          } else if (relaunch.mode === "fresh") {
            crashRecovery.fresh++;
          }
        }
        break;
    }
  }

  const timestamps = events.map((e) => e.timestamp).filter(Boolean).sort();
  const startTime = timestamps[0] || "";
  const endTime = timestamps[timestamps.length - 1] || startTime;
  const durationMinutes = startTime && endTime
    ? (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000
    : 0;

  return {
    sessionDir,
    startTime,
    endTime,
    durationMinutes: Math.round(durationMinutes * 10) / 10,
    eventCount: events.length,
    agentsLaunched: launched,
    agentIds: [...agentIds],
    launchedPrompts,
    tasksCompleted: completed,
    tasksCancelled: cancelled,
    userInputs: inputs,
    userInputDetails: inputDetails,
    findingsResolved: resolved,
    findingsSnoozed: snoozed,
    findingsSkipped: skipped,
    findingsByType,
    crashRecovery,
    sessionKind: crashRecovery.events > 0
      ? (events.some((ev) => ev.type !== "agent_launched" && ev.type !== "crash_recovery") ? "mixed" : "crash_recovery")
      : "normal",
    isEmpty: events.length <= 2 && launched === 0,
  };
}

function detectSnoozeStorms(sessions: SessionSummary[]): AgentSnoozeProfile[] {
  // Aggregate snooze counts per agent across all sessions
  const agentSnoozes = new Map<string, AgentSnoozeProfile>();

  for (const session of sessions) {
    const events = readInteractions(session.sessionDir);
    for (const ev of events) {
      if (ev.type === "finding_resolved" && ev.method === "snooze" && ev.agentId) {
        if (!agentSnoozes.has(ev.agentId)) {
          agentSnoozes.set(ev.agentId, {
            agentId: ev.agentId,
            totalSnoozes: 0,
            totalFindings: 0,
            anomalyTypes: {},
            sessions: [],
            firstSeen: ev.timestamp,
            lastSeen: ev.timestamp,
          });
        }
        const profile = agentSnoozes.get(ev.agentId)!;
        profile.totalSnoozes++;
        profile.totalFindings++;
        const at = ev.anomalyType || "unknown";
        profile.anomalyTypes[at] = (profile.anomalyTypes[at] || 0) + 1;
        if (!profile.sessions.includes(session.sessionDir)) {
          profile.sessions.push(session.sessionDir);
        }
        if (ev.timestamp < profile.firstSeen) profile.firstSeen = ev.timestamp;
        if (ev.timestamp > profile.lastSeen) profile.lastSeen = ev.timestamp;
      }
    }
  }

  // Return agents with 5+ snoozes (storm threshold)
  return [...agentSnoozes.values()]
    .filter((p) => p.totalSnoozes >= 5)
    .sort((a, b) => b.totalSnoozes - a.totalSnoozes);
}

function aggregate(sessions: SessionSummary[]): AggregateStats {
  let totalInputResMs = 0;
  let inputResCount = 0;

  // Collect input resolution times from raw events
  for (const session of sessions) {
    const events = readInteractions(session.sessionDir);
    for (const ev of events) {
      if (ev.type === "finding_resolved" && ev.method === "input" && ev.durationMs) {
        totalInputResMs += ev.durationMs;
        inputResCount++;
      }
    }
  }

  const findingsByAnomalyType: Record<string, { input: number; snooze: number; skip: number }> = {};
  for (const s of sessions) {
    for (const [at, counts] of Object.entries(s.findingsByType)) {
      if (!findingsByAnomalyType[at]) findingsByAnomalyType[at] = { input: 0, snooze: 0, skip: 0 };
      findingsByAnomalyType[at].input += counts.input;
      findingsByAnomalyType[at].snooze += counts.snooze;
      findingsByAnomalyType[at].skip += counts.skip;
    }
  }

  const totalLaunched = sessions.reduce((s, x) => s + x.agentsLaunched, 0);
  const totalInputs = sessions.reduce((s, x) => s + x.userInputs, 0);

  return {
    sessionsAnalyzed: sessions.length,
    agentsLaunched: totalLaunched,
    tasksCompleted: sessions.reduce((s, x) => s + x.tasksCompleted, 0),
    tasksCancelled: sessions.reduce((s, x) => s + x.tasksCancelled, 0),
    userInterventions: totalInputs,
    interventionsPerLaunch: totalLaunched > 0 ? Math.round((totalInputs / totalLaunched) * 100) / 100 : 0,
    findingsResolved: sessions.reduce((s, x) => s + x.findingsResolved, 0),
    findingsSnoozed: sessions.reduce((s, x) => s + x.findingsSnoozed, 0),
    findingsSkipped: sessions.reduce((s, x) => s + x.findingsSkipped, 0),
    findingsByAnomalyType,
    avgInputResolutionMs: inputResCount > 0 ? Math.round(totalInputResMs / inputResCount) : 0,
    emptySessions: sessions.filter((s) => s.isEmpty).length,
    snoozeStorms: detectSnoozeStorms(sessions),
    crashRecoverySessions: sessions.filter((s) => s.crashRecovery.events > 0).length,
    crashRecoveryRelaunches: sessions.reduce((sum, s) => sum + s.crashRecovery.relaunched, 0),
    crashRecoveryResumed: sessions.reduce((sum, s) => sum + s.crashRecovery.resumed, 0),
    crashRecoveryFresh: sessions.reduce((sum, s) => sum + s.crashRecovery.fresh, 0),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const state = readState();
  const allDirs = listSessionDirs();

  // Determine which sessions to analyze
  let targetDirs: string[];
  if (flags.session) {
    targetDirs = [flags.session];
  } else if (flags.all) {
    targetDirs = allDirs;
  } else {
    // New sessions only
    const analyzed = new Set(state.analyzed_sessions);
    targetDirs = allDirs.filter((d) => !analyzed.has(d));
  }

  if (targetDirs.length === 0) {
    if (flags.json) {
      console.log(JSON.stringify({ status: "no_new_sessions", analyzed: state.analyzed_sessions.length }));
    } else {
      console.log("No new sessions to analyze.");
    }
    process.exit(0);
  }

  // Analyze each session
  const sessions = targetDirs.map(analyzeSession);
  const stats = aggregate(sessions);

  // Classify all user inputs
  const inputClassification: Record<string, number> = {};
  for (const s of sessions) {
    for (const input of s.userInputDetails) {
      inputClassification[input.classification] = (inputClassification[input.classification] || 0) + 1;
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({ sessions, stats, inputClassification, state }, null, 2));
    return;
  }

  // ─── Human-readable output ──────────────────────────────────────────────

  console.log("═".repeat(72));
  console.log(`Kookr Interaction Stats — ${targetDirs.length} sessions`);
  console.log("═".repeat(72));

  console.log(`\n## Aggregate Stats\n`);
  console.log(`Sessions analyzed:       ${stats.sessionsAnalyzed} (${stats.emptySessions} empty)`);
  console.log(`Agents launched:         ${stats.agentsLaunched}`);
  console.log(`Tasks completed:         ${stats.tasksCompleted}`);
  console.log(`Tasks cancelled:         ${stats.tasksCancelled}`);
  console.log(`User interventions:      ${stats.userInterventions}`);
  console.log(`Interventions/launch:    ${stats.interventionsPerLaunch}`);
  console.log(`Findings resolved:       ${stats.findingsResolved}`);
  console.log(`Findings snoozed:        ${stats.findingsSnoozed}`);
  console.log(`Findings skipped:        ${stats.findingsSkipped}`);
  console.log(`Avg input resolution:    ${Math.round(stats.avgInputResolutionMs / 1000)}s`);
  if (stats.crashRecoverySessions > 0) {
    console.log(`Crash recovery sessions: ${stats.crashRecoverySessions}`);
    console.log(`Recovery relaunches:     ${stats.crashRecoveryRelaunches} (${stats.crashRecoveryResumed} resumed, ${stats.crashRecoveryFresh} fresh)`);
  }

  console.log(`\n## Findings by Anomaly Type\n`);
  console.log(`${"Type".padEnd(20)} ${"Input".padStart(6)} ${"Snooze".padStart(7)} ${"Skip".padStart(6)} ${"Total".padStart(6)}`);
  console.log("─".repeat(50));
  for (const [at, counts] of Object.entries(stats.findingsByAnomalyType)) {
    const total = counts.input + counts.snooze + counts.skip;
    console.log(`${at.padEnd(20)} ${String(counts.input).padStart(6)} ${String(counts.snooze).padStart(7)} ${String(counts.skip).padStart(6)} ${String(total).padStart(6)}`);
  }

  console.log(`\n## User Input Classification\n`);
  for (const [cls, count] of Object.entries(inputClassification).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }

  if (stats.snoozeStorms.length > 0) {
    console.log(`\n## Snooze Storms (5+ snoozes)\n`);
    for (const storm of stats.snoozeStorms) {
      console.log(`  ${storm.agentId}: ${storm.totalSnoozes} snoozes across ${storm.sessions.length} sessions`);
      console.log(`    Types: ${Object.entries(storm.anomalyTypes).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      console.log(`    Window: ${storm.firstSeen} → ${storm.lastSeen}`);
    }
  }

  console.log(`\n## Per-Session Breakdown\n`);
  for (const s of sessions) {
    const tag = s.isEmpty ? " [EMPTY]" : "";
    const kindTag = s.sessionKind !== "normal" ? ` [${s.sessionKind}]` : "";
    console.log(`### ${s.sessionDir}${tag}${kindTag}`);
    console.log(`  Duration: ${s.startTime.slice(11, 19)} → ${s.endTime.slice(11, 19)} (${s.durationMinutes}m)`);
    console.log(`  Events: ${s.eventCount} | Launched: ${s.agentsLaunched} | Completed: ${s.tasksCompleted} | Inputs: ${s.userInputs} | Resolved: ${s.findingsResolved} | Snoozed: ${s.findingsSnoozed}`);
    if (s.crashRecovery.events > 0) {
      console.log(`  Crash recovery: ${s.crashRecovery.relaunched} relaunched (${s.crashRecovery.resumed} resumed, ${s.crashRecovery.fresh} fresh), ${s.crashRecovery.skipped} skipped, ${s.crashRecovery.failed} failed`);
    }
    if (s.launchedPrompts.length > 0) {
      console.log(`  Launched:`);
      for (const p of s.launchedPrompts) {
        console.log(`    ${p.agentId}: ${p.prompt.slice(0, 80)}...`);
      }
    }
    if (s.userInputDetails.length > 0) {
      console.log(`  User inputs:`);
      for (const inp of s.userInputDetails) {
        console.log(`    [${inp.classification}] → ${inp.agentId}: "${inp.content.slice(0, 80)}"`);
      }
    }
    console.log();
  }

  // ─── State info ──────────────────────────────────────────────────────────

  console.log(`## State\n`);
  console.log(`Previously analyzed: ${state.analyzed_sessions.length}`);
  console.log(`New this run:        ${targetDirs.length}`);
  console.log(`Run count:           ${state.run_count}`);
  console.log(`Last run:            ${state.last_run || "never"}`);
}

main();
