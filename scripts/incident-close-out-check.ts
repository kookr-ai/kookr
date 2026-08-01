#!/usr/bin/env node
/**
 * incident-close-out-check — CLI probe for the incident close-out gate (#1750).
 *
 * Given evidence about an incident issue (state, labels, fix PRs, optional
 * deploy-SHA probe), classify whether it is safe to close. Pure classification
 * lives in `src/core/incident-close-out.ts`; this file gathers optional live
 * inputs and prints a machine-readable receipt.
 *
 * Usage:
 *   node --import tsx scripts/incident-close-out-check.ts --from-file evidence.json
 *   node --import tsx scripts/incident-close-out-check.ts \
 *     --issue-state open --labels incident --merged-fix \
 *     --fix-merged-at 2026-07-31T16:58:00Z \
 *     --health-url http://127.0.0.1:4800/api/health \
 *     --target-sha bf39be2
 *
 * Exit codes:
 *   0  verified-converged | already-closed | not-incident | open-unfixed | fix-open
 *      (no standing alert required)
 *   2  fix-merged-unverified within grace (watch, no alert yet)
 *   3  fix-merged-unverified STALE — standing operator alert
 *   4  re-escalated — verification failed after fix merge
 *   1  usage / runtime error
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_UNVERIFIED_ALERT_MINUTES,
  buildConvergenceReceipt,
  classifyIncidentCloseOut,
  extractServingSha,
  type ClassifyIncidentCloseOutInput,
  type IncidentCloseOutClassification,
  type VerificationResult,
  verifyDeploySha,
} from '../src/core/incident-close-out.js';

export const EXIT_CODES = Object.freeze({
  ok: 0,
  unverified: 2,
  stale: 3,
  reEscalated: 4,
  error: 1,
});

export interface EvidenceFile {
  issueState: 'open' | 'closed';
  labels?: string[];
  hasOpenFixPr?: boolean;
  hasMergedFixPr?: boolean;
  fixMergedAt?: string | null;
  fixPrNumbers?: number[];
  issueNumber?: number;
  verification?: VerificationResult | null;
  /** Optional live probe inputs (used when verification is omitted). */
  healthUrl?: string;
  healthBody?: unknown;
  targetSha?: string;
  servingIncludesTarget?: boolean | null;
  unverifiedAlertMinutes?: number;
}

function usage(): never {
  console.error(`Usage:
  node --import tsx scripts/incident-close-out-check.ts --from-file <evidence.json>
  node --import tsx scripts/incident-close-out-check.ts \\
    --issue-state open|closed --labels <csv> [--merged-fix] [--open-fix] \\
    [--fix-merged-at <iso>] [--health-url <url>] [--target-sha <sha>] \\
    [--issue-number <n>] [--fix-prs <csv>] [--alert-minutes <n>] [--json]

Exit: 0 ok · 2 unverified · 3 STALE alert · 4 re-escalated · 1 error`);
  process.exit(EXIT_CODES.error);
}

function parseArgs(argv: string[]): {
  fromFile?: string;
  issueState?: 'open' | 'closed';
  labels: string[];
  hasMergedFixPr: boolean;
  hasOpenFixPr: boolean;
  fixMergedAt?: string;
  healthUrl?: string;
  targetSha?: string;
  issueNumber?: number;
  fixPrNumbers: number[];
  alertMinutes: number;
  json: boolean;
} {
  const out = {
    labels: [] as string[],
    hasMergedFixPr: false,
    hasOpenFixPr: false,
    fixPrNumbers: [] as number[],
    alertMinutes: DEFAULT_UNVERIFIED_ALERT_MINUTES,
    json: false,
  } as ReturnType<typeof parseArgs>;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (a) {
      case '--from-file':
        out.fromFile = next();
        break;
      case '--issue-state': {
        const v = next();
        if (v !== 'open' && v !== 'closed') usage();
        out.issueState = v;
        break;
      }
      case '--labels':
        out.labels = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--merged-fix':
        out.hasMergedFixPr = true;
        break;
      case '--open-fix':
        out.hasOpenFixPr = true;
        break;
      case '--fix-merged-at':
        out.fixMergedAt = next();
        break;
      case '--health-url':
        out.healthUrl = next();
        break;
      case '--target-sha':
        out.targetSha = next();
        break;
      case '--issue-number':
        out.issueNumber = Number(next());
        break;
      case '--fix-prs':
        out.fixPrNumbers = next()
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        break;
      case '--alert-minutes':
        out.alertMinutes = Number(next());
        break;
      case '--json':
        out.json = true;
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        usage();
    }
  }
  return out;
}

async function resolveVerification(
  evidence: EvidenceFile,
): Promise<VerificationResult | null | undefined> {
  if (evidence.verification !== undefined) return evidence.verification;

  let healthBody = evidence.healthBody;
  if (!healthBody && evidence.healthUrl) {
    const res = await fetch(evidence.healthUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`health probe HTTP ${res.status} for ${evidence.healthUrl}`);
    }
    healthBody = await res.json();
  }

  if (healthBody !== undefined || evidence.targetSha) {
    const servingSha = extractServingSha(healthBody);
    return verifyDeploySha({
      servingSha,
      targetSha: evidence.targetSha,
      servingIncludesTarget: evidence.servingIncludesTarget,
    });
  }

  return undefined;
}

export function exitCodeFor(classification: IncidentCloseOutClassification): number {
  switch (classification.state) {
    case 'fix-merged-unverified':
      return classification.staleUnverified ? EXIT_CODES.stale : EXIT_CODES.unverified;
    case 're-escalated':
      return EXIT_CODES.reEscalated;
    default:
      return EXIT_CODES.ok;
  }
}

export async function classifyFromEvidence(
  evidence: EvidenceFile,
): Promise<{
  classification: IncidentCloseOutClassification;
  receipt: string | null;
  exitCode: number;
}> {
  const verification = await resolveVerification(evidence);
  const input: ClassifyIncidentCloseOutInput = {
    issueState: evidence.issueState,
    labels: evidence.labels,
    hasOpenFixPr: evidence.hasOpenFixPr,
    hasMergedFixPr: evidence.hasMergedFixPr,
    fixMergedAt: evidence.fixMergedAt,
    verification: verification ?? null,
    unverifiedAlertMinutes: evidence.unverifiedAlertMinutes,
  };
  const classification = classifyIncidentCloseOut(input);
  const receipt =
    classification.mayClose && evidence.issueNumber !== undefined && verification
      ? buildConvergenceReceipt({
          issueNumber: evidence.issueNumber,
          fixPrNumbers: evidence.fixPrNumbers,
          verification,
          evaluatedAt: classification.evaluatedAt,
        })
      : null;
  return {
    classification,
    receipt,
    exitCode: exitCodeFor(classification),
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  let evidence: EvidenceFile;

  if (args.fromFile) {
    evidence = JSON.parse(readFileSync(args.fromFile, 'utf-8')) as EvidenceFile;
  } else {
    if (!args.issueState) usage();
    evidence = {
      issueState: args.issueState,
      labels: args.labels,
      hasMergedFixPr: args.hasMergedFixPr,
      hasOpenFixPr: args.hasOpenFixPr,
      fixMergedAt: args.fixMergedAt,
      healthUrl: args.healthUrl,
      targetSha: args.targetSha,
      issueNumber: args.issueNumber,
      fixPrNumbers: args.fixPrNumbers,
      unverifiedAlertMinutes: args.alertMinutes,
    };
  }

  const result = await classifyFromEvidence(evidence);
  const payload = {
    state: result.classification.state,
    mayClose: result.classification.mayClose,
    staleUnverified: result.classification.staleUnverified,
    message: result.classification.message,
    verification: result.classification.verification,
    evaluatedAt: result.classification.evaluatedAt,
    exitCode: result.exitCode,
    ...(result.receipt ? { closeReceipt: result.receipt } : {}),
  };

  if (args.json || args.fromFile) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(
      `incident-close-out: ${result.classification.state}` +
        (result.classification.staleUnverified ? ' STALE' : '') +
        ` · mayClose=${result.classification.mayClose}` +
        ` · ${result.classification.message}`,
    );
    if (result.classification.verification) {
      console.log(`  verification: ${result.classification.verification.receipt}`);
    }
    if (result.receipt) {
      console.log('--- close receipt ---');
      console.log(result.receipt);
    }
  }

  return result.exitCode;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(
        `incident-close-out-check: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT_CODES.error);
    });
}
