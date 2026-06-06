import type { Hono } from "hono";
import { normalizeAgentSelection } from "../../core/agent-types.js";
import type { CreateScheduleInput, UpdateScheduleDefinitionInput } from "../../core/schedule.js";
import type { RouteDeps } from "./shared.js";

function fieldErrorsFrom(err: unknown): Record<string, string> | undefined {
  if (err instanceof Error && "fieldErrors" in err) {
    return (err as { fieldErrors?: Record<string, string> }).fieldErrors;
  }
  return undefined;
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
      if (typeof body.enabled === "boolean" && Object.keys(body).length === 1) {
        return c.json(await deps.scheduleService.setEnabled(id, body.enabled));
      }

      const patch: UpdateScheduleDefinitionInput = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.cron === "string") patch.cron = body.cron;
      if (typeof body.maxTriggers === "number" || body.maxTriggers === null) patch.maxTriggers = body.maxTriggers;
      if (typeof body.cwd === "string") patch.cwd = body.cwd;
      if (typeof body.agentType === "string") patch.agentType = normalizeAgentSelection(body.agentType);
      if (typeof body.playbook === "object" && body.playbook !== null && !Array.isArray(body.playbook)) {
        const playbook = body.playbook as { path?: unknown; parameters?: unknown };
        if (typeof playbook.path === "string") {
          patch.playbook = {
            path: playbook.path,
            parameters: typeof playbook.parameters === "object" && playbook.parameters !== null && !Array.isArray(playbook.parameters)
              ? Object.fromEntries(Object.entries(playbook.parameters).filter(([, value]) => typeof value === "string"))
              : {},
          };
        }
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
    if (result.error) return c.json({ error: result.error }, 400);
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
