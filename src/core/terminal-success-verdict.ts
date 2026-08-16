// Terminal-success verdict recognition (issue #2532).
//
// An agent that finishes its work with an unambiguous SUCCESS verdict — the
// motivating case being a Deploy Convergence run that resolves to `converged`
// (see `core/deploy-convergence.ts` `formatConvergenceReceipt`) — but never
// raises `completion-ready` parks in `needs_input` "awaiting input" with no
// question to ask, holding a fleet slot indefinitely. Those are the phantom /
// finishedAwaitingAck slots #2532 targets: a successful terminal outcome that
// never converts to a completed, slot-releasing state.
//
// This is the pure classifier that decides whether an agent's final turn
// message is such a verdict, so the lifecycle can auto-complete it instead of
// parking (see `server/terminal-verdict-completion-sweep.ts`).
//
// Deliberately conservative, with FOUR independent guards (a verdict must clear
// all four):
//   1. No `?` anywhere in the message — an agent asking anything is not done.
//   2. No non-success / negation marker anywhere (see NON_SUCCESS_MARKERS) — so a
//      receipt-shaped line whose body flips the meaning ("Completed — but 2 checks
//      still failing", "converged — NOT safe") is rejected.
//   3. The whole message must be a SINGLE non-empty line — a verdict headline
//      plus a separate question / caveat line (even with no `?`, e.g.
//      "Complete.\nCan you approve the rollout") is rejected outright.
//   4. That line must BEGIN with a verdict token (optionally behind a `label:`
//      prefix / bullet-emoji decoration) whose tail is EITHER bare (nothing /
//      terminal punctuation) OR a receipt: a separator, a commit-SHA-like token,
//      AND a body composed EXCLUSIVELY of receipt tokens (RECEIPT_BODY). Arbitrary
//      prose never qualifies, so an appended failure clause ("… ; smoke tests
//      exited 1") cannot ride through on the back of a real SHA.
// This is exactly the shape of a convergence receipt ("converged — prod serving
// 97ef54f4 == origin/main HEAD 97ef54f4 (exact match)", "deploy-convergence:
// converged · serving=194eda77 main=194eda77") or a bare "Completed." line, and
// deliberately NOT mid-work prose, questions, caveated outcomes ("Complete: 2
// failed"), a prose success claim with no receipt ("Complete — all checks pass"),
// or non-success states (drift, divergent). Those keep parking in `needs_input`
// unchanged (issue #2532 AC). The guards err toward NOT completing: a false
// negative merely leaves a task parked for a human / the finishedAwaitingAck
// reaper, whereas a false positive discards real work. The vocabulary is
// centralized here so new terminal-success verbs / receipt fields are added in
// one place rather than special-cased per playbook.

/**
 * Terminal-success verdict vocabulary. Kept intentionally small — each token is
 * an unambiguous "the work is done, and it succeeded" verb. Extend here (and in
 * the tests) rather than adding playbook-specific matching elsewhere. `complete`
 * / `completed` are the generic completion verbs; `converged` is the deploy
 * convergence receipt's success state (issue #1883 / #2532).
 */
export const TERMINAL_SUCCESS_VERDICTS = ['converged', 'completed', 'complete'] as const;

export type TerminalSuccessVerdict = (typeof TERMINAL_SUCCESS_VERDICTS)[number];

export interface TerminalSuccessVerdictMatch {
  /** The matched terminal-success verdict token (normalized lower-case). */
  verdict: TerminalSuccessVerdict;
  /** The line the verdict was found on, trimmed (for audit/observability). */
  line: string;
}

/**
 * Upper bound on a message we will fully safety-scan. The `?` / marker bail runs
 * over the WHOLE message (below), so a caveat or question anywhere disqualifies
 * it — but an unbounded scan on a pathologically huge message is a DoS risk. A
 * message past this bound is refused outright (park is the safe default) rather
 * than scanned as a prefix, which could miss a caveat beyond the cut. Real
 * agent final messages are far under this.
 */
const MAX_SCAN_CHARS = 100_000;

/** Leading bullet / quote / emoji decoration stripped before verdict matching. */
const LEADING_DECORATION = /^[\s>*_~`#\-–—•·▪◦✅✔☑✓🟢🎉]+/u;
/**
 * One `label:` prefix (e.g. `deploy-convergence:`), stripped so a labelled
 * receipt still matches on its verdict token. Bounded length so it can only eat
 * a short label, never a whole sentence. Never strips the verdict token itself,
 * because the verdict is tested BOTH before and after this strip.
 */
const LABEL_PREFIX = /^[A-Za-z][\w -]{0,39}:\s*/;

/** A line that begins with a verdict token; group 2 captures the tail after it. */
const VERDICT_HEAD = new RegExp(`^(${TERMINAL_SUCCESS_VERDICTS.join('|')})\\b([\\s\\S]*)$`, 'i');
/** A bare verdict tail — nothing, or only terminal punctuation. */
const BARE_TAIL = /^[.!\s]*$/;
/** A trusted receipt body must START with a receipt-style separator. */
const RECEIPT_SEPARATOR = /^[-–—·:]/;
/**
 * Machine evidence a genuine convergence receipt carries — the serving / main
 * commit SHAs (`serving=194eda77`, `HEAD 97ef54f4`). Requiring this is what
 * makes a non-bare (body-bearing) verdict line trustworthy: arbitrary prose
 * after the token — which can hide a failure the marker denylist never enumerated
 * (`"Complete — smoke tests exited 1"`) — does NOT qualify; only a SHA-bearing
 * receipt does.
 */
const COMMIT_SHA = /\b[0-9a-f]{7,40}\b/i;
/**
 * A trusted receipt body may contain ONLY receipt tokens — commit SHAs,
 * `key=value` receipt fields (`serving=…`, `main=…`), git refs, comparison
 * operators, and a small closed set of convergence-receipt words — plus
 * separators/punctuation. Any other word (prose) makes the body fail this test.
 * This is what stops a SHA-bearing line from smuggling an appended failure
 * clause past the classifier: `converged — serving=<sha> main=<sha>; smoke tests
 * exited 1` contains `smoke`/`tests`/`exited`, none of which are receipt tokens,
 * so the whole body no longer matches and the message is rejected. Extend this
 * vocabulary (not the caller) if a receipt gains a new field.
 */
const RECEIPT_BODY =
  /^(?:[\s·—–\-=:(),.#/]|==|origin\/main|serving=?|main=?|head|prod|ancestry-?confirmed|ancestry|confirmed|includes?|exact|match(?:es|ed)?|[0-9a-f]{4,40})+$/i;

/**
 * A verdict line is trusted only when the WHOLE message contains none of these
 * non-success / uncertainty / negation markers. A verdict token alone is not
 * enough because it is routinely followed — even on a receipt-shaped line — by a
 * caveat that flips the meaning ("Completed — but 2 checks still failing",
 * "Complete: 3 of 5 steps done, 2 failed", "converged — NOT safe to proceed",
 * "Complete — however the tests did not run", "Converged — pending review").
 * Matching a leading token and discarding the rest silently completes not-done
 * work, so we bail on any of these markers anywhere in the message. The trade is
 * deliberate: a false negative merely leaves the task parked for a human / the
 * finishedAwaitingAck reaper, whereas a false positive discards real work. The
 * motivating deploy-convergence `converged` receipts contain none of these, so
 * the invariant still fires for its target population.
 */
const NON_SUCCESS_MARKERS =
  /\b(?:fail(?:s|ed|ing|ure|ures)?|error(?:s)?|pending|incomplete|unfinished|unresolved|remaining|todo|to-do|rollback|roll\s?back|revert(?:s|ed|ing)?|block(?:s|ed|ing)?|blocker(?:s)?|stuck|abort(?:s|ed|ing)?|diverg\w*|caveat(?:s)?|unable|unsafe|retry|retries|await(?:s|ing|ed)?|however|manual\s+review|needs?\s+(?:review|input|attention)|cannot|not|(?:did|does|do|was|were|is|are|has|have|had|could|would|should|ca|wo|sha)n['’]t)\b/i;

/**
 * Match a single candidate line. A line qualifies ONLY when it begins with a
 * verdict token AND its tail is one of:
 *   (a) BARE — nothing, or only terminal punctuation (`Completed.`, `Complete`);
 *   (b) a RECEIPT — a receipt-style separator, a commit-SHA-like token (machine
 *       evidence), AND a body composed EXCLUSIVELY of receipt tokens
 *       ({@link RECEIPT_BODY}), e.g. `converged — serving 194eda77 == main 194eda77`.
 * Arbitrary prose after the token never qualifies, so a body that appends a
 * failure clause (`… ; smoke tests exited 1`) or any other prose cannot pass.
 */
function matchVerdictLine(candidate: string): TerminalSuccessVerdict | null {
  const m = VERDICT_HEAD.exec(candidate);
  if (!m) return null;
  const verdict = m[1].toLowerCase() as TerminalSuccessVerdict;
  const tail = m[2].trim();
  if (BARE_TAIL.test(tail)) return verdict;
  if (RECEIPT_SEPARATOR.test(tail) && COMMIT_SHA.test(tail) && RECEIPT_BODY.test(tail)) return verdict;
  return null;
}

/**
 * Classify an agent's final-turn message as a terminal-success verdict, or
 * `null` when it is not one. Pure and side-effect-free.
 *
 * The message must be a SINGLE clean verdict line — there is intentionally no
 * partial-credit for a verdict buried in a larger message. Concretely it must:
 *   1. not exceed {@link MAX_SCAN_CHARS} (else refuse — a caveat could hide past
 *      any prefix cut);
 *   2. contain no `?` and no non-success / negation marker anywhere
 *      ({@link NON_SUCCESS_MARKERS});
 *   3. be exactly ONE non-empty line — a verdict headline plus a separate
 *      question / caveat line (even one with no `?`) is rejected outright;
 *   4. match {@link matchVerdictLine} — a bare verdict, or a receipt whose body
 *      is exclusively receipt tokens.
 * Every guard errs toward NOT completing; the trade is deliberate (a false
 * negative parks the task for a human / the finishedAwaitingAck reaper, a false
 * positive discards real work).
 */
export function classifyTerminalSuccessVerdict(
  finalMessage: string | undefined | null,
): TerminalSuccessVerdictMatch | null {
  if (typeof finalMessage !== 'string') return null;
  if (finalMessage.length > MAX_SCAN_CHARS) return null;
  if (finalMessage.includes('?')) return null;
  if (NON_SUCCESS_MARKERS.test(finalMessage)) return null;

  // Require the whole message to be a single non-empty line — a clean verdict has
  // no other content, so nothing can hide on another line.
  const nonEmptyLines = finalMessage.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (nonEmptyLines.length !== 1) return null;
  const line = nonEmptyLines[0];

  const decorated = line.replace(LEADING_DECORATION, '');
  if (!decorated) return null;

  // Match the verdict on the (decoration-stripped) line first, so `converged: …`
  // matches on its own token before the label strip could eat it. Only if that
  // fails do we strip a single `label:` prefix and retry, so
  // `deploy-convergence: converged · …` still matches on `converged`.
  const direct = matchVerdictLine(decorated);
  if (direct) return { verdict: direct, line };

  const labelled = decorated.replace(LABEL_PREFIX, '');
  if (labelled !== decorated) {
    const afterLabel = matchVerdictLine(labelled);
    if (afterLabel) return { verdict: afterLabel, line };
  }

  return null;
}
