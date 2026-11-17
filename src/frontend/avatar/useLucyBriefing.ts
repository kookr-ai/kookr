/**
 * Lucy writes first: a briefing in her thread when the operator opens her panel, and again when
 * they come back after being away and something that waits on them has changed.
 *
 * The text, the follow-up requests ("chips") and a signature come ready-made from
 * `GET /api/lucy/briefing`; no model is called. The signature changes only when what waits on the
 * operator changes, and decides whether a briefing would be a repeat:
 *
 *  - The first time the panel is on screen after a page load, she writes it, unless the newest
 *    briefing already in the thread has the same signature and is less than
 *    {@link BRIEFING_FRESH_MS} old (a reload a moment after the last one).
 *  - When the operator returns after {@link OPERATOR_AWAY_MS} or more (`operator-presence.ts`), she
 *    writes it only if the signature differs from the last briefing she gave.
 *
 * The briefing is written, never spoken. It is a `typed-lucy` entry that is `done`, with the chips
 * and the signature stored on it; the thread decides how to show them. When the route answers 404
 * (Lucy's conversation is off) or cannot be reached, nothing is written.
 */
import { useEffect, useRef } from 'react';
import { LUCY_BRIEFING_PATH, type LucyBriefingResponse } from '../../shared/contracts/lucy-briefing.js';
import { appendConversationEntry, getConversationEntries } from '../store/lucy-conversation.js';
import { watchOperatorReturn, type PresenceSources } from './operator-presence.js';

/** A briefing with the same signature as one this recent is not written again when the panel is first shown. */
export const BRIEFING_FRESH_MS = 30 * 60_000;
const MAX_CHIPS = 3;

/** True once the panel has been shown and a briefing was fetched for it, in this page load. */
let offeredThisLoad = false;
/** One fetch at a time: a return and a first showing that coincide give one briefing, not two. */
let inFlight = false;
/** The signature of the last briefing written by this page, for when the thread no longer holds it. */
let lastWrittenSignature: string | null = null;

export type BriefingOccasion = 'opened' | 'returned';

export interface OfferBriefingDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

/** What became of an offer: written, left out as a repeat, or not available. */
export type BriefingOutcome = 'written' | 'repeat' | 'unavailable' | 'busy';

function readBriefing(value: unknown): LucyBriefingResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const { text, chips, signature, at } = value as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim() || typeof signature !== 'string' || !signature) return null;
  const chipList = Array.isArray(chips) ? chips.filter((chip): chip is string => typeof chip === 'string' && chip.trim() !== '').slice(0, MAX_CHIPS) : [];
  return { text: text.trim(), chips: chipList, signature, at: typeof at === 'number' ? at : 0 };
}

async function fetchBriefing(fetcher: typeof fetch): Promise<LucyBriefingResponse | null> {
  try {
    const response = await fetcher(LUCY_BRIEFING_PATH, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return readBriefing(await response.json());
  } catch {
    return null;
  }
}

/** The newest briefing in the thread: its signature and when it was written. */
function newestBriefing(): { signature: string; at: number } | null {
  const entries = getConversationEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === 'typed-lucy' && typeof entry.briefing === 'string') return { signature: entry.briefing, at: entry.at };
  }
  return null;
}

/**
 * The thread entry id of a briefing: its signature and the time of the briefing it follows (0 for
 * the first). Two tabs that see the same thread build the same id for the same briefing, and a
 * briefing that follows a different one never reuses an id, even when its signature has been seen
 * before (what waits on the operator changed and then changed back).
 */
export function briefingEntryId(signature: string, previousBriefingAt: number | undefined): string {
  return `briefing:${signature}:${previousBriefingAt ?? 0}`;
}

/**
 * Fetch the briefing and write it into the thread when the rule for `occasion` says it is not a
 * repeat (see the file header). Never throws.
 */
export async function offerBriefing(occasion: BriefingOccasion, deps: OfferBriefingDeps = {}): Promise<BriefingOutcome> {
  if (inFlight) return 'busy';
  inFlight = true;
  try {
    // Global `fetch` is looked up now, not when this file loads: tests replace it.
    const briefing = await fetchBriefing(deps.fetcher ?? ((input, init) => fetch(input, init)));
    if (!briefing) return 'unavailable';
    if (occasion === 'opened') offeredThisLoad = true;
    const now = deps.now?.() ?? Date.now();
    const last = newestBriefing();
    const repeat = occasion === 'opened'
      ? last !== null && last.signature === briefing.signature && now - last.at < BRIEFING_FRESH_MS
      : (last?.signature ?? lastWrittenSignature) === briefing.signature;
    if (repeat) return 'repeat';
    appendConversationEntry({
      // Tabs that share one thread and decide at the same moment build the same id, so one of them writes.
      id: briefingEntryId(briefing.signature, last?.at),
      kind: 'typed-lucy',
      status: 'done',
      text: briefing.text,
      briefing: briefing.signature,
      ...(briefing.chips.length > 0 ? { chips: briefing.chips } : {}),
      at: now,
    });
    lastWrittenSignature = briefing.signature;
    return 'written';
  } finally {
    inFlight = false;
  }
}

export interface UseLucyBriefingOptions {
  /** The panel is on screen (open, not minimised to its bubble). */
  shown: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Where "the operator is back" comes from; the real page by default. */
  presence?: PresenceSources;
}

/** Mounted by the dock, which stays mounted while the panel is minimised. */
export function useLucyBriefing({ shown, fetcher, now, presence }: UseLucyBriefingOptions): void {
  const latest = useRef({ fetcher, now });
  latest.current = { fetcher, now };

  // The first time the panel is on screen after a page load. A fetch that failed is tried again the next
  // time it is shown. The fetch is not cancelled when the effect is cleaned up: React's development mode
  // runs every effect twice, and the second run finds the first still in flight and leaves it to finish.
  useEffect(() => {
    if (shown && !offeredThisLoad) void offerBriefing('opened', latest.current);
  }, [shown]);

  // The operator is back after being away.
  useEffect(
    () => watchOperatorReturn(() => { void offerBriefing('returned', latest.current); }, presence ? { sources: presence } : {}),
    [presence],
  );
}

export function __resetLucyBriefingForTests(): void {
  offeredThisLoad = false;
  inFlight = false;
  lastWrittenSignature = null;
}
