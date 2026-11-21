# The factory takes every step it can from the owner

Five steps went to the owner because a rule said so, not because only the owner could take them: setting a guard's tuning value, writing to an extension repo, restoring a lost main checkout, answering a permission prompt a standing rule already settles, and picking a session's model and effort. The owner's standing direction is that the factory takes every step it can and involves the owner only when truly blocked. The owner approved moving all five in Inbox #i455.

## Decision

- **Model and effort are the lead's pick.** A lead picks each session's model and effort as it starts or resumes it, by brief-rush's model rule (`scripts/briefs/brief-rush.md`), through spawn.sh's `--model` and `--effort`. The owner keeps the menu beside a dispatcher's, the Assistant's and the hosted session's composer, and the owner's word in the **override** shape outranks both (playbook SKILL.md's Chain, SESSIONS.md).
- **A lost main checkout restores itself.** ops-restore (`packages/scripts/src/ops-restore/cli.ts`), a launchd job with no hook that runs from the Dashboard's checkout, runs LIFECYCLE.md's restore steps once a registered guard's bundle and source are both gone on two looks 5 minutes apart, while no run slot's holder runs the main checkout's upkeep. It keeps the checkout's `git status` before it throws anything away, and tells ops and the dispatcher what it did or which step stopped it.
- **The Ops lead sets a guard's tuning value.** no-extensions-write lets the Ops lead (`opsLead` in `scripts/hooks/role.ts`) set the two guard settings that only tune a number, `glm.readOnlyLoad5` and a `jobs.<name>` row's interval, on a line that holds the `playground` call alone; every other guard setting stays the owner's Approve (scripts/hooks/README.md's no-extensions-write).
- **An extension repo's pull request lands through the factory.** no-extension-repo-write lets a session push a branch other than the default by its remote and refspec, and `bun run ext:merge <owner>/<repo> <n>` (`packages/scripts/src/ext-merge/`) squash-merges its pull request once a reviewer session other than its author has scored it 5/5 at its head and its checks have passed (scripts/hooks/README.md's no-extension-repo-write).
- **A manager answers a settled permission prompt.** A manager answers a prompt a standing rule settles with `playground picker <session> allow|deny <key> --rule <name>`, which refuses a name no rules file holds and records the rule in `ops/picker.log` and a deny's message; a prompt no rule settles still goes to the dispatcher as a decision (playbook SWEEP.md step 3, SESSIONS.md).

## Consequences

- With all five shipped, the owner's `!` window is no longer a step in any playbook route they touched; a step that still needs the owner is a true block or a one-way door, brought up the chain.
- ops-restore rewrites the main checkout with no one watching, so it acts only on two looks in a row, waits while upkeep holds the checkout, and stops at the first failed step, told once, until the guards are back.
