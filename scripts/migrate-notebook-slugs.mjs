#!/usr/bin/env node
// migrate-notebook-slugs — fold legacy-slug project shelves into the canonical
// ones (RFC docs/rfc/rfc-notebook-memory-layers.md, D4; issue #3591).
//
// Background. A project shelf is `<situation>@<slug>`, where the slug is the
// repo's `owner-repo` (`KOOKR_REPO_SLUG`). One repo ended up with shelves under
// two slugs: the short `agent-notebook` and the canonical
// `jeanibarz-agent-notebook`. The session-start index (a later change) shows an
// agent only its own repo's shelves, so the short-slug ones would be hidden from
// the very repo they belong to. plugin/notebooks/slug-aliases.json maps each
// legacy slug to its canonical one; this script moves every lesson from
// `base@legacy` to `base@canonical` with `nb move` (which keeps the score).
//
// DRY-RUN BY DEFAULT. Without --apply it only prints the plan. With --apply it
// first tags the store's git repo (`pre-slug-migration`), then runs the moves.
//
// Why a simulation. `nb move` always admits the moved lesson. When the target is
// full (50 lessons, one per line) `nb` drops the target's LOWEST-scored lesson and
// lowers the score of the lesson touched least recently by one point ("aging"),
// so moving a weak lesson into a full shelf destroys a better one. The plan is
// therefore simulated one move at a time (scripts/lib/nb-sim.mjs; a parity test
// replays it against the real `nb`), and:
//   * if the target is FULL and the lesson `nb` would evict scores the same or
//     higher than the mover, the move is refused unless --force-low: it would
//     trade a lesson for one that is no better, and equal-scored lessons would
//     push each other out one by one. The victim counts at the score it had when
//     the run started (or arrived), so the aging that earlier moves cause cannot
//     make an equal lesson look expendable (a non-full target never refuses:
//     nothing is evicted);
//   * if the target already holds MORE than the cap, a move would evict several
//     lessons at once (`nb move --json` reports only the first), so it is refused
//     unless --force-low;
//   * if the target already holds the same lesson (`nb`'s dedup key), `nb move`
//     refuses ("skipped", exit 0), so the plan predicts it, the lesson stays on
//     its legacy shelf, and it is listed for a manual decision. This script never
//     removes a lesson: a move always happens before any `nb rm`, and migration
//     has no `rm` at all;
//   * a target name over 128 characters (or otherwise invalid) is reported before
//     anything runs, because `nb` would fail it with `bad_args` mid-run.
//
// Resumable. The plan is recomputed from the store on every run and every move
// re-reads the two shelves it touches, so an interrupted run is finished by
// running the same command again; a second run after completion changes nothing.
//
// After the last lesson leaves a legacy shelf, nb 0.7.0 leaves a 0-BYTE file
// behind (hidden from `nb list`, still on disk; the upstream fix, agent-notebook
// #355/#356, is unreleased). This script deletes exactly such files (only size 0,
// only legacy shelves it is migrating) and commits each deletion itself. It then
// re-runs the description seed so the new canonical shelves get descriptions, and
// confirms every legacy shelf is gone from disk AND from `nb list --json`,
// reporting any that remain.
//
// When the migration is finished and verified, delete its tag (`git -C "$NB_DIR" tag -d
// pre-slug-migration`): an existing tag is treated as a resumed run, whose baseline
// and rollback range start at that old state.
//
// A run with nothing to migrate but undescribed canonical shelves only describes
// them (`nb describe`, itself a commit through the shim); it does not tag.
//
// ROLLBACK. Each `nb move` is its own commit in the store (the bin/nb.js shim
// commits every mutation), and the 0-byte deletions are commits too. Run the
// migration while no tasks are running: agents' own `nb add`/`nb vote` commits
// land in the same history. If `git log pre-slug-migration..HEAD` shows only this
// script's commits, undo with `git revert --no-edit pre-slug-migration..HEAD` in
// the store. If agent commits are mixed in, revert only the script's own commits
// (subjects starting `nb move`, `nb describe`, `slug migration:`), newest first,
// so agents' lessons survive. NEVER `git reset --hard`. A revert can conflict
// on a shelf an agent touched afterwards; resolve those by hand, keeping both
// sides' lessons. `--apply` refuses to run with NB_GIT_AUTOCOMMIT=0, because
// then the moves would not be commits at all.
//
// Usage: node scripts/migrate-notebook-slugs.mjs [--apply] [--force-low]
//          [--map <slug-aliases.json>] [--manifest <shelves.json>] [--nb <nb path>]
//          [--tag <name>]
// Environment: NB_DIR selects the store (as for `nb`); NB_MAX_LINES is honored.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyShelf, loadSlugAliases, normalizeSlug, projectShelfName } from '../plugin/hooks/lib/notebook-layers.mjs';
import { applyDescriptions, buildSeed, deriveProjectDescriptions } from './apply-shelf-descriptions.mjs';
import {
  blankNbDir,
  commitPaths,
  createNbClient,
  headSha,
  isStoreGitRepo,
  checkArgv,
  moveCommand,
  nbMove,
  reapZeroByteShelf,
  refreshShelves,
  snapshotStore,
  storeAtTag,
  tagStore,
} from './lib/nb-client.mjs';
import { baselineScores, cloneBaselines, cloneStore, applyMove, decideStep, entryId, maxLines, noteMoved, shelfNameProblem } from './lib/nb-sim.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TAG = 'pre-slug-migration';

const clip = (text, n = 70) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const fmtScore = (n) => (n >= 0 ? `+${n}` : `${n}`);

/**
 * Pick the shelf a legacy shelf folds into. An existing canonical-slug shelf with
 * the same base wins (so `Code-Review@Jeanibarz-Agent-Notebook` is reused rather
 * than shadowed by a differently-cased twin); otherwise `<base>@<canonical slug
 * as written in the alias map>`.
 */
function chooseTarget(cls, canonicalAsWritten, shelfNames, aliases) {
  for (const name of shelfNames) {
    const other = classifyShelf(name, aliases);
    if (other.layer === 'project' && !other.legacy && other.base === cls.base && other.canonical === cls.canonical) {
      return name;
    }
  }
  return projectShelfName(cls.base, canonicalAsWritten);
}

/**
 * Build the migration plan from a store snapshot (pure: no I/O).
 * Returns `{ legacy, steps, invalid, created, approximateOrder }` where each
 * step is `{ from, to, id, score, text, decision }` with `decision` from
 * {@link decideStep} as simulated in order.
 */
export function planMigration({ snapshot, aliases, cap = maxLines(), forceLow = false, baselines = baselineScores(snapshot.store) }) {
  const names = [...snapshot.store.keys()].sort();
  const legacy = [];
  const invalid = [];
  const steps = [];
  const sim = cloneStore(snapshot.store);
  const bars = cloneBaselines(baselines);

  for (const name of names) {
    const cls = classifyShelf(name, aliases);
    if (cls.layer !== 'project' || !cls.legacy) continue;
    const canonicalAsWritten = aliases.get(normalizeSlug(cls.slug));
    const target = chooseTarget(cls, canonicalAsWritten, names, aliases);
    const problem = shelfNameProblem(target);
    const entries = snapshot.store.get(name) ?? [];
    legacy.push({ shelf: name, target, lessons: entries.length, problem });
    if (problem) {
      invalid.push({ from: name, target, problem, lessons: entries.length });
      continue;
    }
    // Highest score first, so the most valuable lessons are admitted before the
    // target fills; ties keep file order (stable sort).
    const ordered = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.score - a.e.score || a.i - b.i);
    for (const { e } of ordered) {
      const step = { from: name, to: target, id: e.id, score: e.score, text: e.text };
      const decision = decideStep(sim, step, { cap, forceLow, baselines: bars });
      step.decision = decision;
      if (decision.action === 'move') {
        applyMove(sim, step.from, step.to, step.id, cap);
        noteMoved(bars, step.id, step.score);
      }
      steps.push(step);
    }
  }

  const created = [...new Set(legacy.filter((l) => !l.problem && !snapshot.store.has(l.target) && l.lessons > 0).map((l) => l.target))];
  const approximateOrder = snapshot.approximateOrder.filter((s) => legacy.some((l) => l.shelf === s || l.target === s));
  return { legacy, steps, invalid, created, approximateOrder, finalStore: sim };
}

/** Print a plan (dry-run and the start of --apply). Returns nothing. */
export function printPlan({ plan, snapshot, cap, forceLow, log }) {
  const { legacy, steps, invalid } = plan;
  log(`Store: ${snapshot.dir}   cap: ${cap} lessons per shelf${forceLow ? '   --force-low' : ''}`);
  if (legacy.length === 0) {
    log('No legacy-slug shelves found: nothing to migrate.');
  } else {
    log(`\nLegacy-slug shelves (${legacy.length}) and where they fold:`);
    for (const l of legacy) {
      const t = snapshot.store.get(l.target);
      const state = l.problem ? `INVALID TARGET (${l.problem})` : t ? `exists, ${t.length}/${cap}${t.length >= cap ? ' FULL' : ''}` : 'new shelf';
      log(`  ${l.shelf} (${l.lessons}) -> ${l.target}  [${state}]`);
    }
  }
  for (const i of invalid) {
    log(`\nREFUSED before starting: ${i.from} -> ${i.target}: ${i.problem}. nb would fail it with bad_args; its ${i.lessons} lesson(s) stay put.`);
  }
  if (plan.approximateOrder.length > 0) {
    log(`\nNote: file order could not be confirmed for ${plan.approximateOrder.join(', ')}; eviction ties and aging there are approximate.`);
  }
  if (steps.length > 0) {
    log(`\nPlanned lesson moves (${steps.length}), simulated one at a time:`);
    steps.forEach((s, i) => {
      const n = String(i + 1).padStart(3);
      const d = s.decision;
      if (d.action === 'move') {
        log(`${n}. ${moveCommand(s.from, s.to, s.id)}   (${fmtScore(s.score)}) ${clip(s.text)}`);
        for (const ev of d.prediction.evictedAll) {
          log(`       target full: evicts ${ev.id} (${fmtScore(ev.score)}) ${clip(ev.text, 50)}`);
        }
        if (d.prediction.docked) {
          log(`       and docks ${d.prediction.docked.id} ${fmtScore(d.prediction.docked.from)} -> ${fmtScore(d.prediction.docked.to)}`);
        }
      } else if (d.reason === 'low-score') {
        log(`${n}. SKIP low score: ${s.from} ${s.id} (${fmtScore(s.score)}) would evict ${d.victim.id} (${fmtScore(d.bar)} un-aged) from the full ${s.to}, a lesson that scores no lower. Moving it would be a pure loss. Re-run with --force-low to move anyway.`);
      } else if (d.reason === 'over-cap') {
        log(`${n}. SKIP over-cap: ${s.to} already holds more than ${cap} lessons, so moving ${s.from} ${s.id} would evict ${d.prediction.evictedAll.length} of them at once. Trim the target by hand or re-run with --force-low.`);
      } else if (d.reason === 'duplicate') {
        log(`${n}. SKIP duplicate: ${s.to} already holds this lesson (${d.prediction.collidedId}); nb would refuse ("skipped", exit 0). ${s.from} ${s.id} stays; decide by hand, e.g. \`nb rm ${s.from} ${s.id} --reason obsolete --note duplicate\` once you are sure.`);
      } else {
        log(`${n}. SKIP ${d.reason}: ${s.from} ${s.id}`);
      }
    });
  }
  // Outcome summary.
  const stillHeld = legacy.filter((l) => !l.problem).map((l) => ({
    shelf: l.shelf,
    left: (plan.finalStore.get(l.shelf) ?? []).length,
  }));
  const emptied = stillHeld.filter((s) => s.left === 0 && legacy.find((l) => l.shelf === s.shelf)?.lessons > 0).map((s) => s.shelf);
  const holding = [
    ...stillHeld.filter((s) => s.left > 0).map((s) => `${s.shelf} (${s.left})`),
    ...invalid.map((i) => `${i.from} (${i.lessons})`),
  ];
  // Collateral damage on lessons that were already in the targets.
  const moverIds = new Set(steps.map((s) => s.id));
  const touched = new Map();
  for (const s of steps) {
    if (s.decision.action !== 'move') continue;
    const { evictedAll, docked } = s.decision.prediction;
    if (docked) {
      const t = touched.get(`${s.to}|${docked.id}`) ?? { shelf: s.to, id: docked.id, text: docked.text, start: docked.from };
      t.end = docked.to;
      if (moverIds.has(docked.id)) t.wasMoved = true;
      touched.set(`${s.to}|${docked.id}`, t);
    }
    for (const evicted of evictedAll) {
      const t = touched.get(`${s.to}|${evicted.id}`) ?? { shelf: s.to, id: evicted.id, text: evicted.text, start: evicted.score };
      t.evicted = true;
      if (moverIds.has(evicted.id)) t.wasMoved = true;
      touched.set(`${s.to}|${evicted.id}`, t);
    }
  }
  const lost = [...touched.values()].filter((t) => t.evicted);
  const lowered = [...touched.values()].filter((t) => !t.evicted && t.end !== t.start);
  log('\nPlanned outcome:');
  log(`  existing lessons evicted from full targets (lost): ${lost.length}`);
  for (const t of lost) log(`    ${t.shelf} ${t.id} (${fmtScore(t.start)}) ${clip(t.text, 60)}${t.wasMoved ? '   [a lesson moved earlier in this plan]' : ''}`);
  log(`  existing lessons lowered by one point (aging): ${lowered.length}`);
  for (const t of lowered) log(`    ${t.shelf} ${t.id} ${fmtScore(t.start)} -> ${fmtScore(t.end)} ${clip(t.text, 60)}${t.wasMoved ? '   [a lesson moved earlier in this plan]' : ''}`);
  log(`  moves: ${steps.filter((s) => s.decision.action === 'move').length}   skipped: ${steps.filter((s) => s.decision.action === 'skip').length}`);
  log(`  legacy shelves emptied (their 0-byte leftovers will be deleted): ${emptied.length ? emptied.join(', ') : 'none'}`);
  log(`  legacy shelves that will still hold lessons (manual decision): ${holding.length ? holding.join(', ') : 'none'}`);
  log(`  new canonical shelves (described by the seed re-run): ${plan.created.length ? plan.created.join(', ') : 'none'}`);
}

/**
 * Run the migration. `apply: false` only plans. Returns
 * `{ ok, plan, performed, skipped, reaped, remaining, warnings, error }`.
 * `stopAfter` (tests) ends the move loop after that many successful moves, and
 * `stopAfterStage: 'reap'` ends the run after the 0-byte cleanup, leaving the store
 * half-migrated for a resume test.
 */
export function runMigration({
  client,
  aliases,
  manifestShelves,
  apply = false,
  forceLow = false,
  tag = DEFAULT_TAG,
  cap = maxLines(),
  log = () => {},
  stopAfter = Infinity,
  stopAfterStage = null,
}) {
  const snapshot = snapshotStore(client);
  const dir = snapshot.dir;
  // The bar a mover must clear comes from the store as it was when the migration
  // began: the rollback tag's tree on a resumed run, else the store now. Otherwise
  // the aging that run 1's moves caused would lower the bar for run 2.
  const baseline = (isStoreGitRepo(dir) ? storeAtTag(dir, tag) : null) ?? snapshot.store;
  const baselines = baselineScores(baseline);
  const plan = planMigration({ snapshot, aliases, cap, forceLow, baselines });
  const applyBars = cloneBaselines(baselines);
  printPlan({ plan, snapshot, cap, forceLow, log });

  const result = { ok: true, plan, performed: [], skipped: [], reaped: [], remaining: [], warnings: [], error: null };
  const legacyNames = plan.legacy.map((l) => l.shelf);

  const scope = (name) => inDescriptionScope(name, aliases);
  const pending = [...snapshot.store.keys()].filter((n) => scope(n) && !snapshot.descriptions.get(n) && snapshot.store.get(n).length > 0);
  if (!apply) {
    log('\nDRY RUN: nothing was changed. Review the plan, then re-run with --apply.');
    if (manifestShelves) {
      const names = [...new Set([...pending, ...plan.created])].sort();
      const derived = deriveProjectDescriptions({ manifestShelves, shelfNames: names, aliases });
      log(`\nThe seed re-run would describe ${Object.keys(derived).length} canonical-slug shelf(s) of the migrated repo(s):`);
      for (const [name, text] of Object.entries(derived)) log(`  would describe ${name} :: ${clip(text, 90)}`);
      const bare = names.filter((n) => !(n in derived));
      if (bare.length) log(`  no seed trigger for: ${bare.join(', ')} (they stay undescribed)`);
    }
    return result;
  }

  const leftovers = snapshot.zeroByte.filter((n) => isLegacyShelf(n, aliases));
  const hasMigrationWork = plan.legacy.length > 0 || leftovers.length > 0;
  if (!hasMigrationWork && pending.length === 0) {
    log('\nNothing to do: the store is already migrated and described.');
    return result;
  }

  if (hasMigrationWork) {
    if (client.autocommitOff) {
      result.ok = false;
      result.error = '--apply refused: NB_GIT_AUTOCOMMIT=0 is set, so `nb move` would not commit and the migration could not be rolled back move by move. Unset it and re-run.';
      log(`\n${result.error}`);
      return result;
    }
    if (!isStoreGitRepo(dir)) {
      result.ok = false;
      result.error = `--apply refused: ${dir} is not a git repository, so there is no rollback anchor and the moves would not be committed. Run \`git init\` there (and commit) first.`;
      log(`\n${result.error}`);
      return result;
    }
    const tagged = tagStore(dir, tag);
    if (!tagged.ok) {
      result.ok = false;
      result.error = `--apply refused: could not tag the store (${tagged.error}).`;
      log(`\n${result.error}`);
      return result;
    }
    log(
      `\nTagged the store: ${tag}${tagged.created ? '' : ' (already existed: kept, this is a resumed run)'}${tagged.snapshotCommitted ? ' (uncommitted changes were committed first)' : ''}.`,
    );
  }

  // The moves: each one re-reads the two shelves it touches.
  const working = cloneStore(snapshot.store);
  let moved = 0;
  for (const step of plan.steps) {
    if (moved >= stopAfter) break;
    refreshShelves(client, dir, working, [step.from, step.to]);
    const d = decideStep(working, step, { cap, forceLow, baselines: applyBars });
    const label = `${step.from} ${step.id} -> ${step.to}`;
    if (d.action === 'skip') {
      if (d.reason === 'already-moved') {
        log(`  already moved   ${label}`);
        continue;
      }
      result.skipped.push({ ...step, reason: d.reason });
      log(`  SKIP ${d.reason.padEnd(10)} ${label}`);
      continue;
    }
    const headBefore = client.expectsCommits ? headSha(dir) : null;
    const r = nbMove(client, step.from, step.to, step.id, { note: 'slug migration' });
    if (r.reason === 'error') {
      result.ok = false;
      result.error = `nb move failed for ${label}: ${r.error}. Fix the cause and re-run; finished moves are kept (resumable).`;
      log(`  FAILED          ${label}: ${r.error}`);
      break;
    }
    if (!r.moved) {
      // Anything but reason "moved" (a refused duplicate that appeared since the
      // re-read) is a skip; the lesson is still on its legacy shelf.
      result.skipped.push({ ...step, reason: r.reason });
      log(`  SKIP ${String(r.reason).padEnd(10)} ${label}`);
      continue;
    }
    moved++;
    noteMoved(applyBars, step.id, step.score);
    result.performed.push({ ...step, evicted: r.evicted });
    if (client.expectsCommits && headSha(dir) === headBefore) {
      result.ok = false;
      result.error = `nb moved ${label}, but the store got no commit (a failing git hook, a stale index.lock, or no git identity?). The change is in the working tree only, so the rollback tag would not cover it. Fix the cause and re-run; nothing further was moved.`;
      log(`  FAILED          ${result.error}`);
      return result;
    }
    const predictedEvicted = d.prediction.evicted?.id ?? null;
    const actualEvicted = r.evicted ? entryId(r.evicted.text) : null;
    if (predictedEvicted !== actualEvicted) {
      const msg = `moved ${label}, but nb evicted ${actualEvicted ?? 'nothing'} where ${predictedEvicted ?? 'nothing'} was predicted (the shelf changed under us?)`;
      result.warnings.push(msg);
      log(`  WARNING         ${msg}`);
    }
    log(`  moved           ${label}${r.evicted ? `   (evicted ${actualEvicted ?? 'a lesson'})` : ''}`);
  }
  if (!result.ok) return result;
  if (moved >= stopAfter) {
    log(`\nStopped after ${moved} move(s) (test hook).`);
    return result;
  }

  // Reap the 0-byte leftovers of emptied legacy shelves.
  const afterMoves = snapshotStore(client);
  const candidates = new Set([...legacyNames, ...afterMoves.zeroByte.filter((n) => isLegacyShelf(n, aliases))]);
  for (const shelf of [...candidates].sort()) {
    const outcome = reapZeroByteShelf(dir, shelf);
    if (outcome === 'locked') log(`  NOT reaped      ${shelf}: nb's store lock stayed busy (is a task running?); re-run later`);
    if (outcome === 'deleted') {
      const committed = commitPaths(dir, [`${shelf}.md`], `slug migration: delete empty legacy shelf ${shelf}`);
      result.reaped.push(shelf);
      if (committed === 'failed') {
        result.ok = false;
        result.error = `deleted the empty file ${shelf}.md but git could not commit the deletion; commit it by hand (git -C "${dir}" add -A && git commit) and re-run`;
        log(`  FAILED          ${result.error}`);
        return result;
      }
      log(`  reaped          ${shelf} (0-byte file deleted and committed)`);
    }
  }

  if (stopAfterStage === 'reap') {
    log('\nStopped after the reap stage (test hook).');
    return result;
  }

  // Describe the canonical shelves of the migrated repo(s). The scope is "project
  // shelves whose slug is an alias target", so a fresh run and a resumed run
  // touch exactly the same shelves, and unrelated seed entries are left to the
  // seed script.
  if (manifestShelves) {
    const full = buildSeed({ dir, manifestShelves, aliases });
    const seed = Object.fromEntries(Object.entries(full).filter(([name]) => scope(name)));
    const r = applyDescriptions({
      dir,
      shelves: seed,
      aliases,
      describe: (shelf, text) => {
        const before = client.expectsCommits ? headSha(dir) : null;
        const out = client.run(['describe', shelf, text]);
        if (out.status !== 0) throw new Error(out.stderr || `nb describe exited ${out.status}`);
        if (client.expectsCommits && headSha(dir) === before) throw new Error('the description was written but not committed (git hook, lock or identity problem)');
      },
      log: (line) => {
        if (/^\s+(described|FAILED)/.test(line)) log(line);
      },
    });
    log(`  description seed re-run: described ${r.described}, failed ${r.failed.length}`);
    if (r.failed.length) {
      result.ok = false;
      result.error = `description seed failed for: ${r.failed.join(', ')}`;
    }
  }

  // Confirm.
  const finalSnap = snapshotStore(client);
  for (const shelf of legacyNames) {
    const onDisk = listedOrOnDisk(finalSnap, shelf, dir);
    if (onDisk) result.remaining.push({ shelf, lessons: (finalSnap.store.get(shelf) ?? []).length, reason: onDisk });
  }
  if (result.remaining.length === 0) {
    log(`\nDone: all ${legacyNames.length} legacy shelves are gone from disk and from nb list --json.`);
  } else {
    result.ok = false;
    log('\nDone with items left for a manual decision. Legacy shelves still present:');
    for (const r of result.remaining) log(`  ${r.shelf}: ${r.lessons} lesson(s) (${r.reason})`);
  }
  return result;
}

/** Project shelves whose slug is the canonical target of an alias: the ones this migration is responsible for describing. */
function inDescriptionScope(name, aliases) {
  const targets = new Set([...aliases.values()].map(normalizeSlug));
  const cls = classifyShelf(name, aliases);
  return cls.layer === 'project' && !cls.legacy && targets.has(cls.canonical);
}

function isLegacyShelf(name, aliases) {
  const cls = classifyShelf(name, aliases);
  return cls.layer === 'project' && cls.legacy;
}

/** Why a legacy shelf is still around: it is still listed by `nb list` (it holds lessons, or is an emptied shelf that kept a description), a 0-byte file is still on disk, or null when it is gone. */
function listedOrOnDisk(snap, shelf, dir) {
  if (snap.store.has(shelf)) return 'listed by nb list';
  // "Gone" means absent on disk too: a hidden file (0 bytes, or only metadata) still counts.
  const file = join(dir, `${shelf}.md`);
  if (existsSync(file)) return statSync(file).size === 0 ? '0-byte file still on disk' : 'file still on disk (hidden from nb list)';
  return null;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/migrate-notebook-slugs.mjs [--apply] [--force-low] [--map <slug-aliases.json>]\n' +
        '         [--manifest <shelves.json>] [--nb <nb path>] [--tag <name>]\n' +
        'Dry-run by default. --apply tags the store git repo, then moves lessons. Rollback: with no agent commits\n' +
        'in <tag>..HEAD, `git revert --no-edit <tag>..HEAD` in the store; otherwise revert only this script\'s commits\n' +
        '(`nb move`, `nb describe`, `slug migration:`), newest first. It may need manual conflict resolution;\n' +
        'never `git reset --hard`. Run it while no tasks are running.',
    );
    return 0;
  }
  const flagProblem =
    checkArgv(argv, {
      switches: ['--apply', '--force-low', '--help', '-h'],
      values: ['--map', '--manifest', '--nb', '--tag'],
    }) ?? blankNbDir();
  if (flagProblem) {
    console.error(`migrate-notebook-slugs: ${flagProblem}. Nothing was changed.`);
    return 2;
  }
  let aliases;
  let manifestShelves;
  try {
    aliases = loadSlugAliases(arg(argv, '--map'), { strict: arg(argv, '--map') !== undefined });
    const manifestPath = arg(argv, '--manifest') ?? join(REPO_ROOT, 'plugin', 'notebooks', 'shelves.json');
    manifestShelves = JSON.parse(readFileSync(manifestPath, 'utf-8')).shelves ?? {};
  } catch (err) {
    console.error(`migrate-notebook-slugs: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
    return 2;
  }
  const client = createNbClient({ nb: arg(argv, '--nb') });
  let result;
  try {
    result = runMigration({
      client,
      aliases,
      manifestShelves,
      apply: argv.includes('--apply'),
      forceLow: argv.includes('--force-low'),
      tag: arg(argv, '--tag') ?? DEFAULT_TAG,
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`migrate-notebook-slugs: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (result.error && !result.ok) return result.error.startsWith('--apply refused') ? 2 : 1;
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
