# Make Loom carry work between agents

October 11, 2026.

**For your daily work, add "Continue with…" and "Request a second opinion" across providers. For public adoption, test whether phone access to the running app makes Loom worth choosing.** These extend what Loom already does well: keep several local agents and their worktrees accessible. They solve different problems. Handoff removes the reconstruction needed when changing agents; phone preview lets someone judge the actual result while away from the PC. Both need trials before becoming a roadmap. Catch-up after an absence is a useful supporting feature.

Your September 12 request explicitly asked for orchestration across multiple harnesses. That is stronger personal evidence than a competitor checklist. A same-provider handoff also exists in your separate Claude mod, so the new capability here is carrying work between providers inside Loom. Public demand is less certain. The phone preview proposal has no direct request in the targeted history search. [History evidence](<C:/Users/ayoub/Videos/claude/loom/research_notes/Loom product bets/history.md>)

| Addition | Personal daily value | Public attraction | Implementation confidence |
|---|---|---|---|
| Continue with another provider | Highest | Strong for people who switch often | Medium; ownership transfer needs care |
| Request a second opinion | High | Clear, easy to demonstrate | Medium; constrain reviewer writes |
| Inspect running app from phone | High for web projects | Strongest candidate to test | Low until transport prototype |
| Catch up since last visit | High during unattended work | Supporting reason to stay | Medium; durable evidence missing |
| Compare two implementations | Selective | Familiar capability | Medium; fair comparisons are difficult |
| Builder/reviewer/checker preset | Unproven incremental value | Unproven | Trial through existing controls first |

These are product judgments, not measured demand or delivery estimates. Priority and build order differ: the editable brief and second-opinion action can validate context transfer before continuation transfers control of the worktree.

**Continue with another provider.** Claude has made progress but repeats an unsuccessful fix, or reaches a usage limit. You choose Codex, review a brief, and continue in the same worktree. Today Loom has provider panes and session resumption, but no cross-provider continuation workflow. Its `messages` command returns only the last prompt and answer, each truncated to 500 characters. That cannot recover the decisions made throughout a task. [Current behavior](<C:/Users/ayoub/Videos/claude/loom/src/main.ts:9151>)

The smallest useful version asks the outgoing agent for an explicit brief: objective, constraints, decisions, failed attempts, unfinished work, and unknowns. Show it beside the current diff, let you edit it, then launch the selected provider with the worktree and next action identified. If the original agent is unavailable, use a human-authored brief. This transfers visible context, not hidden model memory. The outgoing writer must be idle before the next starts; ambiguous state must block continuation. Keep the original session available. [Existing pane and resume foundations](<C:/Users/ayoub/Videos/claude/loom/research_notes/Loom product bets/product.md>)

The hardest risk is an incomplete brief that looks authoritative. Try five real switches. Record every correction caused by an omitted constraint or wrong destination. Continue only if the receiving agent starts useful work without those repairs in most cases, with no overlapping writers. Frequent brief rewriting would argue for improving the brief before adding automation.

**Request a second opinion.** Before accepting a difficult change, ask another provider to challenge one specific claim: "Could this cancellation path lose work?" Reuse the editable brief, selected diff, and relevant check output. Return a bounded review; let you send selected findings to the original agent. This adds a guided operation to today's separate panes without requiring a permanent team.

The reviewer must inspect a captured code state with enforced write restrictions or an isolated snapshot. A prompt saying "do not edit" is insufficient. The hardest risks are reviewing a moving target and generating plausible but irrelevant objections. Trial five uncertain changes. Keep the feature if you accept findings that change the implementation or decision on at least two, and the review takes less effort than arranging it manually. That is a proposed decision rule, not a correctness benchmark.

**Inspect the running app from your phone.** An agent says a layout is fixed. Open that thread's web app on your phone, circle the broken control in a screenshot, and send the correction to its agent. Loom's current live preview shows the terminal. Image attachments already exist, but app capture, annotation, and association with a running server do not. [Terminal preview](<C:/Users/ayoub/Videos/claude/loom/src/main.ts:3977>), [image attachment code](<C:/Users/ayoub/Videos/claude/loom/src/remote/images.ts:1>)

Start with web projects and one explicit development URL per thread. Open an ordinary browser and send an annotated screenshot with its URL, viewport, worktree, and destination pane. Show which server supplied the result. Reuse image upload and guarded submission. Browser inspection itself is established elsewhere: cmux documents screenshots, DOM inspection, viewport emulation, and browser input. Loom's candidate advantage is completing this feedback loop from a phone. [cmux browser commands](https://github.com/manaflow-ai/cmux/blob/main/docs/cli-contract.md)

Phone access to PC localhost is the feasibility gate. The prototype must authenticate access, isolate untrusted app content from Loom's privileged controls, and preserve branch/port identity. No general browser engine or IDE is needed. On five real UI fixes, test whether you can inspect the correct app and send an actionable correction without returning to the PC. Then repeat with outside Windows users. Proceed only if they complete the loop and choose it again; a convincing demonstration alone is weak demand evidence.

**Catch up since you last looked.** Return after lunch to several active threads and see newly completed, failed, or uncertain tasks, changed files, and unanswered questions. Each item opens its evidence. Today's `seen()` clears a waiting flag; it does not save a reviewed revision or event cursor. Begin with an explicit "Caught up" action and the existing durable task events. Check evidence needs additional storage. [Current gap](<C:/Users/ayoub/Videos/claude/loom/research_notes/Loom product bets/product.md>)

The difficult part is distinguishing observed progress from agent claims. Idle must not mean done, and a passed check must identify the code it checked. Compare three unattended runs against today's Overview. Build further only if you identify needed interventions faster without missing any. This extends the earlier transcript-viewer idea by focusing on changes since your visit. [Prior proposal](<C:/Users/ayoub/Videos/claude/loom/research_notes/Loom product bets/history.md>)

**Keep two larger ideas as experiments.** For an ambiguous task, run two implementations from the same committed base with identical, independently chosen checks. Review both results and choose manually. Cursor already offers best-of-N worktree workflows, and Loom's October study proposed it. Its value here must justify extra execution and review time. Try three difficult tasks through existing threads; build a comparison view only if the second candidate changes your choice repeatedly. [Cursor worktrees](https://cursor.com/docs/configuration/worktrees), [earlier study](<C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md>)

Likewise, trial one builder/reviewer/checker round through `loomctl` before building native orchestration. Compare three runs against your current operator workflow. Stop if manual intervention does not fall. Coordination overhead, token use, and file conflicts are documented costs of agent teams. [Claude Code teams](https://code.claude.com/docs/en/agent-teams)

I would build the shared brief and second opinion first, then continuation, while testing phone-preview feasibility separately. Add catch-up when unattended use warrants it. Shared project decisions should start in existing project instruction files. Installation and update delivery remain public-release prerequisites, outside this feature ranking.

No runtime feasibility or customer demand was validated. The main unresolved risks are context omissions, competing writers, and secure phone access to the correct development server.
