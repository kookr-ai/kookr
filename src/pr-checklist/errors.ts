// PR Checklist Contract — error taxonomy (P1).
//
// S2 + S7: a problem *derived from repo-controlled input* (oversized diff,
// path escaping the root, a file over the cap) must fail CLOSED — the caller
// maps it to a verification failure (exit 2), never a soft skip or fail-open.
// Only kookr-internal faults get the fail-open exit (≥64).

export class ChecklistInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecklistInputError';
  }
}
