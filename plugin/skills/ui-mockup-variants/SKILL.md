---
name: ui-mockup-variants
description: >
  Before implementing any user-facing UI/visual change, proactively offer design
  mockup variants for the user to pick from — via a single multiple-choice prompt.
  Use whenever a task asks to add, change, redesign, restyle, or improve any UI
  element (panel, button, badge, layout, dashboard, indicator, color, spacing,
  look-and-feel). Ask once (do mockups? how many? what fidelity?), build a
  self-contained HTML gallery from the app's REAL CSS tokens, let the user choose
  a variant, then implement it. Don't jump straight to component code.
keywords: >
  ui change, ui improvement, ui modification, redesign, restyle, mockup, mockups,
  design variant, design variants, design exploration, visual change, look and feel,
  layout, panel, button, badge, icon, dashboard, indicator, animation, css, styling,
  frontend, ux, choose a design, which design, show me variants, pick a design
related: playwright-e2e-patterns, rfc-iterative-review, requirements-engineering
---

# UI Mockup Variants — design exploration before implementation

When a task involves a **user-facing UI/visual change**, do NOT skip straight to
editing components. First offer the user a quick design-exploration round so they
pick the look from real, viewable variants. This skill makes that the default —
the user shouldn't have to ask for mockups; you propose them.

## When to use (and when to skip)

**Use it** for any task that adds, changes, redesigns, restyles, or improves
something the user *sees*: a new indicator/animation, a panel layout, a button
treatment, badges, spacing, a dashboard section, color/theme work, "make X look
better / clearer / nicer".

**Offer briefly but lean toward skipping** when the change is unambiguous and has
no real design space: a copy/text fix, a one-line color token swap a designer
already specified, reverting to a known prior look, or the user explicitly says
"just implement it, no mockups". Even then, a one-line "I'll just implement this
directly — want variants instead?" is cheap insurance.

If you're unsure whether the work is "UI enough", it is. Offer.

## Step 1 — Offer the menu (one AskUserQuestion call)

Ask all of this in a **single** `AskUserQuestion` call (it supports multiple
questions) so the user answers once and you proceed. Pre-select the recommended
defaults so a fast user can accept everything in a couple of clicks:

1. **Explore mockups first?** — `Yes — show me variants to pick (Recommended)` /
   `No — just implement your best version`.
2. **How many variants?** — `4–5 (Recommended)` / `3` / `2` / `1 (your best)`.
3. **Fidelity?** —
   - `HTML gallery (Recommended)` — a standalone HTML file reusing the app's real
     CSS, openable in a browser. Fast, no dev server required.
   - `Rendered screenshots of the real app` — launch the app and capture each
     variant against the live UI. Highest fidelity, slower, needs the server up.
   - `Quick ASCII sketches` — inline text layout sketches only. Fastest, lowest
     fidelity; good for coarse layout decisions or when no styling exists yet.

If the user picks **No** on Q1, implement directly (still consider a
before/after visual check at the end — see Step 5).

## Step 2 — Ground the mockups in the real UI

The whole point is that variants look like *this app*, not generic HTML. Before
building anything:

- Locate the real component(s) the change touches (search the frontend for the
  feature's markup/classes).
- Read the app's **actual design tokens** — the stylesheet(s) and the real class
  names, colors, fonts, spacing, radii, and dark/light theme variables. Reuse
  them verbatim in the mockups. Copy the real DOM structure/class names so a
  variant is a faithful preview, not an approximation.
- Note any real data shapes the UI renders (states, counts, labels) so the
  mockups show realistic content, not lorem ipsum.

### Before generating: check for an existing gallery

`ls *-mockups*.html` in the repo root (and the feature's directory). This repo
has accumulated stale galleries before — three at once in one working tree. If
a gallery for this feature already exists, offer to **reuse/extend** it instead
of generating a fresh one, and fold the old file into whatever cleanup the user
chooses at the end.

## Step 3 — Build the variants

### Distinctness rule (applies to every format)

Each variant must occupy a **named, distinct design axis** — e.g. *minimal* vs
*information-dense* vs *animated* vs *icon-led*. Name the axis in the variant's
title. If two variants differ only by a token tweak (a color shade, a border
radius), they are one variant — replace one with a genuinely different axis
before presenting.

### HTML gallery (default)
Write **one** self-contained HTML file at the repo root, e.g.
`<feature>-mockups.html`. Inside it:

- Inline the app's real CSS tokens (or `<link>`/`@import` the real stylesheet if
  practical) and match the app's background/theme so cards look in-context.
- Render each variant in its own labeled card, laid out side by side or stacked,
  using the real class names and realistic content.
- Give each variant a short name and a one-line characterization (e.g. *"most
  informative"*, *"most minimal"*, *"closest to current"*).

This file is a **throwaway preview artifact** — leave it untracked; do not commit
it. Report its absolute path and tell the user how to open it (`file://…`, or via
the running dev server).

### Rendered screenshots (if chosen)
Launch the app the way the project documents (its `run`/dev workflow or the dev
script in `package.json`), then drive a headless browser (Playwright) to screenshot
each variant — either the gallery cards or, better, the variant applied behind a
flag. For small elements (< ~100px), zoom the page (`document.body.style.zoom`) and
take a clipped screenshot so pixel-level differences are actually visible; a 36px
icon in a full-viewport shot is too small to judge. Read each PNG back inline so
the user sees them in chat. Be honest about non-deterministic states you can't
reliably capture (e.g. an agent caught mid-action) — substitute a faithful static
preview rather than claiming a live shot you didn't take.

### ASCII sketches (if chosen)
Inline labeled text sketches of each layout, one per variant, with the same
short-name + characterization treatment.

## Step 4 — Present and let the user pick

Regardless of fidelity, also give an **inline numbered list** in chat: each
variant on one line — `N. <name> — <one-line characterization>` — plus the
artifact path / images. Then make the choice a clean multiple-choice with a final
`AskUserQuestion` (header `Variant`, single-select). Offer the obvious
**combinations** as options too when they make sense (e.g. *"2 + 3 combined"*) —
users often want the best of two. Let them pick before you write component code.

### If the user rejects all variants

Rejection is signal, not failure. Ask one follow-up: what is wrong with the
closest variant (axis, density, color, motion)? Then offer exactly three paths
via `AskUserQuestion`: **refine** (one new gallery iterating on the named
objection — one refinement round, not an endless loop), **best-guess** (you
pick and implement the variant you would defend, stating why), or **defer**
(stop; leave the gallery file for a later session). Never silently proceed to
implementation with a rejected design.

## Step 5 — Implement the chosen variant

Once chosen:

- Create a worktree/branch for the change (per the project's contribution rules).
- Implement the picked variant into the **real** component(s) — not the mockup
  file. Reuse the exact tokens/markup you previewed.
- Add or update tests for the new UI behavior.
- Run the project's pre-PR review / quality gate.
- **Visually verify the real result** before reporting done: screenshot the
  before/after in the running app, zooming/clipping small elements. Only declare
  it done when the rendered result matches the chosen mockup. Leave the user a
  working inspection path (running URL or artifact path), don't tear it down.

Delete or leave-untracked the throwaway `*-mockups.html` preview; it isn't part
of the change.

## Worked example (Kookr activity-panel "working" indicator → PR #717)

The reference run for this skill:

1. Request: *"suggest 4 or 5 mockup variants in html format that I can visualize"*
   for an indicator showing the agent is actively working in the activity panel.
2. An agent located `ActivityPanel.tsx`; the real dark-theme tokens and
   `.activity-panel` / `.act-msg-*` classes were read from the stylesheet.
3. One file `activity-working-indicator-mockups.html` rendered 5 variants
   (typing bubble, live tool row, sticky working bar, footer status strip,
   frontier glow) using the real tokens — opened via `file://`.
4. Presented inline as a numbered list, each tagged (*"most informative"*,
   *"minimal"*); `AskUserQuestion` (header `Variant`) offered four build
   candidates including a *"3 + 2 combined"* option. User picked *"live tool row"*.
5. Implemented into the real `ActivityPanel.tsx` in a worktree, added tests, ran
   reviewer specialists, visually checked, opened the PR.

The improvement this skill encodes: the user had to *ask* for the mockups and the
count. Now you offer the menu first, so they just answer multiple choice and you
build.
