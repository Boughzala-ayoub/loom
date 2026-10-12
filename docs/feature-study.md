# Loom feature study

2026-10-11, at `ac726f7`. Follows [the improvement study](improvement-study.md) of 10-06.

This time I started from what you actually do. I pulled every prompt you typed in a Loom session
from 09-09 to today, 627 typed prompts in 93 sessions, plus 98 prompts a conductor session relayed
into panes. I counted the recurring requests and complaints, then checked each feature
against the code. I tested the uncertain ones by running the agent CLIs under ConPTY. Four ideas
from my first draft didn't survive the testing or the counts, and section 7 says why.

Sizes: S is a day or less, M is two to four days, L is one to three weeks.

## Short version

Ranked by how often each comes up in your prompts. Section 8 gives the build order, which starts
with the smallest.

1. **Land and update, as one action.** You asked for it 32 times on 14 different days, as "commit
   and update loom", "merge to main and build and update loom" or "commit and prepare installer".
   It's your most repeated request. An agent does it each time, following a merge and clean-build
   procedure that lives in Claude's memory notes, not in Loom. Size M.
2. **Read the state agents now report themselves.** Claude Code 2.1.296 and OMP 18.8.9 send OSC
   7501 (`working`, `blocked` with the question, `done`, `idle`), and I measured both. Loom ignores
   it. Some of your complaints that a pane wasn't shown as working, or that a notification never
   came, trace back to Loom misjudging a Claude pane, and this removes that guesswork. It also
   makes OMP, your API-credit agent, a full agent. Size S to M.
3. **The review round in Loom.** 74 review reports in 11 days. A conductor session relays each
   one, and its watchers fail ("Restart the two waits", "why i see one watch running"). Build
   `submit --after` first, then a Review action. M each.
4. **Start an agent with its first prompt.** "Add a codex astra high pane and tell it to…" is how
   you start most work. `loomctl new` and `add` take no prompt, so every start is two steps with a
   wait in between. Size S.
5. **What changed since the last update.** On 10-10 you opened four sessions whose first question
   was what the last commits changed. Loom can list them after a restart. Size S.

## 1. What you do in Loom, counted

| What you asked for | Prompts | Days | Feature here |
|---|---|---|---|
| Commit, merge, build, update or install | 32 | 14 | Land and update (2) |
| A review, or fixes from one | 47 typed, 98 relayed | 9 | Review round (4) |
| Add a pane, prompt a pane, tell a pane | 27 | 4 | First prompt at start (5.1), `--after` (4.1) |
| A pane shown in the wrong state, or no notification | 5 | 4 | OSC 7501 (3), for Claude and OMP |
| Whether something is using up the plan | 3 | 3 | Usage per agent (5.5) |
| What the last commit changed | 6 | 1 | What changed (5.2) |
| The phone app | 50 | 8 | Mostly shipped already |

Counted with regexes over the prompt text, then read by hand to drop false matches. The method is
rough, but the order between rows is clear.

### Shipped since 10-06

Phone dictation (`a38bdbb`), images from the phone (`b4e9e20`), the task manager (`2fe435a`), the
Codex-style restyle and 55 themes (`100be1e`, `d5bbf00`), commit paging (`2e5b4a9`), OMP's mark
and resume (`f9add5b`), and about 40 commits of worktree and branch safety from Codex reviews 2 to
9. From the 10-06 list, only `npm test` and the async `cli_reply` got built.

### Decided since, so not proposed

- **A task progress bar.** You had one built as a mod on 10-10 and removed it. It read 6% when the
  turn ended (2a4e30d1).
- **Effort for one prompt.** The `/low` to `/max` prefix mod does it, from the phone too.
- **A snipping tool.** It's in overlayv3's phone bubble (b5519127).
- The 10-06 "Decided against" list still holds. No Full Loom mirror, no frameless title bar, no
  trash restore, no context % on cards, nothing with a hosting fee.

## 2. Land and update

Size M. Item 2.3 of 10-06, which proposed Land with an "after-land command". The prompt count
moves it to the top.

### What an agent does now, each time

The procedure is in Claude's memory note `loom-release-build`, not in Loom:

1. Commit the work, in separate commits if it's separate pieces of work.
2. Fast-forward `main` in the root checkout. Before that, check that none of the root's untracked
   files, your studies and reviews, is tracked on the branch, and that the branch doesn't add a
   path that exists there as an ignored file.
3. Build. Since 10-10 this has to happen in a clean detached worktree. `npm run tauri build`
   builds the working tree, and that day another pane's uncommitted `src/main.ts` edits went into
   an installer. The clean build is `git worktree add --detach`, then `npm ci --prefer-offline`, then
   the build with the root's `CARGO_TARGET_DIR` and `LIBCLANG_PATH`. It takes about 4 minutes.
4. `npm run update`, which swaps the installed `loom.exe` and `loomctl.exe` by checksum.
5. You restart from Preferences or the phone.

Every step is mechanical except the commit message. That makes it a Loom action, not agent work.

### The feature

**Land** on a thread's `⋯`, on the phone's thread menu, and as `loomctl land <thread>`:

1. Refuse while an agent in the thread is working.
2. With uncommitted changes, send the thread's agent the commit prompt you type today, with
   `--after` from 4.1. Land continues when that task completes and stops if it fails.
3. Fast-forward the base with the checks from step 2 above. If the branch is behind, offer Rebase
   in the thread's worktree. The Changes panel already handles a conflict there.
4. Run the project's after-land command, if it has one. For Loom it's **Update**.
5. Close the thread and delete its worktree and branch, as the close dialog does now. Skip this
   step for a thread on the root checkout.

**Update** in Preferences, on the phone and as `loomctl update`, builds the base's tip in a clean
detached worktree and passes the exe to `update.ps1 -Source`. The script already takes a prebuilt
exe (`scripts/update.ps1`, the `-Source` parameter). Then it pushes "Loom updated, 6 commits.
Restart?" with a **Restart** button. Never restart unasked, because it relaunches the pane a
conductor session runs in too.

Both go in as loomctl commands first. The phone then gets Land and Update for nothing, which
matters because you often ask for this from the phone.

Skipped: a PR path, since you don't push or use pull requests. Also a setting to build in the root
checkout to save time. The clean build is one code path and can't pick up another pane's edits.

## 3. Read the state agents report themselves

### What I measured

OSC 7501 is the Program Status protocol Mitchell Hashimoto published on 10-06. A program writes
`ESC ] 7501 ; state=<s>:app=<a>:kind=<k>:msg=<base64> ESC \`. Claude first asks whether the
terminal understands, with `ESC ] 7501 ; ? ESC \`, and a terminal that does answers with the same
sequence. Loom answers nothing, so Claude stays silent in Loom.

I ran each agent under pywinpty, which goes through ConPTY as Loom does. The script answered the
query, sent a prompt and logged every report:

| Agent | Version | What it sent |
|---|---|---|
| Claude Code | 2.1.296 | `idle` at start, `working` when the turn began, `done` 2 s later when it ended |
| Claude Code, a question | 2.1.296 | `working`, then `blocked`, `kind=question`, msg "answer: Do you prefer tea or coffee? (Tea · Coffee)" |
| Claude Code, Esc mid-turn | 2.1.296 | `working`, then `idle` 0.1 s after the Esc |
| OMP | 18.8.9 | `idle`, `working`, `done`, all without waiting for the query |
| Codex | 0.162.1 | nothing, and the binary has no OSC 7501 code |
| OpenCode | 2.0.19 | nothing, and the binary has no OSC 7501 code |

ConPTY carried the reports out and the answer in, so Loom's PTY path will too.

### Why it matters to you

These are your complaints, word for word:

- "Why astra pane is not showing as working in loom while it is" (10-05)
- "Now when this turn finished i did not receive notification on phone why" (10-06)
- "The loom claude pane is done why you did not receive" (10-05)

They have more than one cause. The astra pane runs Codex, which OSC 7501 doesn't cover, so Codex
keeps its OSC 9 and title signals. For Claude, Loom works out the state from hooks, the bell and
screen regexes (`claudeWorking`, `interruptHint`). The hooks miss an Esc interrupt. The regexes
break when Claude redraws its status row, as 2.1.288 did when it dropped the Esc hint. OSC 7501 is
Claude stating its own state, so for Claude and OMP that whole class of misjudgment goes away.

### 3.1 Answer the query and read the reports

Size S for the handler, M with the state changes.

Next to the OSC 9 and OSC 99 handlers in the `Pane` constructor (`src/main.ts:2213`), register an
OSC 7501 handler:

- A body of `?` writes the answer to the PTY.
- `working` sets the pane busy.
- `blocked` wakes it as waiting, with `msg` as the question the overlay and the phone show.
- `done` wakes it and counts the turn.
- `idle` straight after `working` ends the turn as interrupted.

This is the "one busy rule" item from 10-06 section 5, done with the agent's own signal. Keep the
hooks, because they carry the session id and the prompt and final-message hashes tasks match on.
Keep the regexes as the fallback for a Claude old enough to send nothing.

Check while building: what Claude sends for a permission prompt. Auto mode was on in my probe, so
none came up.

### 3.2 OMP as a full agent

Size S after 3.1.

On 10-10 you asked whether the monthly API credit works in other harnesses, then installed OMP and
asked how to add an API key (81a64eaf). OMP is how you spend that credit, but Loom runs it as a
shell command (`agentOf`, `src/agent.ts:15`). `wake()` skips counting a shell's turns
(`src/main.ts:2602`), so OMP gets no tasks, no task notices and no phone push, and the Overview
shows its screen instead of its messages.

OMP already sends `working` and `done`. Once 3.1 reads them, add `omp` to `Agent`, take its turns
from OSC 7501, and run it bare like the other agents, with `ZELLIJ_PANE_ID` in the PTY's
environment instead of the PowerShell line from `f9add5b`. No plugin needed.

## 4. The review round in Loom

### What you do now

`review-loop.md` in the loom-operator skill describes it. A Codex reviewer at xhigh writes
`docs/reviews/<TOPIC>_<MODEL>_REVIEW_<stamp>.md`. A fixer commits the report, then fixes each
finding with a failing check, its own commit, the full suite and a build. Then the next review.
You decide when it stops.

A conductor session sits in the middle. It writes each prompt, watches each pane, and passes on
each result. That's the 98 relayed prompts. On 10-05 alone you had to say "Restart the two waits",
"Restart wait" and "why i see one watch running is that a bug". Its watchers die when memory runs
low, and every hand-off waits on it.

### 4.1 `submit --after`

Size M. Item 3.2 of 10-06, not built.

`loomctl submit <pane> --after <task> <prompt>` queues a prompt that Loom sends when that task ends
`completed`, and drops it on `failed` or `unknown`. The queue lives in the task journal, so a
restart keeps it, and each step can push. Land (2) and the review round both use it.

`--after` already means an event number on `watch` (`src/main.ts:9542`). Call this one
`--when-done` if the reuse reads badly.

### 4.2 A Review action

Size M after 4.1. New.

The thread's `⋯` gets **Review…**. You pick the reviewer pane, the fixer pane and the range, by
default the commits since the last report. Then Loom runs one round:

1. Loom picks the report path and puts it in the reviewer's prompt, so nothing parses a reply to
   find the file.
2. The reviewer prompt ends with "Last line of the report: `Findings: N`." When the review task
   completes, Loom reads that line.
3. `Findings: 0` ends the round with a push saying the review came back clean.
4. Otherwise Loom pushes "Review 3: 2 findings" with **Fix** and **Stop**, on the phone and on
   the overlay. Fix sends the fixer prompt naming the report and queues the next review with
   `--after`.

The prompts are the two in `review-loop.md`, kept as editable templates in Loom's data folder.
Loom never starts a fix you didn't tap, so your stop rule holds.

Skipped: a findings database, severity parsing, swapping a pane at 80% context. Also a reviewer
scoreboard, though on 10-06 you asked "which was better sol or deepseek as reviewer". The reports
and the fix commits that cite them are in git, so a script can count that later if you want it.

## 5. Smaller features

### 5.1 Start an agent with its first prompt

Size S. New.

`loomctl new` and `add` take an agent, model, effort and pane count, but no prompt
(`src/main.ts:9279`, `9299`). The PC's `+` and the phone's `+` don't take one either. So every
"add a codex astra high pane and tell it to do a complete review" is two steps, with a wait for the
agent to boot in between. Today a conductor session or you handles that wait.

Add `--prompt` (`-` for stdin) to `new` and `add`, and a prompt box to both `+` forms. Loom waits
for the agent to boot, then submits the prompt as a task and returns the task id so `--after` can
chain on it. For Claude the boot signal exists already. It's the SessionStart marker that frees a
slot in the restore queue (`src/main.ts:1827`). With 3.1, Claude's and OMP's first `idle` report is
another one. Codex and OpenCode need their composer on screen, which `submit` already waits for.

### 5.2 What changed since the last update

Size S. New.

On 10-10 four sessions opened with "read the last commit and give what changed" (81a64eaf,
e3128490, 6e2d18b2, 41f63707). Your commit subjects are already plain sentences ("Let the commit
lists go back to 10 with Show less."), so the list of them answers the question.

Have `build.rs` embed the commit Loom was built from and the repo it was built in. Today it embeds
neither, apart from a source path that only debug builds use (`remote.rs:486`). On launch, if the
commit differs from the last one Loom ran, show "Updated: 6 commits" with their subjects, on the
PC and in the phone's Settings. It's one `git log --format=%s old..new` in that repo.

### 5.3 Setup on cut

Size S. Item 2.1 of 10-06, not built.

Your sessions since 10-06 ran in six worktree threads (mobile, exp, phone-dictation,
phone-task-manager, the, codex-review-2). Each started without `node_modules` or a Rust build.
Copy the files `.worktreeinclude` lists and run the
project's setup command in a `setup` pane before the agents start. For Loom the command is the
`npm ci --prefer-offline` and shared `CARGO_TARGET_DIR` that the clean build in section 2 uses.

### 5.4 Open OMP's Claude import in a new pane

Size S, after 3.2. Smaller than my first draft proposed.

`omp --from-claude` imports a Claude Code session into OMP. I ran it. It opens a picker of past
Claude sessions, listed by first prompt, and takes no session id or path. So Loom can't continue a
given conversation by itself. It can add **Open in OMP** to a Claude pane's menu, which starts
`omp --from-claude` in a new pane of the same thread, and you pick the session, usually the top
one. Offer it when Claude's five-hour limit hits (`resetsAt`, `src/main.ts:1569`), since OMP runs
on your API credit, a separate allowance.

### 5.5 Usage per agent in the current window

Size S to M. New.

Three times you asked whether something was using up the plan: "the watch is it cinsuming
usage?" (10-05), "The wait like this is consuming usage" (10-06), and whether the progress mod was
(10-10). Each time an agent had to work it out. The Usage tab shows the plan's limits and each
agent's context, but not which agent used the limit.

`usage.rs` already adds up input, output and cache tokens per session from each transcript line
(`src-tauri/src/usage.rs:232`). Keep a second sum of only the lines since the five-hour window
started, and list agents by it under the limit chip, for example "loom:3 (Opus, xhigh) 41%". A
conductor session running in a Loom pane shows up there too. The share is an estimate, because
the window also counts usage from other machines and claude.ai.

## 6. Competitors since 10-06

From changelogs dated 09-25 on:

- **wmux** is a new Windows rival: Electron, xterm.js and ConPTY, installed from winget. Agents
  can message each other, a Fleet list shows the ones that need you, and it has an iOS app. Going
  by its README, it's the closest thing to Loom on Windows.
- **OSC 7501** is the one shared idea worth taking now (section 3). Claude Code added it in
  2.1.295. Factory added a working, waiting and done status to its terminal on 10-08, without
  naming the protocol.
- **Hand-off to another agent** (Orca 10-10, MultiCC, Offrun at the usage limit) is 5.4, cut down
  to what OMP allows.
- **What I left out.** Subagent trees, agent teams, plan and todo status, rewind, pinned threads,
  editable queued prompts, scrollback markers, pre-trusted worktree folders, sending a selection
  to another agent, Reset Terminal. The agent CLI already does some of these, Loom already does
  others, and none of your 627 prompts asked for any of them.

## 7. Cut after testing

- **Continue in OMP by itself.** The picker blocks it (5.4).
- **Share to Loom from Android's share sheet.** It rested on one complaint, about pasting a phone
  screenshot, and images from the phone shipped the day after (`b4e9e20`).
- **An agent version watch.** Section 3 takes Claude and OMP off screen reading. Bring it back if
  a Codex update breaks tasks again.
- **Pre-trusting worktrees.** Neither `~/.claude.json` nor `~/.codex/config.toml` has an entry for
  any `~/loom` worktree, so they already start without the trust prompt.

The rest of the 10-06 list stays where that study put it: behind-base marks, diff comments, the
stuck detector, send at limit reset, shell logs, best of N, port blocks. Nothing in your prompts
since then moved them up.

## 8. Order

1. OSC 7501 for Claude (3.1), then OMP as a full agent (3.2). They're the smallest, they're
   measured, and they fix the Claude and OMP side of your status and notification complaints.
2. `submit --after` (4.1) and the first prompt at start (5.1). They're small, and Land and the
   review round both need them.
3. Land and Update (2).
4. The Review action (4.2).
5. What changed (5.2), setup on cut (5.3), Open in OMP (5.4), usage per agent (5.5).

Build each as a loomctl command first, then the PC button, then the phone, as with every feature
since `483eef0`.

## One question

Should Loom run the review round itself (4.2), or stop at `submit --after` and leave the loop in
the skill? It was open on 10-06 too. Everything else here has a default I'd go with.

## Sources

Your prompts: 627 typed and 98 relayed, from 93 Loom sessions, 09-09 to 10-11, pulled with
session-search. Sessions quoted: 81a64eaf, e3128490, 6e2d18b2, 41f63707 (what changed, API
credit), a3889c40 (watchers, astra status), ad417be1 (phone notification), 2a4e30d1 (progress
bar), b5519127 (snipping), 931da78b (reviewer comparison).

Code: `src/agent.ts:15`, `src/main.ts:1569`, `1827`, `2213`, `2602`, `9279`, `9299`, `9542`,
`src-tauri/src/remote.rs:486`, `src-tauri/src/usage.rs:232`, `scripts/update.ps1`, the
loom-operator skill's `review-loop.md`.

Probes, 2026-10-11: OSC 7501 against Claude Code 2.1.296, OMP 18.8.9, Codex 0.162.1 and OpenCode
2.0.19. `omp --from-claude` with a scratch Claude session, deleted afterwards.

OSC 7501: https://mitchellh.com/writing/program-status-osc7501,
https://superlogical.com/rex/docs/build/program-status.

Competitors, checked 2026-10-11: https://github.com/openwong2kim/wmux,
https://github.com/stablyai/orca/releases, https://conductor.build/changelog,
https://superset.sh/changelog, https://github.com/generalaction/emdash/releases, https://paseo.sh/changelog,
https://cmux.com/docs/changelog, https://code.claude.com/docs/en/changelog,
https://github.com/openai/codex/releases, https://docs.factory.com/changelog/release-notes,
https://offrun.dev, https://github.com/andyrewlee/awesome-agent-orchestrators.
