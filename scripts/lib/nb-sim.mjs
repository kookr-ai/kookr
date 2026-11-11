// nb-sim — a pure, in-memory model of what `nb move` and `nb rm` do to shelves,
// so the migration and promotion scripts can show (and re-check) the outcome of
// each step BEFORE running it.
//
// Why a model at all. `nb move <from> <to> <id>` keeps the lesson's score and
// always admits it. When the target shelf is full (NB_MAX_LINES, default 50) `nb`
// makes room by (1) evicting the LOWEST-scored line of the target (ties: the
// stalest, i.e. earliest in the file), and (2) docking one point from the
// stalest surviving line. So moving a weak lesson into a full shelf can throw away
// a better one. This module copies those rules from agent-notebook 0.7.0
// (`dist/notebook.js` `enforceCap` and `move`); the test file replays random
// stores through the REAL `nb` binary and asserts the model agrees, so a future
// `nb` that changes the rules fails loudly instead of silently mis-planning.
//
// Data model. A "store" is a Map<shelf name, entry[]>; each entry is
// `{ id, score, text }` and the array is in FILE ORDER (least-recently-touched
// first). That order matters for tie-breaks and for which line is docked, and
// `nb show --json` does not expose it (it prints highest score first), which is
// why scripts/lib/nb-client.mjs recovers it from the shelf file.
import { createHash } from 'node:crypto';
import { MAX_SHELF_NAME_LENGTH, exceedsShelfNameLimit } from '../../plugin/hooks/lib/notebook-layers.mjs';

const SAFE_SHELF = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Why `nb` would reject `name` as a shelf name (mirrors `assertSafeShelf`), or
 * `null` when it is acceptable. A move into a rejected name fails with
 * `bad_args`, so the scripts report it before starting instead of mid-run.
 */
export function shelfNameProblem(name) {
  if (exceedsShelfNameLimit(name)) {
    return `too long: ${name.length} chars, max ${MAX_SHELF_NAME_LENGTH}`;
  }
  if (!SAFE_SHELF.test(name) || name.includes('..')) {
    return 'invalid characters (allowed: letters, digits, . _ @ -)';
  }
  if (name.toLowerCase() === 'readme') return 'reserved name';
  if (WINDOWS_DEVICE.test(name.split('.')[0])) return 'reserved Windows device name';
  return null;
}

/** `nb`'s per-shelf line cap (`NB_MAX_LINES`, clamped to 1..5000, default 50). */
export function maxLines(env = process.env) {
  const n = Number.parseInt(env.NB_MAX_LINES ?? '', 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(5000, Math.max(1, n));
}

/** `nb`'s duplicate key: lower-case, punctuation to space, whitespace collapsed. */
export function dedupKey(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `nb`'s stable 6-hex lesson id (sha1 of the dedup key). */
export function entryId(text) {
  return createHash('sha1').update(dedupKey(text)).digest('hex').slice(0, 6);
}

/**
 * Our own "exact" equality for promotion: trim, collapse whitespace, case-fold.
 * Stricter than `dedupKey` (punctuation counts), so two lessons that differ only
 * in punctuation are NOT an exact pair here, even though `nb` would refuse to
 * hold both in one shelf.
 */
export function exactKey(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Deep-enough copy of a store so a plan can be simulated without touching the real snapshot. */
export function cloneStore(store) {
  const copy = new Map();
  for (const [shelf, entries] of store) copy.set(shelf, entries.map((e) => ({ ...e })));
  return copy;
}

/**
 * For every shelf that is full in `store`, its lowest score. Taken once at the
 * start of a run and passed to {@link decideStep} as the bar a mover must clear.
 */
export function fullShelfFloors(store, cap = maxLines()) {
  const floors = new Map();
  for (const [shelf, entries] of store) {
    if (entries.length >= cap) floors.set(shelf, minScore(entries));
  }
  return floors;
}

/** The lowest score on a shelf, or `undefined` when it is empty. */
export function minScore(entries) {
  return entries.length === 0 ? undefined : Math.min(...entries.map((e) => e.score));
}

/**
 * What `nb`'s `enforceCap(entries, 1)` does when a newcomer is appended to a
 * shelf. `entries` is the target BEFORE the newcomer. Returns the evicted entry
 * (or null) and the entry that was docked one point (or null).
 */
function admit(entries, newcomer, cap) {
  const all = [...entries.map((e) => ({ ...e })), newcomer];
  if (all.length <= cap) return { kept: all, evicted: null, evictedAll: [], docked: null };
  const protectedStart = all.length - 1; // the newcomer is never evicted
  const order = all
    .map((_, i) => i)
    .sort((a, b) => (a >= protectedStart ? 1 : 0) - (b >= protectedStart ? 1 : 0) || all[a].score - all[b].score || a - b);
  const drop = new Set(order.slice(0, all.length - cap));
  const kept = [];
  const keptIdx = [];
  const evicted = [];
  all.forEach((e, i) => {
    if (drop.has(i)) evicted.push(e);
    else {
      kept.push(e);
      keptIdx.push(i);
    }
  });
  const pos = keptIdx.findIndex((i) => i < protectedStart);
  let docked = null;
  if (pos !== -1) {
    docked = { id: kept[pos].id, text: kept[pos].text, from: kept[pos].score, to: kept[pos].score - 1 };
    kept[pos].score -= 1;
  }
  // `evicted` is the first line dropped (all `nb move --json` reports); a target that
  // is already OVER the cap loses several at once, listed in `evictedAll`.
  return { kept, evicted: evicted[0] ?? null, evictedAll: evicted, docked };
}

/**
 * Predict `nb move <from> <to> <id>` without changing `store`.
 *
 * `outcome` is one of:
 *   'moved'            the lesson would move (`evicted` / `docked` describe the side effects)
 *   'duplicate'        the target already holds the same dedup key; `nb` refuses and writes nothing
 *   'missing'          the id is not on the source shelf (already moved, or never there)
 *   'ambiguous'        two source lessons share the id; `nb` would refuse to pick one
 *   'same-shelf'       source and target are the same shelf
 * Also returned: `entry` (the mover), `targetFull`, `targetMin` (lowest target
 * score before the move, only meaningful when full) and `collidedId`.
 */
export function predictMove(store, from, to, id, cap = maxLines()) {
  if (from === to) return { outcome: 'same-shelf' };
  const source = store.get(from) ?? [];
  const matches = source.filter((e) => e.id === id);
  if (matches.length === 0) return { outcome: 'missing' };
  if (matches.length > 1) return { outcome: 'ambiguous' };
  const entry = matches[0];
  const target = store.get(to) ?? [];
  const key = dedupKey(entry.text);
  const collider = target.find((e) => dedupKey(e.text) === key);
  const targetFull = target.length >= cap;
  const targetMin = minScore(target);
  if (collider) return { outcome: 'duplicate', entry, collidedId: collider.id, targetFull, targetMin };
  const { evicted, evictedAll, docked } = admit(target, { ...entry }, cap);
  return { outcome: 'moved', entry, evicted, evictedAll, docked, targetFull, targetMin };
}

/** Apply a move to `store` in place (the same rules as {@link predictMove}). Returns the prediction. */
export function applyMove(store, from, to, id, cap = maxLines()) {
  const p = predictMove(store, from, to, id, cap);
  if (p.outcome !== 'moved') return p;
  const target = store.get(to) ?? [];
  const { kept } = admit(target, { ...p.entry }, cap);
  store.set(to, kept);
  store.set(
    from,
    (store.get(from) ?? []).filter((e) => e.id !== id),
  );
  return p;
}

/** Remove a lesson (what `nb rm` does). Returns the removed entry or null. */
export function applyRemove(store, shelf, id) {
  const entries = store.get(shelf) ?? [];
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const [gone] = entries.splice(idx, 1);
  store.set(shelf, entries);
  return gone;
}

/**
 * Decide one move against `store` WITHOUT changing it. `action` is 'move' or
 * 'skip'; a skip carries a `reason`:
 *   'already-moved'  the lesson is no longer on the source shelf
 *   'duplicate'      the target already holds it (nb would refuse)
 *   'low-score'      the target is FULL and the lesson does not score STRICTLY
 *                    above the target's lowest lesson. Moving it would evict a
 *                    lesson that is no worse (a pure loss), and a batch of equal
 *                    scores would push each other out one by one, so equal is
 *                    refused too. The rule depends only on the store, so a
 *                    re-run decides the same way.
 *   'over-cap'       the target already holds more than the cap, so the move
 *                    would evict several lessons at once (`nb move --json`
 *                    reports only the first)
 *   'ambiguous'      the id is not unique on the source shelf
 * `floors` maps shelf -> the lowest score it had at the start of the run, for
 * shelves that were full then (see {@link fullShelfFloors}).
 * `--force-low` (`forceLow`) overrides 'low-score' and 'over-cap' only.
 * Used by the dry-run (on a cloned snapshot, advanced one move at a time) and by
 * --apply (on a fresh re-read of just the two shelves), so both apply the same
 * rules.
 */
export function decideStep(store, step, { cap = maxLines(), forceLow = false, floors = new Map() } = {}) {
  const p = predictMove(store, step.from, step.to, step.id, cap);
  switch (p.outcome) {
    case 'missing':
      return { action: 'skip', reason: 'already-moved', prediction: p };
    case 'ambiguous':
    case 'same-shelf':
      return { action: 'skip', reason: 'ambiguous', prediction: p };
    case 'duplicate':
      return { action: 'skip', reason: 'duplicate', prediction: p };
    default:
      if (p.evictedAll.length > 1 && !forceLow) {
        return { action: 'skip', reason: 'over-cap', prediction: p };
      }
      // The bar is the target's lowest lesson now, or the lowest it had when the run
      // started if that was higher: the one-point aging that earlier moves cause
      // must not lower the bar and let equal-scored lessons in afterwards.
      if (p.targetFull && p.entry.score <= Math.max(p.targetMin, floors.get(step.to) ?? -Infinity) && !forceLow) {
        return { action: 'skip', reason: 'low-score', prediction: p };
      }
      return { action: 'move', reason: null, prediction: p };
  }
}
