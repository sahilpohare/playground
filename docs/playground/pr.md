## What it does

`pr` writes a pull request's body to one template: a `## TL;DR` of a few bullets in [plain words](./plain-words.md) on top, then Summary, Evidence and Merge Danger, with `## Links` last.
The template is the whole skill: it holds the shape and what each section is for, and leaves what goes in it to the session writing the body, so a body reads the same whichever session wrote it.

## When to reach for it

| You want                    | What happens                                         |
| --------------------------- | ---------------------------------------------------- |
| To open or update a PR body | the agent writes it in the template unprompted       |
| To type it yourself         | `/pr` puts the same template in front of the session |

## The template

Abridged from [its file](../../extensions/core/skills/pr/SKILL.md):

```markdown
## TL;DR

- <a few short bullet points by the plain-words skill: what changes, and why>

## Summary

<diagram, diff-sketch, or tree>

## Evidence

- **Before:** <screenshot/output/failing test run>
  **After:** <screenshot/output/passing test run>

## Merge Danger

**Door:** <one-way or two-way>

<optional: description>

**Blast Radius:** <one-word description>

## Links

<tickets, issues it closes, docs, related PRs; a ship-now PR not titled fix( adds a line opening Owner ask: with the owner's Inbox #i id, PG issue or quoted words>
```

The first TL;DR bullet is load-bearing: the Changelog reads a merge's line from it, and the body gate in `bun run pr:merge` and merge-on-ready reads the body against the template it sits in.

## Common questions

**Why is this skill someone else's?**
It is upstream's `pr` skill with a TL;DR, an Evidence note and a Links block added; core's NOTICE and the skill's CREDITS.md name its source and its credits, and a drift test holds the file to upstream plus those three blocks, so an edit beyond them fails `bun run test`.

**What may a review change about a body or the template?**
Nothing in the template: it is settled by the owner, and [code-review-loop](./code-review-loop.md) scores only that a body fills it and speaks in what the owner sees.

## It's working if

- The PRs you open read in the same five sections, and a reviewer finds the proof under Evidence and the risk under Merge Danger without asking.
- A merge's Changelog line comes straight off the TL;DR with no second write.
- A body whose code reads live machine state shows one read-only run of that code on the live layout, its output beside the injected stub, under Evidence.

## Where it fits

Every skill that opens a PR leans on it: an org's ticket skill, in its extension, writes its PR bodies with it, and [code-review-loop](./code-review-loop.md) reads a body against it before it scores.
