# Critique — Productivity & Context-Switching Value Prop

A productivity-coach read of the v3 demo bundle. Blunt, not hype-friendly.

---

### The context-switching story the video tells

The arc the video actually traces is: **chaos hinted at (Act 0) → product features (Acts 1-5) → recap (Act 6)**. Pain is implied — five agents, one pulsing — but it is never *felt*. There is no shot of the developer-before-Kookr alt-tabbing across five terminals at 2x speed, no five-pane tmux nightmare, no "you've been polling agent #3 for four minutes" overlay. By Act 1 the dashboard is already calm and the cursor is gliding through filter chips. The viewer is being told the product is calm; they are not being shown what it replaced.

Relief shows up in Act 2 (one-key allow) and Act 3 (snooze + AI-drafted reply), which are the strongest beats — but relief without prior tension is just a UI tour. Act 5 (cost + completion digest) is where a measurable productivity payoff *could* live and where the script consciously deprioritises it ("first one to trim — lowest-novelty beat"). That is the productivity story being thrown away on purpose. The closing card lists three abstract pills ("Local-first / Multi-agent / Multi-project") — none of which is a time-saving claim. Net: the video is a feature tour wearing a productivity costume.

### Three concrete productivity moments the video MISSES

1. **Act 0 — no "before" frame.** Insert a 1.5-second split-screen cold open: left side, five tmux panes labelled `agent-1 … agent-5` with mouse arrows pinballing between them; right side, the Kookr dashboard. Caption: *"5 terminals every 30s, or 1 notification when it matters."* This is the only place the context-switching tax becomes *visible* rather than narrated. Cost: ~1.5s of runtime, returns the entire premise of the post.

2. **Act 3 — no time-saved meter on the snooze gesture.** When the merge conflict gets snoozed for 1 hour, overlay a micro-counter: *"Polled by you 0 times in the next 60 min. Time reclaimed: ~14 min."* This converts "snooze" from a UI feature into a measurable hour-of-the-day reclaimed. Right now the caption "The other one waits. Snooze and move on" describes the gesture, not its payoff.

3. **Act 5 — cost shown, time-saved absent.** The completion digest lists `Duration: 8m 12s` and `Cost: $0.42` but never the falsifiable productivity line. Add one row: *"Manual supervision avoided: ~22 min (44 terminal checks at 30s cadence)."* That single overlay turns the act from "cute completion screen" into the line the viewer screenshots and sends to their manager. The script explicitly flags this act as cut-bait — that priority is upside-down for a productivity pitch.

### Three productivity moments the video gets RIGHT

1. **Act 0 caption — *"5 AI agents working. One needs you. Which one?"*** This is the sharpest line in the entire bundle. It names the cognitive problem (polling N to find the one) in nine words and matches the muted-autoplay reality. If only the rest of the video stayed at this register.

2. **Act 2 caption — *"Permission blocked. One key — keep moving."*** "Keep moving" is the right verb for a productivity pitch — it implies flow, not features. This is the one beat that frames Kookr as a *latency reducer* rather than a dashboard.

3. **Honest flag — I cannot find a clean third.** Act 3's *"AI drafts a reply. Approve or edit."* is a feature claim, not a productivity claim. Act 4's *"Same queue. Same triage."* is rhythm without a falsifiable number. Act 6's three pills are brand pills, not productivity pills. **This is a failure signal: a 2:30 video aimed at a productivity audience should land more than two measurable wins.**

### LinkedIn copy rewrite

Current opening (140 chars to "see more"): *"Running five AI coding agents in parallel sounded productive. In practice, I spent more time switching between terminals than reviewing code."*

Rewrite (243 chars, under the cutoff, harder claim, falsifiable verb):

> Five parallel AI agents = ~40 terminal-switches per hour, most of them returning nothing.
> I measured it for a week. Then I built Kookr.
> One queue. The agent that needs you floats up. The other four stay out of your head until they don't.

This lands a number (40 switches/hr), a method signal ("measured it for a week"), and a verb-led promise ("stay out of your head"). The original gestures; this one quantifies.

### One paragraph: would this video actually convince me to clone the repo?

**Maybe — leaning no.** The product is clearly competent and the Act 0 hook is strong, but by Act 1 the video reverts to feature-tour rhythm and never returns to the *tax* it claims to solve. There is no "before" frame, no time-saved counter, no falsifiable hours-reclaimed number. As a productivity-skeptical engineer I'd nod along, close the tab, and forget the URL by lunch. The repo gets a clone only if I'm already shopping for an agent supervisor — Kookr won't have *created* the demand, just satisfied an existing one. Add the missing measurable overlays and that flips to a confident yes.
