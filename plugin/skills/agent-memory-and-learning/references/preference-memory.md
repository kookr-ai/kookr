# Preference memory

Use when: an agent serves one person over weeks or months and must learn their preferences, keep up as they
change, resolve contradictions, or decide when to ask instead of guessing.

Each update must keep what is still true. Superseding facts in general: [memory policy](agent-memory-policy.md)
(overwrite, do not append); regression gating: [continual learning](agent-continual-learning.md).

1. **Expect the old preference to win unless the write says it changed.** Models picked the pre-change
   preference on over 35% of wrong answers, 59% when the change was only implied. Record each preference
   with its source (said or inferred), date, scope and status (active or superseded).
2. **Treat a contradiction as a possible scope split: keep both, with their conditions.** Fixed rules
   (recency, majority, source priority) failed, and extractors often dropped the conflict before reasoning.
   Supersede only when the new preference replaces the old one in the same scope; never append both and let
   retrieval pick, and never collapse two context-specific preferences into one "latest" value.
3. **Chase a superseded preference into what was built from it** (summaries, cached outputs, skills). They
   kept steering actions after the source was corrected, 92-99% stale use without repair; cascade repair is
   in [lesson capture](post-task-lesson-capture.md) (retire on evidence).
4. **Stated beats inferred.** Learning from choices beat a profile memory, but statistics alone scored only
   about 10-15% on explicit requests, and people re-label their own choices inconsistently. Use inference to
   fill gaps; let any explicit statement override it.
5. **Ask when active preferences conflict in the current scope, or the request is ambiguous and the action
   is hard to undo; otherwise act and say which preference was applied.** Asking first raised
   ambiguous-request success from about 53% to 98% with 6% needless questions (one author-built benchmark).
6. **Store corrections as scoped rules, not retrieved text, and do not turn one correction into a global
   rule.** Scoped rule directives reached 95% compliance against 55% for naive retrieval at a tenth of the
   tokens; attaching reasoning to rules hurt compliance (one self-built benchmark, which disagrees with the
   reason part of the lesson form in [lesson capture](post-task-lesson-capture.md)).
7. **Keep safety checks independent of the preference store.** Benign personal memory raised
   harmful-request attack success 16% to 244% when its theme matched the request; a detection-and-reflection
   step cut it by about 27%.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-tracking-evolving-operator-preferences-in-agent-memory.md
