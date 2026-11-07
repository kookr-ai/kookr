#!/usr/bin/env node
/**
 * Live smoke test for Kookr->Hermes delegation (RFC `rfc-kookr-hermes-delegation`,
 * slice 1a exit criterion). Run by hand, never in CI: it spends real model calls.
 *
 * What it proves, end to end, against two already-running scratch Hermes agents:
 *  1. The registry accepts two workers with DISTINCT token files and a loopback URL each.
 *  2. Each token authenticates only its own worker (a cross-token request is `auth`).
 *     These checks use `tasks/list`, which costs no model call.
 *  3. ONE triage delegation goes through the real service: a snapshot of a small checkout is
 *     cut under the read-only snapshots root, the issue text (a SYNTHETIC fixture, nothing
 *     private) is embedded in the server-built prompt, the job is dispatched with
 *     `message/send`, and the worker's reply validates against the triage schema, with its
 *     cited paths checked against the snapshot.
 *
 * Usage (paths are yours; nothing here is machine-specific):
 *   node --import tsx scripts/delegation-live-smoke.ts \
 *     --worker <name>,<url>,<tokenFile>   (twice, one per scratch agent) \
 *     --snapshots-root <dir>              (the directory mounted read-only into BOTH agents) \
 *     --repo-dir <checkout>               (a small git checkout; its default branch HEAD is used) \
 *     [--github-repo owner/name] [--project-id smoke] [--container-path /opt/workspace] \
 *     [--timeout-sec 280] [--reply-timeout-sec 900]
 *
 * Token FILES are read by the service itself; token values are never printed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createA2aClient } from '../src/server/delegation/a2a-client.js';
import { readWorkerTokens, validateWorkerRegistry, type DelegationConfig } from '../src/server/delegation/registry.js';
import { DelegationService } from '../src/server/delegation/service.js';
import { createSnapshotManager } from '../src/server/delegation/snapshots.js';
import { DelegationStore } from '../src/server/delegation/store.js';
import type { IssueSnapshot } from '../src/server/delegation/prompts.js';

interface Args {
  workers: Array<{ name: string; url: string; tokenFile: string }>;
  snapshotsRoot: string;
  repoDir: string;
  githubRepo: string;
  projectId: string;
  containerPath: string;
  timeoutSec: number;
  replyTimeoutSec: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    workers: [],
    snapshotsRoot: '',
    repoDir: '',
    githubRepo: 'example/smoke',
    projectId: 'smoke',
    containerPath: '/opt/workspace',
    timeoutSec: 280,
    replyTimeoutSec: 900,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const val = argv[++i];
    if (val === undefined) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case '--worker': {
        const [name, url, tokenFile] = val.split(',');
        if (!name || !url || !tokenFile) throw new Error('--worker needs <name>,<url>,<tokenFile>');
        out.workers.push({ name, url, tokenFile: resolve(tokenFile) });
        break;
      }
      case '--snapshots-root': out.snapshotsRoot = resolve(val); break;
      case '--repo-dir': out.repoDir = resolve(val); break;
      case '--github-repo': out.githubRepo = val; break;
      case '--project-id': out.projectId = val; break;
      case '--container-path': out.containerPath = val; break;
      case '--timeout-sec': out.timeoutSec = Number(val); break;
      case '--reply-timeout-sec': out.replyTimeoutSec = Number(val); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (out.workers.length < 2) throw new Error('give two --worker entries (two scratch agents with distinct tokens)');
  if (!out.snapshotsRoot || !out.repoDir) throw new Error('--snapshots-root and --repo-dir are required');
  return out;
}

/** A synthetic issue: no private data. It asks a question a tiny checkout can answer. */
const SYNTHETIC_ISSUE: IssueSnapshot = {
  number: 1,
  title: 'Document what the main module exports',
  state: 'OPEN',
  labels: ['documentation'],
  body:
    'The README does not say what the main module exports or how to call it. ' +
    'Please check the source and tell us what is missing so we can write the documentation.',
  comments: [{ author: 'maintainer', body: 'I think this is a small docs task; please confirm by reading the code.' }],
  truncated: false,
};

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config: DelegationConfig = {
    snapshotsRoot: args.snapshotsRoot,
    containerSnapshotsPath: args.containerPath,
    maxDelegations: 4,
    allowedHosts: [],
    projects: { [args.projectId]: { repoDir: args.repoDir, githubRepo: args.githubRepo } },
    workers: args.workers.map((w) => ({
      name: w.name,
      url: w.url,
      tokenFile: w.tokenFile,
      projects: [args.projectId],
      maxInFlight: 2,
      operatorAttestedLeaf: true,
      workspaceMode: 'ro',
      replyTimeoutSec: args.replyTimeoutSec,
    })),
  };

  // 1. Registry: distinct tokens, loopback URLs, attestations.
  const tokens = await readWorkerTokens(config.workers);
  const registry = validateWorkerRegistry(config, tokens);
  check('registry accepts two workers with distinct tokens', registry.ok, registry.ok ? '' : registry.issues.map((i) => i.message).join('; '));
  if (!registry.ok) return;

  // 2. Each token authenticates only its own worker (no model call: tasks/list).
  const client = createA2aClient();
  const probe = randomUUID();
  const opts = { timeoutMs: 10_000 };
  for (const [i, w] of registry.workers.entries()) {
    const own = await client.listByContext({ url: w.url, token: tokens.get(w.name)!.trim() }, probe, opts);
    check(`${w.name}: own token is accepted (empty task list for a fresh context)`, own.kind === 'tasks' && own.tasks.length === 0, own.kind);
    const other = registry.workers[(i + 1) % registry.workers.length]!;
    const cross = await client.listByContext({ url: w.url, token: tokens.get(other.name)!.trim() }, probe, opts);
    check(`${w.name}: ${other.name}'s token is refused`, cross.kind === 'auth', cross.kind);
  }

  // 3. One real triage delegation through the service.
  const workDir = mkdtempSync(join(tmpdir(), 'delegation-smoke-'));
  const logs: string[] = [];
  try {
    const service = new DelegationService({
      config,
      workers: registry.workers,
      store: new DelegationStore(join(workDir, 'delegations.json'), { newInstanceId: () => 'smoke' }),
      client,
      snapshots: createSnapshotManager({ root: config.snapshotsRoot, projects: config.projects, log: (l) => logs.push(l) }),
      fetchIssue: async () => SYNTHETIC_ISSUE,
      log: (l) => logs.push(l),
    });
    await service.start();
    const started = Date.now();
    const submitted = await service.submit({ kind: 'triage', projectId: args.projectId, issueRef: SYNTHETIC_ISSUE.number, key: 'live-smoke' });
    check('submit accepted (record written ahead of dispatch)', submitted.ok, submitted.ok ? `state=${submitted.delegation.state} worker=${submitted.delegation.workerId}` : submitted.error.code);
    if (!submitted.ok) return;
    const id = submitted.delegation.id;
    console.log(`      baseSha=${submitted.delegation.baseSha} contextId=${submitted.delegation.contextId}`);

    const deadline = Date.now() + args.timeoutSec * 1000;
    while (Date.now() < deadline) {
      const d = service.get(id)!;
      if (d.state !== 'dispatching' && d.state !== 'working') break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    const final = service.get(id)!;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    check('delegation completed', final.state === 'completed', `state=${final.state}${final.failureReason ? ` reason=${final.failureReason}` : ''} after ${secs}s`);
    if (final.state !== 'completed') {
      if (final.detail) console.log(`      detail (untrusted=${final.detail.untrusted}): ${final.detail.message.slice(0, 400)}`);
      return;
    }
    check('worker task id was resolved via tasks/list', Boolean(final.a2aTaskId), final.a2aTaskId);
    check('result is schema-valid and marked untrusted', final.result?.untrusted === true && Boolean(final.result.verdict.summary));
    console.log(`      verdict: ${JSON.stringify(final.result!.verdict)}`);
    if (final.result!.warnings.length > 0) console.log(`      warnings: ${JSON.stringify(final.result!.warnings)}`);
    await service.drain();
    service.stop();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`smoke aborted: ${(err as Error).message}`);
  process.exit(1);
});
