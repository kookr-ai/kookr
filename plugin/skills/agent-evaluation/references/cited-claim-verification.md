# Cited-claim verification

Use when: an agent (or a worker in a research swarm) writes an answer, report or summary from sources it
retrieved, and you must decide whether its claims are actually supported by the sources it cites before the
output is accepted, published or used to make a decision.

General gate design (judge choice, rubrics, judge attacks) lives in
[agent output verification](agent-output-verification.md); vetting a research agent's ideas and write-ups
is in [research ideas and write-ups](research-ideas-and-writeups.md). This guide covers the claim-to-source
check itself.

## Rules

1. **Do not accept a citation because it resolves or because the quote string exists.** Deep-research agents
   kept link validity above 94% while the cited claim passed a fact check only 39-77% of the time, and
   accuracy fell about 42% on average as search depth rose from 2 to 150 tool calls (2605.06635). Citation
   precision 0.904 sat beside citation faithfulness 0.417 (2607.14400, 47 queries). An exact-quote grep
   against every copy of the source is a good first gate for invented quotes and numbers, but it does not
   check the claim built on the quote. Count a check string only if it is distinctive: a full phrase or a
   number with its unit, never a bare `25`.
2. **Check per claim, and keep a pointer from each claim to its source sentence.** In the one ablation
   found, a direct span variant trailed claim-based checking by 32.3 span-F1 points; a second full-context
   pass added +0.036 F1 on one set and 0.000 on the other (2603.27752, about $0.0104 per sample with
   GPT-4o mini). Keep negation, quantities and qualifiers when splitting. The splitting step drops claims:
   87.6% recall overall, and 82.4% on list and table facts at best (2610.20086, a data-synthesis setting),
   so give tables and lists a structure-aware extraction pass.
3. **Check attribution, not only support.** Ask whether the passage supports the claim, and also whether it
   is about the same entity, condition and source. Answers built from real documents about the wrong entity
   passed every standard faithfulness and citation metric; an entity check caught them at 97.0% precision
   and 98.7% recall (2607.09349). A source-aware verifier reached block F1 0.802 (95% CI 0.664-0.900)
   against MiniCheck 0.783, RAGAS Faithfulness 0.758 and AlignScore 0.662 (2606.18037, 361 claims). Its
   gain is on misattributed claims; the plain-support gap is inside the CI.
4. **Do not average per-passage scores for claims that need several sources.** Mean-pooling pair-level
   entailment gave Macro-F1 0.6516; answer-level features (coverage, max support or refute, conflict) gave
   0.8951 (2605.03534). Flag a claim that no single passage supports instead of letting two half-supports
   add up.
5. **Validate the checker on your own failures before trusting its rate.** The same trained verifier that
   beat a GPT-4o judge on HotpotQA-RAG (0.9075 vs 0.7284) lost to it on natural hallucinations in HaluBench
   (0.3343 vs 0.7389) (2605.03534). Label 50-100 real cases from your own runs and measure the checker
   there.
6. **White-box detectors are an option only with open weights.** A residual-stream monitor came within 0.6
   AUROC points of a GPT-4o judge at $0.0006 vs $0.15 per query (2604.05358), but it needs the generator's
   activations. Probes that score 0.90-1.00 in-distribution (2606.02628) fell to 0.44 on knowledge-gap
   inputs (2606.02289). For closed-API agents, use an output-level check.
7. **Prefer constraints at generation time to repair afterwards.** Requiring a citation for every claim cut
   unsupported claims from 10% to 0% under manual review (2606.28360, 90 queries). Post-hoc citation pruning
   raised citation faithfulness to 0.758, but the gain was not statistically significant and abstentions
   lowered other scores (2607.14400). Never reward a writer or judge for fewer flagged claims without also
   checking recall: it learns to abstain or delete citations (see rule 6 of
   [research ideas and write-ups](research-ideas-and-writeups.md)).

Evidence strength: rule 1 rests on two papers that agree; rules 2-5 each rest on one or two papers with
small benchmarks; no study compares all checker types on one citation set.

## Practice

In research swarms with cheap workers, verbatim-match rates of 87 of 88 and 105 of 115 were typical, and the
misses were mostly parser artifacts. Yet reading the context still corrected claims that had passed: one run
matched every string and corrected four claims (a doubled F1 that compared different baselines, an
agreement figure attributed to the wrong component, an unlabelled derived number, and a quote gate described
as a citation check). Budget a context read for every load-bearing claim, not only a grep.

## Gaps

No same-set comparison of NLI models, small grounding models and LLM judges with cost per check; no
granularity ablation (claim vs sentence vs answer); no agreement figure between a citation-support judge and
human attribution labels; no measured rate of claim distortion by the splitting step.

Source report: `agentic-capability-reports/notes/2026-11-14-claim-support-checks-for-cited-agent-reports.md`.
