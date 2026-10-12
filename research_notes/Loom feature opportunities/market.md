# Market evidence and feature opportunities

## What has become baseline, and where can Loom compete?

### Takeaway

Loom should sell a complete Windows workflow for people supervising several local coding agents. Multiple agents, worktrees, notifications, and phone access already appear in competing products. The stronger hypothesis is that Loom can make the handoff from "agent stopped" to "I reviewed and accepted this change" easier to trust.

Research checked official documentation on 2026-10-11. These are documented capabilities, not hands-on product benchmarks. Pages generally provide no publication date. Warp's remote-control page says updated 2026-10-07; its agent-management page says updated 2026-10-09.

### Cited Findings

| Product | Verified capability | Meaning for Loom |
|---|---|---|
| Conductor | Separate task workspaces with branches, terminals and diffs; setup/run scripts; agent context attachments; review, PR, merge and archive flow. Its documentation directs installation on Mac. | Worktree creation alone is baseline. Setup and review are established parts of the product promise. [Introduction](https://www.conductor.build/docs), [First workspace](https://www.conductor.build/docs/first-workspace) |
| Superset | Worktrees, existing-worktree import, PR-linked workspaces, and workspace state views. Its install guide supports macOS, calls Linux experimental, and explicitly says Windows is unavailable. | Windows remains a plausible segment. Importing existing work lowers adoption cost. [Workspaces](https://docs.superset.sh/workspaces), [Install](https://docs.superset.sh/install) |
| cmux | macOS terminal with agent notifications, a pending-notification list, scriptable browser panes, sidebar branch/PR/port information, project commands, SSH and CLI automation. | Notifications and programmable terminal control are established category features. A browser tab would be parity work, with substantial scope. [Official repository](https://github.com/manaflow-ai/cmux) |
| Warp | Remote control publishes third-party agent sessions, including Claude Code, Codex and OpenCode, for monitoring and input from a browser or phone. Session state uploads to Warp's cloud; view and edit access differ. | "Control any agent from your phone" is already marketed elsewhere. Loom's existing Tailscale architecture and Windows focus need a more specific pitch. [Remote control](https://docs.warp.dev/agents/cli-agents/remote-control) |
| Claude Code | Remote Control keeps execution on the user's machine, syncs across phone/browser/terminal, supports attachments, and reconnects after interruption. Its server mode can create worktree sessions. Transcripts are stored on Anthropic servers while connected. | Do not compare against early, one-session Remote Control limitations. Multi-provider supervision remains a distinction relative to Claude alone. [Remote Control](https://code.claude.com/docs/en/remote-control) |

Loom already documents worktree and open-checkout threads; Claude, Codex and OpenCode; waiting-first Overview with inline replies, guarded menu choices, groups and broadcast; phone Activity, Changes, Usage and Settings; dictation and attachments; Git actions; persistent task IDs and idempotent submissions. These should be described as assets to improve, not new proposals. [Local README](C:/Users/ayoub/Videos/claude/loom/README.md)

The October 6 study already proposed setup-on-cut, port allocation, local Land, branch overlap, diff feedback and `submit --after`. It records a preference for local landing and avoiding hosting costs. These historical findings need current confirmation before treating them as permanent constraints. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md)

### Inferences

- Positioning hypothesis: "Run Claude, Codex and OpenCode on your Windows machine; review and answer them from one place, including your phone." This fits the documented implementation. It is not proof of market demand or exclusivity.
- The likely product advantage is fewer missed decisions and fewer uncertain handoffs, not a larger number of simultaneous terminals.
- Prioritize Windows installation and integration reliability before a Mac/Linux port. The reviewed Mac-focused tools establish an opening, but this review does not establish how large that opening is or exclude Windows competitors.

### Gaps

No interviews, willingness-to-pay evidence, churn data, support-ticket counts, independent reliability benchmarks or market-size estimates were collected. Competitor documentation proves shipped intent, not user satisfaction. The sample is five relevant products, not an exhaustive market map. Do not call Loom the only Windows option or the only private remote option.

## Which additions could improve daily work?

### Takeaway

The best daily-work candidates close small gaps around existing threads and tasks. Reuse the task journal, shell receipts, Git panel and Overview. A generic automation builder would be premature.

### Cited Findings

- Superset's project lifecycle configuration has setup, teardown and run commands. Its optional "wait for workspace setup" mode starts the agent only after setup succeeds. [Project lifecycle scripts](https://docs.superset.sh/setup-teardown-scripts)
- Superset detects listening ports per workspace and supports labels. Deterministic port ranges remain a setup/teardown-script recipe in its docs. [Port management](https://docs.superset.sh/ports)
- Conductor supports line-specific diff comments sent to an agent and displays GitHub review comments. [Diff viewer](https://www.conductor.build/docs/reference/diff-viewer)
- Superset's scheduled-run success means a workspace was created. It explicitly does not track whether the agent's work succeeded, documents possible duplicate dispatch, and records offline hosts as failed runs. [Automations](https://docs.superset.sh/automations)
- Warp exposes run states and command/log/output context. Its documentation says a parent's status covers its own work, so a successful parent can coexist with running or failed children. [Managing cloud agents](https://docs.warp.dev/platform/managing-cloud-agents/)
- Superset's cross-agent handoff seeds a fresh session with recent context. The docs warn that terminal output is not redacted and may include credentials; conversation forks share files. [Agent sessions and forking](https://docs.superset.sh/agent-sessions)

### Inferences

These are proposals, not confirmed absences. The coordinator's source audit should validate the extension points before implementation.

| Candidate | Smallest useful version and example | Existing Loom overlap | Pitfall and validation |
|---|---|---|---|
| 1. Runnable new threads | One project setup command, one run command, setup log and explicit retry. Starting a new worktree installs dependencies before the coding agent starts. | Extends worktree creation and shell receipts; repeats an October 6 proposal. | Repo commands are executable code. Require deliberate project setup, retain errors, and never mark a failed setup ready. Measure time from thread creation to first useful edit. |
| 2. Reviewable task results | A task detail row shows submitted prompt, agent's reported outcome, current diff, and separately recorded verification command, exit result and code version. Example: "turn finished; npm test passed against this revision; review pending." | Extends durable tasks, receipts and Changes. | Turn completion is not correctness. Tests can pass against old code or omit the requirement. Mark evidence stale after edits, and display unknown honestly. Measure how often the user reopens a terminal to discover what was actually checked. |
| 3. Diff feedback to the right agent | Select a changed line, add a note, collect notes and send once to the relevant pane with file/line/diff context. | Existing diff viewer and guarded send; already proposed October 6. | Changed files can make anchors stale. Preserve the selected excerpt/revision and preview the outgoing message. Measure review-to-fix interactions. |
| 4. Bounded review/fix sequence | One named sequence: implement, request review, then offer to send findings back. Display dependencies and stop on approval, failure, unknown state or a small explicit iteration cap. Start with one dependent submission, not a graph editor. | Builds on `submit`, journal, idempotency and proposed `submit --after`. | An agent saying "done" must not auto-merge. Restart and retries must not submit twice. Validation should cover restart, duplicate dispatch, approval and no-progress loops. |
| 5. Previewed cross-agent handoff | "Continue with another agent" prepares an editable brief with objective, decisions, pending work, branch and selected evidence. Show what will be sent and let the user exclude text. | Uses existing multi-provider panes and message reads. Confirm whether previous work already provides this flow. | Do not claim to transfer hidden model state. Avoid dumping raw terminal history with secrets. Sharing files means two writers can conflict. Compare handoff correction effort with manual copy/paste. |
| 6. Thread services and ports | Show just the processes Loom starts for a thread, their known listening ports and a run/restart action. Opening a preview uses the user's existing browser. | Extends run commands and existing Task Manager; port allocation was previously proposed. | System Task Manager is already present. This proposal adds thread ownership, not another general monitor. Do not kill unrelated processes or claim every detached child is owned. Test two simultaneous worktrees running the same project. |

Personal priority: runnable threads, review evidence, then diff feedback. Use the bounded sequence only after task completion and evidence semantics are reliable. A handoff is useful if changing providers or exhausted sessions is common. Services/ports are useful once concurrent dev servers create actual friction.

### Gaps

No current task-duration or review-time baseline was measured. Relative priorities above are judgments from the documented workflow, not quantified ROI. The earlier study includes local Land and overlap detection; retain those in the full ranking even though this market note concentrates on other evidence. Do not assign implementation-day estimates from this research alone.

## Which additions could help Loom become a public product?

### Takeaway

Public-product work should first reduce the effort needed to try Loom successfully. A newcomer should be able to install it, find their agents, open existing work and understand a broken connection without the maintainer's help. PR-related work belongs in this track even if the owner's personal workflow stays local.

### Cited Findings

- Superset's onboarding detects prerequisites and updates as missing tools are installed or authenticated. Its update guide describes automatic update checks. [Install](https://docs.superset.sh/install)
- Conductor's Checks tab brings together Git state, PR metadata, CI, deployments, comments and todos. Available sections depend on integrations and repository state. [Checks](https://www.conductor.build/docs/reference/checks)
- Superset can bulk-import existing worktrees without rerunning setup by default. Its workspaces can link PRs and show review/check information. [Workspaces](https://docs.superset.sh/workspaces)
- Loom's README requires CLI tools on PATH, describes an unsigned Windows installer and a maintainer-oriented local update command, and documents a multi-step Tailscale remote setup. These are documented adoption surfaces; the README alone cannot prove whether every corresponding UI assistant is absent. [Local README](C:/Users/ayoub/Videos/claude/loom/README.md)

### Inferences

| Candidate | Smallest useful version and example | Scope boundary | Validation |
|---|---|---|---|
| 7. First-run checks and shareable diagnostics | Detect Git, available supported agents, WebView2 and supported versions. Offer one "open a checkout" path and a redacted diagnostic export. A remote checklist reports local server, Tailscale exposure, pairing and phone reachability separately. | Use detection already present. Avoid silent installs, credential export or building a managed relay. Signing and a trustworthy update channel are public-release prerequisites to investigate, not a reason to build a new feature platform. | Watch five Windows users set up without intervention. Record first successful task and reasons they stop. |
| 8. PR review status beside an existing thread | Attach a GitHub PR URL/number, show checks/review state and an explicit "send this feedback to agent" action. Start with read-only status and manual forwarding. | Extend current GitHub compare-page/PR path. Do not build issue tracking, broad team permissions or automatic merging in version one. | Pilot with people who already work through PRs. Measure browser switches and missed review feedback. |
| 9. Bring existing work into Loom | Discover Git worktrees under a chosen repo, preview branch/path and open selected ones without changing files or rerunning setup. Offer documented session resume where provider IDs are known. | Extends Open checkout, not another project format. Cross-product transcript conversion is out of scope. | Try real existing worktrees, dirty folders and missing branches. Success means users can try Loom without rebuilding their workspace or risking uncommitted work. |

Recommended validation order: first-run checks, existing-work import, then PR status for external testers. Reviewable task results and phone supervision can support the public pitch after the underlying behavior is demonstrated. Do not lead with more agents, a marketplace, subscriptions, team chat, cloud execution or a new embedded IDE.

### Gaps

No external tester cohort, install analytics or support history was available. Code signing, distribution and update requirements were not investigated technically. No pricing or revenue recommendation is supported by this research. The market evidence does not establish that users want a separate paid manager rather than the tools they already use. Five short observed onboarding sessions and a two-week usage trial would test that before building costly collaboration or hosting features.
