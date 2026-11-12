---
name: asking-the-operator
group: agent-automation
description: >
  Ask the human operator a multiple-choice question from inside a Kookr task
  with `kookr ask` (delivered to their phone over Telegram, and asked aloud by
  Lucy in the dashboard when it is open) and act on the answer. Use when you are blocked on a decision that is genuinely theirs to
  make, with 2-4 concrete options, and the operator is probably away from the
  terminal. Covers when to ask, how to write options, and how to read the
  answer; also when NOT to ask.
keywords: >
  kookr ask, ask the operator, ask the user, operator decision, blocked on a
  decision, multiple choice question, Telegram question, need approval,
  which option, unblock from phone, human in the loop, escalate a decision
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
  time. The server rate-limits you (3 open, 6 per hour per task), and a
  rate-limit error means you are asking too much.

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
- Use `--timeout 2h` (`30s`, `10m`, `2h`, `1d` or plain seconds; minimum 30
  seconds, maximum 24 hours) when the decision stops mattering after a while;
  the default is 30 minutes.

## Waiting, or not

By default `kookr ask` returns **immediately** and prints the ask id. Keep
doing any work that does not depend on the answer. The answer arrives in your
session as an ordinary message:

```text
Operator answered ask 3fa9c1e0b2d4: Keep until expiry
Operator answered ask 3fa9c1e0b2d4: (free text) rotate, but only for admin tokens
```

Use `--wait` (or `--wait=<seconds>`) **only when you have nothing else to do**:
it blocks and prints the chosen label on stdout. If you used `--wait` you may
also receive the typed message above; they are the same answer, act once.

You can look an ask up later: `GET /api/asks/<id>` on the Kookr API
(`$KOOKR_API_BASE_URL`) returns its `state` and `answer`. Treat that record,
or `--wait`'s output, as authoritative; a typed message is a convenience.

## Exit codes (`--wait`, and creation errors)

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Answered (or created, without `--wait`) | Act on the answer. |
| 5 | Expired, nobody answered | Do **not** re-ask the same thing. Take the safest option, and state in your report that you chose it unasked. You may also receive the message `Ask <id> expired with no answer.` in your session: it is the same news. |
| 6 | Cancelled (including: your task is gone) | Stop; nothing to act on. |
| 7 | Telegram is not configured here | The operator cannot be reached this way. Do not retry; pick the safest option or stop and report the blocker. |
| 4 | Rejected (rate limit, unknown/finished task, delivery failed) | Read the message. Do not hammer the command; fall back as for 7. |
| 2 / 3 / 8 | Usage error / no server / `--wait` window elapsed | Fix the command, or continue; for 8 check the ask later. |

## After the answer

- Say in your next report which option was chosen and that the operator chose
  it, so the decision is visible in the task history.
- If the answer is free text that does not fit your options, follow it if it
  is clear; if it is not, ask **one** clarifying question or pick the safest
  reading and say so.
- An answer is a decision, not a blank cheque: it covers the question asked.
