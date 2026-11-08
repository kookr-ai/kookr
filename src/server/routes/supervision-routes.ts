import type { Hono } from 'hono';
import type { SupervisionService } from '../supervision-service.js';

/**
 * Read-only status of attached task supervisions (RFC attachable-task-supervisor,
 * P2a). State, derived health and the next scheduled wake come from the
 * `SupervisionService`. The only mutation is `POST /api/supervisions/:id/end`,
 * which closes the mandate and cancels no task.
 */
export function registerSupervisionRoutes(
  app: Hono,
  deps: { supervisionService?: Pick<SupervisionService, 'list' | 'get' | 'end'> },
): void {
  const service = deps.supervisionService;

  app.get('/api/supervisions', (c) => {
    if (!service) return c.json({ supervisions: [] });
    return c.json({ supervisions: service.list() });
  });

  app.get('/api/supervisions/:id', (c) => {
    const id = c.req.param('id');
    const status = service?.get(id);
    if (!status) return c.json({ error: `Supervision not found: ${id}` }, 404);
    return c.json(status);
  });

  app.post('/api/supervisions/:id/end', async (c) => {
    const id = c.req.param('id');
    const status = await service?.end(id);
    if (!status) return c.json({ error: `Supervision not found: ${id}` }, 404);
    return c.json({ ok: true, supervision: status });
  });
}
