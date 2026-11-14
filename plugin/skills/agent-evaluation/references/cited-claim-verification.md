# Cited-claim verification

Use when: an agent (or a research-swarm worker) writes an answer, report or summary from retrieved sources,
and you must decide whether its claims are supported by the sources it cites before the output is accepted,
published or used for a decision.

General gate design (judge choice, rubrics, judge attacks): [agent output
verification](agent-output-verification.md). Vetting ideas and write-ups: [research ideas and
write-ups](research-ideas-and-writeups.md). This guide covers the claim-to-source check itself.

## Rules

1. **Do not accept a citation because its link works or its quote string exists; check the claim.** Link
   validity stayed above 94% while cited claims passed a fact check only 39-77% of the time, and accuracy
   fell with search depth. An exact-quote grep against every copy of the source is a good first gate for
   invented quotes and numbers, but it does not check the claim built on the quote. Count a check string
   only if distinctive (a full phrase, or a number with its unit, never a bare `25`).
2. **Split the output into claims and check each against its own passage, keeping a pointer to the source
   sentence.** Claim-by-claim checking beat span checking by 32 span-F1 points; a second full-context pass
   added little. Keep negation, quantities and qualifiers when splitting. Splitting drops claims, so give
   tables and lists their own extraction pass (a plain extractor recovered under half of list and table
   facts).
3. **Check that the passage is about the same entity and source, not only that it supports the words.**
   Answers built from real documents about the wrong drug passed every standard faithfulness metric; an
   entity check caught them at ~97% precision and ~99% recall. A source-aware verifier was not
   distinguishably better than MiniCheck.
4. **Judge claims that need several sources as a whole, not by averaging per-passage scores.** Averaging
   pair-level entailment gave Macro-F1 0.65; answer-level features (coverage, strongest support and
   refutation, conflicts) gave 0.90. Flag a claim no single passage supports instead of letting two
   half-supports add up.
5. **Measure the checker on your own failures before trusting its rate.** One verifier beat a GPT-4o judge
   on synthetic RAG errors (0.91 vs 0.73) and lost on natural hallucinations (0.33 vs 0.74). Label 50-100
   real cases from your own runs and measure there.
6. **Use detectors that read model internals only with the generator's weights.** Such a monitor came within
   0.6 AUROC points of a GPT-4o judge at ~250x lower cost but can break on new inputs (0.72 fell to 0.44).
   For closed-API agents, use an output-level check.
7. **Require citations while the output is written, not repaired afterwards.** Requiring a citation per
   claim cut unsupported claims from 10% to 0%. Filtering chunks before and pruning citations after gave no
   significant gain, and abstentions lowered lexical scores. Never reward a writer or judge for fewer
   flagged claims without checking recall: it learns to abstain or delete citations (see **Do not reward
   fewer flagged claims alone** in [research ideas and write-ups](research-ideas-and-writeups.md)).

## Practice

Budget a context read for every load-bearing claim, not only a grep. Verbatim-match rates of ~90% were
typical and the misses were mostly parser artifacts, yet reading the context still corrected claims that
passed: a doubling that compared different baselines, a figure credited to the wrong component, a derived
number with no label, a quote gate described as a citation check, two papers spliced into one claim.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-claim-support-checks-for-cited-agent-reports.md
