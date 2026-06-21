import { describe, expect, test } from "vitest";
import {
  analyzeMessages,
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
