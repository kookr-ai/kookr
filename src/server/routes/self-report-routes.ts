import type { Hono } from 'hono';
import type { ServerMessage } from '../../shared/contracts/messages.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

export const SELF_REPORT_PATH = '/api/self-report';

/**
 * What an agent can report about its own run. Deliberately a short closed set:
 * the point is a signal an operator can filter and act on, not free-form
 * telemetry.
 */
export const SELF_REPORT_KINDS = ['prompt_unusable', 'environment_broken', 'other'] as const;
export type SelfReportKind = (typeof SELF_REPORT_KINDS)[number];

/** Cap on the free-text explanation, so one report cannot bloat the alert log. */
const MAX_DETAIL_CHARS = 2_000;

/**
 * Cap on the reporter id. It goes into the alert key, every durable row, and
 * the broadcast to every connected client, so it is bounded well below the
 * 1 MB request-body limit that would otherwise be its only ceiling.
 */
const MAX_AGENT_ID_CHARS = 200;

export interface SelfReportRouteDeps {
  /**
   * Emit the report on the operational-alert channel. The composition root
   * passes the same binding every other operational-alert emitter uses, so a
   * self-report reaches all four surfaces at once: the dashboard, the operator
   * signal outbox (Discord/Telegram), the ops-status card, and the durable
   * `operational-alerts.jsonl`. Falling back to a bare broadcast reaches only
   * a connected dashboard, which the route warns about at registration.
   */
  emitOperationalAlert: (alert: AlertMessage) => void;
  log?: Pick<typeof console, 'warn'>;
  /**
   * Set by the composition root when {@link emitOperationalAlert} is only a
   * broadcast — i.e. nothing durable is wired behind it.
   */
  broadcastOnly?: boolean;
}

const KIND_SUMMARY: Record<SelfReportKind, string> = {
  prompt_unusable: 'Agent reports its task prompt is unusable',
  environment_broken: 'Agent reports its environment is broken',
  other: 'Agent self-report',
};

function isSelfReportKind(value: unknown): value is SelfReportKind {
  return typeof value === 'string' && (SELF_REPORT_KINDS as readonly string[]).includes(value);
}

/**
 * Agent self-report route.
 *
 * A launched agent that cannot do its job because of something upstream of the
 * work itself — a prompt that arrived truncated (#2977), a broken checkout —
 * has no way to say so: it can only guess at the task, or stall. This gives it
 * one call that turns the observation into an operational alert: broadcast to
 * the dashboard live and appended to `operational-alerts.jsonl` for the
 * incident record.
 *
 * `POST /api/self-report` with `{ agentId, kind, detail }`. Agents reach it
 * through the `kookr-self-report` shim on their PATH, which reads identity and
 * endpoint from `KOOKR_AGENT_ID` / `KOOKR_API_BASE_URL` — see the launch
 * guardrails.
 *
 * Deliberately NOT a remediation trigger. The report is evidence for an
 * operator (or a scheduled sweeper) to act on; auto-spawning a fix from an
 * agent's own claim about its prompt would let one confused agent start
 * unattended work on the codebase.
 */
export function registerSelfReportRoutes(app: Hono, deps: SelfReportRouteDeps): void {
  if (deps.broadcastOnly) {
    // Broadcast-only is a real configuration (no `kookrDir`), and it is a
    // silent downgrade: reports still reach a connected dashboard, but nothing
    // survives for the operator who reads the incident log afterwards. Say so
    // once at registration rather than leaving it to be discovered from an
    // empty log.
    (deps.log ?? console).warn(
      '[self-report] no durable sink wired — reports will broadcast but will not be recorded',
    );
  }

  app.post(SELF_REPORT_PATH, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'body must be JSON' }, 400);
    }

    const agentId = body.agentId;
    if (typeof agentId !== 'string' || agentId.length === 0) {
      return c.json({ error: 'agentId is required and must be a non-empty string' }, 400);
    }
    if (agentId.length > MAX_AGENT_ID_CHARS) {
      return c.json({ error: `agentId must be at most ${MAX_AGENT_ID_CHARS} characters` }, 400);
    }
    // The alert key is `self-report:<agentId>:<kind>`, the same delimiter
    // convention environment-blocker keys use — and the same guard: a ':' in
    // the id would let two distinct reporters collide onto one incident. The
    // control-character guard keeps a forged newline out of the server log and
    // the durable row.
    if (/[:\u0000-\u001f\u007f]/.test(agentId)) {
      return c.json({ error: "agentId must not contain ':' or control characters" }, 400);
    }
    if (!isSelfReportKind(body.kind)) {
      return c.json({ error: `kind must be one of: ${SELF_REPORT_KINDS.join(', ')}` }, 400);
    }
    const detail = body.detail;
    if (typeof detail !== 'string' || detail.trim().length === 0) {
      return c.json({ error: 'detail is required and must be a non-empty string' }, 400);
    }

    const kind: SelfReportKind = body.kind;
    const alert: AlertMessage = {
      type: 'alert',
      agentId,
      summary: KIND_SUMMARY[kind],
      // Validated trimmed, so store trimmed: otherwise a leading newline makes
      // the operator-facing first line of the log entry blank.
      details: detail.trim().slice(0, MAX_DETAIL_CHARS),
      severity: 'warning',
      operationalAlert: {
        // One key per (agent, kind): a repeat report from the same agent about
        // the same thing correlates with the first rather than reading as a
        // separate incident.
        key: `self-report:${agentId}:${kind}`,
        metric: 'agent_self_report',
        state: 'fired',
      },
    };

    deps.emitOperationalAlert(alert);
    (deps.log ?? console).warn(
      `[self-report] ${agentId} reported ${kind}: ${alert.details.split('\n')[0]}`,
    );

    return c.json({ recorded: true }, 202);
  });
}
