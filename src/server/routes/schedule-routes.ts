import type { Hono } from "hono";
import { normalizeAgentSelection } from "../../core/agent-types.js";
import {
  normalizeScheduleLoopConfig,
  ScheduleValidationError,
  type CreateScheduleInput,
  type ScheduleLoopConfig,
  type UpdateScheduleDefinitionInput,
} from "../../core/schedule.js";
import type { PlaybookScope } from "../../core/playbook.js";
import type { RouteDeps } from "./shared.js";

function fieldErrorsFrom(err: unknown): Record<string, string> | undefined {
  if (err instanceof Error && "fieldErrors" in err) {
    return (err as { fieldErrors?: Record<string, string> }).fieldErrors;
  }
  return undefined;
}

/**
 * Coerce a PATCH/POST `loop` body field (issue #2193 gap 2). Objects normalize
 * via {@link normalizeScheduleLoopConfig} (empty `{}` is meaningful). Anything
 * else — string, number, array — rejects with a fieldError so callers never
 * get a silent drop.
 */
function parseScheduleLoopField(raw: unknown, fieldName: string): ScheduleLoopConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScheduleValidationError("Invalid schedule definition", {
      [fieldName]:
        fieldName === "loop"
          ? "Must be an object (use {} to arm loop-on-fire) or null to clear"
          : "Must be an object (use {} to arm loop-on-fire)",
    });
  }
  // Presence alone arms a loop; malformed nested fields are dropped by normalize.
  return normalizeScheduleLoopConfig(raw) ?? {};
}

type ScheduleRunErrorCode = "capacity" | "draining" | "previous_run_active" | "validation";

function scheduleRunErrorResponse(error: string): { code: ScheduleRunErrorCode; status: 400 | 409 | 503 } {
  switch (error) {
    case "Max active tasks reached":
      return { code: "capacity", status: 409 };
    case "Server draining":
    case "Server is draining; not accepting new task launches":
    case "Server is redeploying; not accepting new task launches":
      return { code: "draining", status: 503 };
    case "Previous run still active":
      return { code: "previous_run_active", status: 409 };
    default:
      return { code: "validation", status: 400 };
  }
}

export function registerScheduleRoutes(app: Hono, deps: RouteDeps): void {
  app.get("/api/schedules", (c) => {
    if (!deps.scheduleService) {
      return c.json({
        revision: 0,
        schedules: [],
        status: {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          catchUpMode: "off",
          catchUpEnabled: false,
          schedulerHealthy: false,
        },
      });
    }
    return c.json(deps.scheduleService.listResponse());
  });

  // Fast ROI rollup endpoints (issue #1584). Read ONLY the materialized
  // per-schedule store — no tasks.json / hook-log scan on the request path, so
  // they stay O(1)/O(n) and never hang the way an on-request scan can.
  app.get("/api/schedules/rollups", (c) => {
    if (!deps.scheduleService) return c.json({ rollups: [] });
    return c.json({ rollups: deps.scheduleService.listRollups() });
  });

  app.get("/api/schedules/:id/rollup", (c) => {
    if (!deps.scheduleService) return c.json({ error: "Scheduling not configured" }, 500);
    const rollup = deps.scheduleService.getRollup(c.req.param("id"));
    if (!rollup) return c.json({ error: "Schedule not found" }, 404);
    return c.json(rollup);
  });

  app.post("/api/schedules", async (c) => {
    if (!deps.scheduleService) return c.json({ error: "Scheduling not configured" }, 500);
    try {
      const body = await c.req.json() as CreateScheduleInput;
      const schedule = await deps.scheduleService.createDefinition(body);
      return c.json(schedule, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof Error && err.name === "ScheduleValidationError" ? 400 : 500;
      const fieldErrors = fieldErrorsFrom(err);
      return c.json({ error: message, ...(fieldErrors ? { fieldErrors } : {}) }, status);
    }
  });

  app.patch("/api/schedules/:id", async (c) => {
    if (!deps.scheduleService) return c.json({ error: "Scheduling not configured" }, 500);
    const id = c.req.param("id");
    try {
      const body = await c.req.json() as Record<string, unknown>;
      // enabled-only (or enabled + operatorHold) — issue #2196 hold marker for
      // critical-schedule re-arm. Keep this short-path so UI toggles stay cheap.
      if (typeof body.enabled === "boolean") {
        const keys = Object.keys(body);
        const onlyEnabled = keys.length === 1;
        const enabledPlusHold =
          keys.length === 2
          && Object.prototype.hasOwnProperty.call(body, "operatorHold")
          && typeof body.operatorHold === "boolean";
        if (onlyEnabled || enabledPlusHold) {
          return c.json(
            await deps.scheduleService.setEnabled(
              id,
              body.enabled,
              enabledPlusHold ? { operatorHold: body.operatorHold as boolean } : undefined,
            ),
          );
        }
      }

      const patch: UpdateScheduleDefinitionInput = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.cron === "string") patch.cron = body.cron;
      if (typeof body.maxTriggers === "number" || body.maxTriggers === null) patch.maxTriggers = body.maxTriggers;
      if (typeof body.cwd === "string") patch.cwd = body.cwd;
      if (body.agentType === null) patch.agentType = null;
      else if (typeof body.agentType === "string") {
        // Empty string clears the pin (follow server default).
        if (body.agentType.trim() === "") patch.agentType = null;
        else patch.agentType = normalizeAgentSelection(body.agentType);
      }
      if (typeof body.effort === "string") patch.effort = body.effort;
      if (typeof body.model === "string") patch.model = body.model;
      if (typeof body.playbook === "object" && body.playbook !== null && !Array.isArray(body.playbook)) {
        const playbook = body.playbook as {
          path?: unknown;
          parameters?: unknown;
          scope?: unknown;
          loop?: unknown;
        };
        if (typeof playbook.path === "string") {
          patch.playbook = {
            path: playbook.path,
            parameters: typeof playbook.parameters === "object" && playbook.parameters !== null && !Array.isArray(playbook.parameters)
              ? Object.fromEntries(Object.entries(playbook.parameters).filter(([, value]) => typeof value === "string"))
              : {},
            // Carry scope through the rebuild so a PATCH doesn't strip the
            // pinned tier. Merge-carry against the existing scope happens in
            // ScheduleStore.updateDefinition.
            ...(typeof playbook.scope === "string" ? { scope: playbook.scope as PlaybookScope } : {}),
            // Nested loop is accepted for create/update convenience (#1899 /
            // #2193) and normalized onto Schedule.loop in updateDefinition.
            ...(playbook.loop !== undefined
              ? { loop: parseScheduleLoopField(playbook.loop, "playbook.loop") }
              : {}),
          };
        }
      }
      // Top-level loop: set to arm loop-on-fire, null to clear, omit to leave
      // unchanged. Malformed values reject with fieldErrors (issue #2193 gap 2)
      // rather than silently dropping the field.
      if ("loop" in body) {
        patch.loop = body.loop === null
          ? null
          : parseScheduleLoopField(body.loop, "loop");
      }

      return c.json(await deps.scheduleService.updateDefinition(id, patch));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof Error && err.name === "ScheduleValidationError" ? 400 : 500;
      const fieldErrors = fieldErrorsFrom(err);
      return c.json({ error: message, ...(fieldErrors ? { fieldErrors } : {}) }, status);
    }
  });

  app.delete("/api/schedules/:id", async (c) => {
    if (!deps.scheduleService) return c.json({ error: "Scheduling not configured" }, 500);
    const id = c.req.param("id");
    try {
      await deps.scheduleService.delete(id);
    } catch {
      return c.json({ error: "Schedule not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/api/schedules/:id/run", async (c) => {
    if (!deps.scheduleRunner) return c.json({ error: "Scheduling not configured" }, 500);
    const id = c.req.param("id");
    const result = await deps.scheduleRunner.runNow(id);
    if (result.error) {
      const { code, status } = scheduleRunErrorResponse(result.error);
      return c.json({ error: result.error, code }, status);
    }
    return c.json({ ok: true, taskId: result.taskId, ...(result.queued ? { queued: true } : {}) });
  });

  app.post("/api/schedules/preview", async (c) => {
    if (!deps.scheduleService) return c.json({ error: "Scheduling not configured" }, 500);
    try {
      const body = await c.req.json() as { cron?: string };
      if (!body.cron || typeof body.cron !== "string") {
        return c.json({ error: "cron is required" }, 400);
      }
      return c.json(await deps.scheduleService.previewCron(body.cron));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof Error && err.name === "ScheduleValidationError" ? 400 : 500;
      const fieldErrors = fieldErrorsFrom(err);
      return c.json({ error: message, ...(fieldErrors ? { fieldErrors } : {}) }, status);
    }
  });
}
