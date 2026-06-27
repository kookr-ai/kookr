import { describe, expect, it } from 'vitest';
import { buildLocalSpeechCapabilities, createSnapshotMessage, getProjectSummaries, getSnapshotAgentsForClient, getSnapshotAgentsRaw } from './get-snapshot.js';
import type { AgentEvent } from '../../core/types.js';
import { TaskStore } from '../../core/tasks.js';
import { USER_INPUT_DELIVERY_TEXT_MAX_CHARS } from '../../shared/contracts/user-input-delivery.js';

// Matches the self-diagnostic's SNAPSHOT_SIZE_WARNING threshold in
// src/core/self-diagnostic.ts. The projected snapshot of realistic pathological
// fixtures must stay well under this, so the diagnostic becomes a useful signal
// again rather than a permanent warning.
const SNAPSHOT_SIZE_WARNING_BYTES = 500 * 1024;

describe('snapshot use cases', () => {
  it('creates a snapshot message with optional metadata', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', events: [], anomaly: null }] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      serverStartedAt: '2026-04-04T10:00:00.000Z',
      totalSpendUsd: 12.5,
      sttUrl: 'ws://localhost:8003',
      ttsUrl: 'http://localhost:8004',
      now: () => new Date('2026-05-15T22:00:00.000Z'),
      achievements: { first: '2026-04-04T10:00:00.000Z' },
      availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }] as any,
      defaultAgentType: 'claude-code',
      drainStatus: { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z' },
    });

    expect(msg).toEqual(expect.objectContaining({
      type: 'snapshot',
      serverCwd: '/repo',
      sttEnabled: true,
      sttUrl: 'ws://localhost:8003',
      ttsEnabled: true,
      ttsUrl: 'http://localhost:8004',
      totalSpendUsd: 12.5,
      defaultAgentType: 'claude-code',
      drainStatus: { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z' },
    }));
    expect(msg.speechCapabilities?.capabilitiesByDevice['local-node']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'stt',
        protocol: 'kookr-stt-ws',
        endpointUrl: 'ws://localhost:8003',
        readiness: 'ready',
      }),
      expect.objectContaining({
        kind: 'tts',
        endpointUrl: 'http://localhost:8004',
        readiness: 'ready',
      }),
    ]));
    expect(msg.agents).toHaveLength(1);
  });

  it('builds no speech capability descriptors when STT/TTS are disabled', () => {
    expect(buildLocalSpeechCapabilities({})).toBeUndefined();
  });

  it('includes activity metadata when provider is wired', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', events: [], anomaly: null }] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      activityMetaProvider: {
        getActivityMeta: () => ({
          totalEventsSeen: 3,
          parentEventCount: 1,
          childEventCount: 1,
          foreignEventCount: 0,
          unknownParentageCount: 0,
          malformedRecordCount: 1,
          droppedRecordCount: 0,
          duplicateRecordCount: 0,
        }),
      },
    });

    expect(msg.agents[0].activityMeta).toMatchObject({
      totalEventsSeen: 3,
      childEventCount: 1,
      malformedRecordCount: 1,
    });
  });

  it('projects user input deliveries for client transport', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', events: [], anomaly: null }] as any,
    };
    const longPrompt = 'x'.repeat(USER_INPUT_DELIVERY_TEXT_MAX_CHARS + 200);

    const agents = getSnapshotAgentsForClient({
      monitor,
      userInputDeliveryProvider: {
        getSnapshot: () => [
          {
            deliveryId: 'delivery-1',
            sessionId: 'a-1',
            deliverySeq: 1,
            source: 'respond',
            text: 'Short prompt',
            status: 'submitted_by_agent',
            createdAt: '2026-06-06T10:00:00.000Z',
            updatedAt: '2026-06-06T10:00:01.000Z',
          },
          {
            deliveryId: 'delivery-2',
            sessionId: 'a-1',
            deliverySeq: 2,
            source: 'respond',
            text: longPrompt,
            status: 'queued',
            createdAt: '2026-06-06T10:00:02.000Z',
            updatedAt: '2026-06-06T10:00:02.000Z',
          },
        ],
      },
    });

    expect(agents[0].userInputDeliveries).toHaveLength(2);
    expect(agents[0].userInputDeliveries?.[0]).toMatchObject({
      deliveryId: 'delivery-1',
      text: 'Short prompt',
      status: 'submitted_by_agent',
    });
    expect(agents[0].userInputDeliveries?.[1]).toMatchObject({
      deliveryId: 'delivery-2',
      status: 'queued',
    });
    expect(agents[0].userInputDeliveries?.[1].text).toContain('<2200 chars total>');
    expect(agents[0].userInputDeliveries?.[1].text.length).toBeLessThan(longPrompt.length);
  });

  it('runs coordinator detectors when task store and audit tail provider are wired', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      coordinator: {
        taskStore: {
          listTasks: () => [{
            id: 'task-1',
            prompt: 'Ship it',
            cwd: '/repo',
            agentType: 'codex-cli',
            status: 'inProgress',
            sessions: [{
              tmuxSession: 'kookr-task-1',
              agentType: 'codex-cli',
              cwd: '/repo',
              createdAt: new Date('2026-05-21T11:00:00.000Z'),
            }],
            createdAt: new Date('2026-05-21T11:00:00.000Z'),
            updatedAt: new Date('2026-05-21T11:00:00.000Z'),
          }],
        },
        auditTailProvider: {
          getCoordinatorAuditTail: () => [],
        },
      },
      now: () => new Date('2026-05-21T12:00:00.000Z'),
    });

    expect(msg.coordinator?.outputs).toEqual([
      expect.objectContaining({
        detectorId: 'stale',
        taskId: 'task-1',
      }),
    ]);
  });

  it('does not attach raw terminal session anomaly to synthetic completed tasks', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ship it', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'done-agent',
      agentType: 'codex-cli',
      cwd: '/repo',
      createdAt: new Date('2026-05-21T11:00:00.000Z'),
    });
    taskStore.setCompletionDigest(task.id, { bullets: ['done'], filesChanged: [] });
    taskStore.completeTask(task.id);

    const monitor = {
      getSnapshot: () => [{
        agentId: 'done-agent',
        events: [],
        anomaly: {
          agentId: 'done-agent',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Needs review',
          detectedAt: new Date('2026-05-21T12:00:00.000Z'),
        },
        lastEventSeq: 0,
      }] as any,
      getTaskSnapshot: () => taskStore.getAllTasks(),
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      coordinator: {
        taskStore: { listTasks: () => taskStore.listTasks() },
      },
      now: () => new Date('2026-05-21T12:00:00.000Z'),
    });

    expect(msg.coordinator?.outputs).toEqual([
      expect.objectContaining({
        detectorId: 'done_not_cleared',
        taskId: task.id,
      }),
    ]);
  });

  it('preserves raw monitor identity for legacy mocks without task snapshots', () => {
    const agents = [{ agentId: 'x' }] as any;
    expect(getSnapshotAgentsRaw({ monitor: { getSnapshot: () => agents } as any })).toBe(agents);
  });

  it('assembles dashboard task state from raw monitor and task snapshots', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ship the fix', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:00:00.000Z'),
    });
    const monitor = {
      getSnapshot: () => [{ agentId: 'agent-1', events: [], anomaly: null, lastEventSeq: 0 }] as any,
      getTaskSnapshot: () => taskStore.getAllTasks(),
    };

    const [agent] = getSnapshotAgentsRaw({ monitor });

    expect(agent).toMatchObject({
      agentId: 'agent-1',
      taskId: task.id,
      taskName: 'Ship the fix',
      taskStatus: 'inProgress',
      cwd: '/repo',
      agentType: 'claude-code',
    });
  });

  it('projects launch permission posture from task metadata', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({
      prompt: 'Ship unguarded',
      cwd: '/repo',
      metadata: {
        launchPermissionPosture: {
          bypassAllPermissions: true,
          mode: 'bypass-all',
          capturedAt: '2026-06-11T08:00:00.000Z',
        },
      },
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-06-11T08:00:00.000Z'),
    });

    const [agent] = getSnapshotAgentsRaw({
      monitor: {
        getSnapshot: () => [{ agentId: 'agent-1', events: [], anomaly: null, lastEventSeq: 0 }] as any,
        getTaskSnapshot: () => taskStore.getAllTasks(),
      },
    });

    expect(agent.launchPermissionPosture).toEqual({
      bypassAllPermissions: true,
      mode: 'bypass-all',
      capturedAt: '2026-06-11T08:00:00.000Z',
    });
  });

  it('projects launch permission posture for pending and terminal task entries', () => {
    const taskStore = new TaskStore();
    const posture = {
      bypassAllPermissions: true as const,
      mode: 'bypass-all' as const,
      capturedAt: '2026-06-11T08:00:00.000Z',
    };
    const pendingTask = taskStore.createTask({
      prompt: 'Queued unguarded',
      cwd: '/repo',
      metadata: { launchPermissionPosture: posture },
    });
    taskStore.pendTask(pendingTask.id);
    const completedTask = taskStore.createTask({
      prompt: 'Finished unguarded',
      cwd: '/repo',
      metadata: { launchPermissionPosture: posture },
    });
    taskStore.startTask(completedTask.id);
    taskStore.completeTask(completedTask.id);

    const agents = getSnapshotAgentsRaw({
      monitor: {
        getSnapshot: () => [] as any,
        getTaskSnapshot: () => taskStore.getAllTasks(),
      },
    });

    expect(agents.find((agent) => agent.taskId === pendingTask.id)?.launchPermissionPosture).toEqual(posture);
    expect(agents.find((agent) => agent.taskId === completedTask.id)?.launchPermissionPosture).toEqual(posture);
  });

  it('projects events for client transport (strips toolResponse, keeps raw via Raw)', () => {
    const rawEvents: AgentEvent[] = [
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Read',
        toolResponse: 'x'.repeat(20_000),
      },
    ];
    const agents = [{ agentId: 'a-1', events: rawEvents, anomaly: null }] as any;
    const monitor = { getSnapshot: () => agents } as any;

    const client = getSnapshotAgentsForClient({ monitor });
    expect(client[0].events[0]).not.toHaveProperty('toolResponse');

    const raw = getSnapshotAgentsRaw({ monitor });
    expect(raw[0].events[0]).toHaveProperty('toolResponse');
  });

  it('projects finding evidence for client transport without raw pane excerpts', () => {
    const agents = [{
      agentId: 'a-1',
      events: [],
      anomaly: null,
      findingEvidenceAudit: {
        id: 'finding-1',
        agentId: 'a-1',
        anomalyType: 'needs_input',
        explanation: 'Waiting',
        detectedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:05.000Z',
        status: 'active',
        verdict: 'supports_finding',
        observations: [{
          sampledAt: '2026-05-18T10:00:05.000Z',
          ageMs: 5_000,
          source: 'watchdog_tick',
          anomalyStillPresent: true,
          lastEventType: 'stop',
          eventCount: 1,
          paneHash: 'abc123',
          paneChangedSincePrevious: false,
          paneExcerpt: 'raw terminal contents',
        }],
        notes: [],
      },
    }] as any;
    const monitor = { getSnapshot: () => agents } as any;

    const client = getSnapshotAgentsForClient({ monitor });
    expect(client[0].findingEvidenceAudit?.observations[0]).not.toHaveProperty('paneExcerpt');

    const raw = getSnapshotAgentsRaw({ monitor });
    expect(raw[0].findingEvidenceAudit.observations[0]).toHaveProperty('paneExcerpt');
  });

  it('projected snapshot of a pathological fixture stays under SNAPSHOT_SIZE_WARNING', () => {
    // Modeled on real prod observations (6 agents, 50 events/agent, ~10 KB per
    // tool_result toolResponse). Pre-fix this was ~1.3 MB; post-fix it must
    // drop below the diagnostic's warning threshold.
    const AGENT_COUNT = 6;
    const EVENTS_PER_AGENT = 50;
    const TOOL_RESPONSE_BYTES = 10_000;

    const bigEvents: AgentEvent[] = Array.from({ length: EVENTS_PER_AGENT }, (_, i) => ({
      type: 'tool_result' as const,
      sessionId: 's1',
      toolName: 'Read',
      toolResponse: 'y'.repeat(TOOL_RESPONSE_BYTES),
      toolUseId: `tu_${i}`,
    }));
    const agents = Array.from({ length: AGENT_COUNT }, (_, i) => ({
      agentId: `a-${i}`,
      events: bigEvents,
      anomaly: null,
    })) as any;
    const monitor = { getSnapshot: () => agents } as any;

    const clientBytes = JSON.stringify(getSnapshotAgentsForClient({ monitor })).length;
    const rawBytes = JSON.stringify(getSnapshotAgentsRaw({ monitor })).length;

    // Sanity: the raw fixture is indeed pathological (far exceeds the warning).
    expect(rawBytes).toBeGreaterThan(SNAPSHOT_SIZE_WARNING_BYTES * 2);
    // Budget: projection brings it well under the diagnostic's warning.
    expect(clientBytes).toBeLessThan(SNAPSHOT_SIZE_WARNING_BYTES / 2);
    // And the reduction ratio is at least an order of magnitude.
    expect(clientBytes).toBeLessThan(rawBytes / 10);
  });

  it('includes workspaceEnabled: true in snapshot when set', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      workspaceEnabled: true,
    });

    expect(msg.workspaceEnabled).toBe(true);
  });

  it('includes bypassAllPermissions: true in owner snapshots when set', () => {
    const msg = createSnapshotMessage({
      monitor: {
        getSnapshot: () => [] as any,
      },
      serverCwd: '/repo',
      bypassAllPermissions: true,
    });

    expect(msg.bypassAllPermissions).toBe(true);
  });

  it('omits bypassAllPermissions from project-scoped snapshots', () => {
    const msg = createSnapshotMessage({
      monitor: {
        getSnapshot: () => [] as any,
      },
      serverCwd: '/repo',
      bypassAllPermissions: true,
      scope: { kind: 'projects', projectIds: ['github.com/kookr-ai/kookr'] },
    });

    expect(msg).not.toHaveProperty('bypassAllPermissions');
  });

  it('omits bypassAllPermissions when not active', () => {
    const msg = createSnapshotMessage({
      monitor: {
        getSnapshot: () => [] as any,
      },
      serverCwd: '/repo',
      bypassAllPermissions: false,
    });

    expect(msg).not.toHaveProperty('bypassAllPermissions');
  });

  it('omits workspaceEnabled when not set', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
    });

    expect(msg).not.toHaveProperty('workspaceEnabled');
  });

  it('omits workspaceEnabled when false', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      workspaceEnabled: false,
    });

    expect(msg).not.toHaveProperty('workspaceEnabled');
  });

  it('builds project summaries from the snapshot query path', () => {
    const summaries = getProjectSummaries({
      monitor: {
        getSnapshot: () => [{
          agentId: 'a-1',
          taskId: 'task-1',
          taskName: 'Test task',
          cwd: '/repo',
          status: 'running',
          events: [],
          anomaly: null,
        }] as any,
      } as any,
      ledgerAnalytics: {
        getTodayCount: () => 0,
        getWeekCount: () => 0,
        getAttemptsByProjectRecent: () => [],
        getProjects: () => [],
        getTodayBlockedEntries: () => [],
      } as any,
      projectConfigStore: {
        getConfig: () => undefined,
        getRateLimit: () => undefined,
        getAllConfigs: () => [],
        getEffectiveDailyLimit: () => undefined,
      } as any,
    });

    expect(summaries).toHaveLength(0);
  });

  it('stamps active-task GitHub overlay fields when getTaskGithubReferences is supplied', () => {
    const summaries = getProjectSummaries({
      monitor: {
        getSnapshot: () => [{
          agentId: 'a-1',
          taskId: 'task-1',
          taskName: 'Fix #42',
          taskStatus: 'inProgress',
          projectId: 'github.com/octo/cat',
          cwd: '/repo',
          events: [],
          anomaly: null,
          summary: '',
          summarizedAt: null,
          lastActivityAt: 0,
        }] as any,
      } as any,
      ledgerAnalytics: {
        getTodayCount: () => 0,
        getWeekCount: () => 0,
        getAttemptsByProject: () => [],
        getAttemptsByProjectRecent: () => [],
        getProjects: () => [],
        getTodayBlockedEntries: () => [],
      } as any,
      projectConfigStore: {
        getConfig: () => undefined,
        getRateLimit: () => undefined,
        getAllConfigs: () => [],
        getEffectiveDailyLimit: () => undefined,
      } as any,
      getTaskGithubReferences: (taskId: string) => taskId === 'task-1' ? [{
        type: 'issue' as const,
        owner: 'octo',
        repo: 'cat',
        number: 42,
        url: 'https://github.com/octo/cat/issues/42',
        detectedAt: new Date(),
        detectedFrom: 'agent-1',
        taskId: 'task-1',
      }] : [],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0].openIssuesTiedToActiveTasks).toBe(1);
    expect(summaries[0].openPrsTiedToActiveTasks).toBe(0);
    expect(summaries[0].activeTaskGithubLinks).toHaveLength(1);
    expect(summaries[0].activeTaskGithubLinks?.[0]).toMatchObject({
      kind: 'issue', number: 42, taskId: 'task-1', taskName: 'Fix #42',
    });
  });

  describe('relation projection (#601)', () => {
    const baseRelation = (overrides: Record<string, unknown>) => ({
      id: 'rel-1',
      sourceTaskId: 'c1',
      targetTaskId: 'p1',
      type: 'spawned_by',
      confidence: 1,
      source: 'api',
      evidence: [],
      createdAt: '2026-05-26T10:00:00.000Z',
      updatedAt: '2026-05-26T10:00:00.000Z',
      lifecycle: 'active',
      ...overrides,
    });

    it('omits taskRelations when no relationTaskStore is wired', () => {
      const msg = createSnapshotMessage({
        monitor: { getSnapshot: () => [{ agentId: 'a1', events: [], anomaly: null }] as any },
        serverCwd: '/repo',
      });
      expect(msg).not.toHaveProperty('taskRelations');
      expect(msg.agents[0]).not.toHaveProperty('childRollup');
    });


    it('projects active relations and decorates the parent agent with a rollup', () => {
      const monitor = {
        getSnapshot: () => [
          { agentId: 'parent-agent', taskId: 'p1', events: [], anomaly: null, taskStatus: 'inProgress' },
          { agentId: 'child-agent', taskId: 'c1', events: [], anomaly: null, taskStatus: 'inProgress' },
        ] as any,
      };
      const relations = [
        baseRelation({}),
        baseRelation({ id: 'rel-superseded', sourceTaskId: 'c2', lifecycle: 'superseded' }),
      ];
      const msg = createSnapshotMessage({
        monitor,
        serverCwd: '/repo',
        relationTaskStore: { listRelations: () => relations },
      });

      expect(msg.taskRelations).toHaveLength(1);
      expect(msg.taskRelations?.[0]).toMatchObject({ sourceTaskId: 'c1', targetTaskId: 'p1', lifecycle: 'active' });

      const parent = msg.agents.find((a) => a.taskId === 'p1');
      expect(parent?.childRollup).toMatchObject({ childCount: 1, running: 1, completed: 0, blocked: 0 });
      const child = msg.agents.find((a) => a.taskId === 'c1');
      expect(child?.childRollup).toBeUndefined();
    });

    it('keeps deterministic and inferred relations distinguishable by confidence/source', () => {
      const monitor = { getSnapshot: () => [] as any };
      const relations = [
        baseRelation({ id: 'det', confidence: 1, source: 'api' }),
        baseRelation({
          id: 'inferred',
          sourceTaskId: 'c2',
          targetTaskId: 'p1',
          type: 'related_to',
          confidence: 0.35,
          source: 'llm-inference',
        }),
      ];
      const msg = createSnapshotMessage({
        monitor,
        serverCwd: '/repo',
        relationTaskStore: { listRelations: () => relations },
      });
      const det = msg.taskRelations?.find((r) => r.source === 'api');
      const inferred = msg.taskRelations?.find((r) => r.source === 'llm-inference');
      expect(det?.confidence).toBe(1);
      expect(inferred?.confidence).toBe(0.35);
    });

    it('bumps the parent attention severity when a child finding is strictly worse than the parent', () => {
      // Acceptance criterion: "Parent/orchestrator task priority rises when a
      // child has needs_input / permission_blocked / pending too long … or
      // similar urgent state."  This test pins the *strict* bump: parent's
      // own anomaly is `info` and the child is `warning`, so the effective
      // severity must end at `warning` — not at the parent's original `info`.
      const monitor = {
        getSnapshot: () => [
          {
            agentId: 'parent-agent',
            taskId: 'p1',
            events: [],
            taskStatus: 'inProgress',
            anomaly: {
              agentId: 'parent-agent',
              type: 'needs_input',
              severity: 'info',
              explanation: 'parent waiting on supervisor',
              detectedAt: new Date('2026-05-26T10:00:00.000Z'),
            },
          },
          {
            agentId: 'child-agent',
            taskId: 'c1',
            events: [],
            taskStatus: 'inProgress',
            anomaly: {
              agentId: 'child-agent',
              type: 'needs_input',
              severity: 'warning',
              explanation: 'needs review',
              detectedAt: new Date('2026-05-26T10:00:00.000Z'),
            },
          },
        ] as any,
      };
      const msg = createSnapshotMessage({
        monitor,
        serverCwd: '/repo',
        relationTaskStore: { listRelations: () => [baseRelation({})] },
      });
      const parent = msg.agents.find((a) => a.taskId === 'p1');
      expect(parent?.anomaly?.severity).toBe('info');
      expect(parent?.effectiveAttentionSeverity).toBe('warning');
      expect(parent?.childRollup?.mostUrgentChildFinding).toMatchObject({
        childTaskId: 'c1',
        severity: 'warning',
        anomalyType: 'needs_input',
      });
    });

    it('does not downgrade a parent that is already more severe than its worst child', () => {
      const monitor = {
        getSnapshot: () => [
          {
            agentId: 'parent-agent',
            taskId: 'p1',
            events: [],
            taskStatus: 'inProgress',
            anomaly: {
              agentId: 'parent-agent',
              type: 'permission_blocked',
              severity: 'critical',
              explanation: 'parent awaiting allow',
              detectedAt: new Date('2026-05-26T10:00:00.000Z'),
            },
          },
          {
            agentId: 'child-agent',
            taskId: 'c1',
            events: [],
            taskStatus: 'inProgress',
            anomaly: {
              agentId: 'child-agent',
              type: 'needs_input',
              severity: 'warning',
              explanation: 'mild child finding',
              detectedAt: new Date('2026-05-26T10:00:00.000Z'),
            },
          },
        ] as any,
      };
      const msg = createSnapshotMessage({
        monitor,
        serverCwd: '/repo',
        relationTaskStore: { listRelations: () => [baseRelation({})] },
      });
      const parent = msg.agents.find((a) => a.taskId === 'p1');
      expect(parent?.effectiveAttentionSeverity).toBe('critical');
    });

    it('does not mutate the parent agent object even when a child finding bumps the effective severity', () => {
      const parentAgentObj = {
        agentId: 'parent-agent',
        taskId: 'p1',
        events: [] as any[],
        anomaly: null,
        taskStatus: 'inProgress' as const,
      };
      const before = structuredClone(parentAgentObj);
      const monitor = {
        getSnapshot: () => [
          parentAgentObj,
          {
            agentId: 'child-agent',
            taskId: 'c1',
            events: [],
            taskStatus: 'inProgress',
            anomaly: {
              agentId: 'child-agent',
              type: 'permission_blocked',
              severity: 'critical',
              explanation: 'awaiting allow',
              detectedAt: new Date('2026-05-26T10:00:00.000Z'),
            },
          },
        ] as any,
      };
      const msg = createSnapshotMessage({
        monitor,
        serverCwd: '/repo',
        relationTaskStore: { listRelations: () => [baseRelation({})] },
      });
      // Source object is untouched in every field, not just `anomaly`.
      expect(parentAgentObj).toEqual(before);
      // And the projected parent is a different reference — no shared state.
      const projectedParent = msg.agents.find((a) => a.taskId === 'p1');
      expect(projectedParent).not.toBe(parentAgentObj);
      expect(projectedParent?.childRollup?.mostUrgentChildFinding?.severity).toBe('critical');
    });

    it('ships an empty taskRelations array when the active set is empty (clears sticky cache)', () => {
      const msg = createSnapshotMessage({
        monitor: { getSnapshot: () => [] as any },
        serverCwd: '/repo',
        relationTaskStore: { listRelations: () => [] },
      });
      expect(msg.taskRelations).toEqual([]);
    });
  });
});

describe('pending agent signal projection', () => {
  it('joins the task pending signal onto the client-facing agent state', () => {
    const monitor = {
      getSnapshot: () => [
        { agentId: 'a-1', taskId: 't-1', events: [], anomaly: null },
        { agentId: 'a-2', taskId: 't-2', events: [], anomaly: null },
      ] as any,
    };
    const signal = { kind: 'completion_ready' as const, raisedAt: '2026-06-05T12:00:00.000Z' };
    const agents = getSnapshotAgentsForClient({
      monitor,
      pendingSignalProvider: {
        getPendingSignal: (taskId: string) => (taskId === 't-1' ? signal : undefined),
      },
    });
    expect(agents.find((a) => a.agentId === 'a-1')?.pendingSignal).toEqual(signal);
    expect(agents.find((a) => a.agentId === 'a-2')?.pendingSignal).toBeUndefined();
  });

  it('omits pendingSignal when no provider is wired', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', taskId: 't-1', events: [], anomaly: null }] as any,
    };
    const agents = getSnapshotAgentsForClient({ monitor });
    expect(agents[0].pendingSignal).toBeUndefined();
  });

  it('createSnapshotMessage defaults the provider from relationTaskStore', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', taskId: 't-1', events: [], anomaly: null }] as any,
    };
    const signal = { kind: 'completion_ready' as const, raisedAt: '2026-06-05T12:00:00.000Z' };
    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      relationTaskStore: {
        listRelations: () => [],
        getPendingSignal: (taskId: string) => (taskId === 't-1' ? signal : undefined),
      } as any,
    });
    expect(msg.agents.find((a) => a.agentId === 'a-1')?.pendingSignal).toEqual(signal);
  });
});
