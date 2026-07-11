import { describe, expect, test, vi } from "vitest";
import {
  analyzeMessages,
  buildToolEfficiencyReport,
  collectRepeatedInstructions,
  normalizeCommandFingerprint,
  parseCodexMessage,
  parseMessage,
  parseSubagentNotification,
  renderToolsReport,
  type ParsedMessage,
  type SessionMeta,
} from "../plugin/skills/self-reflect/scripts/session-analyzer.js";

const meta: SessionMeta = {
  sessionId: "session-1",
  projectPath: "/repo",
  projectName: "repo",
  jsonlPath: "/tmp/session.jsonl",
  provider: "codex-cli",
  fileSize: 1,
};

function notification(status: Record<string, string>, agentPath = "019ee564-reviewer"): string {
  return `<subagent_notification>
${JSON.stringify({ agent_path: agentPath, status })}
</subagent_notification>`;
}

function analysisWithHumanMessage(sessionId: string, text: string): ReturnType<typeof analyzeMessages> {
  return analyzeMessages(
    { ...meta, sessionId },
    [{
      type: "user",
      timestamp: "2026-06-27T10:00:00.000Z",
      isHumanInput: true,
      humanText: text,
    }],
  );
}

function repeatedAnalyses(prefix: string, count: number, text: string): ReturnType<typeof analyzeMessages>[] {
  return Array.from({ length: count }, (_, index) => analysisWithHumanMessage(`${index.toString(16).padStart(8, "0")}-${prefix}`, text));
}

describe("session analyzer reviewer fan-out", () => {
  test("parses reviewer subagent notifications as machine events, not human input", () => {
    const msg = parseCodexMessage({
      timestamp: "2026-06-20T14:20:02.184Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: notification({
            completed: "No test issues found.\n\nReviewed only changed test files.",
          }, "test-agent"),
        }],
      },
    }, true);

    expect(msg).toMatchObject({
      type: "user",
      isHumanInput: false,
      machineEvent: "subagent_notification",
      reviewerResult: {
        agentPath: "test-agent",
        role: "test",
        status: "completed",
        findings: [],
      },
    });
  });

  test("parses Codex event_msg reviewer notifications as machine events", () => {
    const msg = parseCodexMessage({
      timestamp: "2026-06-20T14:20:02.184Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: notification({
          completed: "No correctness issues found.",
        }, "correctness-agent"),
      },
    }, true);

    expect(msg).toMatchObject({
      type: "user",
      isHumanInput: false,
      machineEvent: "subagent_notification",
      reviewerResult: {
        agentPath: "correctness-agent",
        role: "correctness",
        status: "completed",
      },
    });
  });

  test("aggregates no findings, suggestions, blockers, and failed specialist runs", () => {
    const messages: ParsedMessage[] = [
      parseCodexMessage({
        timestamp: "2026-06-20T14:19:03.355Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: notification({ completed: "No test issues found." }, "test-agent") }],
        },
      }, true)!,
      parseCodexMessage({
        timestamp: "2026-06-20T14:19:09.717Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: notification({
              completed: [
                "### Finding 1",
                "- **File**: `loop/propose.py:125-130`",
                "- **Severity**: suggestion",
                "- **Category**: dead-code",
                "- **Comment**: The operator mutates a value that no runtime consumer reads.",
              ].join("\n"),
            }, "deadcode-agent"),
          }],
        },
      }, true)!,
      parseCodexMessage({
        timestamp: "2026-06-20T14:20:02.184Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: notification({
              completed: [
                "### Finding 1",
                "- **File**: loop/propose.py:65-73",
                "- **Severity**: blocking",
                "- **Category**: correctness",
                "- **Comment**: Disabled operators enter the sampler choices before the eligibility gate rejects them.",
              ].join("\n"),
            }, "correctness-agent"),
          }],
        },
      }, true)!,
      parseCodexMessage({
        timestamp: "2026-06-20T14:21:02.184Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: notification({ failed: "agent timed out" }, "a11y-agent") }],
        },
      }, true)!,
      {
        type: "user",
        timestamp: "2026-06-20T14:22:02.184Z",
        isHumanInput: true,
        humanText: "please fix the blocker",
      },
    ];

    const analysis = analyzeMessages(meta, messages);

    expect(analysis.humanTurns).toBe(1);
    expect(analysis.humanMessages.map((m) => m.text)).toEqual(["please fix the blocker"]);
    expect(analysis.reviewerAggregate).toMatchObject({
      blockerCount: 1,
      suggestionCount: 1,
      noFindingCount: 1,
      failedSpecialistRuns: [{ role: "unknown", agentPath: "a11y-agent", error: "agent timed out" }],
    });
    expect(analysis.reviewerAggregate.findings.map((finding) => finding.severity).sort()).toEqual([
      "blocking",
      "suggestion",
    ]);
    expect(analysis.reviewerAggregate.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "deadcode",
          agentPath: "deadcode-agent",
          file: "`loop/propose.py:125-130`",
          category: "dead-code",
          comment: "The operator mutates a value that no runtime consumer reads.",
        }),
        expect.objectContaining({
          role: "correctness",
          agentPath: "correctness-agent",
          file: "loop/propose.py:65-73",
          category: "correctness",
          comment: "Disabled operators enter the sampler choices before the eligibility gate rejects them.",
        }),
      ]),
    );
    expect(analysis.reviewerAggregate.rolesRun).toEqual(
      expect.arrayContaining(["test", "deadcode", "correctness", "unknown"]),
    );
  });

  test("handles Claude-style user messages with subagent notification wrappers", () => {
    const msg = parseMessage({
      type: "user",
      timestamp: "2026-06-20T14:20:02.184Z",
      message: {
        role: "user",
        content: notification({
          completed: "### Finding 1\n- **Severity**: blocking\n- **Category**: correctness\n- **Comment**: A real bug.",
        }, "claude-reviewer"),
      },
    }, true);

    expect(msg?.isHumanInput).toBe(false);
    expect(msg?.reviewerResult?.findings[0]).toMatchObject({
      role: "correctness",
      severity: "blocking",
      comment: "A real bug.",
    });
  });

  test("returns undefined for normal human messages", () => {
    expect(parseSubagentNotification("please run tests")).toBeUndefined();
  });
});

describe("session analyzer repeated-instruction workflow filtering", () => {
  test("excludes repeated harness notes by default and includes them with debug flag", () => {
    const harnessNote = "Harness note: the read-only KB command is `kb-ro`. When the variant instructions say `kb ...`, run `kb-ro ...` instead.";
    const organicInstruction = "Run the focused self-reflect session analyzer test";
    const analyses = [
      ...repeatedAnalyses("harness", 64, harnessNote),
      ...repeatedAnalyses("organic", 3, organicInstruction),
    ];

    const filtered = collectRepeatedInstructions(analyses, 3);
    expect(filtered.filteredCount).toBe(64);
    expect(filtered.filteredReasons).toMatchObject({ harness_note: 64 });
    expect(filtered.repeated.map((pattern) => pattern.normalized)).toEqual([
      "run the focused self-reflect session analyzer test",
    ]);

    const debug = collectRepeatedInstructions(analyses, 3, { includeFilteredWorkflow: true });
    expect(debug.repeated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalized: "harness note: the read-only kb command is `kb-ro`. when the variant instructions",
          intent: "machine_workflow",
          filteredReason: "harness_note",
          messages: expect.arrayContaining([
            expect.objectContaining({ original: harnessNote }),
          ]),
        }),
      ]),
    );
  });

  test("excludes reviewer-specialist launch prompts from repeated instructions by default", () => {
    const reviewerPrompt = [
      "You are the correctness-specialist reviewer for a Kookr PR.",
      "",
      "Repo checkout: /path/to/repo",
      "Review the merge-base diff and report blocking correctness issues only.",
    ].join("\n");
    const analyses = repeatedAnalyses("reviewer", 3, reviewerPrompt);

    const filtered = collectRepeatedInstructions(analyses, 2);
    expect(filtered.repeated).toEqual([]);
    expect(filtered.filteredReasons).toMatchObject({ reviewer_prompt: 3 });

    const debug = collectRepeatedInstructions(analyses, 2, { includeFilteredWorkflow: true });
    expect(debug.repeated).toEqual([
      expect.objectContaining({
        intent: "machine_workflow",
        filteredReason: "reviewer_prompt",
      }),
    ]);
  });

  test("excludes repeated eval task gist fixtures by default", () => {
    const taskGist = [
      "## Task gist",
      "",
      "I'm serving an LLM with very long contexts (100k-1M tokens) and the KV cache is blowing up memory.",
      "",
      "## Criteria",
      "",
      "Find the smallest practical implementation strategy.",
    ].join("\n");
    const analyses = repeatedAnalyses("eval", 10, taskGist);

    const filtered = collectRepeatedInstructions(analyses, 3);
    expect(filtered.repeated).toEqual([]);
    expect(filtered.filteredReasons).toMatchObject({ eval_fixture: 10 });

    const debug = collectRepeatedInstructions(analyses, 3, { includeFilteredWorkflow: true });
    expect(debug.repeated).toEqual([
      expect.objectContaining({
        intent: "machine_workflow",
        filteredReason: "eval_fixture",
      }),
    ]);
  });

  test("excludes repeated workflow launch prompts by default", () => {
    const launchPrompt = [
      "You are continuing a sequential Kookr GitHub-issue implementation chain.",
      "",
      "Goal: Implement Kookr GitHub issue #1046 end-to-end.",
      "",
      "Continue from the previous handoff and push the branch when done.",
    ].join("\n");
    const analyses = repeatedAnalyses("workflow", 4, launchPrompt);

    const filtered = collectRepeatedInstructions(analyses, 2);
    expect(filtered.repeated).toEqual([]);
    expect(filtered.filteredReasons).toMatchObject({ workflow_launch: 4 });

    const debug = collectRepeatedInstructions(analyses, 2, { includeFilteredWorkflow: true });
    expect(debug.repeated).toEqual([
      expect.objectContaining({
        intent: "machine_workflow",
        filteredReason: "workflow_launch",
      }),
    ]);
  });

  test("excludes structured reviewer fan-out launches (marker) regardless of body text", () => {
    // A structured launch carries the machine-event marker on its first line;
    // its body no longer needs to open with the legacy "You are the ..." line.
    const structuredLaunch = [
      "[[kookr-workflow:reviewer-fanout]] role=correctness workflow=reviewer-fanout:feat/x",
      "Repo: /path/to/worktree",
      "Diff scope: origin/main..HEAD (3 changed file(s))",
      "",
      "<verbatim specialist instructions with a completely different opening>",
    ].join("\n");
    const analyses = repeatedAnalyses("structured", 3, structuredLaunch);

    const filtered = collectRepeatedInstructions(analyses, 2);
    expect(filtered.repeated).toEqual([]);
    expect(filtered.filteredReasons).toMatchObject({ reviewer_prompt: 3 });

    const debug = collectRepeatedInstructions(analyses, 2, { includeFilteredWorkflow: true });
    expect(debug.repeated).toEqual([
      expect.objectContaining({
        intent: "machine_workflow",
        filteredReason: "reviewer_prompt",
      }),
    ]);
  });

  test("keeps operator-authored text that merely quotes the marker mid-body", () => {
    // The operator authored this — the marker is not on the first line, so it
    // must NOT be reclassified as a machine event.
    const operatorText = [
      "Can you explain what the reviewer fan-out marker does?",
      "I saw [[kookr-workflow:reviewer-fanout]] in a prompt and was confused.",
    ].join("\n");
    const analyses = repeatedAnalyses("operator", 3, operatorText);

    const filtered = collectRepeatedInstructions(analyses, 2);
    expect(filtered.filteredCount).toBe(0);
    expect(filtered.repeated).toEqual([
      expect.objectContaining({ intent: expect.not.stringMatching(/machine_workflow/) }),
    ]);
  });
});

describe("session analyzer tool efficiency report", () => {
  test("normalizes volatile command arguments and redacts secrets", () => {
    const first = normalizeCommandFingerprint("git show 0123456789abcdef0123456789abcdef --token=super-secret /tmp/run-123 2026-07-11T10:00:00Z");
    const second = normalizeCommandFingerprint("git show fedcba9876543210fedcba9876543210 --token=different /tmp/run-999 2026-07-12T11:22:33Z");

    expect(first).toBe(second);
    expect(first).toContain("--token=<redacted>");
    expect(first).not.toContain("super-secret");
    expect(first).not.toContain("0123456789abcdef");
    expect(normalizeCommandFingerprint("curl --password 'quoted secret' --data abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
      .toMatch("curl --password <redacted> --data <arg:");
    expect(normalizeCommandFingerprint("TOKEN=secret API_KEY=also-secret PASSWORD='quoted secret' env"))
      .toBe("TOKEN=<redacted> API_KEY=<redacted> PASSWORD=<redacted> env");
  });

  test("distinguishes repeats with and without intervening state changes", () => {
    const analysis = analyzeMessages(meta, [
      toolCall("status-1", "exec_command", { cmd: "git status --short" }),
      toolCall("status-2", "exec_command", { cmd: "git status --short" }),
      toolCall("edit-1", "apply_patch", {}),
      toolCall("status-3", "exec_command", { cmd: "git status --short" }),
    ]);

    const report = buildToolEfficiencyReport([analysis]);
    expect(report.repeatedStatusDiffPollCalls).toEqual([
      expect.objectContaining({
        fingerprint: "git status --short",
        count: 3,
        repeats: 2,
        repeatsWithoutStateChange: 1,
      }),
    ]);

    const ghChecks = analyzeMessages(meta, [
      toolCall("checks-1", "exec_command", { cmd: "gh pr checks 1328" }),
      toolCall("checks-2", "exec_command", { cmd: "gh pr checks 1328" }),
    ]);
    expect(buildToolEfficiencyReport([ghChecks]).repeatedStatusDiffPollCalls[0])
      .toMatchObject({ count: 2, repeatsWithoutStateChange: 1 });
  });

  test("classifies repeated reads, identical failures, sleep loops, and empty polls", () => {
    const analysis = analyzeMessages(meta, [
      toolCall("read-1", "Read", { file_path: "/repo/src/a.ts" }),
      toolCall("read-2", "Read", { file_path: "/repo/src/a.ts" }),
      toolCall("fail-1", "exec_command", { cmd: "pnpm test --run 123" }),
      toolResult("fail-1", true, "8f3f5dc1a214"),
      toolCall("fail-2", "exec_command", { cmd: "pnpm test --run 456" }),
      toolResult("fail-2", true, "8f3f5dc1a214"),
      toolCall("sleep-1", "exec_command", { cmd: "sleep 10; gh pr checks 1328" }),
      toolCall("sleep-2", "exec_command", { cmd: "sleep 30; gh pr checks 1328" }),
      toolCall("poll-1", "write_stdin", {}),
      toolCall("poll-2", "write_stdin", { chars: "" }),
    ]);

    const report = buildToolEfficiencyReport([analysis]);
    expect(report.repeatedSameFileReads[0]).toMatchObject({ count: 2, repeatsWithoutStateChange: 1 });
    expect(report.identicalFailedRetries[0]).toMatchObject({ count: 2, repeats: 1 });
    expect(report.identicalFailedRetries[0]?.fingerprint).not.toContain("same-error");
    expect(report.fixedSleepPollLoops[0]).toMatchObject({ count: 2, repeats: 1 });
    expect(report.emptyStdinPolls).toMatchObject({ count: 2, sessions: 1 });
    expect(report.emptyStdinPolls.exampleSessionIds).toEqual(["session-1"]);
  });

  test("correlates raw Codex and Claude provider fixtures with failed commands", () => {
    const codexMessages = [
      parseCodexMessage({
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "codex-1", arguments: JSON.stringify({ cmd: "pnpm test 123" }) },
      }, false)!,
      parseCodexMessage({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "codex-1", output: JSON.stringify({ output: "failed at 123", metadata: { exit_code: 1 } }) },
      }, false)!,
      parseCodexMessage({
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "codex-2", arguments: JSON.stringify({ cmd: "pnpm test 456" }) },
      }, false)!,
      parseCodexMessage({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "codex-2", output: JSON.stringify({ output: "failed at 456", metadata: { exit_code: 1 } }) },
      }, false)!,
    ];
    const claudeMessages = [
      parseMessage({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "claude-1", name: "Bash", input: { command: "pnpm test 123" } }] },
      }, false)!,
      parseMessage({
        type: "user",
        toolUseResult: { stdout: "failed at 123", stderr: "", is_error: true },
        message: { content: [{ type: "tool_result", tool_use_id: "claude-1", is_error: true, content: "failed at 123" }] },
      }, false)!,
      parseMessage({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "claude-2", name: "Bash", input: { command: "pnpm test 456" } }] },
      }, false)!,
      parseMessage({
        type: "user",
        toolUseResult: { stdout: "failed at 456", stderr: "", is_error: true },
        message: { content: [{ type: "tool_result", tool_use_id: "claude-2", is_error: true, content: "failed at 456" }] },
      }, false)!,
    ];

    for (const [provider, messages] of [["codex-cli", codexMessages], ["claude-code", claudeMessages]] as const) {
      const report = buildToolEfficiencyReport([analyzeMessages({ ...meta, provider }, messages)]);
      expect(report.identicalFailedRetries).toEqual([
        expect.objectContaining({ fingerprint: expect.stringContaining("pnpm test <n>"), count: 2, repeats: 1 }),
      ]);
    }
  });

  test("renders bounded JSON and human-readable tool report sections", () => {
    const analysis = analyzeMessages(meta, [
      toolCall("status-1", "exec_command", { cmd: "git status --short" }),
      toolCall("status-2", "exec_command", { cmd: "git status --short" }),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      renderToolsReport([analysis], "json");
      const json = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(json.efficiency.repeatedStatusDiffPollCalls[0]).toMatchObject({
        fingerprint: "git status --short",
        count: 2,
      });

      log.mockClear();
      renderToolsReport([analysis], "text");
      expect(log.mock.calls.flat().join("\n")).toContain("Repeated status/diff/poll calls:");
      expect(log.mock.calls.flat().join("\n")).toContain("git status --short");
    } finally {
      log.mockRestore();
    }
  });
});

function toolCall(callId: string, name: string, input: Record<string, unknown>): ParsedMessage {
  return {
    type: "assistant",
    isSyntheticAssistantEvent: true,
    toolCalls: [{ name, input, inputSummary: "", callId }],
  };
}

function toolResult(callId: string, failed: boolean, outputHash: string): ParsedMessage {
  return {
    type: "progress",
    toolResults: [{ callId, failed, outputHash }],
  };
}
