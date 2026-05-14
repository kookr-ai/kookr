# kookr-toolkit plugin hooks

Hook scripts shipped with the kookr-toolkit plugin. Registration happens via
the sidecar manifest at `plugin/hooks/hooks.json` (the Claude Code plugin
format — verified empirically; this is the canonical mechanism, not
`plugin.json`'s root).

## placement-gate.sh

Per-write reactive gate for skill/agent placement violations. Reads the
Claude Code / Codex CLI `PreToolUse` JSON event on stdin and prints
warnings to stderr when a new file would be created at a misplaced
location.

### Checks

Four path-prefix checks, all deterministic — no body-text heuristics:

1. **`<repo>/.claude/skills/<name>/`** must start with `kookr-` (kookr repo only).
2. **`<repo>/plugin/skills/kookr-<name>/`** is banned (kookr-prefix only allowed in `.claude/skills/`).
3. **`<repo>/.claude/skills/<name>/`** collides with `<repo>/plugin/skills/<name>/` (shadow risk).
4. **`<repo>/.claude/agents/<name>.md`** must start with `kookr-` (kookr repo only).

Memory-frontmatter enforcement is owned by the sibling
`reflect-memory-frontmatter-gate.sh` — this gate does NOT duplicate that
boundary.

### Modes

- **Advisory (default)**: warns to stderr, exits 0 (allows the write).
- **Strict (opt-in)**: hard-blocks via `exit 2` on any violation. Opt in by
  placing the sentinel file `<repo>/.kookr-placement-gate-strict` at the
  git common-dir's parent (resolved via `git rev-parse --git-common-dir`,
  so worktrees inherit consistently). The sentinel is in `.gitignore` to
  prevent accidental commit-to-shared-repo propagation.

### Per-call suppression

Prepend `KOOKR_PLACEMENT_GATE_SKIP=1` to the env for a single tool call to
bypass the gate. Use sparingly; recorded in stderr if a violation is
present.

### Bash-matcher residual gap

When `tool_name == Bash` (the only file-write surface on Codex CLI per
PoC 003 §Gap 6), the gate parses `tool_input.command` for explicit write
patterns: `>`, `>>`, `tee`, `cp`, `mv`, and here-doc redirections targeting
watched paths. The following slip past the matcher and are NOT covered:

- Variable-expanded paths (`> "$DIR/skill.md"`)
- Interpreter-internal writes (`python -c "open('x','w')..."`, `node -e`)
- `dd of=<path>`
- `git checkout -- <path>`
- Codex `apply_patch` (emits no `PreToolUse` event per PoC 003 §Gap 5;
  caught instead at push time by the existing `<kookr>/hooks/skill-
  placement-gate.sh` tree scanner via the overlay)

The gate is best-effort; the existing tree-scanner push-time gate is the
catch-net for what slips through here.

### Bypass-mode coverage

Empirically untested as of writing. PoC 008 (a 15-minute probe) is
recommended before depending on this gate to catch placement issues
inside Kookr sessions launched with `KOOKR_BYPASS_ALL_PERMISSIONS=true`.
Whichever way PoC 008 resolves, this gate ships in advisory mode either
way — the result only edits one sentence here and in the
`kookr-toolkit:placement-picker` skill body.

### Design reference

See `docs/rfc/rfc-unified-placement-picker.md` §C for the full design and
the round-2 critic findings that shaped it.

## reflect-memory-frontmatter-gate.sh

Sibling gate that enforces memory-file frontmatter shape for reflection
spawns. Different responsibility (content-axis); see the script's header
for details.
