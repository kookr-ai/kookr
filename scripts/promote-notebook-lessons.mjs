#!/usr/bin/env node
// promote-notebook-lessons — find lessons that several repos' project shelves
// share, and (only on request) move them up a memory layer
// (RFC docs/rfc/rfc-notebook-memory-layers.md, D5; issue #3591).
//
// Background. Memory is layered project > domain > global. A project shelf
// `base@slug` holds facts true in one repo; the bare domain shelf `base` holds
// lessons that are true in any repo; `fleet-global` holds host-wide facts. A
// lesson sitting in several repos' `base@*` shelves is evidence it is not
// project-specific. Promotion is `nb move` (which keeps the lesson's score).
//
// DRY-RUN BY DEFAULT: prints a report. `--apply` tags the store's git repo
// (`pre-lesson-promotion-<time>`) and then acts. Two tiers, with deliberately different
// powers:
//
//   EXACT group  the same text after trimming, collapsing whitespace and
//                case-folding, in project shelves of two or more DIFFERENT repos
//                (slugs are resolved through slug-aliases.json first, so a copy
//                under `@agent-notebook` and one under `@jeanibarz-agent-notebook`
//                count as ONE repo and are never a cross-project promotion).
//                `--apply` moves the highest-scored copy to the domain shelf and
//                then runs `nb rm <copy> --reason obsolete --note duplicate` on
//                each other copy, only after that move succeeded.
//   CANDIDATE    a paraphrase: word overlap (Jaccard over word sets) at or above
//   group        --threshold (default 0.6; printed). REPORT ONLY by default.
//                `--apply --only <group-id,...>` moves the highest-scored copy
//                up and removes NOTHING. Fuzzy matching must never delete: a
//                lesson and its negation can score as near-identical, and a
//                lesson that exists in one copy only would be lost. The other
//                copies stay in their project shelves (project wins on conflict)
//                until a person removes them.
//
// Where a lesson goes. Always the bare domain shelf `base`, unless the reviewer
// names the group in `--to-global <group-id,...>` (then `fleet-global`). Nothing
// is ever sent to `fleet-global` by default, and this script cannot populate it
// unattended: on today's store it finds 0 exact groups, so the first pass yields
// candidates a person chooses from.
//
// Safety shared with the slug migration (see scripts/lib/nb-sim.mjs):
//   * Each move is simulated one at a time. When the target shelf is full, `nb`
//     drops the target's lowest-scored lesson to admit the moved one, and lowers
//     the score of the lesson touched least recently by one point ("aging"); the
//     plan shows both.
//   * Moving a lesson that does not score strictly above a FULL target's lowest
//     lesson is refused unless --force-low (an equal swap is a pure loss); so is
//     a move into a target already over the cap, which would evict several.
//   * A move `nb` would refuse because the target already holds the lesson is
//     predicted and skipped, and that group's other copies are NOT removed.
//   * Results are read from `nb move --json` (`reason` must be "moved"), never
//     from the exit code.
//   * Every `nb rm` comes after its move, and only once a re-read shows the
//     destination really holds the lesson. All moves run first and the removals
//     after them, so a later move that pushes an earlier one out of a full shelf
//     cannot cost the only copy.
//   * Groups are applied highest-scored first.
//   * Each `--apply` step re-reads the shelves it touches, so an interrupted run
//     is resumable and a second run is a no-op. If a run stops between an exact
//     group's move and its removals, the leftover project copies are listed as
//     "PROJECT COPIES of a lesson the domain shelf already holds" with the `nb rm`
//     to run by hand; they are never removed on the strength of a different run.
//
// ROLLBACK. `--apply` tags the store with a fresh `pre-lesson-promotion-<UTC time>`
// anchor each run (an explicit --tag that already exists is kept). Every move and
// removal is its own commit (the bin/nb.js shim commits each mutation; `--apply`
// refuses to run with NB_GIT_AUTOCOMMIT=0). Run it while no tasks are running:
// agents' own `nb add`/`nb vote` commits share the history. If `git log <tag>..HEAD`
// shows only this script's commits, `git revert --no-edit <tag>..HEAD` undoes the
// run; otherwise revert only the commits whose subject starts `nb move` or `nb rm`,
// newest first. Never `git reset --hard`; a revert can conflict on a shelf an agent
// touched afterwards, which you resolve by hand keeping both sides' lessons.
//
// Usage: node scripts/promote-notebook-lessons.mjs [--apply] [--only <ids>]
//          [--to-global <ids>] [--threshold <0..1>] [--force-low]
//          [--map <slug-aliases.json>] [--nb <nb path>] [--tag <name>]
// Environment: NB_DIR selects the store (as for `nb`); NB_MAX_LINES is honored.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GLOBAL_SHELF, classifyShelf, loadSlugAliases } from '../plugin/hooks/lib/notebook-layers.mjs';
import {
  createNbClient,
  isStoreGitRepo,
  checkArgv,
  moveCommand,
  nbMove,
  nbRemoveDuplicate,
  reapZeroByteShelf,
  commitPaths,
  refreshShelves,
  removeCommand,
  snapshotStore,
  tagStore,
} from './lib/nb-client.mjs';
import { applyMove, applyRemove, cloneStore, decideStep, entryId, exactKey, maxLines, shelfNameProblem } from './lib/nb-sim.mjs';

export const DEFAULT_TAG = 'pre-lesson-promotion';
export const DEFAULT_THRESHOLD = 0.6;

const clip = (text, n = 110) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const fmtScore = (n) => (n >= 0 ? `+${n}` : `${n}`);
const hash6 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 6);

/** Distinct words (lower-case letters and digits, 3+ characters) of a lesson. */
export function tokenSet(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

/** Jaccard overlap of two word sets: |A and B| / |A or B|, 0 when both are empty. */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Highest score first; ties by shelf name then id, so the choice is deterministic. */
const byBest = (a, b) => b.score - a.score || (a.shelf < b.shelf ? -1 : a.shelf > b.shelf ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Find exact and candidate groups in a store (pure).
 *
 * Only project shelves count. Lessons are grouped per `base` (the part before
 * the LAST `@`), and a group needs lessons from at least two different
 * canonical slugs. Returns `{ groups, covered, stats }`: `groups` are
 * actionable; `covered` are candidate groups whose lesson is already (nearly)
 * held by the bare domain shelf or `fleet-global`, so a repeat run does not
 * offer them again.
 */
export function findGroups({ store, aliases, threshold = DEFAULT_THRESHOLD }) {
  const byBase = new Map();
  let projectLessons = 0;
  let projectShelves = 0;
  const skippedShelves = [];
  for (const [shelf, entries] of store) {
    const cls = classifyShelf(shelf, aliases);
    if (cls.layer === 'malformed') {
      skippedShelves.push(shelf);
      continue;
    }
    if (cls.layer !== 'project') continue;
    projectShelves++;
    for (const e of entries) {
      projectLessons++;
      const item = { shelf, slug: cls.canonical, base: cls.base, id: e.id, score: e.score, text: e.text };
      if (!byBase.has(cls.base)) byBase.set(cls.base, []);
      byBase.get(cls.base).push(item);
    }
  }

  const groups = [];
  const covered = [];
  for (const [base, items] of [...byBase].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Exact tier.
    const byKey = new Map();
    for (const it of items) {
      const k = exactKey(it.text);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }
    const inExact = new Set();
    for (const [key, members] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (new Set(members.map((m) => m.slug)).size < 2) continue;
      members.sort(byBest);
      members.forEach((m) => inExact.add(m));
      groups.push({ id: `e-${hash6(`${base}\0${key}`)}`, tier: 'exact', base, members, best: members[0], similarity: 1 });
    }

    // Candidate tier: one star per anchor, at most one lesson per other repo.
    const pool = items.filter((it) => !inExact.has(it)).sort(byBest);
    const tokens = new Map(pool.map((it) => [it, tokenSet(it.text)]));
    const taken = new Set();
    const domainTexts = [...(store.get(base) ?? []), ...(store.get(GLOBAL_SHELF) ?? [])];
    const domainTokens = domainTexts.map((e) => tokenSet(e.text));
    for (const anchor of pool) {
      if (taken.has(anchor)) continue;
      const perSlug = new Map();
      for (const other of pool) {
        if (other === anchor || taken.has(other) || other.slug === anchor.slug) continue;
        const sim = jaccard(tokens.get(anchor), tokens.get(other));
        if (sim < threshold) continue;
        const cur = perSlug.get(other.slug);
        if (!cur || sim > cur.sim) perSlug.set(other.slug, { other, sim });
      }
      if (perSlug.size === 0) continue;
      const picked = [...perSlug.values()].sort((a, b) => b.sim - a.sim || byBest(a.other, b.other));
      const members = [anchor, ...picked.map((p) => p.other)];
      members.forEach((m) => taken.add(m));
      members.sort(byBest);
      const group = {
        id: `c-${hash6(`${base}\0${anchor.id}`)}`,
        tier: 'candidate',
        base,
        members,
        best: members[0],
        similarity: Math.min(...picked.map((p) => p.sim)),
      };
      const holder = domainTexts.find((_, i) => members.some((m) => jaccard(tokens.get(m) ?? tokenSet(m.text), domainTokens[i]) >= threshold));
      if (holder) covered.push({ ...group, coveredBy: holder });
      else groups.push(group);
    }
  }

  // Project copies of a lesson the domain shelf (or fleet-global) already holds
  // verbatim. After a promotion that was interrupted between its move and its
  // removals these are the leftover copies. Never removed automatically: a person
  // decides (the commands are printed).
  const leftovers = [];
  for (const [base, items] of byBase) {
    const holders = new Map();
    for (const shelf of [base, GLOBAL_SHELF]) {
      for (const e of store.get(shelf) ?? []) holders.set(exactKey(e.text), shelf);
    }
    for (const it of items) {
      const heldIn = holders.get(exactKey(it.text));
      if (heldIn) leftovers.push({ ...it, heldIn });
    }
  }
  leftovers.sort((a, b) => (a.shelf < b.shelf ? -1 : a.shelf > b.shelf ? 1 : a.id < b.id ? -1 : 1));
  return { groups, covered, leftovers, stats: { projectLessons, projectShelves, skippedShelves } };
}

/**
 * Where a group's best copy goes: the bare domain shelf `base`, or
 * `fleet-global` for a group the reviewer named. A `base` that itself contains
 * `@` (`a@b@c` has base `a@b`) is not a valid domain shelf name, so it has no
 * destination and is reported instead of guessed.
 */
export function destinationFor(group, toGlobal) {
  if (toGlobal.has(group.id)) return { shelf: GLOBAL_SHELF, problem: null };
  const cls = classifyShelf(group.base);
  if (cls.layer !== 'domain') {
    const why = cls.layer === 'global' ? 'it is the global shelf' : 'it contains "@"';
    return { shelf: group.base, problem: `base "${group.base}" is not a bare domain shelf name (${why})` };
  }
  const bad = shelfNameProblem(group.base);
  return { shelf: group.base, problem: bad };
}

/**
 * Build the step list for the groups an `--apply` would act on, simulating them
 * in order against `store` (mutated). `selected` is a Set of group ids.
 */
export function planPromotion({ groups, selected, toGlobal, store, cap = maxLines(), forceLow = false }) {
  const steps = [];
  // Highest-scored groups first, so a strong lesson is admitted before weaker ones can crowd a full shelf.
  const ordered = [...groups].sort((a, b) => b.best.score - a.best.score || (a.id < b.id ? -1 : 1));
  for (const group of ordered) {
    const dest = destinationFor(group, toGlobal);
    const chosen = selected.has(group.id);
    const step = {
      group,
      from: group.best.shelf,
      to: dest.shelf,
      id: group.best.id,
      score: group.best.score,
      text: group.best.text,
      selected: chosen,
      removes: group.tier === 'exact' ? group.members.filter((m) => m !== group.best) : [],
    };
    if (dest.problem) {
      step.decision = { action: 'skip', reason: 'bad-destination', detail: dest.problem, prediction: {} };
    } else {
      step.decision = decideStep(store, step, { cap, forceLow });
      if (chosen && step.decision.action === 'move') {
        applyMove(store, step.from, step.to, step.id, cap);
        // An exact group's other copies go only after the move; model it so
        // later steps see the shelves as they will be.
        for (const m of step.removes) applyRemove(store, m.shelf, m.id);
      }
    }
    steps.push(step);
  }
  return steps;
}

function parseIdList(raw) {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Print the report (dry-run, and the top of --apply). */
export function printReport({ snapshot, found, steps, cap, threshold, toGlobal, only, log }) {
  const { groups, covered, stats } = found;
  const exact = groups.filter((g) => g.tier === 'exact');
  const cand = groups.filter((g) => g.tier === 'candidate');
  log(`Store: ${snapshot.dir}   cap: ${cap} lessons per shelf   candidate threshold: ${threshold} (word-set Jaccard)`);
  log(`Scanned ${stats.projectLessons} lessons in ${stats.projectShelves} project shelves (slugs resolved through the alias map).`);
  log(`Exact groups: ${exact.length}   Candidate groups: ${cand.length}${covered.length ? `   (${covered.length} more already covered by a domain/global lesson, not offered)` : ''}`);
  for (const s of stats.skippedShelves) log(`  ignored malformed shelf name: ${s}`);
  if (snapshot.approximateOrder.length > 0) {
    log(`Note: file order could not be confirmed for ${snapshot.approximateOrder.join(', ')}; eviction ties and aging there are approximate.`);
  }
  if (exact.length === 0) {
    log('No exact groups: nothing is removable. A person chooses from the candidates below; fleet-global is never filled automatically.');
  }

  const show = (step) => {
    const g = step.group;
    const mark = step.selected ? '*' : ' ';
    const repos = new Set(g.members.map((m) => m.slug)).size;
    log(`\n${mark} [${g.id}] ${g.tier.toUpperCase()} base=${g.base}  ${g.members.length} copies in ${repos} repos${g.tier === 'candidate' ? `  min similarity ${g.similarity.toFixed(2)}` : ''}${toGlobal.has(g.id) ? '  -> fleet-global (reviewer flag)' : ''}`);
    for (const m of g.members) {
      log(`    ${m === g.best ? 'BEST ' : '     '}${m.shelf}  ${fmtScore(m.score)}  ${m.id}  ${clip(m.text)}`);
    }
    const d = step.decision;
    if (d.action === 'move') {
      log(`    plan: ${moveCommand(step.from, step.to, step.id)}`);
      for (const ev of d.prediction.evictedAll) log(`          target full: evicts ${ev.id} (${fmtScore(ev.score)}) ${clip(ev.text, 60)}`);
      if (d.prediction.docked) log(`          and docks ${d.prediction.docked.id} ${fmtScore(d.prediction.docked.from)} -> ${fmtScore(d.prediction.docked.to)}`);
      if (g.tier === 'exact') {
        for (const m of step.removes) log(`          then: ${removeCommand(m.shelf, m.id)}`);
      } else {
        log('          removes nothing; the other copies stay until a person removes them');
      }
    } else if (d.reason === 'duplicate') {
      log(`    SKIP: ${step.to} already holds this lesson (${d.prediction.collidedId}); nb would refuse ("skipped", exit 0). Nothing is removed; decide by hand.`);
    } else if (d.reason === 'low-score') {
      log(`    SKIP: ${fmtScore(step.score)} does not score above the full target's lowest lesson (${fmtScore(d.prediction.targetMin)}); it would evict a lesson that is no worse. --force-low overrides.`);
    } else if (d.reason === 'over-cap') {
      log(`    SKIP: ${step.to} already holds more than ${cap} lessons, so this move would evict ${d.prediction.evictedAll.length} of them at once. --force-low overrides.`);
    } else if (d.reason === 'bad-destination') {
      log(`    SKIP: ${d.detail}`);
    } else {
      log(`    SKIP: ${d.reason}`);
    }
  };
  if (exact.length) log('\nEXACT groups (an --apply moves the best copy, then removes the other copies):');
  steps.filter((s) => s.group.tier === 'exact').forEach(show);
  if (cand.length) {
    log('\nCANDIDATE groups (report only; read both texts, a lesson and its negation can look alike):');
    steps.filter((s) => s.group.tier === 'candidate').forEach(show);
  }
  if (found.leftovers.length > 0) {
    log(`\nPROJECT COPIES of a lesson the domain shelf or fleet-global already holds word for word (${found.leftovers.length}); not removed automatically (e.g. a promotion that stopped before its removals). Remove by hand if you agree:`);
    for (const l of found.leftovers) log(`    ${removeCommand(l.shelf, l.id)}   (held in ${l.heldIn}) ${clip(l.text, 70)}`);
  }
  log(`\n${only ? `* = chosen with --only (${[...only].join(', ')})` : '* = what a plain --apply would act on (exact groups only)'}`);
}

/**
 * Run promotion. Returns `{ ok, steps, performed, skipped, removed, warnings, error }`.
 */
export function runPromotion({
  client,
  aliases,
  apply = false,
  only = null,
  toGlobal = new Set(),
  threshold = DEFAULT_THRESHOLD,
  forceLow = false,
  tag = null,
  cap = maxLines(),
  log = () => {},
}) {
  const snapshot = snapshotStore(client);
  const found = findGroups({ store: snapshot.store, aliases, threshold });
  const known = new Map(found.groups.map((g) => [g.id, g]));

  // Validate the reviewer's ids. An id that is no longer found is not necessarily
  // a typo: after a partial --apply the groups already promoted are gone (or now
  // "covered"), and re-running the same command must finish the rest. So unknown
  // ids are warned about, and it is an error only when NONE of --only is known.
  const unknown = [...new Set([...(only ?? []), ...toGlobal].filter((id) => !known.has(id)))];
  const coveredIds = new Set(found.covered.map((g) => g.id));
  for (const id of unknown) {
    log(`Note: group ${id} was not found${coveredIds.has(id) ? ' (its lesson is already covered by a domain/global lesson)' : ' (already applied, or a typo)'}; skipping it.`);
  }
  if (only && only.size > 0 && [...only].every((id) => !known.has(id))) {
    // Every named group is gone: either this exact command already ran to the end
    // (a re-run must be a harmless no-op) or the ids were mistyped. Say which
    // groups do exist so a typo is obvious, and change nothing.
    const knownList = [...known.keys()].join(', ') || 'none';
    const note = `None of the --only group ids exist (${[...only].join(', ')}). Nothing to apply. Groups found now: ${knownList}.`;
    log(note);
    return { ok: true, nothing: true, note, steps: [], performed: [], skipped: [], removed: [], warnings: [], error: null };
  }
  const selected = new Set(only ? [...only].filter((id) => known.has(id)) : found.groups.filter((g) => g.tier === 'exact').map((g) => g.id));
  const stray = [...toGlobal].filter((id) => known.has(id) && !selected.has(id));
  if (stray.length > 0) {
    const error = `--to-global names ${stray.join(', ')} but ${only ? 'it is not in --only' : 'candidate groups are applied only through --only'}.`;
    log(error);
    return { ok: false, error, usage: true, steps: [], performed: [], skipped: [], removed: [], warnings: [] };
  }

  const sim = cloneStore(snapshot.store);
  const steps = planPromotion({ groups: found.groups, selected, toGlobal, store: sim, cap, forceLow });
  printReport({ snapshot, found, steps, cap, threshold, toGlobal, only, log });

  const result = { ok: true, steps, performed: [], skipped: [], removed: [], warnings: [], error: null };
  if (!apply) {
    log('\nDRY RUN: nothing was changed.');
    return result;
  }
  const dir = snapshot.dir;
  if (selected.size === 0) {
    log('\nNothing to apply.');
    return result;
  }
  const refuse = (msg) => {
    result.ok = false;
    result.usage = true;
    result.error = msg;
    log(`\n${msg}`);
    return result;
  };
  if (client.autocommitOff) {
    return refuse('--apply refused: NB_GIT_AUTOCOMMIT=0 is set, so `nb move` would not commit and the promotion could not be rolled back. Unset it and re-run.');
  }
  if (!isStoreGitRepo(dir)) {
    return refuse(`--apply refused: ${dir} is not a git repository, so there is no rollback anchor and the moves would not be committed.`);
  }
  // A fresh anchor per run: promotion is repeated (the playbook offers it every
  // time), and a tag kept from an earlier run would make a rollback undo that
  // run's work too. An explicit --tag that already exists is kept.
  const tagName = tag ?? `${DEFAULT_TAG}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const tagged = tagStore(dir, tagName);
  if (!tagged.ok) return refuse(`--apply refused: could not tag the store (${tagged.error}).`);
  log(`\nTagged the store: ${tagName}${tagged.created ? '' : ' (already existed: kept)'}${tagged.snapshotCommitted ? ' (uncommitted changes were committed first)' : ''}.`);

  // Phase 1: the moves. Removing an exact group's other copies waits for phase 2,
  // because a later move into the same full shelf could push out a lesson that
  // was promoted earlier in this run; a copy may only be removed while the
  // destination demonstrably still holds the lesson.
  const working = cloneStore(snapshot.store);
  const pendingRemovals = [];
  for (const step of steps) {
    if (!step.selected) continue;
    const g = step.group;
    const label = `[${g.id}] ${step.from} ${step.id} -> ${step.to}`;
    if (step.decision.reason === 'bad-destination') {
      result.skipped.push({ id: g.id, reason: 'bad-destination' });
      log(`  SKIP bad-destination ${label}: ${step.decision.detail}`);
      continue;
    }
    refreshShelves(client, dir, working, [step.from, step.to]);
    const d = decideStep(working, step, { cap, forceLow });
    if (d.action === 'skip' && d.reason !== 'already-moved') {
      result.skipped.push({ id: g.id, reason: d.reason });
      log(`  SKIP ${d.reason.padEnd(10)} ${label}`);
      continue;
    }
    if (d.action === 'skip') {
      // Resumed run: the best copy is already gone from its shelf. That alone
      // does NOT prove it was promoted (it could have been evicted or removed by
      // someone else), so phase 2 re-checks the destination before removing.
      log(`  already moved   ${label}`);
    } else {
      const r = nbMove(client, step.from, step.to, step.id, { note: `promotion ${g.id}` });
      if (r.reason === 'error') {
        result.ok = false;
        result.error = `nb move failed for ${label}: ${r.error}. Re-run to resume; finished steps are kept.`;
        log(`  FAILED          ${label}: ${r.error}`);
        return result;
      }
      if (!r.moved) {
        result.skipped.push({ id: g.id, reason: r.reason });
        log(`  SKIP ${String(r.reason).padEnd(10)} ${label}   (copies left in place)`);
        continue;
      }
      result.performed.push({ id: g.id, from: step.from, to: step.to, lesson: step.id });
      const predicted = d.prediction.evicted?.id ?? null;
      const actual = r.evicted ? entryId(r.evicted.text) : null;
      if (predicted !== actual) {
        const msg = `${label}: nb evicted ${actual ?? 'nothing'} where ${predicted ?? 'nothing'} was predicted (the shelf changed under us?)`;
        result.warnings.push(msg);
        log(`  WARNING         ${msg}`);
      }
      log(`  moved           ${label}${r.evicted ? '   (evicted a lesson from the target)' : ''}`);
    }
    if (g.tier === 'exact') pendingRemovals.push(step);
  }

  // Phase 2: remove exact groups' other copies, each only if the destination
  // still holds the lesson right now.
  for (const step of pendingRemovals) {
    const g = step.group;
    const label = `[${g.id}] ${step.to}`;
    refreshShelves(client, dir, working, [step.to]);
    const destHolds = (working.get(step.to) ?? []).some((e) => exactKey(e.text) === exactKey(step.text));
    if (!destHolds) {
      result.skipped.push({ id: g.id, reason: 'destination-lacks-lesson' });
      log(`  NOT REMOVING    ${label} does not hold the lesson (it was not promoted, or a later move pushed it out); the other copies stay`);
      continue;
    }
    for (const m of step.removes) {
      refreshShelves(client, dir, working, [m.shelf]);
      const still = (working.get(m.shelf) ?? []).find((e) => e.id === m.id && exactKey(e.text) === exactKey(m.text));
      if (!still) {
        log(`  already gone    ${m.shelf} ${m.id}`);
        continue;
      }
      const rm = nbRemoveDuplicate(client, m.shelf, m.id);
      if (rm.ok) {
        result.removed.push({ shelf: m.shelf, id: m.id });
        log(`  removed         ${m.shelf} ${m.id}   (duplicate of the promoted copy)`);
      } else {
        result.ok = false;
        result.error = `nb rm failed for ${m.shelf} ${m.id}: ${rm.error}`;
        log(`  FAILED          ${result.error}`);
        return result;
      }
    }
  }
  // nb 0.7.0 leaves a 0-byte file when a move takes a shelf's last lesson. It is
  // hidden from `nb list` but stays on disk; delete exactly such files (size 0,
  // only shelves this run moved a lesson out of) and commit each deletion.
  for (const shelf of [...new Set(result.performed.map((p) => p.from))].sort()) {
    if (reapZeroByteShelf(dir, shelf) === 'deleted') {
      commitPaths(dir, [`${shelf}.md`], `lesson promotion: delete empty shelf ${shelf}`);
      log(`  reaped          ${shelf} (0-byte file deleted and committed)`);
    }
  }

  log(`\nDone: ${result.performed.length} moved, ${result.removed.length} duplicate copies removed, ${result.skipped.length} skipped.`);
  return result;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/promote-notebook-lessons.mjs [--apply] [--only <ids>] [--to-global <ids>]\n' +
        '         [--threshold <0..1>] [--force-low] [--map <slug-aliases.json>] [--nb <nb path>] [--tag <name>]\n' +
        'Dry-run by default. --apply tags the store git repo (a fresh pre-lesson-promotion-<time> tag), moves exact groups and\n' +
        'removes their other copies;\n' +
        '--apply --only <ids> moves the chosen groups (candidates included) and removes nothing for candidates.\n' +
        '--to-global <ids> sends the named groups to fleet-global instead of the domain shelf.',
    );
    return 0;
  }
  const flagProblem = checkArgv(argv, {
    switches: ['--apply', '--force-low', '--help', '-h'],
    values: ['--only', '--to-global', '--threshold', '--map', '--nb', '--tag'],
  });
  if (flagProblem) {
    console.error(`promote-notebook-lessons: ${flagProblem}. Nothing was changed.`);
    return 2;
  }
  const thrRaw = arg(argv, '--threshold');
  const threshold = thrRaw === undefined ? DEFAULT_THRESHOLD : Number(thrRaw);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error('promote-notebook-lessons: --threshold must be a number in (0, 1].');
    return 2;
  }
  const onlyRaw = arg(argv, '--only');
  let result;
  try {
    result = runPromotion({
      client: createNbClient({ nb: arg(argv, '--nb') }),
      aliases: loadSlugAliases(arg(argv, '--map')),
      apply: argv.includes('--apply'),
      only: onlyRaw === undefined ? null : parseIdList(onlyRaw),
      toGlobal: parseIdList(arg(argv, '--to-global')),
      threshold,
      forceLow: argv.includes('--force-low'),
      tag: arg(argv, '--tag') ?? null,
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`promote-notebook-lessons: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!result.ok) return result.usage ? 2 : 1;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
