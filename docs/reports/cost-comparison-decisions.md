# Cost Comparison Decisions

Audit log for the qualitative decision rule introduced by
`docs/rfc/rfc-cost-comparison-panel.md` §Why now / what success looks like.

The Cost Comparison panel (top-bar `$` icon, behind `KOOKR_COST_PANEL=1`)
surfaces per-playbook Claude vs Codex spend and a thumbs-up rate on a rolling
30-day window. The panel does NOT make routing decisions — it prompts a human
judgment, and the audit log lives here.

## When to write an entry

On any playbook with at least 5 runs per agent in the rolling 30-day window:

- If median cost-per-run differs by ≥ 50% AND the thumbs-up rate differs by
  ≥ 20 percentage points (or one side has a clear thumbs-down concentration),
  write the rationale below along with what you did about it. Action options:
  do nothing, change which agent the playbook prefers in your head, document
  a known weakness and revisit.

- If no rule trip in the 30-day window, write a "no rule trip — current
  routing reasonable" entry so the absence of action is itself recorded
  (the RFC's failure mode is "no entry after 30 days," which means the
  panel didn't drive thinking).

## Entry format

Append entries below the divider, newest first. One H3 per entry:

```
### YYYY-MM-DD — <playbook> — <verdict>

- Window: <start> → <end>
- Claude: n=<count>, median $<cost>, 👍 <rate>%
- Codex:  n=<count>, median $<cost>, 👍 <rate>%
- Rule trip: yes / no, reason
- Action: <do nothing | re-route | document weakness | other>
```

---
