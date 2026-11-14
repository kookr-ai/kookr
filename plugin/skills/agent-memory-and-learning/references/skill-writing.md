# Skill writing

Use when: writing or editing the text of a SKILL.md or a skill reference file, including a skill drafted
from a research report. Whether a skill should exist at all, and how to gate it, is in
[skill library design](skill-library-design.md).

A loaded skill competes with everything else in the window. Write only what the agent does not already
know and needs in order to act.

1. **Description: what it does, then "Use when ...", as short as covers every trigger.** Third person, key
   use case first, in the words a user or agent would actually say. Routing reads only the description:
   name every distinct situation the skill serves, because the body's routing table only picks a file
   once the skill has loaded, and Claude Code ignores unknown frontmatter such as `keywords`. Hard cap
   1,024 characters; house target about 400-550. Claude Code fits all descriptions into about 1% of the
   context window and drops the least-used ones on overflow (names stay listed), so a padded description
   pushes other skills' descriptions out.
2. **Body: rules, not reports.** Each rule is a bold imperative plus the threshold or condition needed to
   apply it, in at most about 3 lines. Add a one-clause "why" only when the rule is non-obvious. Keep a
   number only when its size changes the decision, and round it.
3. **Keep every "do not" rule and gotcha.** In one study of a coding agent's rule file (one model),
   removing "do not" rules cost the most and removing positive style directives raised pass rate, so cut
   style advice first.
4. **Leave the evidence in the report.** No arXiv IDs, benchmark names or sample sizes inside rules, and no
   "evidence against", "gaps" or "not measured" sections; they are the research backlog. End each
   reference file with one `Evidence:` line pointing at the report note. Keep a caveat only if it changes
   what the agent does ("measured on one model: re-test on yours").
5. **No dated facts.** Point to the skill that owns them (prices: `claude-api`) or state them relatively.
6. **Progressive disclosure.** SKILL.md under 500 lines and under ~5,000 tokens (Anthropic's own exemplar
   skills run 500-1,500 words); detail goes in reference files one level deep, each linked with a
   when-to-read trigger ("read X if ..."), not "see references/".
7. **Cite other rules by title, not number**, so renumbering cannot break the link.
8. **Prefer a template or a worked example to a prose description of a format.**
9. **Shape of a reference file:** `# Title`, a `Use when:` line, numbered rules, an optional short "Do not"
   list, the `Evidence:` line. Add steps, a table or a checklist only when the task is a sequence or a
   choice; no background, rationale or evidence sections.

Do not trim for a line count alone: for always-loaded rule files, one study found rule count did not change
pass rate and another found file size did not change adherence. For skills, focused beat exhaustive, so
trim for focus and context cost, and never drop a rule to hit a target.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-instruction-file-size-and-content-for-coding-agents.md,
kb://agentic-capability-reports/notes/2026-11-14-when-do-skill-libraries-help-tool-agents.md;
Anthropic skill-authoring best practices (platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices),
Claude Code skills docs (code.claude.com/docs/en/skills), and the agentskills.io specification.
