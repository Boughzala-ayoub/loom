# Prior art for stronger Loom product bets

The strongest direct demand is cross-provider coordination. On September 12 the user asked, "what is the best way to introduce orchestration in loom ... take in consideration multiple harnesses." On October 4 they asked to "control loom completely with a session like this one, watch ... create threads panes." Sources: `00edd06f`, turn 0; `a3889c40`, turn 484.

| Candidate | Prior-art verdict |
|---|---|
| Two competing implementations, compare and choose | Already proposed as "Best of N" in `docs/improvement-study.md`, October 6, section 3.3. No direct user request or completed implementation established. A comparison screen with test results would extend that earlier suggestion. |
| Cross-provider task handoff | Cross-provider orchestration is explicitly wanted. A related same-provider handoff already exists outside Loom: on October 10 the user selected a cold-cache Claude mod with a short handoff into a fresh session. The assistant reports `/handoff` summarizes, clears, and puts an editable summary in the prompt. Source `c698af19`, turns 124 and 150. Do not claim handoff is entirely new; transferring work between providers remains distinct. |
| Phone live web preview plus screenshot/element feedback | No exact prior proposal or direct request found. Basic phone screenshot attachments already shipped. The earlier study deferred a desktop browser, but that does not settle this different workflow. Frame it as inspecting an agent's running app and sending precise corrections from the phone. |
| Catch-up since last viewed | Adjacent idea already proposed September 9: transcript viewer answering "what did this agent do while I was away." Source `d0adbf61`, turn 15. No exact since-last-viewed summary found. Make the distinction explicit: changes and decisions since the user's last visit, rather than another transcript viewer. |
| Shared project decision notes | No exact product proposal found. A coordinator previously wrote `loom-control-state.md` to preserve task IDs, assignment reasons and unresolved decisions across compaction. Source `a3889c40`, turn 92. This is an assistant workaround, not direct user demand, but it identifies information Loom's task journal did not preserve. |
| Fixed builder/reviewer/checker team | Review/fix loops were previously proposed and operated through loom-operator. Broad orchestration demand is direct; this exact three-role preset is unvalidated. Treat it as a concrete product form of an existing workflow, not a new category. |

One missed usability need is unambiguous agent identity: "thread and the pane type and pane order ... if it is a worktree ... the project that worktree was created on." Source `a3889c40`, turn 227. Teams and handoffs must make ownership obvious.

Skipped implementation verification. "No exact match found" means this targeted history pass found none, not proof the idea was never discussed.

## Source identifiers

Read these with the existing session-search tool, not by parsing raw JSONL:

`python C:/Users/ayoub/Videos/claude/session-visualizer-searcher/session_search.py --show <id> --json --from <turn> -n 3`

- `00edd06f-8697-4382-abf9-c353394403d0`, Orchestration in loom with multiple harnesses, September 12.
- `a3889c40-5465-4d83-a53a-f22e7ee87854`, Loom CLI control and overlayv3 thread panes, October 4.
- `c698af19-1a18-42c7-ac5f-5947829d2480`, Context X-ray mod, October 10. The session later switches to the cold-cache mod.
- `d0adbf61-aa86-4cd4-a088-6bac9fe60368`, Features to add, September 9.
- [October 6 improvement study](C:/Users/ayoub/Videos/claude/loom/docs/improvement-study.md), sections 3.2, 3.3 and 6.
