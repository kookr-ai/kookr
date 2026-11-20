---
name: launch-distribution
group: communication
description: >
  Publish a finished launch asset (a film, a demo, a release) on the operator's own social and
  video accounts through their signed-in browser, with a fleet of agents: read-only account recon,
  one researcher per platform for current rules and ranking behaviour, one writer for all post
  texts, a blind reader that fact-checks them, a plan page the operator approves, then scheduled
  publication with each platform's own timer and one one-time Kookr task for what a timer cannot
  do. Use when asked to post, announce, publish or schedule a launch on YouTube, X, LinkedIn or
  similar, or to plan where a launch should be announced. Do NOT use for paid advertising, for
  replying to people on the operator's behalf, or for accounts the operator is not signed in to.
keywords: >
  launch post, announce, publish video, schedule post, social media, YouTube upload, YouTube Studio,
  Short, X post, thread, LinkedIn post, Reddit, Hacker News, community manager, distribution plan,
  platform algorithm, ranking signals, disclosure, synthetic voice, Claude in Chrome, browser
  automation, file upload, one-time schedule, kookr schedule, maxTriggers
related: launch-video-production, asking-the-operator, adversarial-swarm-analysis, clear-technical-writing, agent-safety
---

# Launch distribution

How to take a finished launch asset to the operator's own accounts: decide where it belongs, write
what goes with it, get the operator's approval on the exact words and actions, and publish on a
schedule. Distilled from one full run (a 49-second film published to YouTube, X and LinkedIn);
`references/lessons.md` holds what failed first and `references/briefs.md` the agent briefs.

Three rules shape everything else.

1. **Nothing public without the operator's yes to that exact thing.** Text, asset, account, time.
   A change to an approved text goes back for approval. Reading a signed-in page is not publishing;
   uploading as private is reversible; posting is not.
2. **Rules are looked up, not remembered.** Limits, ranking behaviour, disclosure rules and each
   community's self-promotion rules change within months. Every platform claim in the plan carries
   its source and date, and says whether the platform stated it, a third party measured it, or it
   is folklore.
3. **Platform timers beat agent timers.** A post held in the platform's own scheduler goes out
   even if this machine, Kookr or the browser is down. Use an agent at publish time only for what
   the platform cannot schedule.

## The run, in order

### 1. Look before planning (read-only, one driver)

One session drives the browser, in its own tab group; research and writing agents get no browser.

- **Accounts.** For each candidate platform: signed in or not, the handle, follower count, account
  tier, and the language and tone of the last few posts. Keep handles out of web searches.
- **Upload path.** Inject a file input into a blank page, give it each file with the browser
  upload tool, and read back size, duration and dimensions. This proves the tool can read the files
  where they are, and shows its size limit (10 MB per call in the source run) before the plan
  depends on it. Nothing is sent anywhere.
- **Blocked sites.** Try to open each platform. Some are refused by the browser tool outright
  (Reddit was): those posts become "the operator pastes this", not something to automate.
- **Link targets.** Check, as a stranger would, that every link the posts will carry resolves:
  the repository is public, the package version exists.

Tell the operator plainly what you looked at.

### 2. Research each platform (parallel, one agent each)

One researcher per platform, with web search, in a fixed answer shape: specifications from official
help pages; what the platform states about ranking; the current evidence on links; concrete
recommendations for this post; the disclosure rule for synthetic or AI-made media, quoted; the
desktop click path; and the questions only the account owner can answer. Each statement is labelled
**A** (stated by the platform, with URL and date), **B** (measured by a third party, with sample
size) or **C** (folklore). For community sites, the researcher quotes each community's own rules
on self-promotion and on AI-written text, and gives a verdict per community.

Expect to be surprised. In the source run the research overturned three things the lead would have
done from memory: the link went in the post, not the first reply; one platform's rules forbade
AI-drafted text entirely; and the platform the operator named first had the wrong audience.

### 3. Answer "where", with the recon in hand

Recommend channels by fit, not by habit. An account with no posts and a handful of followers is
not a channel. Say what each channel is for (a permanent home, discovery, the existing network,
the exact audience) and who will post there: the agent, or the operator by hand where the browser
tool is blocked or the site's rules require the author's own words.

### 4. Write, then have a stranger check (two agents)

- **One writer** for every platform, from the product's own documentation and the research files,
  so one voice runs through all of it. No outcome claims the documentation cannot back. Statements
  only the operator can vouch for are marked `[CONFIRM]`. The writer also prepares short answers to
  the replies the post will draw.
- **One blind reader** who has not seen the writer's reasoning: checks every claim against the
  documentation, counts characters with a script (the platform's own counting rules, such as a
  fixed length for any link), checks each draft against the rules its research file quotes, and
  reads it as a skeptical member of the audience.

Apply the reader's must-fix list, then recount. Keep all texts in one file that both the plan page
and the publishing steps read, so the approved words and the posted words cannot drift apart.

### 5. Put a plan in front of the operator

One page: the final asset playing; what you recommend and what you checked; the team and why each
agent existed; then per channel the exact text with its character count and a copy button, the
settings, the evidence behind the choices, and every action you will take in their browser; the
suggested times; and a numbered list of what you need from them. State that nothing has been
posted. Ask for decisions that are theirs: the channels, the texts, the `[CONFIRM]` facts, the
disclosure answers, anything touching their employer, and when.

### 6. Publish in reversible steps

1. **Private first.** Upload to the video host as private, with all metadata, and report the link.
   This proves the path and can be undone.
2. **Ask when**, if it was not settled: now, a recommended slot, or on their word. Offer the choice
   between platform timers plus one agent task, and agent tasks for everything, and say what each
   depends on.
3. **Schedule on each platform** and read the result back from the platform's own scheduled list,
   not from the composer closing.
4. **One one-time Kookr task** for the leftovers (replies under a post that could only be
   scheduled alone, links between two videos that require the first to be public, a check that
   everything went out, the links sent to the operator). A Kookr schedule with a cron pinned to
   the date and `maxTriggers: 1` fires at most once. Write the playbook first (creation checks
   that it and `cwd` exist), then:

   ```sh
   curl -s -X POST "$KOOKR_API_BASE_URL/api/schedules/preview" -H 'content-type: application/json' \
     -d '{"cron":"5 16 24 11 *"}'                          # check the next run first
   curl -s -X POST "$KOOKR_API_BASE_URL/api/schedules" -H 'content-type: application/json' -d '{
     "name": "launch follow-up (one-time)", "cron": "5 16 24 11 *", "maxTriggers": 1,
     "playbook": {"path": "launch-followup.md", "parameters": {}, "scope": "user"},
     "cwd": "<ABSOLUTE_PATH_OF_THE_REPO>", "agentType": "claude-code", "enabled": true}'
   ```

   The playbook (a file in `~/.kookr/playbooks/`, or in `$KOOKR_USER_PLAYBOOKS_DIR` when set)
   must stand alone: what is already scheduled and where, exactly what the operator approved, the
   texts verbatim, the steps, what to do when something is missing, and how to report. Cron times
   are in the scheduler's time zone (`GET /api/schedules` shows it).

   **A missed slot does not cancel the task.** If the Kookr server is down at that minute and
   restarts within 24 hours, the task runs late. After that the run is skipped, the schedule
   keeps its one trigger, and the same cron matches again a year later. Guard both ends: the
   playbook's first step compares today's date with the date it was written for and, if it is
   later, posts nothing, disables its own schedule and reports; and after the slot, you or the
   operator check `kookr schedule list` and disable or delete the schedule
   (`DELETE /api/schedules/:id`) if it has not fired. Put that check in the runbook.

   A task that Kookr starts on a schedule does browser work only if it can reach the operator's
   signed-in browser: before relying on it, start one throwaway Kookr task and confirm it sees
   the browser tools. Tell the operator what must be running at that time (this machine, Kookr,
   the browser with its extension).
5. **Write a runbook** beside the texts: what is scheduled where and for when, how to cancel each
   piece, the ids and links, and what is left. Copy the assets and the runbook outside any worktree
   that the task's completion would remove.

## What to tell the operator, every time

- What is public, what is only scheduled, and what is still private, each with its link and time.
- Every setting you chose that was not on the plan page they approved.
- What you could not do and why (a blocked site, a rejected file, a rule that requires their own words).
- How to cancel each scheduled item.
- That the first hour after a post is theirs: on most feeds a reply is worth far more than a like,
  and you do not reply on their behalf.

## Stop conditions

Stop and report, without retrying, when a site asks for a password, a code or a CAPTCHA; when a
composer shows an error or looks unlike what the research described; when a post that should exist
does not; or when an action would need a change to an approved text. Never type credentials, never
change account settings, never delete what you did not create, and work only in tabs you opened.
