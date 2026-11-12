## What it does

`code-review-loop` is how a reviewer session scores one PR out of 5, round by round, until nothing but nits is left to change.
Each round reads what was asked (the plan item and the brief for a Playground PR, the ticket and its comments for an org's one), reviews the change on two axes, posts a verdict and inline comments, and closes the threads the new head settles.

It treats a review as a **subscription**, not a one-off: every push gets a round, a finding stays open until a round sees it fixed in the code, and a faultless push does not raise the score while anyone's finding is still open.
The score is the PR's, never the delta's.

The reviewer reads the skill's newest text, its scripts included, from the main checkout at the start of every round, so a fix to the skill reaches it at its next round.

It replaces review-bot.
What review-bot learned stays; what changed is who runs it: one reviewer session per PR, spawned by the PR's worker once its head is ready, in the same step as its tester, rather than one loop polling every repo in an org.

## When to reach for it

It is model-invoked: a reviewer session loads it from its brief, and you can type `/code-review-loop` too.

| Your situation                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You are a reviewer and your worker sent a head | One round: recover, place the push, read the spec, review, score, post                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A push lands that nobody announced             | Its background waiter ends with the new head, which starts the next round                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A round would score 5/5                        | A fresh full read of the whole diff first, again at a head made only by merging canary in after it, `bun run check-types` through run-slot, and, when canary changed a file the PR changes or the PR adds or changes a repo scanner (with canary moved), the touched tests on a local merge with canary, unless green CI at the head stands in for them and for check-types, then `bun run pr:merge <n> --explain` reading ✓ on every gate but ready, ci and review; 5/5 only if the read finds nothing blocking or should-fix and every run is green |
| A lead's sweep                                 | The recovery scan: open PRs whose head no verdict scored, and who holds each                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Two axes

The review itself is core's `code-review`, loaded by name and never copied: a **Spec** axis (is this the right thing: every requirement delivered, nothing unasked, and in an org's PR nothing beyond its ticket and the answers of the people its ticket skill names) and a **Standards** axis (is it built well, against AGENTS.md, the skills it touches and the reviewer's brief).
A changed skill, agent guide or docs page is also held to core's `writing-for-agents`, which the reviewer loads first, so an agent doc that sprawls or leaves a step with no completion criterion costs the score as code would.
The two stay apart in the verdict, so a well-built change that misses the ask cannot hide behind its quality.
Its two sub-agents start with no memory of earlier rounds, which is what makes the read before the last 5/5 fresh.
They leave the review clone as it stands, and the reviewer checks its HEAD still sits at the PR's head once they return, since a HEAD that moved under them shows `canary`'s files as the PR's.
The reviewer pastes the spec's text beside its path into the `code-review` call and on into its Spec sub-agent's prompt, and a Spec read that reports the spec missing runs again rather than passing.

## State lives on the PR

A reviewer session keeps nothing it cannot read back: the skill's `state.ts` asks GitHub and git each time for the head, the newest verdict, the open threads and what others said since.
So a session that restarts, or a new reviewer taking over, picks up exactly where the last verdict left off, and when GitHub cuts a list at its page size the script says so rather than reading the rest as absent.
When the shared GraphQL budget is spent it reads the same facts over REST and says so, marking each review thread's resolution unknown rather than reading it as settled.
The same script tells a base merge apart from new work: any commit of the PR's own in the push is new work, and otherwise it compares the PR's own changed lines on each side of the push, because a range diff across a merge of `canary` shows `canary`'s work as the PR's; a conflict resolved by hand that kept both sides reads as a base merge too.
Its waiter for the next push polls GitHub's REST API, so a reviewer waiting all afternoon spends none of the GraphQL budget every session shares.
While the head's `Audit, Lint, and Build` and `test` checks are not both green, its `checks` waiter takes the next push's waiter's place: it also ends once both conclude at the head, and started again after a red it waits for that check's re-run, so a red that clears on a re-run, which moves no head, is still seen.

## It's working if

- Every verdict's first line reads `## ReviewBot · round <r>: <s>/5 at <sha7>`, at the head it names, and `bun run pr:merge` accepts the last one.
- Every verdict sets its PR's `Review • <s>/5` label, colored by its score (green for 5/5, orange for 4/5, red below) from the table in `references/COMMENTS.md`, so a label never lands in GitHub's gray.
- Each finding of a round below 5/5 sits on its line in Files changed as well as in the verdict, while a 5/5's nits sit in the verdict alone, and the threads still open are exactly the findings still open.
- A push gets its round within a few minutes, announced or not.
- Round 1 of a PR that adds a member to a kind (a status, a type, a choice, a button) files every list still naming the kind's old members as one finding, found by one grep for each list's wording, so later rounds spend no turn on lists outside the diff.
- Round 1 also greps the agent-facing and web docs for each term whose meaning the diff changes, and files every doc still describing the old meaning as one finding, each by `file:line`, so later rounds spend no turn finding them one at a time.
  When the PR moves text out of a file, it greps the old file's name over the whole repo, code comments included, since pointers to the old file can sit anywhere.
- A reviewer reuses its newest free review clone, one whose PR has merged or closed and that no live reviewer holds, moving it to `review-<n>` before it checks out PR n, since the nightly clean reads a detached clone's PR from its folder's name; it makes a fresh clone, about 115k files, only when none is free.
  Once it moves a clone, it sends the session it reports to the old and new paths, so the cleanup that clone's last PR handed it to drops the old one.
- A verdict posts with every blank filled, and a review's sub-agents search inside its clone and the paths its brief names, stopping every background task of theirs before they report.
  Each sub-agent makes its scratch folder first and writes every probe output to an absolute path inside it.
- No verdict stands on stale CI: the reviewer reads the head's checks again right before it posts, and a check gone red since its earlier read is a blocking finding in that verdict.
- No verdict answers a stale read either: its post runs behind `state.ts fresh`, which refuses while the PR body has changed since the reviewer's last `state.ts pr`, or a comment, thread reply or review came after it, and names each, so the reviewer drops what the author already answered and scores again before it posts.
- A reviewer stays up after its 5/5, its waiter on the head, until the PR merges or stays closed a poll later (Checks closes and reopens a PR to rebuild its merge commit), so a canary move after the score gets its merge round from the same session, not a new one.
- A reviewer idle 30 minutes with every head scored may be ended by the factory's 5-minute check, and its worker resumes it under the same name on the next push.
- A 5/5 can go stale with no push and no conflict: each time the reviewer sees canary move, it diffs what landed since each waiting 5/5's canary, checks that PR for any file:line or quoted text in those files, and scores each match again.
  When a test that scans the repo or reads the schema lands on canary, it runs that test and the touched tests on a local merge before it calls a waiting 5/5 still good, since a clean merge can still fail that test.
  A waiting 5/5 that adds or changes a repo scanner takes that local merge at every canary move, whatever landed, since CI's merge holds only the canary of its run.
- A reviewer also checks each waiting 5/5's head for a merge conflict with canary each time canary moves, with `git merge-tree --write-tree --name-only`: a conflict is a blocking verdict that names the conflicted files, and the worker merges canary in.
  On a stack held at 5/5 until the owner's try, that verdict is one signal to sync it with canary, and between syncs the reviewer runs only this conflict check on it.
- The touched tests a reviewer runs come from the diff: the test of every file the PR changes, every test file it changes, every test that names or imports one of those files, by its path or from the test's own folder, plus the tests that scan the whole repo;
  `state.ts touched-tests` lists them, and in a Python repo it adds each test that scans a folder holding a changed file and, when a prompt template changes, each test that pins a built prompt's digest.
- When GitHub's `test` and `Audit, Lint, and Build` checks are green at the exact head, and canary has changed none of the PR's files since the base that run merged, the last 5/5 cites that run's link in place of a local run of the touched tests, since CI already ran the whole suite there.
  It fetches canary again once both checks are green and reads those conditions against it, since canary can move while CI runs.
  While those checks still run at the head, with canary unchanged on the PR's files, the reviewer waits for CI still running at the head with its `checks` waiter and cites it, queueing a local run only when a condition fails or a check goes red.
- On a large app repo, when the touched tests run past about 100 files, green PR CI at the exact head stands as the merge evidence, and the reviewer runs the changed modules' own tests locally.
- When canary has moved and changed a file the PR changes, or the PR adds or changes a repo scanner, unless CI stands in, the 5/5 verdict names the touched tests it ran on a local merge with canary, since a merge git calls clean can still break; a red run or a conflict there blocks the 5/5.
  It names that canary from the merge commit itself, since a fetch after the merge would name one the run never merged.
- A dependency-bump PR whose advisory is answered as exactly pinned is scored only after the audit skill's rung 2 read of each parent's newest in-range version, since a parent's range often already carries the fix.
- A stacked child is scored on its own lines, read from its parent's branch, and a child that fails playbook's stack test is a blocking finding.
- The touched tests run in one form, `bun --cwd=<clone> run test:file <files>` through run-slot with no `NODE_ENV`, which reads the same on the runner box as on the Mac.
- Neither side of a review queues a run the other side has already measured at the same head: the result is asked for and cited.
  A box run's id is `ci-<first 12 of the tree>-<random>`, so a cited run's prefix is checked against the first 12 characters of `git -C <clone> rev-parse <head>^{tree}` before citing.
- When a merge with canary moves a path a test fixture uses, the reviewer points the fixture's reader at a missing path and checks each fixture-reading case goes red, since a reader that fails open passes a fixture left at the old path.
- A claim about one environment of a deploy-config repo reads that environment's values on the branch its ArgoCD app targets, not on the PR's branch.
- A finding against a rule written in the code, such as a ratchet that never rises, stays blocking when the brief lists the bend as agreed, unless that agreement quotes the rule's owner.
- A branch is called untested only once a grep of the tests for its effect and its entry point finds nothing, a mutation of it turns no test red, and the repo's testing guide has been read, so a suggested test never breaks that guide.
- A test that fails only on the runner box counts against the score once a rerun on the Mac fails too, so a difference in the box alone never lowers a score.
- A report that fails to send by name reaches the worker anyway, sent again to the `uds:` address its newest message came from.
- The reviewer's small fix goes to the worker as a patch, never as a commit of its own, since ADR 0004 makes the gate a reviewer independent of the code it scores: save `git -C <clone> diff > <scratch>/fix.patch`, restore the clone, check it with `git -C <clone> apply --check <scratch>/fix.patch`,
  and hand it over inline in the verdict, which the message to the worker links, since a restart clears `/tmp`: that `fix.patch` as a `diff` block, pasted whole and unedited with every context line kept so `git apply` takes it as it stands, which the worker applies word for word, on the PR for a blocking or should-fix finding, and a nit's as playbook's SESSIONS.md, Fix pushes and nits sorts it.
  It applies a patch or a suggested wording in its clone and runs the checks its files call for before it posts, the trace ratchet's test and the em-dash check among them on any doc, so its own fix never costs the PR a round.
  Each patched test file outside `CLOCK_EXEMPT` also runs once under `CLOCK_AHEAD_DAYS=30`, since a file's mtime and a child process stay on the real clock, and an exempt file's run counts as a no-op, not a pass.
  A patch to a promoted skill's `SKILL.md` also greps each changed term over that skill's docs page and every README that lists it, and patches every hit.
- When a round leaves only fixes the next push can close, the reviewer asks the worker to merge canary in with that push, so the 5/5 candidate scores a head canary has not moved past.
- After a compaction, a resume, or a notice that background tasks did not finish before the previous session ended, the reviewer runs `state.ts pr` for each PR it holds and re-arms a waiter wherever none is running, `state.ts checks` on a head whose two gate checks are not both green and `state.ts wait` on the rest, since an account flip kills the waiters with no notice.
- A waiter starts from the tmp folder, and `state.ts wait` and `checks` move there as they start, so a waiter that outlives its PR holds no review worktree from the cleanup.
- A finding that asks for a behaviour states the behaviour wanted, not only the defect.
- On a collaborator's org PR whose review ask came to you, the session that posts your review turns at once to the work org's ticket skill, in its extension, for what follows a review you were asked for.
- A reviewer agrees with an author's reply only once it has reproduced the author's reason with one command, named in its reply.
- A 5/5 verdict says the fresh full read found nothing blocking or should-fix and `bun run check-types` ran green, or green CI at the head stood in for it; a red run is a blocking finding.
- Before a 5/5 posts, `bun run pr:merge <n> --explain`, bare and unpiped, reads ✓ on every gate but ready, ci and review, since the body gate also needs a doc that a reviewer's patch or the last commit changed named in the Evidence; a ✗ is a finding for the worker.
- The reviewer posts the 5/5 verdict and its `Review • 5/5` label; GitHub's two checks green at the head are the next gate, never an input to the score, and a run cited where CI stands in is evidence of the touched tests and check-types alone.
- A round left with only nits scores 5/5: the reviewer lists them, or hands the small edit over as a patch, for the worker to keep or drop by playbook's SESSIONS.md, Fix pushes and nits, since that head merges as it stands and a push after it would need a fresh full read.
  A nit that would widen a permission, a setting or a guard's reach if a rare event happens goes to the worker's lead first, and the 5/5 waits for the lead's ruling, since a worker can merge seconds after a 5/5 posts.
- A PR body with no `test:skills` result in it is a nit, since GitHub Actions runs the suite at the head.
- When the ticket carries samples, the verdict holds a samples table, and a sample left unhandled holds the score down.
- When the diff holds a long-lived connection (a socket, a pub/sub subscriber, a retrying client), the PR's Evidence holds a lifecycle table, one row per path from connect to close, and a missing table holds the score at 3.
- When the diff loosens a guard, the PR's Evidence holds a `canary | head` table of refusal rows from round 1 for each refused-forms row it adds or allows and each bypass the review finds that canary refuses, with the refused-forms test's pass count for the rest, and a row canary refuses that runs at the head, unless the fixture's allow list names it, holds the score at 3.
  The review first checks that the loosening passes the docs-path rule in playbook's `SESSIONS.md` (Spawn), and a loosening that fails it holds the score at 3.
  When the diff changes how one hook reads a reader other hooks share, those forms also go to every hook that imports the reader, since a hook left on the old reading can let a call through that it used to refuse.
- When the diff changes a hook, the reviewer runs the `bun run hooks:differential` command the PR's Evidence names and quotes its `reused:` line when it shows, since that line is the author's run at the same head and base; a moved head or base runs fresh on its own, and `--fresh` is for a run the reviewer doubts.
  A hook the PR adds replays against a baseline that allows every call, and a hook that judges by role replays under `--role <role>`, or `--role session` for each call's own session, since with no role it allows every call.
- A working bypass the review finds in a guard is explained on the PR by its mechanism alone, and its exact forms go to the worker in a message until the fix refuses them, so no working payload sits in a public comment.
- A PR that changes a skill, an agent guide or a docs page has its writing judged against writing-for-agents in the verdict, beside the code.
- A FAIL a lead overruled on the PR (`Lead ruling:`) no longer counts against the score, once the issue the ruling names exists.
- The recovery scan lists no unscored PR held by a worker without a live reviewer, and no PR as lost: every open PR is held by an agent (its roster row, or a live worker `plan.json` gives it), parked by a plan (`plan.json` or a plans file), or another author's for the Builder to triage.

## Where it fits

[playbook](./playbook.md)'s **gate** names it: a reviewer session, spawned by the PR's worker, scores through code-review-loop, then the PR waits for GitHub Actions' `Audit, Lint, and Build` and `test` green at the head, which run on every push to the pull request.
The Builder's sweep runs its recovery scan.
It leans on core's `code-review` for the two axes; for an org's PR the **classified** rule holds, so its comments carry only the `ReviewBot` name.
