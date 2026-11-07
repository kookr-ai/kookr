# P2 probe — `--plugin-dir` × `enabledPlugins:false`

Resolves the RFC open question gating slice 2b
(`docs/rfc/rfc-plugin-skill-manager.md`, "Open questions"): *does disabling a
`--plugin-dir`-loaded plugin via the per-session `--settings` `enabledPlugins`
map actually remove it, or does the dir force-load win?*

Recorded on umbrella #3499 before 2b was built (MUST-PROBE gate).

## Method

`claude` 2.1.319, Linux (WSL2). The spawn shape replicates the Kookr
bypass-mode adapter path (`src/adapters/claude-code-adapter.ts`): a
`--dangerously-skip-permissions --setting-sources '' --plugin-dir <toolkit>`
launch, optionally plus `--settings <file>`. The `kookr-toolkit` tree under
`plugin/` is the dir-loaded plugin. We measured the `system`/`init`
stream-json message's `plugins[]` and `skills[]`.

## Result

| Spawn | `kookr-toolkit:` skills in init | toolkit in `init.plugins` |
|---|---:|---|
| Baseline (`--plugin-dir`, no `enabledPlugins`) | 70 | yes — `source: "kookr-toolkit@inline"` |
| `+ enabledPlugins {"kookr-toolkit@kookr": false}` | 70 (**no effect**) | yes |
| `+ enabledPlugins {"kookr-toolkit@inline": false}` | **0** (**removed**) | **no** |

## Verdict — RESOLVED, with a correction to the key form

A `--plugin-dir`-loaded plugin **can** be disabled by the per-session
`--settings` `enabledPlugins` map; the dir force-load does **not**
unconditionally win. **But** it is addressable only under the synthetic
marketplace id **`<pluginName>@inline`** (reported in `init.plugins[].source`),
**not** under its real marketplace id. Keying the override as
`kookr-toolkit@kookr` is a silent no-op; `kookr-toolkit@inline` removes it.

Consequences, carried into the 2b implementation:

- The toolkit's own per-project budget lever works via settings — it is
  `enabledPlugins:{"<name>@inline": false}`, **not** the marketplace id, and
  not "stop passing `--plugin-dir`".
- The loadout resolver maps an override that targets a `plugin-dir`-loaded
  plugin onto its `@inline` id when rendering `enabledPlugins`; a marketplace-id
  key would not disable a dir-loaded plugin. `loadSource` is therefore an input
  to the resolver.
- The UI may promise the budget saving for the toolkit, provided the override
  is emitted under `@inline`.

## Reproduce

```bash
PDIR="$(git rev-parse --show-toplevel)/plugin"
probe() { # $1 = settings json or empty
  local extra=()
  [ -n "$1" ] && { printf '%s' "$1" > /tmp/psm-probe.json; extra=(--settings /tmp/psm-probe.json); }
  claude -p 'say OK' --output-format stream-json --verbose \
    --dangerously-skip-permissions --setting-sources '' --plugin-dir "$PDIR" "${extra[@]}" \
  | node -e 'const fs=require("fs");for(const l of fs.readFileSync(0,"utf8").split("\n").filter(Boolean)){try{const o=JSON.parse(l);if(o.subtype==="init"){const sk=(o.skills||[]).filter(s=>String(s).startsWith("kookr-toolkit:"));const pl=(o.plugins||[]).find(p=>p.name==="kookr-toolkit");console.log("skills:",sk.length,"| toolkit:",pl?pl.source:"absent");}}catch(e){}}'
}
probe ''                                              # baseline        -> skills: 70 | toolkit: kookr-toolkit@inline
probe '{"enabledPlugins":{"kookr-toolkit@kookr":false}}'   # wrong id  -> skills: 70 | toolkit: kookr-toolkit@inline
probe '{"enabledPlugins":{"kookr-toolkit@inline":false}}'  # @inline   -> skills: 0  | toolkit: absent
```
