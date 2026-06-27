#!/usr/bin/env bun
/**
 * Claude Code Session Analyzer
 *
 * CLI tool to analyze ~/.claude session data for self-reflection,
 * correction detection, and workflow optimization.
 *
 * Usage: bun scripts/session-analyzer.ts [options]
 */

import { readdirSync, statSync, existsSync, createReadStream, openSync, readSync, closeSync } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";
import { homedir } from "os";
import { pathToFileURL } from "url";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CliArgs {
  project?: string;
  since?: string;
  until?: string;
  session?: string;
  includeWorktrees: boolean;
  sortBy: "date" | "turns" | "tokens" | "tool-calls" | "size";
  limit: number;
  detail: "list" | "summary" | "conversation" | "tools" | "corrections" | "tokens" | "errors" | "timeline";
  format: "text" | "json" | "markdown";
  current?: string; // current session ID
  toolsReport: boolean;
  patterns: boolean;
  userMessages: boolean;
  repeatedInstructions: boolean;
  includeFilteredRepeatedInstructions: boolean;
  repeatThreshold: number;
  help: boolean;
}

export interface SessionMeta {
  sessionId: string;
  projectPath: string;    // raw project dir name
  projectName: string;    // friendly name (e.g., "kookr")
  jsonlPath: string;
  provider: "claude-code" | "codex-cli";
  dirPath?: string;       // session directory if exists
  fileSize: number;
  startedAt?: string;     // ISO timestamp from first message
  pid?: number;
  kind?: string;
  entrypoint?: string;
}

export interface ParsedMessage {
  type: "user" | "assistant" | "system" | "progress" | "file-history-snapshot" | "queue-operation" | "last-prompt";
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
  // User-specific
  isHumanInput?: boolean;  // true when user typed it (no toolUseResult)
  humanText?: string;
  codexEventKind?: "response_user" | "event_user" | "token_snapshot" | "function_call";
  toolUseResult?: boolean;
  permissionMode?: string;
  machineEvent?: "subagent_notification";
  reviewerResult?: ReviewerSpecialistResult;
  // Assistant-specific
  isSyntheticAssistantEvent?: boolean;
  textContent?: string;
  thinkingContent?: string;
  toolCalls?: ToolCall[];
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  isError?: boolean;
  errorText?: string;
  // System-specific
  subtype?: string;
  durationMs?: number;
}

interface ToolCall {
  name: string;
  inputSummary: string; // first ~100 chars of input
}

type ReviewerRole = "conventions" | "correctness" | "deadcode" | "test" | "a11y" | "unknown";
type ReviewerRunStatus = "completed" | "failed" | "unknown";
type ReviewerSeverity = "blocking" | "suggestion" | "info" | "unknown";

export interface ReviewerFinding {
  role: ReviewerRole;
  agentPath: string;
  title: string;
  severity: ReviewerSeverity;
  category?: string;
  file?: string;
  comment: string;
  raw: string;
}

export interface ReviewerSpecialistResult {
  agentPath: string;
  role: ReviewerRole;
  status: ReviewerRunStatus;
  summary: string;
  findings: ReviewerFinding[];
  error?: string;
}

export interface ReviewerAggregateResult {
  rolesRun: ReviewerRole[];
  blockerCount: number;
  suggestionCount: number;
  noFindingCount: number;
  findings: ReviewerFinding[];
  linksToDetail: Array<{ role: ReviewerRole; agentPath: string }>;
  failedSpecialistRuns: Array<{ role: ReviewerRole; agentPath: string; error: string }>;
}

export interface SessionAnalysis {
  meta: SessionMeta;
  humanTurns: number;
  assistantTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  toolCounts: Record<string, number>;
  toolErrors: number;
  longestTurnMs: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  humanMessages: Array<{ text: string; timestamp: string }>;
  corrections: Array<{ text: string; timestamp: string; precedingAssistant?: string }>;
  errors: Array<{ text: string; timestamp: string }>;
  interruptions: number;
  reviewerAggregate: ReviewerAggregateResult;
  messages: ParsedMessage[]; // full parsed messages (only populated for detail modes that need it)
}

type WorkflowFilteredReason = "harness_note" | "eval_fixture" | "reviewer_prompt" | "workflow_launch";

export interface RepeatedInstructionRecord {
  normalized: string;
  original: string;
  sessionId: string;
  timestamp: string;
  intent: string;
  filteredReason?: WorkflowFilteredReason;
}

export interface RepeatedInstructionPattern {
  normalized: string;
  messages: RepeatedInstructionRecord[];
  intent: string;
  filteredReason?: WorkflowFilteredReason;
}

export interface RepeatedInstructionCollection {
  allMessages: RepeatedInstructionRecord[];
  repeated: RepeatedInstructionPattern[];
  filteredCount: number;
  filteredReasons: Partial<Record<WorkflowFilteredReason, number>>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const CODEX_SESSIONS_DIR = process.env.CODEX_HOME ?? join(homedir(), ".codex", "sessions");

const CORRECTION_PATTERNS = [
  /\bi told you\b/i,
  /\bremember that\b/i,
  /\byou should have\b/i,
  /\bwhy did you\b/i,
  /\bdon'?t do\b/i,
  /\bstop doing\b/i,
  /\bnot like that\b/i,
  /\bwrong\b/i,
  /\bi already said\b/i,
  /\byou must\b/i,
  /\byou forgot\b/i,
  /\byou missed\b/i,
  /\bthat's not what\b/i,
  /\bthat is not what\b/i,
  /\bno,?\s+(don'?t|not|instead|actually|that'?s)\b/i,
  /\bi said\b/i,
  /\bi asked you\b/i,
  /\byou were supposed to\b/i,
  /\bplease don'?t\b/i,
  /\bnever\s+(do|use|add|create|make)\b/i,
  /\balways\s+(do|use|run|check)\b/i,
  /\byou need to\b/i,
  /\byou have to\b/i,
  /\byou shall\b/i,
];

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    includeWorktrees: false,
    sortBy: "date",
    limit: 20,
    detail: "list",
    format: "text",
    toolsReport: false,
    patterns: false,
    userMessages: false,
    repeatedInstructions: false,
    includeFilteredRepeatedInstructions: false,
    repeatThreshold: 3,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--project":
      case "-p":
        args.project = next;
        i++;
        break;
      case "--since":
        args.since = next;
        i++;
        break;
      case "--until":
        args.until = next;
        i++;
        break;
      case "--session":
      case "-s":
        args.session = next;
        i++;
        break;
      case "--include-worktrees":
        args.includeWorktrees = true;
        break;
      case "--sort-by":
        args.sortBy = next as CliArgs["sortBy"];
        i++;
        break;
      case "--limit":
      case "-n":
        args.limit = parseInt(next, 10);
        i++;
        break;
      case "--detail":
      case "-d":
        args.detail = next as CliArgs["detail"];
        i++;
        break;
      case "--corrections":
        args.detail = "corrections";
        break;
      case "--timeline":
        args.detail = "timeline";
        break;
      case "--tokens":
        args.detail = "tokens";
        break;
      case "--errors":
        args.detail = "errors";
        break;
      case "--tools-report":
        args.toolsReport = true;
        break;
      case "--patterns":
        args.patterns = true;
        break;
      case "--user-messages":
        args.userMessages = true;
        break;
      case "--repeated-instructions":
        args.repeatedInstructions = true;
        break;
      case "--include-filtered-workflow":
      case "--include-filtered-repeated-instructions":
        args.includeFilteredRepeatedInstructions = true;
        break;
      case "--repeat-threshold":
        args.repeatThreshold = parseInt(next, 10);
        i++;
        break;
      case "--format":
      case "-f":
        args.format = next as CliArgs["format"];
        i++;
        break;
      case "--current":
        args.current = next;
        i++;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // Positional: treat as session ID if looks like UUID prefix
        if (/^[0-9a-f]{4,}/.test(arg)) {
          args.session = arg;
        }
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Claude Code Session Analyzer

Usage: bun scripts/session-analyzer.ts [options] [session-id]

Filtering:
  -p, --project <name>      Filter by project (fuzzy match on path)
  --since <date>             Sessions after this date (YYYY-MM-DD)
  --until <date>             Sessions before this date (YYYY-MM-DD)
  -s, --session <id>         Filter by session ID (prefix match)
  --include-worktrees        Include worktree sessions (excluded by default)
  --sort-by <field>          Sort by: date|turns|tokens|tool-calls|size (default: date)
  -n, --limit <N>            Max sessions to show (default: 20, 0=all)

Detail levels:
  -d, --detail <level>       Detail level: list|summary|conversation|tools|
                             corrections|tokens|errors|timeline
  --corrections              Shorthand for --detail corrections
  --timeline                 Shorthand for --detail timeline
  --tokens                   Shorthand for --detail tokens
  --errors                   Shorthand for --detail errors

Reports:
  --tools-report             Aggregate tool usage across all matching sessions
  --patterns                 Cross-session pattern analysis
  --user-messages            Extract only human-typed messages (no tool results)
  --repeated-instructions    Find instructions repeated across sessions (default: 3+)
  --include-filtered-workflow
                              Include filtered machine/workflow prompts in repeated instructions (debug)
  --repeat-threshold <N>     Min occurrences for repeated instructions (default: 3)

Output:
  -f, --format <fmt>         Output format: text|json|markdown (default: text)
  --current <sessionId>      Analyze a specific current session

Examples:
  bun scripts/session-analyzer.ts -p kookr --since 2026-03-25
  bun scripts/session-analyzer.ts --corrections -p kookr -n 5
  bun scripts/session-analyzer.ts -s c53005dc -d conversation
  bun scripts/session-analyzer.ts -p kookr --tools-report
  bun scripts/session-analyzer.ts -p kookr --patterns --since 2026-03-20
`);
}

// ─── Session Discovery ───────────────────────────────────────────────────────

function discoverSessions(args: CliArgs): SessionMeta[] {
  const sessions: SessionMeta[] = [];

  if (!existsSync(PROJECTS_DIR)) return discoverCodexSessions(args);

  const projectDirs = readdirSync(PROJECTS_DIR);

  for (const projDir of projectDirs) {
    const projPath = join(PROJECTS_DIR, projDir);
    if (!statSync(projPath).isDirectory()) continue;

    // Filter worktrees
    if (!args.includeWorktrees && projDir.includes("--worktree")) continue;

    // Filter by project name
    if (args.project) {
      const normalized = projDir.toLowerCase().replace(/-/g, "");
      const query = args.project.toLowerCase().replace(/-/g, "");
      if (!normalized.includes(query)) continue;
    }

    // Derive friendly project name
    const projectName = deriveProjectName(projDir);

    // Find all JSONL files (sessions)
    const entries = readdirSync(projPath);
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;

      const sessionId = entry.replace(".jsonl", "");

      // Filter by session ID
      if (args.session && !sessionId.startsWith(args.session)) continue;

      const jsonlPath = join(projPath, entry);
      const stat = statSync(jsonlPath);

      // Check for companion directory
      const dirPath = join(projPath, sessionId);
      const hasDirPath = existsSync(dirPath) && statSync(dirPath).isDirectory();

      sessions.push({
        sessionId,
        projectPath: projDir,
        projectName,
        jsonlPath,
        provider: "claude-code",
        dirPath: hasDirPath ? dirPath : undefined,
        fileSize: stat.size,
      });
    }
  }

  sessions.push(...discoverCodexSessions(args));
  return sessions;
}

function discoverCodexSessions(args: CliArgs): SessionMeta[] {
  if (!existsSync(CODEX_SESSIONS_DIR)) return [];

  const sessions: SessionMeta[] = [];
  for (const jsonlPath of walkCodexRollouts(CODEX_SESSIONS_DIR)) {
    const stat = statSync(jsonlPath);
    const meta = readCodexSessionMeta(jsonlPath);
    const sessionId = meta.sessionId || basename(jsonlPath).replace(/^rollout-/, "").replace(/\.jsonl$/, "");

    if (args.session && !sessionId.startsWith(args.session)) continue;

    const projectPath = meta.cwd || "codex-cli";
    const projectName = projectPath ? basename(projectPath) : "codex-cli";
    if (args.project) {
      const normalizedPath = projectPath.toLowerCase().replace(/-/g, "");
      const normalizedName = projectName.toLowerCase().replace(/-/g, "");
      const normalizedPrompt = meta.firstUserText.toLowerCase().replace(/-/g, "");
      const query = args.project.toLowerCase().replace(/-/g, "");
      const invocationProject = basename(process.cwd()).toLowerCase().replace(/-/g, "");
      const isRuntimeContextForInvocationProject = normalizedName.startsWith(".") && invocationProject.includes(query);
      if (!isRuntimeContextForInvocationProject && !normalizedPath.includes(query) && !normalizedName.includes(query) && !normalizedPrompt.includes(query)) continue;
    }

    sessions.push({
      sessionId,
      projectPath,
      projectName,
      jsonlPath,
      provider: "codex-cli",
      fileSize: stat.size,
      startedAt: meta.startedAt,
    });
  }
  return sessions;
}

function walkCodexRollouts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkCodexRollouts(path));
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      out.push(path);
    }
  }
  return out;
}

function readCodexSessionMeta(path: string): { sessionId: string; cwd: string; startedAt?: string; firstUserText: string } {
  const lines = readInitialLines(path, 24);
  const first = lines[0];
  if (!first) return { sessionId: "", cwd: "", firstUserText: "" };
  try {
    const obj = JSON.parse(first) as Record<string, unknown>;
    if (obj.type !== "session_meta") return { sessionId: "", cwd: "", firstUserText: extractFirstCodexUserText(lines.slice(1)) };
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    return {
      sessionId: typeof payload.id === "string" ? payload.id : "",
      cwd: typeof payload.cwd === "string" ? payload.cwd : "",
      startedAt: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
      firstUserText: extractFirstCodexUserText(lines.slice(1)),
    };
  } catch {
    return { sessionId: "", cwd: "", firstUserText: "" };
  }
}

function readInitialLines(path: string, maxLines: number): string[] {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    let text = "";
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytes <= 0) break;
      text += buffer.subarray(0, bytes).toString("utf-8");
      const lines = text.split("\n");
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines);
      }
      offset += bytes;
      if (offset >= 2 * 1024 * 1024) {
        return lines.slice(0, maxLines);
      }
    }
    return text ? text.split("\n").slice(0, maxLines) : [];
  } finally {
    closeSync(fd);
  }
}

function extractFirstCodexUserText(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === "response_item") {
        const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
        if (payload.type === "message" && payload.role === "user") {
          return extractCodexText(payload.content);
        }
      }
      if (obj.type === "event_msg") {
        const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
        if (payload.type === "user_message" && typeof payload.message === "string") {
          return payload.message;
        }
      }
    } catch {
      continue;
    }
  }
  return "";
}

function deriveProjectName(projDir: string): string {
  // -home-jean-git-kookr -> kookr
  // -home-jean-git-aegiscore -> aegiscore
  const parts = projDir.split("-").filter(Boolean);
  // Find the part after "git" if it exists
  const gitIdx = parts.indexOf("git");
  if (gitIdx >= 0 && gitIdx < parts.length - 1) {
    return parts.slice(gitIdx + 1).join("-");
  }
  return parts[parts.length - 1] || projDir;
}

// ─── JSONL Parsing ───────────────────────────────────────────────────────────

async function parseSessionJsonl(path: string, fullMessages: boolean, provider: SessionMeta["provider"]): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];

  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const msg = provider === "codex-cli"
        ? parseCodexMessage(obj, fullMessages)
        : parseMessage(obj, fullMessages);
      if (msg) messages.push(msg);
    } catch {
      // Skip malformed lines
    }
  }

  return provider === "codex-cli" ? normalizeCodexMessages(messages) : messages;
}

function normalizeCodexMessages(messages: ParsedMessage[]): ParsedMessage[] {
  const responseUserTexts = new Set(
    messages
      .filter((msg) => msg.codexEventKind === "response_user" && msg.humanText)
      .map((msg) => msg.humanText!.trim()),
  );

  const withoutDuplicateUserEvents = messages.filter((msg) => {
    if (msg.codexEventKind !== "event_user" || !msg.humanText) return true;
    return !responseUserTexts.has(msg.humanText.trim());
  });

  let lastTokenSnapshotIndex = -1;
  for (let i = 0; i < withoutDuplicateUserEvents.length; i++) {
    if (withoutDuplicateUserEvents[i].codexEventKind === "token_snapshot") {
      lastTokenSnapshotIndex = i;
    }
  }

  if (lastTokenSnapshotIndex < 0) return withoutDuplicateUserEvents;
  return withoutDuplicateUserEvents.map((msg, index) => {
    if (msg.codexEventKind !== "token_snapshot" || index === lastTokenSnapshotIndex) {
      return msg;
    }
    return {
      ...msg,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  });
}

export function parseCodexMessage(obj: Record<string, unknown>, fullContent: boolean): ParsedMessage | null {
  const type = obj.type as string | undefined;
  if (!type) return null;

  const base: ParsedMessage = {
    type: "system",
    timestamp: obj.timestamp as string | undefined,
  };

  if (type === "session_meta") {
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    return {
      ...base,
      subtype: "session_meta",
      sessionId: typeof payload.id === "string" ? payload.id : undefined,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    };
  }

  if (type === "response_item") {
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    const payloadType = payload.type as string | undefined;
    if (payloadType === "message") {
      const role = payload.role as string | undefined;
      if (role === "user") {
        const text = extractCodexText(payload.content);
        const reviewerResult = parseSubagentNotification(text);
        return {
          ...base,
          type: "user",
          codexEventKind: "response_user",
          isHumanInput: reviewerResult ? false : true,
          humanText: text,
          machineEvent: reviewerResult ? "subagent_notification" : undefined,
          reviewerResult,
        };
      }
      if (role === "assistant") {
        return {
          ...base,
          type: "assistant",
          textContent: fullContent ? extractCodexText(payload.content) : truncate(extractCodexText(payload.content), 200),
        };
      }
    }
    if (payloadType === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const args = typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments ?? {});
      return {
        ...base,
        type: "assistant",
        codexEventKind: "function_call",
        isSyntheticAssistantEvent: true,
        toolCalls: [{ name, inputSummary: truncate(args, 80) }],
      };
    }
    return null;
  }

  if (type === "event_msg") {
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    const eventType = payload.type as string | undefined;
    if (eventType === "user_message" && typeof payload.message === "string") {
      const reviewerResult = parseSubagentNotification(payload.message);
      return {
        ...base,
        type: "user",
        codexEventKind: "event_user",
        isHumanInput: reviewerResult ? false : true,
        humanText: payload.message,
        machineEvent: reviewerResult ? "subagent_notification" : undefined,
        reviewerResult,
      };
    }
    if (eventType === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined;
      const total = info?.total_token_usage as Record<string, unknown> | undefined;
      if (!total) return null;
      return {
        ...base,
        type: "assistant",
        codexEventKind: "token_snapshot",
        isSyntheticAssistantEvent: true,
        inputTokens: typeof total.input_tokens === "number" ? total.input_tokens : 0,
        outputTokens: typeof total.output_tokens === "number" ? total.output_tokens : 0,
        cacheReadTokens: typeof total.cached_input_tokens === "number" ? total.cached_input_tokens : 0,
      };
    }
    return null;
  }

  return null;
}

function extractCodexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const text = b.text ?? b.input_text ?? b.output_text;
    if (typeof text === "string") texts.push(text);
  }
  return texts.join("\n");
}

export function parseMessage(obj: Record<string, unknown>, fullContent: boolean): ParsedMessage | null {
  const type = obj.type as string;
  if (!type) return null;

  const base: ParsedMessage = {
    type: type as ParsedMessage["type"],
    timestamp: obj.timestamp as string | undefined,
    uuid: obj.uuid as string | undefined,
    parentUuid: obj.parentUuid as string | undefined,
    sessionId: obj.sessionId as string | undefined,
    gitBranch: obj.gitBranch as string | undefined,
    cwd: obj.cwd as string | undefined,
    version: obj.version as string | undefined,
  };

  if (type === "user") {
    const hasToolResult = Boolean(obj.toolUseResult);
    base.isHumanInput = !hasToolResult;
    base.toolUseResult = hasToolResult;
    base.permissionMode = obj.permissionMode as string | undefined;

    if (!hasToolResult) {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg) {
        const content = msg.content;
        if (typeof content === "string") {
          base.humanText = content;
        } else if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const block of content) {
            if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
              texts.push((block as Record<string, unknown>).text as string);
            }
          }
          base.humanText = texts.join("\n");
        }
      }
      const reviewerResult = parseSubagentNotification(base.humanText ?? "");
      if (reviewerResult) {
        base.isHumanInput = false;
        base.machineEvent = "subagent_notification";
        base.reviewerResult = reviewerResult;
      }
    }
    return base;
  }

  if (type === "assistant") {
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) return base;

    base.stopReason = msg.stop_reason as string | undefined;
    base.isError = Boolean(obj.error) || Boolean(obj.isApiErrorMessage);

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      base.inputTokens = (usage.input_tokens as number) || 0;
      base.outputTokens = (usage.output_tokens as number) || 0;
      base.cacheReadTokens = (usage.cache_read_input_tokens as number) || 0;
      base.cacheCreationTokens = (usage.cache_creation_input_tokens as number) || 0;
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      const thinkings: string[] = [];
      const tools: ToolCall[] = [];

      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          const text = b.text as string;
          if (base.isError || (text && text.startsWith("API Error"))) {
            base.isError = true;
            base.errorText = text;
          }
          if (fullContent) texts.push(text);
          else texts.push(truncate(text, 200));
        } else if (b.type === "thinking") {
          if (fullContent) thinkings.push(b.thinking as string);
        } else if (b.type === "tool_use") {
          const input = b.input as Record<string, unknown> | undefined;
          tools.push({
            name: b.name as string,
            inputSummary: input ? summarizeToolInput(b.name as string, input) : "",
          });
        }
      }

      base.textContent = texts.join("\n");
      base.thinkingContent = thinkings.join("\n") || undefined;
      base.toolCalls = tools.length > 0 ? tools : undefined;
    }

    return base;
  }

  if (type === "system") {
    base.subtype = obj.subtype as string | undefined;
    base.durationMs = obj.durationMs as number | undefined;
    return base;
  }

  if (type === "progress") {
    return base;
  }

  // Skip file-history-snapshot and other types in most modes
  return fullContent ? base : null;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return (input.file_path as string) || "";
    case "Write":
      return (input.file_path as string) || "";
    case "Edit":
      return (input.file_path as string) || "";
    case "Bash":
      return truncate((input.command as string) || "", 80);
    case "Grep":
      return `${input.pattern || ""} ${input.path || ""}`.trim();
    case "Glob":
      return `${input.pattern || ""} ${input.path || ""}`.trim();
    case "Agent":
      return truncate((input.description as string) || (input.prompt as string) || "", 80);
    case "Skill":
      return (input.skill as string) || "";
    default:
      return truncate(JSON.stringify(input), 80);
  }
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len) + "...";
}

// ─── Reviewer Fan-Out Result Parsing ─────────────────────────────────────────

function emptyReviewerAggregate(): ReviewerAggregateResult {
  return {
    rolesRun: [],
    blockerCount: 0,
    suggestionCount: 0,
    noFindingCount: 0,
    findings: [],
    linksToDetail: [],
    failedSpecialistRuns: [],
  };
}

export function parseSubagentNotification(text: string): ReviewerSpecialistResult | undefined {
  const match = text.trim().match(/^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/);
  if (!match) return undefined;

  try {
    const payload = JSON.parse(match[1]) as Record<string, unknown>;
    const agentPath = typeof payload.agent_path === "string" ? payload.agent_path : "";
    const status = payload.status && typeof payload.status === "object"
      ? payload.status as Record<string, unknown>
      : {};

    const completed = typeof status.completed === "string" ? status.completed : undefined;
    const failed = typeof status.failed === "string"
      ? status.failed
      : typeof status.error === "string"
        ? status.error
        : undefined;
    const summary = completed ?? failed ?? JSON.stringify(status);
    const role = inferReviewerRole(summary);
    const runStatus: ReviewerRunStatus = completed ? "completed" : failed ? "failed" : "unknown";
    const findings = runStatus === "completed"
      ? parseReviewerFindings(summary, role, agentPath)
      : [];

    return {
      agentPath,
      role,
      status: runStatus,
      summary,
      findings,
      error: failed,
    };
  } catch {
    // Malformed synthetic notifications are ignored as machine events so they
    // do not get promoted into organic user-message analytics.
    return undefined;
  }
}

function addReviewerResult(aggregate: ReviewerAggregateResult, result: ReviewerSpecialistResult): void {
  if (!aggregate.rolesRun.includes(result.role)) {
    aggregate.rolesRun.push(result.role);
  }

  aggregate.linksToDetail.push({ role: result.role, agentPath: result.agentPath });

  if (result.status === "failed") {
    aggregate.failedSpecialistRuns.push({
      role: result.role,
      agentPath: result.agentPath,
      error: result.error ?? result.summary,
    });
    return;
  }

  if (result.status === "completed" && result.findings.length === 0) {
    aggregate.noFindingCount++;
  }

  for (const finding of result.findings) {
    aggregate.findings.push(finding);
    if (finding.severity === "blocking") {
      aggregate.blockerCount++;
    } else if (finding.severity === "suggestion") {
      aggregate.suggestionCount++;
    }
  }
}

function inferReviewerRole(text: string): ReviewerRole {
  const lower = text.toLowerCase();
  // Reviewer notifications do not carry role metadata today, so infer the
  // specialist role from stable rubric words and finding categories.
  if (/\ba11y\b|accessibility|aria|screen reader/.test(lower)) return "a11y";
  if (/dead[- ]?code|unused symbol|orphaned definition/.test(lower)) return "deadcode";
  if (/correctness|behavioral regression|edge case|safety/.test(lower)) return "correctness";
  if (/\btest issues?\b|test specialist|test correctness|tautological|coverage/.test(lower)) return "test";
  if (/convention|style|readability|scope\/noise|category\*\*:\s*docs|category\*\*:\s*documentation|module docstring/.test(lower)) return "conventions";
  return "unknown";
}

function parseReviewerFindings(text: string, role: ReviewerRole, agentPath: string): ReviewerFinding[] {
  const sections = text.split(/^###\s+Finding\s+/gm).slice(1);
  return sections.map((section, index) => {
    const firstNewline = section.indexOf("\n");
    const label = firstNewline >= 0 ? section.slice(0, firstNewline).trim() : String(index + 1);
    const body = firstNewline >= 0 ? section.slice(firstNewline + 1).trim() : "";
    const number = label.match(/^(\d+)/)?.[1] ?? String(index + 1);
    const raw = `### Finding ${label}\n${body}`.trim();
    return {
      role,
      agentPath,
      title: `Finding ${number}`,
      severity: parseReviewerSeverity(extractMarkdownField(body, "Severity")),
      category: extractMarkdownField(body, "Category"),
      file: extractMarkdownField(body, "File"),
      comment: extractMarkdownField(body, "Comment") ?? summarizeFindingComment(body),
      raw,
    };
  });
}

function extractMarkdownField(text: string, field: string): string | undefined {
  const re = new RegExp(`^-\\s+\\*\\*${field}\\*\\*:\\s*(.+)$`, "im");
  const match = text.match(re);
  return match?.[1]?.trim();
}

function parseReviewerSeverity(value: string | undefined): ReviewerSeverity {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "blocking") return "blocking";
  if (normalized === "suggestion") return "suggestion";
  if (normalized === "info" || normalized === "informational") return "info";
  return "unknown";
}

function summarizeFindingComment(body: string): string {
  const lines = body
    .split("\n")
    .map((line) => line.replace(/^-\s+/, "").trim())
    .filter(Boolean);
  return truncate(lines.join(" "), 240);
}

// ─── Session Analysis ────────────────────────────────────────────────────────

export function analyzeMessages(meta: SessionMeta, messages: ParsedMessage[]): SessionAnalysis {
  const analysis: SessionAnalysis = {
    meta,
    humanTurns: 0,
    assistantTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    toolCounts: {},
    toolErrors: 0,
    longestTurnMs: 0,
    humanMessages: [],
    corrections: [],
    errors: [],
    interruptions: 0,
    reviewerAggregate: emptyReviewerAggregate(),
    messages,
  };

  let lastAssistantText: string | undefined;

  for (const msg of messages) {
    if (msg.timestamp) {
      if (!analysis.firstTimestamp || msg.timestamp < analysis.firstTimestamp) {
        analysis.firstTimestamp = msg.timestamp;
      }
      if (!analysis.lastTimestamp || msg.timestamp > analysis.lastTimestamp) {
        analysis.lastTimestamp = msg.timestamp;
      }
    }

    if (msg.machineEvent === "subagent_notification" && msg.reviewerResult) {
      addReviewerResult(analysis.reviewerAggregate, msg.reviewerResult);
      continue;
    }

    if (msg.type === "user" && msg.isHumanInput && msg.humanText) {
      const text = msg.humanText.trim();
      if (isAnalyzerNoise(text)) {
        continue;
      }

      analysis.humanTurns++;

      if (text === "[Request interrupted by user]") {
        analysis.interruptions++;
      }

      analysis.humanMessages.push({
        text,
        timestamp: msg.timestamp || "",
      });

      // Check for corrections
      if (isCorrection(text)) {
        analysis.corrections.push({
          text,
          timestamp: msg.timestamp || "",
          precedingAssistant: lastAssistantText,
        });
      }
    }

    if (msg.type === "assistant") {
      if (!msg.isSyntheticAssistantEvent) {
        analysis.assistantTurns++;
      }
      analysis.totalInputTokens += msg.inputTokens || 0;
      analysis.totalOutputTokens += msg.outputTokens || 0;
      analysis.totalCacheRead += msg.cacheReadTokens || 0;
      analysis.totalCacheCreation += msg.cacheCreationTokens || 0;

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          analysis.toolCounts[tc.name] = (analysis.toolCounts[tc.name] || 0) + 1;
        }
      }

      if (msg.isError) {
        analysis.toolErrors++;
        if (msg.errorText) {
          analysis.errors.push({
            text: msg.errorText,
            timestamp: msg.timestamp || "",
          });
        }
      }

      if (msg.textContent) {
        lastAssistantText = msg.textContent;
      }
    }

    if (msg.type === "system" && msg.subtype === "turn_duration") {
      if (msg.durationMs && msg.durationMs > analysis.longestTurnMs) {
        analysis.longestTurnMs = msg.durationMs;
      }
    }
  }

  return analysis;
}

function isCorrection(text: string): boolean {
  if (text.length < 5) return false;
  if (text === "[Request interrupted by user]") return false;
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isAnalyzerNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("<environment_context>")) return true;
  if (trimmed.startsWith("<turn_aborted>")) return true;
  if (trimmed.startsWith("# AGENTS.md instructions")) return true;
  if (trimmed.startsWith("<task-notification>")) return true;
  if (trimmed.startsWith("<subagent_notification>")) return true;
  if (trimmed.startsWith("Base directory for this skill:")) return true;
  if (trimmed.startsWith("---\n")) return true;
  if (trimmed.startsWith("## Worktree isolation")) return true;
  if (/do not commit/i.test(trimmed) && /worktree/i.test(trimmed)) return true;
  if (/^Implement .* issue #\d+ .*end-to-end/i.test(trimmed) && /(Hard constraints:|Worktree isolation)/i.test(trimmed)) return true;
  return false;
}

// ─── Timestamp Filtering ─────────────────────────────────────────────────────

async function getSessionTimestamp(path: string): Promise<string | undefined> {
  // Read just the first few lines to find a timestamp
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) {
        rl.close();
        stream.destroy();
        return obj.timestamp as string;
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

function dateToIso(dateStr: string): string {
  // Accept YYYY-MM-DD and return start-of-day ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr + "T00:00:00.000Z";
  }
  return dateStr;
}

// ─── Output Formatters ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function formatTime(iso: string): string {
  if (!iso) return "??:??:??";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "??:??:??";
  return d.toISOString().slice(11, 19);
}

function topTools(toolCounts: Record<string, number>, limit = 4): string {
  return Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${count} ${name}`)
    .join("  ");
}

// ─── Detail Renderers ────────────────────────────────────────────────────────

function renderList(analyses: SessionAnalysis[]): void {
  const header = `${"Date".padEnd(17)} ${"Session".padEnd(10)} ${"Turns".padEnd(6)} ${"Tools".padEnd(6)} ${"Tokens".padEnd(10)} ${"Size".padEnd(8)} ${"Longest".padEnd(8)} Project`;
  console.log(header);
  console.log("─".repeat(header.length));

  for (const a of analyses) {
    const date = a.firstTimestamp ? formatDate(a.firstTimestamp) : "unknown";
    const sid = a.meta.sessionId.slice(0, 8);
    const turns = String(a.humanTurns).padEnd(6);
    const totalTools = Object.values(a.toolCounts).reduce((s, c) => s + c, 0);
    const tools = String(totalTools).padEnd(6);
    const tokens = formatTokens(a.totalOutputTokens).padEnd(10);
    const size = formatSize(a.meta.fileSize).padEnd(8);
    const longest = a.longestTurnMs > 0 ? formatDuration(a.longestTurnMs).padEnd(8) : "—".padEnd(8);
    const proj = a.meta.projectName;

    console.log(`${date} ${sid} ${turns} ${tools} ${tokens} ${size} ${longest} ${proj}`);
  }
}

function renderSummary(analyses: SessionAnalysis[]): void {
  for (const a of analyses) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId}`);
    console.log(`Project: ${a.meta.projectName} (${a.meta.projectPath})`);
    console.log(`Provider: ${a.meta.provider}`);
    if (a.firstTimestamp) console.log(`Started: ${formatDate(a.firstTimestamp)}`);
    if (a.firstTimestamp && a.lastTimestamp) {
      const dur = new Date(a.lastTimestamp).getTime() - new Date(a.firstTimestamp).getTime();
      console.log(`Duration: ${formatDuration(dur)}`);
    }
    console.log(`\nHuman turns: ${a.humanTurns}  |  Assistant turns: ${a.assistantTurns}  |  Interruptions: ${a.interruptions}`);
    console.log(`Tokens — Input: ${formatTokens(a.totalInputTokens)}  Output: ${formatTokens(a.totalOutputTokens)}  Cache read: ${formatTokens(a.totalCacheRead)}  Cache write: ${formatTokens(a.totalCacheCreation)}`);
    if (a.longestTurnMs > 0) console.log(`Longest turn: ${formatDuration(a.longestTurnMs)}`);

    renderReviewerAggregate(a.reviewerAggregate);

    console.log(`\nTool usage:`);
    const sortedTools = Object.entries(a.toolCounts).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sortedTools) {
      console.log(`  ${count.toString().padStart(4)}  ${name}`);
    }

    if (a.corrections.length > 0) {
      console.log(`\nCorrections detected: ${a.corrections.length}`);
      for (const c of a.corrections) {
        console.log(`  [${formatTime(c.timestamp)}] ${truncate(c.text, 100)}`);
      }
    }

    if (a.humanMessages.length > 0) {
      console.log(`\nHuman messages (first 10):`);
      for (const m of a.humanMessages.slice(0, 10)) {
        console.log(`  [${formatTime(m.timestamp)}] ${truncate(m.text, 120)}`);
      }
      if (a.humanMessages.length > 10) {
        console.log(`  ... and ${a.humanMessages.length - 10} more`);
      }
    }
  }
}

function renderConversation(analyses: SessionAnalysis[]): void {
  for (const a of analyses) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId} | ${a.meta.projectName}`);
    console.log(`${"═".repeat(72)}\n`);

    for (const msg of a.messages) {
      if (msg.type === "user" && msg.isHumanInput && msg.humanText) {
        console.log(`[${formatTime(msg.timestamp || "")}] USER:`);
        console.log(msg.humanText);
        console.log();
      } else if (msg.type === "assistant") {
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            console.log(`[${formatTime(msg.timestamp || "")}] TOOL: ${tc.name}  ${truncate(tc.inputSummary, 100)}`);
          }
        }
        if (msg.textContent && msg.textContent.trim()) {
          console.log(`[${formatTime(msg.timestamp || "")}] ASSISTANT:`);
          console.log(msg.textContent);
          console.log();
        }
      } else if (msg.type === "system" && msg.subtype === "turn_duration") {
        console.log(`  ── turn duration: ${formatDuration(msg.durationMs || 0)} ──\n`);
      }
    }
  }
}

function renderTools(analyses: SessionAnalysis[]): void {
  for (const a of analyses) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId} | ${a.meta.projectName}\n`);

    for (const msg of a.messages) {
      if (msg.type === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const time = formatTime(msg.timestamp || "");
          console.log(`[${time}] ${tc.name.padEnd(16)} ${tc.inputSummary}`);
        }
      }
    }
  }
}

function renderCorrections(analyses: SessionAnalysis[]): void {
  let totalCorrections = 0;

  for (const a of analyses) {
    if (a.corrections.length === 0) continue;
    totalCorrections += a.corrections.length;

    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId} | ${a.meta.projectName} | ${a.meta.provider} | ${formatDate(a.firstTimestamp || "")}`);
    console.log(`Corrections: ${a.corrections.length} / ${a.humanTurns} human turns`);
    console.log(`${"─".repeat(72)}`);

    for (const c of a.corrections) {
      console.log(`\n  [${formatTime(c.timestamp)}] USER:`);
      console.log(`  ${c.text}`);
      if (c.precedingAssistant) {
        console.log(`\n  Preceding assistant output:`);
        console.log(`  ${truncate(c.precedingAssistant, 300)}`);
      }
      console.log();
    }
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log(`Total corrections found: ${totalCorrections} across ${analyses.filter((a) => a.corrections.length > 0).length} sessions`);
}

function renderTokens(analyses: SessionAnalysis[]): void {
  for (const a of analyses) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId} | ${a.meta.projectName}\n`);

    const cacheHitRate =
      a.totalCacheRead + a.totalCacheCreation > 0
        ? ((a.totalCacheRead / (a.totalCacheRead + a.totalCacheCreation)) * 100).toFixed(1)
        : "0.0";

    console.log(`Total input:     ${formatTokens(a.totalInputTokens)}`);
    console.log(`Total output:    ${formatTokens(a.totalOutputTokens)}`);
    console.log(`Cache read:      ${formatTokens(a.totalCacheRead)}`);
    console.log(`Cache creation:  ${formatTokens(a.totalCacheCreation)}`);
    console.log(`Cache hit rate:  ${cacheHitRate}%`);
    console.log();

    // Show top turns by output tokens
    const assistantMsgs = a.messages
      .filter((m) => m.type === "assistant" && (m.outputTokens || 0) > 0)
      .sort((x, y) => (y.outputTokens || 0) - (x.outputTokens || 0))
      .slice(0, 10);

    if (assistantMsgs.length > 0) {
      console.log("Top turns by output tokens:");
      for (const msg of assistantMsgs) {
        const time = formatTime(msg.timestamp || "");
        const out = formatTokens(msg.outputTokens || 0);
        const inp = formatTokens(msg.inputTokens || 0);
        const tools = msg.toolCalls?.map((t) => t.name).join(", ") || "(text)";
        console.log(`  [${time}] out=${out.padEnd(8)} in=${inp.padEnd(8)} ${tools}`);
      }
    }
  }
}

function renderErrors(analyses: SessionAnalysis[]): void {
  let totalErrors = 0;

  for (const a of analyses) {
    if (a.errors.length === 0) continue;
    totalErrors += a.errors.length;

    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId} | ${a.meta.projectName}`);

    for (const e of a.errors) {
      console.log(`  [${formatTime(e.timestamp)}] ${truncate(e.text, 200)}`);
    }
  }

  if (totalErrors === 0) {
    console.log("No errors found in matching sessions.");
  } else {
    console.log(`\nTotal errors: ${totalErrors}`);
  }
}

function renderTimeline(analyses: SessionAnalysis[]): void {
  for (const a of analyses) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId} | ${a.meta.projectName}`);
    console.log(`${"═".repeat(72)}\n`);

    for (const msg of a.messages) {
      const time = formatTime(msg.timestamp || "");

      if (msg.type === "user" && msg.isHumanInput && msg.humanText) {
        const label = msg.humanText === "[Request interrupted by user]" ? "INTR" : "USER";
        console.log(`${time}  ${label.padEnd(5)}  ${truncate(msg.humanText, 100)}`);
      } else if (msg.type === "assistant") {
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            console.log(`${time}  TOOL   [${tc.name}] ${truncate(tc.inputSummary, 80)}`);
          }
        }
        if (msg.textContent && msg.textContent.trim() && !msg.isError) {
          console.log(`${time}  ASST   ${truncate(msg.textContent.trim(), 100)}`);
        }
        if (msg.isError && msg.errorText) {
          console.log(`${time}  ERROR  ${truncate(msg.errorText, 100)}`);
        }
      } else if (msg.type === "system" && msg.subtype === "turn_duration") {
        console.log(`${time}  DUR    ${formatDuration(msg.durationMs || 0)}`);
      }
    }
  }
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function renderToolsReport(analyses: SessionAnalysis[]): void {
  const aggregate: Record<string, { count: number; sessions: number }> = {};
  const sessionCount = analyses.length;

  for (const a of analyses) {
    for (const [tool, count] of Object.entries(a.toolCounts)) {
      if (!aggregate[tool]) aggregate[tool] = { count: 0, sessions: 0 };
      aggregate[tool].count += count;
      aggregate[tool].sessions++;
    }
  }

  const sorted = Object.entries(aggregate).sort((a, b) => b[1].count - a[1].count);

  console.log(`\nTool Usage Report (${sessionCount} sessions)\n`);
  renderProviderCoverage(analyses);
  const header = `${"Tool".padEnd(24)} ${"Total".padStart(7)} ${"Avg/Sess".padStart(10)} ${"Sessions".padStart(10)}`;
  console.log(header);
  console.log("─".repeat(header.length));

  for (const [tool, data] of sorted) {
    const avg = (data.count / sessionCount).toFixed(1);
    const sessPercent = `${data.sessions}/${sessionCount}`;
    console.log(`${tool.padEnd(24)} ${data.count.toString().padStart(7)} ${avg.padStart(10)} ${sessPercent.padStart(10)}`);
  }
}

function renderPatterns(analyses: SessionAnalysis[]): void {
  console.log(`\nCross-Session Pattern Analysis (${analyses.length} sessions)\n`);
  renderProviderCoverage(analyses);
  console.log();

  // 1. Correction frequency
  const sessionsWithCorrections = analyses.filter((a) => a.corrections.length > 0);
  console.log(`Sessions with corrections: ${sessionsWithCorrections.length}/${analyses.length}`);

  // Aggregate correction texts to find repeated themes
  const correctionTexts: string[] = [];
  for (const a of analyses) {
    for (const c of a.corrections) {
      correctionTexts.push(c.text);
    }
  }
  console.log(`Total corrections: ${correctionTexts.length}\n`);

  if (correctionTexts.length > 0) {
    // Find common words in corrections (simple frequency)
    const wordFreq: Record<string, number> = {};
    const stopWords = new Set(["the", "a", "an", "to", "in", "of", "and", "or", "is", "it", "that", "this", "for", "you", "i", "do", "not", "don't", "have", "should", "be"]);

    for (const text of correctionTexts) {
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stopWords.has(w));
      const seen = new Set<string>();
      for (const w of words) {
        if (!seen.has(w)) {
          wordFreq[w] = (wordFreq[w] || 0) + 1;
          seen.add(w);
        }
      }
    }

    const topWords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    if (topWords.length > 0) {
      console.log("Common themes in corrections:");
      for (const [word, count] of topWords) {
        console.log(`  ${count.toString().padStart(3)}x  ${word}`);
      }
      console.log();
    }
  }

  // 2. Interruption rate
  const totalInterruptions = analyses.reduce((s, a) => s + a.interruptions, 0);
  const totalTurns = analyses.reduce((s, a) => s + a.humanTurns, 0);
  console.log(`Interruptions: ${totalInterruptions}/${totalTurns} turns (${totalTurns > 0 ? ((totalInterruptions / totalTurns) * 100).toFixed(1) : 0}%)\n`);

  const reviewerRuns = analyses.reduce((sum, a) => sum + a.reviewerAggregate.linksToDetail.length, 0);
  if (reviewerRuns > 0) {
    const blockers = analyses.reduce((sum, a) => sum + a.reviewerAggregate.blockerCount, 0);
    const suggestions = analyses.reduce((sum, a) => sum + a.reviewerAggregate.suggestionCount, 0);
    const failures = analyses.reduce((sum, a) => sum + a.reviewerAggregate.failedSpecialistRuns.length, 0);
    console.log(`Reviewer fan-out machine events: ${reviewerRuns} runs, ${blockers} blockers, ${suggestions} suggestions, ${failures} failed runs`);
    console.log("  These are excluded from human-turn, correction, and repeated-instruction counts.\n");
  }

  // 3. Token trends (by session date)
  const byDate: Record<string, { tokens: number; sessions: number }> = {};
  for (const a of analyses) {
    const date = a.firstTimestamp ? a.firstTimestamp.slice(0, 10) : "unknown";
    if (!byDate[date]) byDate[date] = { tokens: 0, sessions: 0 };
    byDate[date].tokens += a.totalOutputTokens;
    byDate[date].sessions++;
  }

  const dates = Object.keys(byDate).sort();
  if (dates.length > 1) {
    console.log("Daily token usage:");
    for (const date of dates) {
      const d = byDate[date];
      console.log(`  ${date}  ${formatTokens(d.tokens).padStart(10)} output  (${d.sessions} sessions)`);
    }
    console.log();
  }

  // 4. Average session metrics
  const avgTurns = totalTurns / analyses.length;
  const avgTools = analyses.reduce((s, a) => s + Object.values(a.toolCounts).reduce((x, y) => x + y, 0), 0) / analyses.length;
  const avgTokens = analyses.reduce((s, a) => s + a.totalOutputTokens, 0) / analyses.length;

  console.log("Averages per session:");
  console.log(`  Human turns: ${avgTurns.toFixed(1)}`);
  console.log(`  Tool calls:  ${avgTools.toFixed(1)}`);
  console.log(`  Output tokens: ${formatTokens(avgTokens)}`);
}

// ─── User Message Analysis ──────────────────────────────────────────────────

function renderUserMessages(analyses: SessionAnalysis[]): void {
  console.log(`\nUser Messages Across ${analyses.length} Sessions\n`);
  renderProviderCoverage(analyses);
  console.log();

  let totalMessages = 0;
  for (const a of analyses) {
    const msgs = a.humanMessages.filter(
      (m) => m.text !== "[Request interrupted by user]" && m.text.length > 0,
    );
    if (msgs.length === 0) continue;

    console.log(`${"═".repeat(72)}`);
    console.log(`Session: ${a.meta.sessionId.slice(0, 8)} | ${a.meta.projectName} | ${a.meta.provider} | ${a.firstTimestamp ? formatDate(a.firstTimestamp) : "unknown"}`);
    console.log(`${"─".repeat(72)}`);

    for (const msg of msgs) {
      const time = msg.timestamp ? formatTime(msg.timestamp) : "??:??:??";
      // Truncate long messages to first 200 chars
      const text = msg.text.length > 200 ? msg.text.slice(0, 200) + "..." : msg.text;
      console.log(`  [${time}] ${text}`);
      totalMessages++;
    }
    console.log();
  }

  console.log(`Total user messages: ${totalMessages} across ${analyses.length} sessions`);
}

/**
 * Normalize a user message for fuzzy matching:
 * - lowercase, collapse whitespace, trim
 * - strip leading "ok " / "okay " / "yes " / "sure "
 * - strip trailing punctuation
 * - truncate to first 80 chars (captures the intent, ignores variable details)
 */
function normalizeForMatching(text: string): string {
  let s = text.toLowerCase().replace(/\s+/g, " ").trim();
  // Strip common acknowledgment prefixes
  s = s.replace(/^(ok|okay|yes|sure|great|thanks|thank you|please)[,. ]+/i, "");
  // Strip trailing punctuation
  s = s.replace(/[.!?]+$/, "");
  // Truncate — intent is usually in the first 80 chars
  return s.slice(0, 80).trim();
}

/**
 * Classify a user message by intent category.
 * More granular than the kookr-interaction-stats 4-category system.
 */
function classifyIntent(text: string): string {
  const lower = text.toLowerCase().trim();

  // Interruption
  if (lower === "[request interrupted by user]") return "interruption";

  // Approval / acknowledgment
  if (/^(yes|y|ok|okay|sure|go ahead|looks good|lgtm|perfect|approved|ship it|do it|merge|merge it)[\s!.]*$/i.test(lower)) return "approval";

  // Lifecycle commands (commit, push, PR, merge)
  if (/\b(commit|push|create pr|create a pr|pull request|merge it|merge$)\b/i.test(lower)) return "lifecycle";

  // Course correction / redirect
  if (/^(no[, ]|don't|stop|actually|instead|not that|wrong|undo|revert|focus on|skip)/i.test(lower)) return "correction";

  // Process instruction (use subagents, create worktree, review, etc.)
  if (/\b(subagent|worktree|use .* to|create .* for|spawn|launch|reflect|review|criticize|revise)\b/i.test(lower)) return "process";

  // Question
  if (/\?$/.test(lower) || /^(what|why|how|did|is|are|can|could|should|do you|have you|where)\b/i.test(lower)) return "question";

  // Directive (everything else that's substantive)
  if (lower.length > 10) return "directive";

  return "other";
}

function classifyWorkflowInjectedInstruction(text: string): WorkflowFilteredReason | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith("harness note:")) return "harness_note";
  if (lower.startsWith("## task gist")) return "eval_fixture";
  if (/^you are the (?:test|correctness|dead[- ]?code|conventions|a11y|accessibility)-specialist reviewer for a kookr pr\b/i.test(trimmed)) {
    return "reviewer_prompt";
  }
  if (/^you are continuing a sequential kookr github-issue implementation chain\b/i.test(trimmed)) {
    return "workflow_launch";
  }
  if (/^# (?:agent )?task assignment\b/i.test(trimmed) && /\b(repo checkout|worktree|issue #?\d+)\b/i.test(trimmed)) {
    return "workflow_launch";
  }

  return undefined;
}

export function collectRepeatedInstructions(
  analyses: SessionAnalysis[],
  threshold: number,
  options: { includeFilteredWorkflow?: boolean } = {},
): RepeatedInstructionCollection {
  const allMessages: RepeatedInstructionRecord[] = [];
  let filteredCount = 0;
  const filteredReasons: Partial<Record<WorkflowFilteredReason, number>> = {};

  for (const a of analyses) {
    for (const msg of a.humanMessages) {
      const text = msg.text.trim();
      if (text === "[Request interrupted by user]" || text.length < 5) continue;
      if (isAnalyzerNoise(text)) continue;

      const filteredReason = classifyWorkflowInjectedInstruction(text);
      if (filteredReason) {
        filteredCount++;
        filteredReasons[filteredReason] = (filteredReasons[filteredReason] ?? 0) + 1;
        if (!options.includeFilteredWorkflow) continue;
      }

      allMessages.push({
        normalized: normalizeForMatching(text),
        original: text,
        sessionId: a.meta.sessionId.slice(0, 8),
        timestamp: msg.timestamp ? formatDate(msg.timestamp) : "unknown",
        intent: filteredReason ? "machine_workflow" : classifyIntent(text),
        filteredReason,
      });
    }
  }

  const groups: Record<string, RepeatedInstructionRecord[]> = {};
  for (const msg of allMessages) {
    if (!groups[msg.normalized]) groups[msg.normalized] = [];
    groups[msg.normalized].push(msg);
  }

  const repeated = Object.entries(groups)
    .filter(([_, msgs]) => {
      const uniqueSessions = new Set(msgs.map((m) => m.sessionId));
      return msgs.length >= threshold && uniqueSessions.size >= 2;
    })
    .sort((a, b) => b[1].length - a[1].length)
    .map(([normalized, messages]) => ({
      normalized,
      messages,
      intent: messages[0].intent,
      filteredReason: messages[0].filteredReason,
    }));

  return { allMessages, repeated, filteredCount, filteredReasons };
}

function renderRepeatedInstructions(
  analyses: SessionAnalysis[],
  threshold: number,
  options: { includeFilteredWorkflow?: boolean } = {},
): void {
  console.log(`\nRepeated User Instructions Across ${analyses.length} Sessions (threshold: ${threshold}+)\n`);

  const collection = collectRepeatedInstructions(analyses, threshold, options);
  const { allMessages, repeated } = collection;

  if (!options.includeFilteredWorkflow && collection.filteredCount > 0) {
    const reasonSummary = Object.entries(collection.filteredReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ");
    console.log(`Filtered ${collection.filteredCount} machine/workflow prompt(s): ${reasonSummary}.`);
    console.log("Use --include-filtered-workflow to include them for debugging.\n");
  }

  if (repeated.length === 0) {
    console.log("No repeated instructions found above threshold.\n");

    // Still show intent classification summary
    renderIntentSummary(allMessages);
    return;
  }

  console.log(`Found ${repeated.length} repeated instruction patterns:\n`);

  for (const pattern of repeated) {
    const { normalized, messages: msgs } = pattern;
    const uniqueSessions = new Set(msgs.map((m) => m.sessionId));
    const intent = pattern.intent;
    console.log(`  ${msgs.length}x across ${uniqueSessions.size} sessions [${intent}]`);
    if (pattern.filteredReason) {
      console.log(`  Filter: ${pattern.filteredReason}`);
    }
    console.log(`  Pattern: "${normalized}"`);
    // Show first 3 examples with session context
    for (const ex of msgs.slice(0, 3)) {
      const original = ex.original.length > 100 ? ex.original.slice(0, 100) + "..." : ex.original;
      console.log(`    ${ex.timestamp} (${ex.sessionId}): "${original}"`);
    }
    console.log();
  }

  // Suggestions based on intent
  console.log("─".repeat(72));
  console.log("Improvement Suggestions:\n");

  const byIntent: Record<string, RepeatedInstructionPattern[]> = {};
  for (const entry of repeated) {
    const intent = entry.intent;
    if (!byIntent[intent]) byIntent[intent] = [];
    byIntent[intent].push(entry);
  }

  if (byIntent["approval"]) {
    console.log(`  APPROVAL patterns (${byIntent["approval"].length}): Users repeatedly approve agent proposals.`);
    console.log(`  → Consider adding a CLAUDE.md rule that pre-authorises this approval pattern.`);
    console.log();
  }
  if (byIntent["lifecycle"]) {
    console.log(`  LIFECYCLE patterns (${byIntent["lifecycle"].length}): Users repeatedly ask to commit/push/PR.`);
    console.log(`  → Agents should auto-complete the delivery cycle or prompt once.`);
    console.log();
  }
  if (byIntent["correction"]) {
    console.log(`  CORRECTION patterns (${byIntent["correction"].length}): Users repeatedly redirect agents.`);
    console.log(`  → Each pattern should become a CLAUDE.md rule or skill.`);
    console.log();
  }
  if (byIntent["process"]) {
    console.log(`  PROCESS patterns (${byIntent["process"].length}): Users repeatedly specify workflow steps.`);
    console.log(`  → Consider creating playbooks for these workflows.`);
    console.log();
  }

  renderIntentSummary(allMessages);
}

function renderIntentSummary(allMessages: Array<{ intent: string }>): void {
  // Intent classification summary
  const intentCounts: Record<string, number> = {};
  for (const msg of allMessages) {
    intentCounts[msg.intent] = (intentCounts[msg.intent] || 0) + 1;
  }

  console.log("─".repeat(72));
  console.log("User Input Intent Classification:\n");
  const sorted = Object.entries(intentCounts).sort((a, b) => b[1] - a[1]);
  for (const [intent, count] of sorted) {
    const pct = allMessages.length > 0 ? ((count / allMessages.length) * 100).toFixed(0) : "0";
    console.log(`  ${intent.padEnd(15)} ${count.toString().padStart(4)} (${pct}%)`);
  }
  console.log(`  ${"total".padEnd(15)} ${allMessages.length.toString().padStart(4)}`);
}

function renderProviderCoverage(analyses: SessionAnalysis[]): void {
  const counts: Record<string, number> = {};
  for (const analysis of analyses) {
    counts[analysis.meta.provider] = (counts[analysis.meta.provider] || 0) + 1;
  }
  if (Object.keys(counts).length <= 1) return;
  console.log(`Provider coverage: ${Object.entries(counts).map(([provider, count]) => `${provider}=${count}`).join(", ")}`);
}

// ─── JSON Output ─────────────────────────────────────────────────────────────

function renderJson(analyses: SessionAnalysis[]): void {
  const output = analyses.map((a) => ({
    sessionId: a.meta.sessionId,
    project: a.meta.projectName,
    projectPath: a.meta.projectPath,
    provider: a.meta.provider,
    fileSize: a.meta.fileSize,
    startedAt: a.firstTimestamp,
    endedAt: a.lastTimestamp,
    humanTurns: a.humanTurns,
    assistantTurns: a.assistantTurns,
    interruptions: a.interruptions,
    tokens: {
      input: a.totalInputTokens,
      output: a.totalOutputTokens,
      cacheRead: a.totalCacheRead,
      cacheCreation: a.totalCacheCreation,
    },
    toolCounts: a.toolCounts,
    toolErrors: a.toolErrors,
    reviewerAggregate: a.reviewerAggregate,
    longestTurnMs: a.longestTurnMs,
    corrections: a.corrections.map((c) => ({
      text: c.text,
      timestamp: c.timestamp,
      precedingAssistant: c.precedingAssistant ? truncate(c.precedingAssistant, 300) : undefined,
    })),
    errors: a.errors,
    humanMessages: a.humanMessages.map((m) => ({
      text: truncate(m.text, 500),
      timestamp: m.timestamp,
    })),
  }));

  console.log(JSON.stringify(output, null, 2));
}

// ─── Markdown Output ─────────────────────────────────────────────────────────

function renderMarkdown(analyses: SessionAnalysis[]): void {
  console.log("# Session Analysis Report\n");
  console.log(`**Sessions analyzed:** ${analyses.length}\n`);

  for (const a of analyses) {
    console.log(`## ${a.meta.sessionId.slice(0, 8)} — ${a.meta.projectName}\n`);
    console.log(`| Metric | Value |`);
    console.log(`|--------|-------|`);
    if (a.firstTimestamp) console.log(`| Started | ${formatDate(a.firstTimestamp)} |`);
    console.log(`| Human turns | ${a.humanTurns} |`);
    console.log(`| Assistant turns | ${a.assistantTurns} |`);
    console.log(`| Output tokens | ${formatTokens(a.totalOutputTokens)} |`);
    console.log(`| Interruptions | ${a.interruptions} |`);
    console.log(`| Corrections | ${a.corrections.length} |`);
    console.log(`| Reviewer runs | ${a.reviewerAggregate.linksToDetail.length} |`);
    console.log(`| Reviewer blockers | ${a.reviewerAggregate.blockerCount} |`);
    console.log(`| Reviewer suggestions | ${a.reviewerAggregate.suggestionCount} |`);
    console.log(`| Longest turn | ${formatDuration(a.longestTurnMs)} |`);
    console.log();

    if (Object.keys(a.toolCounts).length > 0) {
      console.log("**Tools:** " + topTools(a.toolCounts, 8) + "\n");
    }

    if (a.corrections.length > 0) {
      console.log("**Corrections:**\n");
      for (const c of a.corrections) {
        console.log(`- \`${formatTime(c.timestamp)}\` ${c.text}`);
      }
      console.log();
    }
  }
}

function renderReviewerAggregate(aggregate: ReviewerAggregateResult): void {
  if (aggregate.linksToDetail.length === 0) return;

  console.log(`\nReviewer fan-out: ${aggregate.linksToDetail.length} run(s)`);
  console.log(`  Roles: ${aggregate.rolesRun.join(", ") || "unknown"}`);
  console.log(`  Findings: ${aggregate.blockerCount} blocker(s), ${aggregate.suggestionCount} suggestion(s), ${aggregate.noFindingCount} no-finding run(s), ${aggregate.failedSpecialistRuns.length} failed run(s)`);

  for (const finding of aggregate.findings.slice(0, 5)) {
    const file = finding.file ? ` ${finding.file}` : "";
    console.log(`  - [${finding.role}/${finding.severity}]${file} ${truncate(finding.comment, 120)}`);
  }
  if (aggregate.findings.length > 5) {
    console.log(`  ... and ${aggregate.findings.length - 5} more reviewer finding(s)`);
  }
  for (const failed of aggregate.failedSpecialistRuns) {
    console.log(`  - [${failed.role}/failed] ${truncate(failed.error, 120)}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  // If --current, override session filter
  if (args.current) {
    args.session = args.current;
  }

  // Discover sessions
  let sessions = discoverSessions(args);

  if (sessions.length === 0) {
    console.log("No sessions found matching filters.");
    return;
  }

  // Get timestamps for date filtering and sorting
  const needTimestamps = Boolean(args.since || args.until || args.sortBy === "date");
  if (needTimestamps) {
    const timestampPromises = sessions.map(async (s) => {
      s.startedAt = await getSessionTimestamp(s.jsonlPath);
    });
    await Promise.all(timestampPromises);
  }

  // Apply date filters
  if (args.since) {
    const sinceIso = dateToIso(args.since);
    sessions = sessions.filter((s) => !s.startedAt || s.startedAt >= sinceIso);
  }
  if (args.until) {
    const untilIso = dateToIso(args.until);
    sessions = sessions.filter((s) => !s.startedAt || s.startedAt <= untilIso);
  }

  // Sort
  switch (args.sortBy) {
    case "date":
      sessions.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      break;
    case "size":
      sessions.sort((a, b) => b.fileSize - a.fileSize);
      break;
    // For turns/tokens/tool-calls sort, we need to parse first - defer to post-analysis
  }

  // Apply limit
  const needsFullParse = args.detail !== "list" || args.toolsReport || args.patterns || args.userMessages || args.repeatedInstructions || args.sortBy === "turns" || args.sortBy === "tokens" || args.sortBy === "tool-calls";

  if (!needsFullParse && args.limit > 0) {
    sessions = sessions.slice(0, args.limit);
  }

  // For list mode with date sort, we can do a lightweight analysis
  const fullContent = ["conversation", "tools", "timeline"].includes(args.detail);

  // Parse and analyze sessions
  const analyses: SessionAnalysis[] = [];

  // Process in batches to avoid too many open file handles
  const batchSize = 10;
  const toProcess = needsFullParse && args.limit > 0 ? sessions : sessions.slice(0, args.limit > 0 ? args.limit : sessions.length);

  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (session) => {
        const messages = await parseSessionJsonl(session.jsonlPath, fullContent, session.provider);
        return analyzeMessages(session, messages);
      }),
    );
    analyses.push(...batchResults);
  }

  // Post-analysis sorting
  if (args.sortBy === "turns") {
    analyses.sort((a, b) => b.humanTurns - a.humanTurns);
  } else if (args.sortBy === "tokens") {
    analyses.sort((a, b) => b.totalOutputTokens - a.totalOutputTokens);
  } else if (args.sortBy === "tool-calls") {
    const totalTools = (a: SessionAnalysis) => Object.values(a.toolCounts).reduce((s, c) => s + c, 0);
    analyses.sort((a, b) => totalTools(b) - totalTools(a));
  }

  // Apply limit after sort if needed
  const limited = args.limit > 0 ? analyses.slice(0, args.limit) : analyses;

  // Render reports if requested
  if (args.toolsReport) {
    renderToolsReport(limited);
    return;
  }

  if (args.patterns) {
    renderPatterns(limited);
    return;
  }

  if (args.userMessages) {
    renderUserMessages(limited);
    return;
  }

  if (args.repeatedInstructions) {
    renderRepeatedInstructions(limited, args.repeatThreshold, {
      includeFilteredWorkflow: args.includeFilteredRepeatedInstructions,
    });
    return;
  }

  // Render by format
  if (args.format === "json") {
    renderJson(limited);
    return;
  }

  if (args.format === "markdown") {
    renderMarkdown(limited);
    return;
  }

  // Text output by detail level
  switch (args.detail) {
    case "list":
      renderList(limited);
      break;
    case "summary":
      renderSummary(limited);
      break;
    case "conversation":
      renderConversation(limited);
      break;
    case "tools":
      renderTools(limited);
      break;
    case "corrections":
      renderCorrections(limited);
      break;
    case "tokens":
      renderTokens(limited);
      break;
    case "errors":
      renderErrors(limited);
      break;
    case "timeline":
      renderTimeline(limited);
      break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
