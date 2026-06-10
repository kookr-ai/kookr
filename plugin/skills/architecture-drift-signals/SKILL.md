---
name: architecture-drift-signals
description: Detect AI-induced architecture drift by measuring file-size distribution, layer-boundary violations, and dependency-graph corruption. Use to score structural health, spot drift hotspots, and produce a drift report.
keywords: architecture drift, AI-generated code, layer boundary, circular dependency, god module, file size distribution, drift ratio, structural entropy, dependency graph, AI chaos index, local optimization, fan-in, fan-out, oversized file, LOC threshold
related: monorepo-architecture, safe-refactoring, dependency-injection-patterns, domain-driven-design
---

# Architecture Drift Signals

How AI-generated codebases degrade — and how to measure it. Architecture drift is a **cumulative** failure pattern: no single commit is the culprit, but after 200 prompt sessions the layer boundaries have dissolved. Every individual change looked locally reasonable at review time.

This skill gives you the **quantitative signals**, **thresholds**, and **detection commands** to measure drift before it becomes unrecoverable.

**Calibration disclaimer:** the threshold bands below were tuned on mid-size TypeScript services; treat them as starting points and calibrate for your codebase (a generated-code-heavy or monorepo codebase will sit in different bands legitimately). The detection commands are TypeScript-specific (`.ts` globs, `madge`/`depcruise`); adapt the globs and tools for other stacks.

## The Mechanism (why AI codebases drift)

Three reinforcing root causes:

| Code | Root cause | Mechanism |
|------|-----------|-----------|
| RC01 | **Local optimization** | Each prompt session solves the immediate problem in the most convenient location. The AI has no cross-session memory of which layer a concept belongs in, so business logic lands in UI components, DB queries in route handlers, etc. |
| RC02 | **Dependency-graph corruption** | Drift manifests as cycles, cross-layer imports, and hub modules. Once cycles exist, every subsequent prompt has unpredictable blast radius — which accelerates further corruption. |
| RC03 | **Structural entropy** | Entropy only increases. The more drift has accumulated, the higher the cost of "doing it the right way", so under pressure the most convenient location wins — again. |

**Implication**: drift is self-reinforcing. The earlier you measure, the cheaper remediation is.

## The Three Detection Signals

### FP001 — File-size distribution (the drift fingerprint)

Oversized files are the clearest aggregate signal: each prompt session added logic to the most convenient file, and over time those files inflate past any coherent responsibility.

```bash
# Distribution of file sizes (TypeScript src/ tree)
find src -name "*.ts" -o -name "*.tsx" 2>/dev/null | \
  grep -v -E '\.test\.ts|\.spec\.ts|__fixtures__' | \
  xargs wc -l 2>/dev/null | grep -v total | \
  awk '{
    if ($1 < 100) small++
    else if ($1 < 300) medium++
    else if ($1 < 500) large++
    else critical++
    total++
  }
  END {
    print "< 100 LOC (healthy):", small, "files"
    print "100-300 LOC (acceptable):", medium, "files"
    print "300-500 LOC (warning):", large, "files"
    print "> 500 LOC (drift signal):", critical, "files"
    printf "Drift ratio: %.1f%%\n", (critical/total)*100
  }'

# Top 10 drift hotspots
find src -name "*.ts" -o -name "*.tsx" | \
  grep -v -E '\.test\.ts|\.spec\.ts|__fixtures__' | \
  xargs wc -l 2>/dev/null | sort -rn | head -11 | tail -10
```

**Severity thresholds**:

| Drift ratio (% of files > 500 LOC) | Severity | Interpretation |
|-----------------------------------|----------|----------------|
| 0-5% | Healthy | Boundaries intact |
| 5-15% | Watch | Early drift; a few hotspots forming |
| 15-30% | **Significant** | Boundaries eroding; folder structure no longer reflects logic distribution |
| > 30% | **Critical** | Architecture has dissolved; folder names are misleading |

The **top-10 largest files** are the drift hotspots — where the most architectural violations have compounded. Read them first.

### FP002 — Layer-boundary violations (logic in the wrong layer)

**Example layer order** (substitute your own — every project's layer naming differs). The pattern is "outer depends on inner only", with a thin shared protocol-types tier:

```
frontend → server → adapters → core
                                ↓
                        (shared: protocol types only)
```

Violations to detect:

```bash
# Core importing outward (most severe — breaks isolation)
grep -rn "from ['\"]\.\./\(server\|adapters\|frontend\)" src/core/ 2>/dev/null

# Adapters importing server/frontend
grep -rn "from ['\"]\.\./\(server\|frontend\)" src/adapters/ 2>/dev/null

# Server importing frontend
grep -rn "from ['\"]\.\./frontend" src/server/ 2>/dev/null

# Business logic in UI components (React/TSX)
grep -rn "fetch\|axios\|prisma\.\|db\." --include="*.tsx" src/frontend/ 2>/dev/null | \
  grep -v -E "import|//|\.test\.|\.stories\."

# DB queries / transport concerns in core (layer leak downward into domain)
grep -rn "fetch\|WebSocket\|http\.\|express\|hono" --include="*.ts" src/core/ 2>/dev/null | \
  grep -v -E "import type|//|\.test\."
```

**Severity thresholds**:

| Finding | Severity |
|---------|----------|
| Any `core → outer` runtime import | Critical (isolation broken) |
| Any `adapters → server/frontend` runtime import | Critical |
| Any direct DB/transport call inside `core/` | Critical |
| Business logic (pricing, auth, validation rules) in UI components | Critical (testability destroyed) |
| `import type` crossing layers | Minor (no runtime coupling) |
| `server → frontend` imports | Major |

### FP006 — Circular dependencies (graph-corruption signal)

```bash
# Install-free circular-dep check (uses npx)
npx --yes madge --circular --extensions ts,tsx src/ 2>/dev/null

# Files with broad import surface (potential hub/god modules)
find src -name "*.ts" -o -name "*.tsx" | grep -v -E '\.test\.' | while read f; do
  count=$(grep -c "^import" "$f" 2>/dev/null || echo 0)
  echo "$count $f"
done | sort -rn | head -10
```

**Severity thresholds**:

| Count | Severity | Interpretation |
|-------|----------|----------------|
| 0 cycles | Healthy | DAG intact |
| 1-2 cycles | Major | Isolation compromised in those clusters |
| ≥ 3 cycles | **Critical** | Blast radius of any change is unpredictable |
| File with > 15 imports | Watch | Potential hub coupling many domains |
| File with fan-in > 10 | Watch | God module; change-magnet |

## Drift Score (synthesis)

Combine the three signals into a single score (0-100, higher = worse):

```
drift_score = 40 * min(drift_ratio_pct / 30, 1.0)      # FP001 weight: 40
            + 35 * layer_violations_severity_factor     # FP002 weight: 35
            + 25 * cycle_severity_factor                # FP006 weight: 25

where:
  layer_violations_severity_factor = min(critical_violations / 5, 1.0)
  cycle_severity_factor           = min(cycle_count / 3, 1.0)
```

| Score | Band | Recommendation |
|-------|------|----------------|
| 0-15 | Healthy | Monitor; no action |
| 16-40 | Watch | Address top-3 hotspots within the next few PRs |
| 41-70 | **Stabilize** | Stop adding features to the drift hotspots; break cycles; enforce boundaries via lint |
| 71-100 | **Cap & Grow** | Freeze legacy zone; new features in isolated modules with enforced boundaries |

These weights match the emphasis in the source guide (architecture drift weighted ~25% of the AI Chaos Index, file-size distribution called the "drift fingerprint").

## Drift Trajectory (diagnostic timeline)

Use this to estimate how far drift has progressed and place findings on a curve:

```
Week 1-4  Launch           Folder structure reflects intent. Drift ratio ~0%.
Month 2   First violations A pricing calc lands in a UI component. Drift ratio ~5%.
Month 3   Velocity drops   Largest file ~400 LOC. First cycle forms — undetected.
Month 4   Naming divergence Same concept named 3 ways. Onboarding cost rises.
Month 5   Folder lies      Folder structure no longer matches actual logic distribution.
Month 6   Structural debt  Drift ratio >15%, several cycles, business logic in >20 UI files.
```

**Critical insight**: the cost of remediation grows **non-linearly** — not because individual violations get harder to fix, but because they become interdependent.

## Why drift is the root of other pains

| Observable pain | Drift mechanism that enables it |
|-----------------|---------------------------------|
| Fragile systems, unpredictable blast radius | Eroded boundaries (FP002) + cycles (FP006) |
| Regression fear | No layer isolation → changes leak across modules without tests catching it |
| Hidden technical debt | Structural entropy accumulates invisibly between commits |
| "Afraid to regenerate" | Custom logic intermixed with generated code because layer separation is gone |

Fixing drift is therefore a **precondition** for solving these other pains — not an optional cleanup.

## Remediation Sequence

1. **Measure** — run the three scans above, produce the drift score, list hotspots.
2. **Stabilize** — fix the top layer violations, break the critical cycles, establish a dependency-cruiser or ESLint boundary rule so violations can't merge silently.
3. **Cap & Grow** — freeze legacy hotspots (don't rewrite), build new features in isolated modules with enforced boundaries. The legacy code doesn't need to be perfect; it needs to be *stable*.

## How to use this skill

- **Agents**: `architecture-drift-detector`, `architecture-smell-scanner`, and `dependency-graph-analyzer` should reference this skill for thresholds and detection commands so their findings stay consistent.
- **Pre-push / pre-PR**: spot-check the drift ratio on changed files. A PR that pushes a file past 500 LOC or introduces a new cycle is a drift event.
- **Periodic**: run the full scan monthly, track the drift score over time. A rising score is the earliest warning; by the time velocity complaints arrive, months of drift have already accumulated.
