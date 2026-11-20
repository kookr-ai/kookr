# Lessons from the source run

What failed or surprised the first time this process ran, per platform, and the rule each became.
Interfaces change: treat the click-level details as a starting point and check them against what
the page shows.

## The browser tool

- **A file-upload button may open the system file dialog, which you cannot see or close.** Look for
  a hidden `input[type=file]` first and give the file to it. When a button creates the input and
  calls `.click()` on it (LinkedIn's media, caption and thumbnail buttons did), patch
  `HTMLInputElement.prototype.click` in the page before clicking, so a file input is captured and
  labelled instead of opening the dialog; then use the upload tool on the captured input.
  Synthetic paste and drop events did not attach media.
- **One upload call has a size limit** (10 MB in the source run). Encode the video under it. Flat
  graphics survive a low bitrate; a platform re-encodes anyway.
- **Some sites are refused outright.** The tool would not open Reddit. Find out during recon.
- **A function that returns a large page object across the bridge hangs the call.** Return plain
  values from page scripts.
- **A lost connection mid-action means "unknown", not "failed".** Read the page state before
  repeating anything that posts.

## YouTube Studio

- **Escape closes the whole upload dialog**, not just a suggestion popup. The upload survives as a
  draft; reopen it from the content list. Dismiss popups by clicking a heading instead.
- **The channel's default category applies** (it was Gaming). Set the category explicitly.
- **The scheduled time field ignores typed text until it is focused and selected**: click the
  field, select all, type the time, press Enter, then read the field back.
- **A Short can only be linked to a public or unlisted video.** Link it after the main video goes
  public, in a follow-up task.
- **The custom thumbnail control appears only on a verified channel**; whether it is offered is
  visible in the upload dialog.
- **The automatic transcript is a free check of a synthetic narrator**: if the platform's speech
  recognition returns the script word for word, the voice is intelligible.
- **The "AI use" question lists specific cases.** Read the cases on the page and answer for the
  asset in hand; keep the disclosure sentence in the description either way.

## X

- **A rejected caption file blocks posting silently.** The composer showed "some of your media
  could not be uploaded" at its very top, out of view, and the submit button then did nothing: no
  request, no toast. Scroll the composer to the top when a submit has no effect. Removing the
  caption file fixed it.
- **A multi-post thread could not be scheduled** (with that caption error present; untested
  without it). Schedule the main post alone and add the replies with a follow-up task.
- **The scheduled list is the proof**, not the composer closing.
- **Words ending in `.md` become links** and count as a link's fixed length. Keep file names out
  of post text.
- **The link belongs in the post** on current evidence, not in the first reply; this has changed
  more than once, so check the newest dated source.

## LinkedIn

- **The composer lives in a shadow DOM**; ordinary selectors do not reach its editor. Walk shadow
  roots to read the text back.
- **The media editor accepts a caption file and a thumbnail** after the video is in; both buttons
  need the file-dialog interception above.
- **The schedule dialog works in local time** and reads back the result ("Posting at ...").
- **Typing a line that starts with a hyphen did not become a list**, and a blank line became an
  empty paragraph, which is the wanted result. Read the text back after typing.

## Community sites

- **Each community has its own rule on self-promotion and on AI-written text.** Several of the
  obvious ones forbade a project announcement, and some forbid AI-drafted text entirely. One site's
  own guidelines say to write the text yourself: give the operator a title and a list of facts,
  not prose.
- **Rule pages may block automated readers**; archived copies can be months old. Say so, and tell
  the operator to check the live page before pasting.
- **New or quiet accounts are held silently.** Use the designated showcase threads first.

## Texts

- **Count with the platform's rules**, by script, after every edit.
- **Captions and labels are not claims the product makes; pictures are.** An illustrated outcome
  (a test that passes in the film) needs a sentence saying it is an illustration.
- **Mark what only the operator can vouch for.** "I learned", "my agents use it daily", "there is
  nothing to sell" are theirs to confirm.
- **A description needs line breaks.** The operator asked for structure and for removing a remark
  about links not being clickable: say where things are, not what the platform cannot do.

## Scheduling and hand-off

- **Kookr has no "run once at" command, and does not need one**: a schedule whose cron names the
  day and month, with `maxTriggers: 1`, fires at most once. Preview it before creating it.
- **A missed one-time slot stays armed.** A server restart within 24 hours runs it late; after that
  the run is skipped and the same cron matches a year later. The playbook checks the date before
  it does anything, and the schedule is disabled once the slot has passed.
- **The follow-up playbook is read by an agent with no memory of this task.** Put in it what is
  already scheduled, what was approved, the texts verbatim, and what to do when a step cannot be done.
- **Worktrees may be removed when a task completes.** Copy assets, texts and the runbook somewhere
  durable, and keep upload paths pointing at files that will still exist at publish time.
- **Ask about timing once the reversible step is done**, with the trade-offs: the operator in the
  source run chose a slot days ahead and platform timers over an agent posting live.
