import { describe, expect, test } from 'vitest';

import { createDevDemoServer } from '../../scripts/dev-demo.js';

describe('dev demo server', () => {
  test('boots with seeded synthetic snapshot data', async () => {
    const handle = await createDevDemoServer({ port: 0, printReady: false });
    try {
      const healthRes = await fetch(`${handle.baseUrl}/api/health`);
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json() as { status?: string; agents?: number };
      expect(health.status).toBe('ok');
      expect(health.agents).toBe(handle.seededTaskIds.length);

      const snapshotRes = await fetch(`${handle.baseUrl}/api/snapshot`);
      expect(snapshotRes.status).toBe(200);
      const snapshot = await snapshotRes.json() as Array<{
        agentId: string;
        agentType?: string;
        anomaly?: { type: string } | null;
        projectId?: string;
        taskStatus?: string;
      }>;

      expect(snapshot).toHaveLength(handle.seededTaskIds.length);
      expect(snapshot.some((agent) => agent.anomaly?.type === 'permission_blocked')).toBe(true);
      expect(snapshot.some((agent) => agent.anomaly?.type === 'needs_input')).toBe(true);
      expect(snapshot.some((agent) => agent.agentType === 'codex-cli' && agent.anomaly === null)).toBe(true);
      expect(snapshot.some((agent) => agent.taskStatus === 'completed')).toBe(true);
      expect(snapshot.some((agent) => agent.taskStatus === 'pending')).toBe(true);
      expect(new Set(snapshot.map((agent) => agent.projectId).filter(Boolean)).size).toBeGreaterThanOrEqual(3);
    } finally {
      await handle.close();
    }
  });
});
