# Loom history and prior feature decisions

## What does the user repeatedly need?

### Takeaway

The clearest direct requests concern doing real work from a phone, seeing what agents are doing, preserving conversations after restarts, and avoiding hosting costs. These support product direction, but one person's requests do not establish public demand.

### Cited findings

- On 2026-10-06 at 07:54 UTC, the user rejected the Full Loom window mirror: "I don't like the full loom thing ... i want the real mobile experience but not loose features". The same message specifically asks for Changes, Usage and Preferences. The following assistant turn removes the mirror and plans native mobile screens. Source is session `43220ab2-75be-44c3-887a-c7dbaabd31f0`, turn 295. [Session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/43220ab2-75be-44c3-887a-c7dbaabd31f0.jsonl)
- On 2026-10-06 at 05:26 UTC, the user considered React Native but explicitly said "focus on cost, i don't want host fees". This is a direct constraint on their personal deployment, not proof that nobody would buy hosting. Source is session `ae9721e7-2287-469f-94d8-3643fe7b0c87`, turn 50. [Session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-loom-loom-mobile/ae9721e7-2287-469f-94d8-3643fe7b0c87.jsonl)
- On 2026-10-04 at 23:37 UTC, the user wanted the card to show "what i prompt it to do" and "how long it been working for", and said "i don't want to see the ctx thing". This was a request about card contents. It should not be stretched into a ban on optional context inspection. Source is session `a3889c40-5465-4d83-a53a-f22e7ee87854`, turn 855. [Session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/a3889c40-5465-4d83-a53a-f22e7ee87854.jsonl)
- On 2026-10-09 at 14:19 UTC, the user asked to paste screenshots from their Android clipboard and select photos in Loom's phone prompt and reply boxes. Their motivating workflow was an image from the separate overlayv3 snipping tool. They requested thumbnails, removal, multiple images, authenticated uploads, file-type validation and cleanup. Source is session `1852d617-88d9-4c90-996b-1ef7fcf2f4cd`, turn 178. This is already documented in the current README, so basic mobile attachments are not a new proposal. [Session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/1852d617-88d9-4c90-996b-1ef7fcf2f4cd.jsonl), [README](C:/Users/ayoub/Videos/claude/loom/README.md:278)
- On 2026-10-10 at 21:14 UTC, the user reported "can not resume omp session after closing and opening loom". The session's final response reports a fix that gives each pane a stable OMP terminal identity and adds `--continue` when restoring. The current README documents this behavior. Do not sell basic resume as wholly absent; cross-provider recovery quality remains a defensible area to assess. [Session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/ee5ac877-b847-4446-b2c1-f9a7a3baf6c1.jsonl), [README](C:/Users/ayoub/Videos/claude/loom/README.md:191)
- On 2026-10-10 at 03:17 UTC, the user asked for a Claude task-progress mod. At 04:12 UTC, they requested a Context X-ray mod listing prompt sections by size and allowing sections to be dropped for the rest of the session. These are requests for separate Claude modifications, not verified Loom feature gaps. They show interest in progress visibility and controlling context cost. [Progress session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/2a4e30d1-7615-44c5-8d58-9fb9391a50d3.jsonl), [Context session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/c698af19-1a18-42c7-ac5f-5947829d2480.jsonl)

### Inferences

- Improving phone review, unattended work, and recovery fits actual requests better than another visual theme or a generic dashboard.
- Agent cards should prioritize the task, elapsed time and next action. Deeper context information can remain optional.
- Public onboarding and distribution deserve their own assessment. The owner's ability to configure Tailscale and rebuild binaries does not prove new users will tolerate those steps.

### Gaps

- No customer interviews, usage analytics, installation funnel, or public willingness-to-pay evidence was available in this scope.
- The final OMP response says the real installed app was not restarted for its test. Current documentation confirms implementation intent, not installed-binary behavior.

## Which ideas were already proposed, shipped, or deferred?

### Takeaway

Most obvious worktree and orchestration ideas appeared in earlier lists. They can still be worthwhile, but the study should label them as prior proposals and verify current implementation separately. The October 6 ranking was an assistant recommendation, not an approved roadmap.

### Cited findings

- The October 6 study records prior idea lists from September 9, September 22, and October 5. It proposes setup on cut, per-thread ports, local Land, base drift and overlapping-file warnings, diff comments sent to agents, `submit --after`, best-of-N threads, send-at-quota-reset, stuck detection, and shell logs. These are already proposed. Setup was already proposed twice; port allocation, drift, stuck detection and quota-reset prompts also date to September 9. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md)
- After receiving that study, the user selected `npm test` and async `cli_reply` on October 6 at 20:38 UTC. The assistant's later outcome names commits `7e44eb3` and `da0b23c`, says both binaries were updated, and corrects its earlier overclaim: async commands do not solve a wholly stuck WebView2 window thread. This selection does not establish acceptance of the study's remaining feature list. Source is session `3661a791-028f-40f8-b0b7-f82d1676ef68`, user exchange around turn 44 and assistant outcome turn 116. [Session](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/3661a791-028f-40f8-b0b7-f82d1676ef68.jsonl)
- The October 6 study marks worktree deletion protection/trash, automatic Claude hooks, keep-awake, loomctl, mobile push, and the four-tab phone app as shipped from earlier proposals. Stable pane IDs were partial relative to user-chosen names. Current README describes groups, bulk messages, menu answers and previews too. Avoid presenting these as new standalone features. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md), [README](C:/Users/ayoub/Videos/claude/loom/README.md:138)
- The earlier study proposed several explicit revisit conditions. Allocate ports when multiple threads run development servers. Add archive scripts when real teardown work exists. Add a browser when the user repeatedly switches to Chrome for a thread's server. Add PR/CI when the workflow begins to use pushed branches. These are assistant-proposed triggers; the history reviewed does not prove they have fired. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md)
- The study says the review/fix loop lived in the loom-operator skill rather than Loom. It proposes a durable dependency queue first, then deciding whether Loom should own the loop. Treat a durable review loop as previously proposed, and distinguish it from the already-existing loomctl task journal and task commands. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md), [Current task documentation](C:/Users/ayoub/Videos/claude/loom/docs/loomctl.md:962)

### Inferences

- The strongest continuation candidates are thread preparation, safe completion of thread work, and fewer manual handoffs between agents. They are continuity with the prior study, not fresh discoveries.
- For the public-product track, the previous exclusion of PR/CI should be reopened. The old rationale was the owner's local fast-forward workflow, not a direct rejection of all GitHub integration by future users.
- Sizes in the earlier study are guesses. Do not repeat its one-day or two-week estimates as measured delivery commitments.

### Gaps

- The code inventory researcher must establish which October 6 gaps are still open on October 11. This researcher did not duplicate that audit.
- Broad parked/decision queries were noisy because invoked skill text appears in the session index. The actual exchanges and dated outcomes were read before treating a hit as a decision.

## Which prior decisions should constrain this study?

### Takeaway

Keep the mobile interface adapted to phones and preserve a deployment option without hosting fees. Do not let stale assistant advice override newer direct requests.

### Cited findings

- The earlier study suggests possibly deleting dictation. That is stale. On October 7 at 14:33 UTC the user explicitly instructed an agent to build phone dictation, share language and prefix selections with the PC, transcribe on the PC through Whisper, and test its mobile UI. The current loomctl documentation describes the shared language/prefix controls and phone microphone. [Direct request](C:/Users/ayoub/.claude/projects/C--Users-ayoub-loom-loom-phone-dictation/22c558aa-3e8e-47b0-a235-66283c5ad000.jsonl), [Current documentation](C:/Users/ayoub/Videos/claude/loom/docs/loomctl.md:585)
- The prior study's exclusions include an MCP wrapper, cloud sandboxes, multiplayer, a custom chat view, and a built-in browser. These appear under "What I'd skip" and should be described as prior assistant advice, not as user vetoes. The report's local-only, sole-user premise is particularly limited now that the current scope includes a public product. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md)
- The prior study records removal of `loomctl trash restore` in `5173850`, a native title-bar restoration in `8a29016`, and replacement of ntfy with Loom Web Push. These were not independently replayed from their original sessions here. They should be treated as documented history requiring verification before reversal, not as newly proven user preferences. [Earlier study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md)
- The October 6 session later restyled themes and reported two theme commits. It says the user preferred subtle colors, while a final question about removing four novelty themes remained unanswered. Thus "remove all loud themes" is not an accepted task found by this research. [Session outcome](C:/Users/ayoub/.claude/projects/C--Users-ayoub-Videos-claude-loom/3661a791-028f-40f8-b0b7-f82d1676ef68.jsonl)

### Inferences

- The personal and public priorities should share the core but have separate gates. Personal automation can be justified by repeated use; public features need evidence from other users.
- A context-cost feature should state which providers and data it supports. The requested Claude mod can intercept information that a provider-neutral terminal workspace may not have.

### Gaps

- Search used the existing tool at `C:/Users/ayoub/Videos/claude/session-visualizer-searcher/session_search.py`; the skill's `Videos/Codex` path is stale. To reproduce a source, use `python <tool> --show <session-id> --json --find <phrase>` or the cited turn range. Session files were not parsed directly.
- No source code changed. No runtime, responsive UI, or competitor claims were tested in this history-only pass.
