import { describe, expect, test } from "vitest";
import {
  analyzeMessages,
  collectRepeatedInstructions,
  parseCodexMessage,
  parseMessage,
  parseSubagentNotification,
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
});
