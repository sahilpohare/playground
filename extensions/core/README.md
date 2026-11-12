# Core

Playground's own skills, which every session gets; core's upstream skills are listed in its NOTICE.

Every promoted skill has an entry here and in the top-level `README.md` (the name linked to its `SKILL.md`, grouped into **User-invoked** and **Model-invoked**), plus a docs page at `docs/playground/<name>.md` written per [.agents/writing-docs.md](../../.agents/writing-docs.md); adding, renaming or changing a skill re-syncs all three.
An internal worker (called only by another skill or an ops job) gets a docs page linked from its caller's and no README entry; one an ops job types keeps the default `user-invocable` ([.agents/invocation.md](../../.agents/invocation.md)).

## Model-invoked

Model- or user-reachable.

- **[agent-desktop](./skills/agent-desktop/SKILL.md)**: Operate a desktop app through the agent-desktop CLI (computer use through the macOS accessibility tree): check its install and grants, load the binary's own docs, and keep to Playground's guardrails: headless, the owner's apps untouched, desktop content private.
- **[code-review-loop](./skills/code-review-loop/SKILL.md)**: Review one PR as its reviewer session, round by round until it scores 5/5: the two axes of core's code-review (the right thing, built well), a score out of 5 checked against the ticket, inline comments, a re-review on every push, its own threads resolved, and a fresh full read before the last 5/5. Its recovery scan lists the open PRs whose head nobody has scored.
- **[plain-words](./skills/plain-words/SKILL.md)**: Write every text a person reads by two rules, ASD-STE100's sentence checks and an ELI5 read for a newcomer, and a message to the owner in its owner style, picture first. Every factory session loads it before it writes for a person (the **talk** rule).
- **[playbook](./skills/playbook/SKILL.md)**: Run Playground's factory of herdr sessions by one set of rules: the roles (the dispatcher, the Planner, the two leads Builder and Ops, the Optimizer, the Assistant, workers with their reviewers and testers, runners, probes), who reports to whom, how work is routed and bundled, how sessions start and end, the leads' sweep, and the standing rules every session keeps.
- **[pr](./skills/pr/SKILL.md)**: Use when writing a PR body.
- **[shell-pane](./skills/shell-pane/SKILL.md)**: Run a command in a plain shell pane with no Claude in it, on the playground-probes herdr server: open a pane, run a command that every Bash guard has passed, read its output and exit status back (unknown with no exit marker, never a pass), and close the pane. It suits a step that needs a terminal that outlives one tool call, never a login or anything that waits on a keypress.
- **[to-inbox](./skills/to-inbox/SKILL.md)**: Write every message the owner reads at a glance, an Inbox item or a reply in chat, Slack or Yard: a picture of the point first with a short note (a diff, an ASCII drawing, before and after shots, a work status block, or an HTML demo page), then emoji bullets in plain words (the plain-words skill), one callout when a fact must not be missed, what Approve does on a card, each drawing within the card's width, and times in the owner's zone. Every factory session loads it before every `playground ask new` and every message to the owner (the **talk** rule).
- **[yard](./skills/yard/SKILL.md)**: Read and post to Yard, the hosted chat of channels and DMs, from this Mac with `playground yard`: sign in with a token, list channels, read one, post to one, and answer a Yard mention the Inbox shows.

## User-invoked

Reached only by typing them.

- **[core-audit](./skills/core-audit/SKILL.md)**: Check that Playground's core holds nothing beyond its generic self: no linked org's terms, read at run time from the extensions, and no value or process shaped like one org's. Report each hit by its place and kind, never its text, then fix them in one PR and keep the run as an audit doc.
- **[setup](./skills/setup/SKILL.md)**: Check and set up what the skills need on this machine: the command-line tools and the gh login, the home skill set, and each extension's own needs through its setup check. Run once on a new machine, or when a skill fails for a missing tool or connection.
