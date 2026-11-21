# Shipping a Playground PR: the body and the pre-review pass

AGENTS.md's Shipping a Playground PR, step 1, points here: read this before you write a Playground PR's body, and again before the review's round 1.

The body is written with the [pr](../extensions/core/skills/pr/SKILL.md) skill, called through the Skill tool: a `## TL;DR` of two sentences or more on top, then its Summary, Evidence and Merge Danger, then `## Links` last.
Its TL;DR is in plain words: what the owner sees or can do now, in words a person uses, with no factory or code jargon such as pane, slot or jsonb.
The body gate (`packages/scripts/src/pr-merge/body.ts`, read by Checks, `pr:merge`, merge-on-ready and the train) takes the template, a TL;DR with no `Outcome:` label, and Evidence with an `A/B:` line, no `TBD`.
That line opens with `A/B:` exactly, colon included (`abLine()` in `body.ts`), so `- A/B, red at canary` fails the gate; `bun run pr:merge <n> --explain` before round 1 prints the body gate's verdict.
The Changelog (`api/hono/src/plugins/changelog/sources.ts`) reads a body's `Outcome:` line, else the TL;DR's first bullet or a prose TL;DR's first sentence.
Before the review's round 1, settle in your own pass what a round should never spend its turn on (most late findings were docs, skill, body and wording ones): run doc-sync over the change, give each touched doc and skill a writing-for-agents read,
and fill the template above; the reviewer still judges everything.
When the diff adds a member to an enumerated kind (a status, a type, a choice, a button), grep the repo for the wording of every list that names that kind's members and update each hit: one such grep once found what six rounds had found.
As part of that doc-sync pass, write each term as one regex over its spellings (possessive, plural, hyphenated), such as `card('s)? width`, then
run the changed-term grep for each term whose meaning the diff changes (a behaviour, a rule, what a command does): `git grep -lE <term>` over the whole repo, code and help text too, then fix each hit on the old meaning, since one PR took 7 rounds, one doc a round; name each kept hit, read in context, by line and reason in Evidence.
After you merge `canary` into the branch, run that grep for what the incoming commits changed: list each term whose meaning they changed (`git log -p HEAD^1..HEAD^2` while the merge commit is `HEAD`), grep the PR's own changed docs for each,
and fix every line still describing the old meaning in a commit after the merge before you ask for the next round, since stale lines from a merge once cost two docs-only rounds; done when no line of the PR's docs describes a meaning those commits changed.
When the PR moves text out of a file, run `git grep -n <old file name>` over the whole repo too, code comments, `scripts/hooks/README.md` and `.agents/dashboard/` included, and check each hit against the moved text at the old base, since one PR's greps kept to one folder and missed 7 hits, which cost two rounds.
Done when the body's Evidence names each touched doc and skill by its full repo path with its check, doc-sync's result and each list grep and changed-term grep with its hits, the moved-text grep's included, before the review's round 1 opens.
