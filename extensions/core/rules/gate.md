---
decisions: [i541]
---

A Playground PR reaches `canary` only through `bun run pr:merge <n>` or merge-on-ready, at a head with code-review-loop's 5/5 and GitHub's `Audit, Lint, and Build` and `test` checks green.
An independent reviewer, not the owner, is what lets a change land, so the 5/5 comes from a reviewer session other than the author, and an override never lowers it.
A round left with only nits scores 5/5, the reviewer listing them or handing the worker a checked patch, and making no commit on the PR it scores; that head merges as it stands, and its nits are kept or dropped by playbook's SESSIONS.md, Fix pushes and nits.
A worker merges its own PR, in the order its lead sets when PRs overlap.
Scope found after the 5/5 goes on a new branch, or waits behind a hold, and nothing is pushed to a branch whose PR reads merged.
A hold is a line Ops writes to the held list on a lead's word, since pr:merge and merge-on-ready read that list and a hold kept only in messages holds nothing.
A lead who overrules a FAIL posts the ruling on the PR, so the verdict the next reviewer reads is the ruling, and the merge still waits for a fresh verdict at the head.
A refusal `--explain` shows to be wrong goes to the Builder, who alone merges that PR by hand, on an override, and has pr:merge fixed.
A PR to any other repo follows that repo's own flow.
Done when `bun run pr:merge <n>` or merge-on-ready prints the merge SHA and that SHA has gone to the Builder.
The flow is AGENTS.md's "Shipping a Playground PR", and each gate, holds, rulings, a merge by hand and merge-on-ready are in `packages/scripts/src/pr-merge/README.md`.
