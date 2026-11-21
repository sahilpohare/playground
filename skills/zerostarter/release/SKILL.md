---
name: release
description: Cut a production release by promoting canary to main. Use when asked to cut, ship, or publish a release, tag a version, or push canary to production.
source: https://github.com/nrjdalal/zerostarter
---

# Release

A ship promotes `canary` to `main` by hand: one PR `canary -> main`, merged with a **merge commit**, then a tag and a GitHub release on that merge.
`auto-canary-into-main.yml` runs on each push to `canary`, and by hand (`workflow_dispatch`), and only opens the draft ship PR when none is open, moving no version; it opens the PR with `GITHUB_TOKEN`, so it needs the repository's "Allow GitHub Actions to create and approve pull requests" setting on.
No workflow tags a ship or writes a changelog, so every step below is yours.
`main` deploys to production, so ship only on the user's go-ahead (playbook's **release** rule gives it to Ops).
An `[ops-ship]` line reading `#<n> carries ship-now and merged at <sha>: ship canary now by the release skill, ...` starts a ship at step 1 outside the usual beat, the **release** rule's `ship-now`; when a ship you are already running pinned a `CANARY` that holds it (`git merge-base --is-ancestor <sha> "$CANARY"` exits 0), that ship carries it, and every step's gate below holds for it as for any ship.

Run every command from a cwd inside the Playground checkout, so `gh` reads the right repository.

## 1. Pin the content

Every PR meant for this ship is squash-merged into `canary`.
The ship's version `vX.Y.Z` is the last tag's patch plus one (`v0.0.98` is followed by `v0.0.99`); the root `package.json` version is not moved and does not decide it.
Freeze `canary` at that version, so `pr:merge` and merge-on-ready hold every PR, then pin the head you ship:

```bash
gh pr list --base canary --state open   # anything that should ship still open?
bun run ship:freeze vX.Y.Z
CANARY=$(gh api repos/{owner}/{repo}/branches/canary --jq .commit.sha)
```

A ship still short of step 4 as the freeze nears its lapse ([pr-merge's Holds and rulings](../../../packages/scripts/src/pr-merge/README.md#holds-and-rulings)) runs `bun run ship:freeze vX.Y.Z` again, which restarts it.
A ship that stops before its tag ends the freeze with `bun run ship:freeze --end`, so the held PRs merge again, and clears its rehearsal's scratch folder (the rehearsal's **Clear**).

Run the new-user gate on it from a detached worktree at `$CANARY`, through run-slot as `ops-ship`, so it runs at class 0, beside the runs that gate a merge, and a ship needs no focus (`.agents/testing.md`, End-to-end tests).
The box is the calling checkout's gate code, so the gate runs from the pin's own: the gate stops with exit 2 in a checkout whose gate code differs from the sha's, since a main checkout's older gate once let its box reach the live dashboard's database.

```bash
GATE="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/ship-gate-${CANARY:0:7}"
git worktree add --detach "$GATE" "$CANARY"
~/.playground/ops/run-slot.sh ops-ship -- bun install --cwd "$GATE"
~/.playground/ops/run-slot.sh ops-ship -- bun run --cwd "$GATE" gate:new-user "$CANARY"
playground rm --worktree "$GATE" --reason "ship gate at ${CANARY:0:7}"
```

Its last line, `New-user gate at <sha>: PASS` or `New-user gate at <sha>: FAIL`, goes into the ship PR's body on a line of its own, for step 3's `ship:merge` to read, with each FAIL and INCONCLUSIVE line it printed named below it.
A ship the owner approves past a FAIL takes the dispatcher's Inbox decision whose title or text names `vX.Y.Z` and whose approved row reads `Ship everything now, skip the new-user check this once` verbatim (`WAIVER_LABEL`), the label the dispatcher offers for it: write `New-user gate at <sha>: waived by Inbox <id>` in place of the FAIL line, the failing lines still named below it, since `ship:merge` refuses a FAIL line beside a waiver too and reads the decision through `playground ask get` ([pr-merge's README, ship:merge](../../../packages/scripts/src/pr-merge/README.md#shipmerge)).

Done when `bun run ship:freeze status` prints the `"*"` line naming `vX.Y.Z` (step 3's `ship:merge` refuses a line Ops wrote by hand, so ask Ops to lift one), `CANARY` holds the SHA you mean to ship and the gate's last line for it, or its waiver line, is in hand. When `canary` moves before step 3, read it again.

## Rehearse an invitee's update

When the candidate changes the update path anything in the ship's step 5 runs (`update.ts` itself, `link-skills.sh`, an ops job, the Dashboard roll), rehearse the update an invitee runs, from the last tag to the candidate, before the ship's step 3: a machine whose own checkout cannot take the update yet still gets the proof. The whole rehearsal lives in one scratch folder, which `bun run --silent ship:rehearsal new` makes in your temp folder and prints, named `ops-r<suffix>` with safe-delete's marker in it, and nothing outside it changes but the real data folder's `ops/run-slot*` files, which its own run-slot calls write. A `--to` run stops before the Dashboard roll, which `playground update` reaches only without a tag, and with no `jobs.json` in the throwaway data folder its ops-restart step restarts nothing, so the rehearsal proves the checkout-side path: the fetch, the tag checkout, `link-skills.sh`, the install and the build. The roll proves itself on a dashboard stack of its own; an ops job's restart proves itself in the ship's step 5, on the machine that holds the jobs. The rehearsal's install, build and `playground update` each run through run-slot as `ops-ship`, by run-slot's real absolute path (`<real home>/.playground/ops/run-slot.sh ops-ship -- <command>`), since the throwaway `HOME` holds no ops folder; the containment of step b, written `env -i ...` in the blocks below, stays on the command after `--`.

a. **Mirror.** Give the rehearsal an origin of its own: clone the repository bare into the scratch folder, then clone that mirror and, in the clone, fetch the pinned `$CANARY` from the repository, merge it into `main` with `--no-ff` (the merge commit a ship makes), and tag the merge with the tag this ship will cut.
   Clone the mirror with `-b main`, since the mirror's HEAD is `canary`, where the merge is a no-op (`Already up to date.`) and the tag lands on the candidate itself (the v0.0.29 rehearsal).
   Merge with `-c commit.gpgsign=false`, since the merge commit stays in the scratch folder and signing stops on a machine with no secret key (the v0.0.29 rehearsal).
   The block runs the whole step; its last line brings `main` and the tag into the mirror with a fetch run in the mirror, since no-extension-repo-write refuses a push to a local path (the v0.0.28 rehearsal):

   ```bash
   git clone --bare <repository> <mirror>.git
   git clone -b main <mirror>.git <clone>   # the mirror's HEAD is canary
   git -C <clone> fetch <repository> "$CANARY"
   git -C <clone> -c commit.gpgsign=false merge --no-ff "$CANARY"   # the merge commit stays in the scratch folder
   git -C <clone> tag <tag>
   git -C <mirror>.git fetch <clone> refs/heads/main:refs/heads/main refs/tags/<tag>:refs/tags/<tag>
   ```

   Done when the mirror's `main` holds the merge commit, the tag names it, and the repository holds neither.

b. **Contain.** Run every later command under `env -i`, so the run inherits nothing from the real environment, `PLAYGROUND_REPO` included, with `HOME` at the throwaway `<scratch>/home`.
   Put `PATH` together for the run: the stub folder first, then the throwaway `HOME`'s `.bun/bin`, then a folder holding the real `bun`, `bunx` and `node` alone, the runtimes the install, the build and the `playground` command run on (`bunx` since `bun install` runs the checkout's `prepare` script), then the system basics; the real `HOME`'s own bin stays off `PATH`, since its `playground` link points at the real checkout.
   Seed the throwaway `HOME`'s bun cache, `mkdir -p <scratch>/home/.bun/install` and then, with that `cache` itself absent, since a `cache` already there takes the copy in as `cache/cache`, so the install reads packages it already has:
   on macOS a copy-on-write clone, `cp -c -R <real home>/.bun/install/cache <scratch>/home/.bun/install/cache`, which writes only the copy;
   on Linux hardlinks, which add no file data where ext4's `cp -R --reflink=auto` writes a full copy (3.08 GB, measured on 16 Nov 2026), and that copy in their place when `cp -al` fails, as across two filesystems (EXDEV), after moving aside the `cache` folder a failed `cp -al` leaves:

   ```bash
   cp -al <real home>/.bun/install/cache <scratch>/home/.bun/install/cache ||
     { [ ! -e <scratch>/home/.bun/install/cache ] || mv <scratch>/home/.bun/install/cache <scratch>/cache-partial; cp -R --reflink=auto <real home>/.bun/install/cache <scratch>/home/.bun/install/cache; }
   ```

   The links leave the real cache unchanged, measured on 16 Nov 2026 with bun 1.4.4: bun links cache files into `node_modules` and writes its cache only as new files renamed into the rehearsal's own folders, and the one package script that rewrites a package file, vue-demi's postinstall, unlinks it first, so the cache's 128,749 files read the same by inode, mode, size and mtime after a frozen install and build of a tag and the candidate.
   Removing the scratch folder removes only the links, so the real cache keeps its files, while the folder still holds about 140,000 entries by count (129,000 files).
   The realism it trades: the seeded cache can hold packages an invitee's cache lacks, so the rehearsal no longer shows a package missing from a fresh cache.
   Put a stub on `PATH` for each side-effecting tool the update can call, one that logs each call and refuses; read `update.ts`, `ops-restart/cli.ts` and what they call for the list.
   Write each stub's link with its literal target path, one `ln -s` a line (`ln -s _stub <scratch>/stubs/gh`), since no-extensions-write refuses a link whose target holds a loop variable, and the whole call with it ([scripts/hooks/README.md](../../../scripts/hooks/README.md#no-extensions-write)).
   Leave `claude` off `PATH` altogether: `link-skills`' `orgs home` step waits for an absent `claude` and fails a stub that refuses.
   Record the before-state (listings and checksums) of everything outside the scratch folder the update could reach, the home folder's bins and links among them, before any install runs, and on the `cp -al` route the real cache's stat listing, `find <real home>/.bun/install/cache -type f -printf '%i:%p\t%m %s %T@\n' | LC_ALL=C sort > <scratch>/cache-before.tsv`, keyed by inode and path, since a write through a link keeps the file's inode while other sessions' installs and bun's transpiler cache add, rename and remove files there during the rehearsal (ctime stays out, since a new link changes it),
   leaving out the main checkout's `.git/config`, which other sessions rewrite as they add branches and worktrees (two v0.0.27 rehearsals in a row read it changed), and the real data folder's `ops/run-slot*` files, which the rehearsal's own run-slot calls write.
   Done when `<scratch>/home/.bun/install/cache` holds the real cache's packages at its top level, every tool on the list is stubbed or absent, and the before-state is saved.
   The cache listing passes when the after-state's, taken the same way into `<scratch>/cache-after.tsv`, shows no write through a link: `LC_ALL=C join -t "$(printf '\t')" <scratch>/cache-before.tsv <scratch>/cache-after.tsv | awk -F '\t' '$2 != $3 { print $1 }'` prints each file whose path still holds the same inode but reads another mode, size or mtime, and leaves out new, renamed and removed files, which are other sessions' own (tabs, since a cache path can hold a space).
   Any line it prints fails the rehearsal red: its report names each printed file, says the real cache is suspect, and gives the repair, `bun pm cache rm`, after which the next install fetches again, and nothing ships until Ops clears or repairs the cache.

c. **Invitee.** Clone from the mirror, check out the last tag on `main`, and install and build inside the containment, running the install and build steps of an invitee's install from the clone, since `install.sh` itself stops without `claude`:

   ```bash
   <real home>/.playground/ops/run-slot.sh ops-ship -- env -i ... bun install --frozen-lockfile
   <real home>/.playground/ops/run-slot.sh ops-ship -- env -i ... env NODE_ENV=production SKIP_ENV_VALIDATION=true node_modules/.bin/turbo run build --filter='./packages/*'
   env -i ... bash scripts/link-skills.sh   # links this clone's playground command into the throwaway HOME's bin, already on PATH
   ```

   Done when `playground doctor` from the clone, still contained, reads `held at <last tag>, N commits behind origin/main`.

d. **Update.** Run the update, then `playground doctor`, still contained:

   ```bash
   <real home>/.playground/ops/run-slot.sh ops-ship -- env -i ... playground update --to <tag>
   env -i ... playground doctor
   ```

   This run proves the last tag's `update.ts` taking the invitee to the candidate, since the clone runs the code it holds.
   When the candidate changes `update.ts` itself, run that block a second time from the updated clone, so the candidate's own `update.ts` runs.
   The first run leaves the tag's own commit in the throwaway data folder's `ops/update-head`, so a second run reads an empty change set and skips the install, the build and the skills line: first move that file aside when the change is on the no-record path, or write the last tag's commit into it when the change reads the change set, so the second run reads what the first did (the v0.0.26 rehearsal on 1 Nov: the first run ran v0.0.25's `update.ts`, and only the second, with the file moved aside, printed the candidate's new no-record line).
   Done when each update exits 0, doctor's version line reads `at <tag>` after each, and the MISSING lines are only the containment's own and the machine's own gaps: `claude` off `PATH`, `docker` and `gh` left off it and the pinned `herdr` the throwaway `HOME` lacks, while every need the update itself runs on reads ok (`bun`, `git` and `node`, with `python3` from the system basics); the after-state, taken the same way, reads unchanged against the before-state, the real cache's listing by step b's comparison alone, and each stub's log names the calls the real machine would have taken, and a second run's output shows the step the candidate's change is on, with the line that change adds when it adds one. A step that fails names its caller: when a stub took that call, the update needs it, so contain that call another way (a flag, an env) and run the rehearsal again.

The rehearsal's result goes into the ship PR's body beside the new-user gate's line, as `Invitee rehearsal at <sha>: PASS` on a line of its own, `<sha>` the full `$CANARY`; a candidate that changes no update path writes `Invitee rehearsal at <sha>: not needed` there, since step 3's `ship:merge` reads one of the two.

**Clear.** Clear the scratch folder with `bun run ship:rehearsal clear <scratch>` once step 3's `ship:merge` has merged, since the ship PR's body cites its before and after files and a held ship reruns from it; a ship that fails or stops clears it as its freeze ends.
The clear removes the whole folder, about 140,000 entries, past `playground rm`'s cap of 5,000 files or 2 GB, and keeps any folder without the marker, outside your temp folder or not named `ops-r` (`packages/scripts/src/ship/rehearsal.ts`); nightly-clean removes a marked one left over a day, so a rehearsal that dies frees its disk by the next night.
Done when `ship:rehearsal clear` printed `removed <scratch>`, or kept it as `is not a folder`, since a clear or the nightly clean already removed it, or as `not a folder made in the temp folder`, since on Linux a session started again since `new` has a new temp folder, and the nightly clean removes that folder after a day.

## 2. Open the ship PR

Write the body to a file first. It opens with two or three plain sentences the owner reads first, then `## What ships`, one line per PR since the last tag (`gh release view --json tagName --jq .tagName` names it).

```bash
gh pr create --base main --head canary \
  --title "ci(release): 🚀 merge canary into main" --body-file <file>
```

When a dispatch of `auto-canary-into-main` already opened it as a draft, `gh pr create` refuses: edit that PR's body instead and mark it ready (`gh pr ready <n>`). Done when `gh pr list --head canary --base main --state open` shows it, ready.

## 3. Merge into `main`

Merge with `ship:merge`, the one merge into `main`, which refuses, naming each reason, until its gates hold at the ship PR's head ([pr-merge's README, ship:merge](../../../packages/scripts/src/pr-merge/README.md#shipmerge)), then merges with a merge commit at that head:

```bash
bun run ship:merge <n>
MERGE=$(gh pr view <n> --json mergeCommit --jq .mergeCommit.oid)
```

Fix each reason it names, then run it again, at most every 5 minutes while a check still runs (the **github** rule):

- A refusal naming a head other than `$CANARY` means `canary` moved: go back to step 1.
- No `Audit, Lint, and Build` or `test` check at the head, with the pin's `auto-check-build` and `auto-test` runs reading `action_required` (`gh run list --commit "$CANARY" --event pull_request`), means the bot opened the draft there, so its runs are held runs ([GITHUB-BULK-READS.md, Reading canary's own checks](../../../extensions/core/skills/playbook/GITHUB-BULK-READS.md#reading-canarys-own-checks)). Run `bun run ship:approve-held <n>`, which approves the ship PR's held runs at its head alone and prints each run it approved, or `none held`.
- A red check: rerun its run once, `gh run rerun <run id> --failed`, or a cancelled run whole with `gh run rerun <run id>`, its id from `gh run list --commit "$CANARY" --event pull_request --json databaseId,workflowName,conclusion`. A check whose failing test turns green on that rerun still gets one issue to root-cause its red, or to delete the test with the reason, as a `BATCH-RED` does in [code-review-loop's step 2](../../../extensions/core/skills/code-review-loop/SKILL.md).
- A second red, or a FAIL gate line, holds the ship: name the failing test (`gh run view <run id> --log-failed`; `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<job id>/logs` reads a job's whole log, where `--log-failed` cuts it) or step in the ship PR and up the chain, and end the freeze by step 1's line for a ship that stops.

Then clear the rehearsal's scratch folder (the rehearsal's **Clear**).

Done when `ship:merge` printed `merged #<n> at <sha>`, `MERGE` holds that commit and, when a rehearsal ran, its **Clear** is done.

## 4. Tag and publish

The tag is step 1's `vX.Y.Z`.

The notes take ZeroStarter's shape: the compare link, one emoji section per commit type, then each contributor: the owner as `- <name> @<login>`, its name the words of the commit's author name that `owner.names` lists, and every other contributor as `- @<login>`, the login alone, the one line a ship's notes may name a person on (no-public-leak's section of `scripts/hooks/README.md` says how the guard reads it). `bun run release:notes <last tag> vX.Y.Z` renders them from GitHub's compare of the two tags (`packages/scripts/src/release-notes/`) and prints them. Write them to a file outside the checkout, and name it by its literal absolute path in `--notes-file`, since the leak guards read a notes file only through a literal path. Run each line below as a Bash call of its own, since the guards read the notes file before a call runs:

```bash
gh api -X POST repos/{owner}/{repo}/git/refs -f ref=refs/tags/vX.Y.Z -f sha="$MERGE"
bun run release:notes vX.Y.W vX.Y.Z > /tmp/notes-vX.Y.Z.md   # vX.Y.W is the last tag
gh release create vX.Y.Z --verify-tag --latest --title vX.Y.Z --notes-file /tmp/notes-vX.Y.Z.md
bun run ship:title vX.Y.Z
```

When a guard refuses the notes, edit the file in a call of its own, then create the release again in the next: an edit and the create in one call are refused again, since the guard read the file before the edit. Cut a refused contributor line to `- @<login>` and keep the section; delete a line only when the guard refuses its login itself.
`--title` names the version by its tag, since GitHub otherwise takes the tagged commit's subject (the ship PR's merge line); `ship:title` (`packages/scripts/src/ship/title.ts`) reads the name back and, when it is not the tag, prints the `gh release edit vX.Y.Z --title vX.Y.Z` line that fixes it and exits 1: run that line, then `ship:title` again.
Then end step 1's freeze with `bun run ship:freeze --end`.

Then deploy the hosted Yard from the tag with `bun run ship:yard vX.Y.Z` (`packages/scripts/src/ship/yard.ts`), the Ops lead's call alone: no-raw-vercel reads it as a production move, and the step itself stops unless the claude process it runs under is the Ops lead's (`PLAYGROUND_ROLE` lead, the roster's ops kind, read from that process), naming what it found.
It fetches the tag, deploys the API and then the web with `vercel deploy --prod` from a detached worktree at the tag, checks the live host after each (`/api/health` answers 200, `/api/v1/yard/channels` answers 401 with no token), records the tag in the data folder's `ops/yard-tag`, and removes the worktree.
Its ids and hosts are the live dashboard checkout's `.env` keys `.env.example` lists under the step, and it names each one unset.
When the tag changes `packages/db`'s schema or migrations since the recorded tag, it stops, naming the files: take the change through the db-migration skill's step 0, then run it again with `--schema-cleared <Inbox id>` naming that decision.
With no record yet it stops once and asks for `--since <the tag live now>`.
A failed deploy or check stops it before the next project, naming the URL and the status it answered: send that line up the chain.

Done when `gh release list -L 1` shows `vX.Y.Z` marked Latest, `ship:title` printed `ship:title: vX.Y.Z is named vX.Y.Z`, its page opens with the compare link, `--end` printed `removed the "*" line` or that a line Ops wrote by hand stays for Ops to remove; and `ship:yard` exited 0, both projects' live checks passing.

## 5. Pull the main checkout

Run `playground update` (`packages/scripts/src/playground/update.ts`) in a run slot; the command is the main checkout's own, linked into `~/.bun/bin`:

```bash
~/.playground/ops/run-slot.sh ops-ship -- playground update
```

It runs each step below and stops at the first that fails, naming it.
Steps 2 to 5 read what changed since the commit the last finished update reached, which it records in the data folder's `ops/update-head` once step 5 passes, so a run after one cut short (a crash, a killed terminal, a failed step) still installs, builds and restarts what that merge changed; with no record yet, they read from the reflog's last fast-forward onto `origin/main` (`merge origin/main: Fast-forward`), else from `HEAD` at the run's start, which it records before step 1 moves the checkout, naming the point in one line either way.
A reset or merge of the main checkout made outside `playground update`, with no record yet, writes the commit `main` stood at before it into the record first, so the next update installs, builds and restarts what that move brought in; a record already there keeps its older point, which covers that move too: `[ -s <data folder>/ops/update-head ] || git -C <main checkout> rev-parse HEAD > <data folder>/ops/update-head`, the data folder being `~/.playground` unless `PLAYGROUND_DATA_DIR` names another.

1. Fetch and fast-forward onto `origin/main`, since `pull --ff-only origin main` there fails with "Cannot fast-forward to multiple branches". A checkout on another branch with a clean tree moves to `main` at `origin/main` first, and a dirty one stops here.
   When `origin/main` declares a dependency the checkout has not linked (`unlinked.ts` reads its manifests with `git show`), it checks out the changed `bun.lock` and `package.json` files and installs before the checkout moves (the fast-forward, or the move to `main` from another branch), since every hook that runs its source (all but the bundled PreToolUse guards) runs the checkout's code the moment it moves; a target that deletes or moves a manifest, or a tree with edits or untracked files of its own, moves first as before, and so does a failed install there (one needing a file the manifests were staged without, such as a patch), after it puts the old commit's manifests back with `git restore`.
   Then each hook bundle the move adds or changes is written beside its path, renamed over it and staged (`swap-bundles.ts`), since every guard loads its bundle from this checkout and git's own move rewrites a file in place; a checkout with commits or files of its own moves as before, and a swap or a move that fails puts HEAD's bundles back by the same rename, so the next update moves the checkout.
   The `reset --keep` below writes in place still, on that rare manual path.
   When the fast-forward fails because `main` holds a local commit no remote holds (a session's stray commit there), run `git -C <main checkout> reset --keep origin/main`, the one reset no-main-checkout lets through while the tree is clean, then run `playground update` again.
   When no-main-checkout refuses that reset (a dirty tree, or a commit some remote holds), stop there and send its reason up the chain, since that work or commit is someone else's to keep.
2. `link-skills.sh`, before anything else, since every later step and every ops job reads `~/.playground`, which it links to `~/.playground` on a machine holding only the old folder; it installs first when the merge declared a dependency the checkout has not linked, since its home set loads the workspace packages; when the merge changed a skill, `playground update` then prints `skills changed:` with each one's folder in the checkout, which you send every lead, for each live checker to read the new text there (the `release` rule says why).
   Then each manager's brief copy in the data folder that matches a committed version of its template follows it, an edited one stays, and the manager gets the template's diff through the ops outbox, at its next start when it is not live (`brief-refresh.ts`); a failure there prints `brief refresh failed` or `brief-<name>.md:` and the update goes on.
3. Install when the merge changed `bun.lock` or a `package.json`, with `--ignore-scripts`, since the postinstall's `deps-manager.ts` can rewrite a `package.json` there (v0.0.141's pull left a newly added `nanoid` uninstalled, so `bun run name` failed).
4. Build `packages/*` when the merge changed a package with a `dist` (`packages/scripts` runs from source, so a change there alone builds nothing), since the `playground` command imports their `dist`, with env validation off, since the main checkout has no `.env`.
5. Restart each ops job whose source the merge changed ([ops-restart](../../../scripts/ops/README.md#when-a-job-restarts-onto-new-code)).
6. Move each peer's Playground clone to the commit `HEAD` reached (`peer-sync.ts`), for each machine the Dashboard's `.env` names in `PLAYGROUND_PEERS`, so a job run from a peer's clone (the relay) runs the same code: over ssh, as the System panel reads a peer, it reads the status of the peer's clone at the same place under its home as the main checkout (`cloneOf`), then fetches, checks out that sha detached and runs a frozen `bun install` under `nice`.
   A clone with changes of its own, committed or not, on a branch other than `main`, or with another worktree cut from it (a replay run, whose hooks read through the clone's git dir) is left as it is, and each peer prints one `peer <name>:` line, `at <sha7>` or why not, never failing the update.
7. Roll the Dashboard, which answers `Already up to date` when the branch it follows has not moved.
   The update gives its run slot back first (`gave its run slot back`), since the roll's own steps queue in run-slot; a roll queued there reads `Waiting for load: load5 is <n>…` or another `Waiting for …` line naming its queue, never `Failed`, and one still waiting at 30 minutes exits 0 and finishes by itself, so this item is done once `ops/dashboard/results.log` holds that roll's `ROLL … PASS` line.

A build that fails part way can leave another package's `dist` cleaned and empty (`packages/redis`, which pr:merge's lock imports, on v0.0.107): after a failed build, fix its cause and run `playground update` again, which builds again, since a run that stopped short records nothing.
A job that a `left alone` or an `on, but not running` line names and that is not running three of its cycles after the update (its heartbeat's `cycleSeconds`, the staleness `up.py` reads a job down by) is a failed step, whatever the line's `up.py exited 0` says, since `up.py` exits 0 on every pass: send its `up.log` lines (`ops/` in the data folder) up the chain.

Done when the main checkout's `HEAD` equals `origin/main`, `playground update` exits 0, no `ops-restart:` line reads `still runs` or a non-zero `up.py exited`, each job an `ops-restart:` line names as `source changed, stopped pid <n>` has restarted, its heartbeat (`ops/<job>.json` in the data folder) reading a `pid` other than `<n>` and a `startedAt` after the update, the proof the rehearsal cannot give, each job a `left alone` or an `on, but not running` line names is running once it has beaten again, its heartbeat reading a `pid` that `ps -p` finds and a `startedAt` after the update, a launchd job started by launchd, every package but `packages/scripts` holds a `dist` with files in it, each folder a `skills changed:` line names has reached every lead, and each `peer <name>:` line reads `at <sha7>` or has gone up the chain.

## Notes

- **Merge method is load-bearing.** `canary` PRs squash; the ship PR merges with a **merge commit** so `main` keeps shared history with `canary` and the next ship's diff stays clean.
- **The notes are rendered, never committed.** `release:notes` groups the commits since the last tag as ZeroStarter's changelogen notes do, with `ci` hidden as ZeroStarter's `changelog.config.json` hides it, and the release keeps them, so a ship makes no changelog commit on `canary` or `main`.
- **Each tag is made once.** A tag that already exists fails the `git/refs` call: read the last tag again, take the next number, and run step 1's `bun run ship:freeze` with it.
