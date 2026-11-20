---
decisions: [i706]
---

Every session compacts in one {context.window}-token window, GLM's included (a local session in a 120000-token one, inside its model's context), and carries on under its name; after a compaction it loads playbook again and rereads its roster entry, open Inbox items and PRs' states before it acts.
One window for every session keeps cost even, since every turn re-reads the whole context and a long tail of large turns costs the most.
The reread adds the decisions register, `.agents/decisions.md`, so a settled decision is carried rather than argued again.
A resume, unlike a compaction, ends the session's background tasks, so a resumed session first starts each one again and re-sends every message that got no reply in the minutes before the restart.
Done when the session's next action follows from its roster entry, its open Inbox items, its PRs' states and the skill, each reread, and after a resume every background task it ran is running again and each unanswered message has gone again.
spawn.sh sets the window on every start and both settings files set it for every other session (playbook's SPAWN.md, Role and settings), and the `after-compact`, `after-resume` and `rules` hooks put these instructions in front of a session (`scripts/hooks/README.md`).
