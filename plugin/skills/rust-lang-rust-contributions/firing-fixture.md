# Firing-regression fixture

Prompts each pre-merge skill matched. Before any edit to this skill's
`description:`/`keywords:` lands, verify every prompt still shares at least
one trigger term with the frontmatter (the RFC's merge safety net — keyword
union alone is necessary but not sufficient).

Check mechanically:

```bash
python3 - <<'EOF'
import re, sys
fm = open('plugin/skills/rust-lang-rust-contributions/SKILL.md').read().split('---')[1].lower()
prompts = [l.split('| ', 1)[1].strip().lower() for l in open('plugin/skills/rust-lang-rust-contributions/firing-fixture.md')
           if l.startswith('- |')]
fail = False
for p in prompts:
    terms = [t for t in re.findall(r'[a-z][a-z0-9/+-]{3,}', p) if t in fm]
    print(('OK  ' if terms else 'MISS') + f' {p!r} -> {terms[:4]}')
    fail |= not terms
sys.exit(1 if fail else 0)
EOF
```

## Prompts (former rust-lang-rust-tests)

- | Write a regression test for this rust-lang/rust ICE
- | Add a compiletest ui test for a fixed compiler bug
- | Should this test be build-pass or check-pass?
- | Pick up an E-needs-test issue and write the test
- | Name and structure a test under tests/ui for rust-lang/rust

## Prompts (former rust-lang-rust-pre-push)

- | Run the pre-push checklist before I push this rust PR
- | Check my rust-lang PR before submitting it to reviewers
- | About to push my rust compiler regression test, anything to verify?
- | Review my PR description for the rust compiler repo before push
