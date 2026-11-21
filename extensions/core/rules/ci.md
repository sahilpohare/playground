Every verdict is the reviewer's 5/5 and every GitHub check green at the head that merges (`Audit, Lint, and Build`, `test` and, on `factory.repo`, `GitGuardian`), for a diff under `web/next/` the tester's PASS there, and for an installer or first-run diff the new-user gate's PASS there.
GitHub runs them on every push to a pull request into `canary`, so a verdict needs no run of its own and no one's go.
`GitGuardian` on `factory.repo` reads every commit in the PR, not only the head, so a fixed secret in an earlier commit keeps it red at a clean head. The way back is: open a new branch from `canary`, carry the clean change over, and close the old PR.
`Audit, Lint, and Build` is the last job of `auto-check-build.yml` and runs after `Lint and Build` and the suite, so a green `Lint and Build` alone leaves the gate unfilled.
A merge of `canary` makes a new head, which needs its own green checks and a 5/5, and a new tester's or new-user gate's PASS where its diff calls for one.
A red that `canary` caused clears with a fresh merge of `canary` once its fix lands, since a rerun replays the old merge commit.
Done when the head you merge holds the 5/5, each check it carries green and each PASS its diff calls for: the tester's on `web/next/`, the new-user gate's on an installer or first-run diff.
Each gate and its reading are in `packages/scripts/src/pr-merge/README.md`.
