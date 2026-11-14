# Cited-claim verification

Use when: an agent (or a worker in a research swarm) writes an answer, report or summary from sources it
retrieved, and you must decide whether its claims are actually supported by the sources it cites before the
output is accepted, published or used to make a decision.

General gate design (judge choice, rubrics, judge attacks) lives in
[agent output verification](agent-output-verification.md); vetting a research agent's ideas and write-ups
is in [research ideas and write-ups](research-ideas-and-writeups.md). This guide covers the claim-to-source
check itself.

Metrics used below: F1 balances missed and false flags (1.0 is perfect); span-F1 scores whether the flagged
words are the wrong ones; AUROC is how well a score ranks bad above good (1.0 perfect, 0.5 chance). NLI
(natural language inference) models are small classifiers that say whether one text entails another;
MiniCheck, AlignScore and RAGAS are published support checkers of that kind.

## Rules

1. **Do not accept a citation because its link works or its quote string exists; check the claim.** In a
   study of deep-research agents, link validity stayed above 94% while the cited claim passed a fact check
   only 39-77% of the time. Fact-check accuracy also dropped about 42% on average as search depth rose from
   2 to 150 tool calls; the note does not say whether that is relative or in points (2605.06635). In one
   frontier-model run, citation precision was 0.904 and citation faithfulness 0.417 (2607.14400, 47 test
   queries). An exact-quote grep against every copy of the source is a good first gate for invented quotes
   and numbers. It does not check the claim built on the quote. Count a check string only if it is
   distinctive, such as a full phrase or a number with its unit, never a bare `25`.
2. **Split the output into claims and check each against its own passage, keeping a pointer back to the
   source sentence.** In a RAG hallucination detector, checking claim by claim beat checking spans directly
   by 32.3 span-F1 points. A second pass over the full context added +0.036 F1 on one benchmark and 0.000 on
   the other (2603.27752, about $0.0104 per sample with GPT-4o mini). Keep negation, quantities and
   qualifiers when splitting. The splitting step drops claims. A structure-aware fact extractor recovered
   87.6% of facts overall and 82.4% of list and table facts, against 48.7% on lists and tables for a plain
   extractor (2610.20086, a training-data setting). Give tables and lists their own extraction pass.
3. **Check that the passage is about the same entity and source, not only that it supports the words.**
   Answers built from real documents about the wrong drug passed every standard faithfulness and citation
   metric; an entity check caught them at 97.0% precision and 98.7% recall (2607.09349). A source-aware
   verifier for multi-tool agents scored block F1 0.802 (95% CI 0.664-0.900) against MiniCheck 0.783, RAGAS
   Faithfulness 0.758 and AlignScore 0.662 on 361 human-reviewed claims (2606.18037). The gap to MiniCheck
   is inside the CI.
4. **Judge claims that need several sources as a whole, not by averaging per-passage scores.** Averaging
   pair-level entailment scores gave Macro-F1 0.6516. Answer-level features (how much of the answer is
   covered, the strongest support and refutation, conflicts) gave 0.8951 (2605.03534). Flag a claim that no
   single passage supports instead of letting two half-supports add up.
5. **Measure the checker on your own failures before trusting its rate.** The same trained verifier beat a
   GPT-4o judge on HotpotQA-RAG (Macro-F1 0.9075 vs 0.7284) and lost to it on natural hallucinations in
   HaluBench (unsafe-F1 0.3343 vs 0.7389) (2605.03534). Label 50-100 real cases from your own runs and
   measure the checker there.
6. **Use detectors that read model internals only when you have the generator's weights.** A monitor reading
   the generator's hidden activations came within 0.6 AUROC points of a GPT-4o judge, at $0.0006 vs $0.15
   per query (2604.05358). Such probes can break on new inputs: one scoring 0.72 in-distribution fell to
   0.44 on questions the model could not know (2606.02289). For agents on closed APIs, use an output-level
   check.
7. **Require citations while the output is written rather than repairing them afterwards.** Requiring a
   citation for every claim cut unsupported claims from 10% to 0% under manual review (2606.28360, 90
   queries). A pipeline combining chunk filtering before generation with citation pruning after it reached
   citation faithfulness 0.758, but the gain was not statistically significant and abstentions lowered its
   lexical scores (2607.14400). Never reward a writer or judge for fewer flagged claims without also
   checking recall: it learns to abstain or delete citations (see rule 6 of
   [research ideas and write-ups](research-ideas-and-writeups.md)).

Evidence strength: rule 1 rests on two papers that agree; rules 2-7 each rest on one or two papers with
small benchmarks; no study compares all checker types on one citation set.

## Practice

In research swarms with cheap workers, verbatim-match rates of 87 of 88 and 105 of 115 were typical, and the
misses were mostly parser artifacts. Yet reading the context still corrected claims that had passed. In one
run every string matched, and reading the notes still corrected four claims: an F1 doubling that compared
different baselines, an agreement figure credited to the wrong component, a derived number with no label,
and a quote gate described as a citation check. A fresh-context review of the resulting guide then caught
two papers spliced into one claim and two different metrics reported as one. Budget a context read for
every load-bearing claim, not only a grep.

## Gaps

No same-set comparison of NLI models, small grounding models and LLM judges with cost per check; no
granularity ablation (claim vs sentence vs answer); no agreement figure between a citation-support judge and
human attribution labels; no measured rate of claim distortion by the splitting step.

Source report: `agentic-capability-reports/notes/2026-11-14-claim-support-checks-for-cited-agent-reports.md`.
