---
name: asking-the-operator
group: agent-automation
description: >
  Ask the human operator a multiple-choice question from inside a Kookr task
  with `kookr ask` (delivered to their phone over Telegram, and asked aloud
  by Lucy in the dashboard when it is open) and act on the answer. Use when you are blocked on a decision that is genuinely theirs to
  make, with 2-4 concrete options, and the operator is probably away from the
  terminal. Covers when to ask, how to write options, and how to read the
  answer; also when NOT to ask. In an unattended task, a UI mockup or a
  reversible choice never blocks: publish the material, link it on the issue,
  ask without waiting, and carry on with the recommended option (the opinion
  request flow).
keywords: >
  kookr ask, ask the operator, ask the user, operator decision, blocked on a
  decision, multiple choice question, Telegram question, need approval,
  which option, unblock from phone, human in the loop, escalate a decision,
  opinion request, needs-operator-opinion, needs a mockup, needs a decision,
  unattended task, ask without waiting, answer in a comment
related: autonomous-watch-loop, automation-design
---

# Asking the operator

`kookr ask` puts one multiple-choice question in front of the operator on
their phone and routes the answer back into your session. It exists so an
operator who is away from the terminal can unblock you in one tap. It is a
scarce resource: every question interrupts a person. Ask rarely, ask well.

The same question is also shown in the Kookr dashboard, where Lucy (the avatar
panel, when the operator has it on) reads it out and takes the answer. The
operator answers in whichever place they are; the first answer wins and you
receive it the same way. Nothing changes in how you ask or read the answer.

## When to ask

In an **unattended** task, needing a mockup or an opinion is not a reason to
stop. Use the [opinion request flow](#unattended-tasks-ask-for-an-opinion-without-waiting)
below: it asks without waiting and carries on. The rules in this section are
for blocking questions in a session someone is watching.

Ask only when **all** of these are true:

1. You are **blocked on a decision that is the operator's to make** — scope,
   product direction, risk acceptance, a choice between approaches with real
   trade-offs, or an irreversible/outward-facing action nobody authorised.
2. **You cannot decide it yourself** from the task, the code, the docs, or
   sensible defaults. If a reasonable default exists, take it and say so in
   your report instead.
3. There are **2 to 4 concrete options** you can name today.
4. Waiting costs something: other work is also blocked, or the wrong guess is
   expensive to undo. If neither, decide and move on.

Do **not** ask:

- to report progress or ask "is this OK so far?" (use your normal report or
  `kookr signal completion-ready` when you are done);
- for permission you already have, or something a quick read of the repo
  would answer;
- the same question again after it expired or was answered (see below);
- in a loop, or several questions at once. Keep **one** open question at a
  time. The server rate-limits you (per task: 3 open with a timeout of 2 hours
  or less, 10 open with a longer timeout, 6 per hour), and a rate-limit error
  means you are asking too much.

## How to write the question

```bash
kookr ask \
  --question "Auth tokens: rotate on every request or keep until expiry?" \
  --context "Rotating breaks the mobile client until 2.4 ships (3 weeks). Keeping is what main does today." \
  --option "Keep until expiry" \
  --option "Rotate every request" \
  --option "Rotate on login only"
```

- **Question**: one sentence the operator can answer on a lock screen, with
  the decision in it. Not "what should I do?". It is also **read aloud** in
  the dashboard, together with the option labels, so write both the way you
  would say them: no file paths, ids, hashes or code.
- **Context** (optional, short): the one or two facts that change the answer.
  Not a transcript. It is shown but never read aloud, so paths, numbers and
  names belong here.
- **Options**: 2-4 labels, each a *complete, mutually exclusive action*
  ("Merge as-is", "Split into two PRs"), at most 48 characters. Put your
  recommended option **first**. No "Other" option: free-text replies are
  already accepted unless you pass `--no-other`.
- Never put secrets, tokens or credentials in any field. Question or context
  text that looks like a credential (it also trips on words like "token" or
  "password") is replaced by a placeholder and the command warns you: rephrase
  and ask again. An option label that looks like one is refused (exit 4).
- **Links** (optional): the page the question is about (a mockup, a
  write-up, a pull request) goes in `--link <https URL>`, at most 2, each
  with a `--link-label "Open mockups"` (at most 40 characters) right after
  it. They are shown as buttons, never read aloud. A link must be `https://`
  and at most 500 characters, or the command exits 2. While the question is
  waiting, the operator can also say "show me" to Lucy to open it.
- Use `--timeout 2h` (`30s`, `10m`, `2h`, `1d` or plain seconds; minimum 30
  seconds, maximum 7 days, so `8d` is refused) when the decision stops
  mattering after a while; the default is 30 minutes. With a timeout of hours
  or days, do not block on a bare `--wait` (it would wait that long): carry on
  and read the answer when it arrives, or with `GET /api/asks/<id>`.

## Waiting, or not

By default `kookr ask` returns **immediately** and prints the ask id. Keep
doing any work that does not depend on the answer. The answer arrives in your
session as an ordinary message:

```text
Operator answered ask 3fa9c1e0b2d4: Keep until expiry
Operator answered ask 3fa9c1e0b2d4: (free text) rotate, but only for admin tokens
```

Use `--wait` (or `--wait=<seconds>`) **only when you have nothing else to do**:
it blocks and prints the chosen label on stdout. While it waits, the answer is
normally **not** typed into your session as well. It is typed as a fallback if
`--wait` stopped before reading it (its window ran out, or the command was
killed). An answer given in the first seconds, before `--wait` first checks for
it, can still arrive both ways: if both reach you, they are the same answer;
act once.

The answer is typed only into the session that asked, or into a session that
resumed its conversation (crash recovery, Reopen). An answer given after your
task has ended, or after it was relaunched fresh, is still **recorded**: the ask
ends as `answered` with `taskDelivery: "skipped"`, nothing is typed into any
session, and the operator is told "Recorded. The task has ended, so nothing was
typed into it." (or that it was relaunched). A relaunched session that asks the same
question again (same question, options and context) takes over the pending ask
instead of sending a second message.

You do not need to remind the operator yourself: while the question waits,
Kookr sends short Telegram reminders (by default after 10 minutes, after 1 hour,
then every 4 hours, and once 10 minutes before it closes; never during the
operator's quiet hours). So do not re-ask a question that is still pending to
get attention; a second identical ask is deduplicated anyway.

You can look an ask up later: `GET /api/asks/<id>` on the Kookr API
(`$KOOKR_API_BASE_URL`) returns its `state` and `answer`. Treat that record,
or `--wait`'s output, as authoritative; a typed message is a convenience.

## Exit codes (`--wait`, and creation errors)

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Answered (or created, without `--wait`) | Act on the answer. |
| 5 | Expired, nobody answered | Do **not** re-ask the same thing. Take the safest option, and state in your report that you chose it unasked. You may also receive the message `Ask <id> expired with no answer.` in your session: it is the same news. |
| 6 | Cancelled (withdrawn, or the question never reached Telegram) | Stop; nothing to act on. |
| 7 | Telegram is not configured here | The operator cannot be reached this way. Do not retry; pick the safest option or stop and report the blocker. |
| 4 | Rejected (rate limit, unknown/finished task, delivery failed) | Read the message. Do not hammer the command; fall back as for 7. |
| 2 / 3 / 8 | Usage error / no server / `--wait` window elapsed | Fix the command, or continue; for 8 check the ask later. |

## Unattended tasks: ask for an opinion without waiting

A task is **unattended** when nobody is at the terminal to answer: it was
launched by a schedule or a parent task (`KOOKR_LAUNCH_PROVENANCE` is
`schedule` or `parent`, or `KOOKR_PARENT_TASK_ID` is set), `KOOKR_UNATTENDED=1`
is set, or its prompt says nobody is watching. There, a UI choice or a
reversible decision never blocks the task. The operator answers later, from a
phone, with a comment.

1. **Prepare.** For a visible UI change, build the mockup variants with the
   `ui-mockup-variants` skill, without asking first whether to build them. For
   a decision, write the options (letters `A`, `B`, …), their trade-offs and a
   recommendation.
2. **Publish where a phone can open it.** A Claude artifact when the Artifact
   tool is available in the session. Otherwise commit screenshots (PNG) to the
   pull request branch and embed them in the comment. Never only a path or a
   `localhost` URL on the host.
3. **Link it on the issue** with one comment, and label the issue. Its first
   line is the marker, with the recommended letter. When you open the pull
   request, post the same request comment on it and label it too, so the
   operator can answer on whichever page they opened (the sweep reads only
   labelled items):

   ```bash
   gh label create needs-operator-opinion --repo "$REPO" --color FBCA04 \
     --description "A task asked for the operator's opinion and carried on" 2>/dev/null || true
   gh issue comment "$N" --repo "$REPO" --body-file - <<'MD'
   <!-- kookr:opinion-request recommended=A -->
   **Opinion wanted:** <the question, one sentence>

   - **A (recommended):** <option>. <why it is recommended>
   - **B:** <option>. <trade-off>

   Material: <artifact link, or the embedded screenshots>. I am carrying on with **A**.
   Task: <task name> (issue #<N>)

   Answer with a comment here, in your own words: "ok" keeps A, or name
   another option, or say what to change.

   <full URL of the artifact or pull request, on its own line>
   MD
   gh issue edit "$N" --repo "$REPO" --add-label needs-operator-opinion
   # Later, on the pull request: the same comment, then
   #   gh pr edit "$PR" --repo "$REPO" --add-label needs-operator-opinion
   ```

   The operator answers in plain language, with no prefix or format. Workers
   post on GitHub with the operator's own account, so a reply cannot be told
   apart by its author; automation is told apart by its markers instead. So,
   from the request on, **start every comment you post on that issue or pull
   request with `<!-- kookr:automation -->`** on its own line (a request,
   verdict or other Kookr marker also counts). An unmarked comment is read as
   the operator's answer and becomes a follow-up task.
4. **Notify, do not wait.** Send one `kookr ask` **without** `--wait`, with
   `--timeout 48h`, the options (recommended first), and the material and the request comment as
   `--link`s, each with a `--link-label`. They become buttons on Lucy's card
   and on Telegram, so the operator opens them with one tap. Say in the
   context that the durable way to answer is a comment on the request. An
   answer tapped on Telegram is typed into the task only while it is still
   running; after it ends, Kookr records the answer on the ask and tells the
   operator nothing was typed into the task.

   Name the task in the question (issue number and a few words of its title):
   the Telegram message shows only the task id. Do not paste URLs into the
   question; the card also has an "Open task" button.

   ```bash
   kookr ask --timeout 48h \
     --question "Issue #$N (<short title>): which layout should the panel use?" \
     --context "I am carrying on with A. Answer any time with a comment on the opinion request, in your own words." \
     --link "$ARTIFACT_URL" --link-label "Open mockups" \
     --link "$COMMENT_URL" --link-label "Open the request" \
     --option "A: compact list (recommended)" --option "B: cards"
   ```
5. **Carry on with the recommended option** when the choice is reversible (UI,
   wording, defaults, an approach you can change later): implement it and
   deliver the pull request through the normal flow, with screenshots for a UI
   change. When the choice is hard to undo (a data migration, deleting
   something, an external side effect), deliver everything up to the choice
   and stop there: write the marker as
   `<!-- kookr:opinion-request recommended=A stopped -->`, say in the comment
   that nothing past the choice was done, add `automation-blocked` as well
   (issue selection skips it, so no other task re-picks the issue), and record
   the blocker. Every reply to a stopped request, "ok" included, starts the
   follow-up that carries out the chosen option.
6. **If an answer arrives in your session** (`Operator answered ask …`), post
   it on the issue as a relay: first line `<!-- kookr:opinion-relay -->`, then
   the answer (the option letter, or the operator's free text), then
   `(answered on Telegram)`. Keep going. Do not change course yourself; the
   sweep below turns it into work.

**How the answer comes back.** `kookr opinion sweep --repo <owner/name>` reads
every item labelled `needs-operator-opinion`, open or closed. Every new
unmarked comment after the request is a reply, in any words and any language.
A short accept ("ok", "lgtm", "looks good", or the recommended letter alone)
removes the label. Any other reply, and every reply to a `stopped` request,
starts one follow-up task that reads it and decides: another option or a
change is implemented, an accept in other words removes the label, and a
comment that is not an answer is left alone. The sweep posts a `kookr:opinion-handled` marker for each reply it
handled, so running it again does nothing. Only comments by the repository
owner, members and collaborators count. After an accept the item is no longer
labelled, so a later change of mind needs a new issue. The `Deliver GitHub Issues`
playbook runs the sweep at the start of every run.

In this flow the one-question rules above still hold: one `kookr ask` per
opinion request, and never a second ask for the same question.

## After the answer

- Say in your next report which option was chosen and that the operator chose
  it, so the decision is visible in the task history.
- If the answer is free text that does not fit your options, follow it if it
  is clear; if it is not, ask **one** clarifying question or pick the safest
  reading and say so.
- An answer is a decision, not a blank cheque: it covers the question asked.
