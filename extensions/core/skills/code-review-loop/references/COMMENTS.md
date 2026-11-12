# Comments, inline findings and threads

Every body goes to a file in your scratchpad in one call and is posted in a separate call, with a literal absolute path (the comment-wording hook reads the file, and refuses a path held in a shell variable). Write it with the Write tool, or with a heredoc whose delimiter is quoted (`<<'EOF'`), and the inline review's JSON file the same way. A review's comment text quotes probe commands, and an unquoted heredoc runs them: on 1 Nov, a reviewer fed python3 its inline review JSON through an unquoted heredoc, the backticked probe commands in the comment text ran as command substitutions, and one, a folder delete, took `scripts/` and `skills/` out of its review clone. Write "ship" or "publish step" where the word for cutting a version would go (the **comments** rule). When the PR's own text holds that word (a line format, a command, a quoted rule, a code line or identifier), name it by its `file:line` or paraphrase it in the comment rather than quote it, as "the grouped prod-deploy line" stood for end-of-day's line on one PR: the hook refuses a quote all the same, a code span included. Describe the hook as "the hook that refuses the publish-step word" and its test file as "the comment hook's test file", never by either path: each path holds the word, and a comment that cites one is refused and lost. Every SHA, time or count in a body or a command's argument (a verdict, an inline review's `commit_id`, a thread reply) comes from the command that produces it, copied whole from that command's output, never typed from memory or padded out from a short SHA; step 7's `state.ts pr` read then confirms the head the verdict names. A write that times out, errors or is killed may have landed: read the PR's comments, threads or reviews before posting again, and go by what is there.

Every session shares one GitHub account, and with it one GraphQL budget (`gh api rate_limit --jq .resources.graphql`). REST has a budget of its own: the verdict and the inline review always post over it (below), and when GraphQL is spent, so does a PR body, with `gh api -X PATCH repos/<repo>/pulls/<n> -F body=@<file>`. With GraphQL spent, `state.ts pr` and `scan` read over REST and say so, listing every review thread with its resolution unknown, since only GraphQL knows it: treat each as open until the reset lets you check. Closing threads needs GraphQL and waits for the reset, and the verdict names the threads still open.

## A working bypass

When the review finds a working way past a guard (a form the guard should refuse that runs), the verdict and its inline finding explain the mechanism in words, the shape and the parse step that misses it, and the exact forms go to the worker by `SendMessage` alone.
The forms stay off the PR until the fix pins each as a refused row in `tests/scripts/hooks/fixtures/refused-forms/`, so a working payload never sits in a public comment while the guard still lets it run; on 2 Nov one guard PR's round 1 took this path on its lead's ruling.
Done when each bypass's mechanism is in the verdict, its forms are in the worker's inbox, and a later round confirms each refused at the head.

## The verdict comment

One new comment per round, never an edit of an earlier one: the record of what was said at which SHA is the point. Post it over REST, which spends no GraphQL (playbook's **github** rule), behind SKILL.md step 7's `fresh` check: `${CLAUDE_SKILL_DIR}/scripts/state.ts fresh <repo> <n> <read-at> <digest> && gh api repos/<repo>/issues/<n>/comments -F body=@<file> --jq .html_url`. Its first line is the gate's, exactly:

```
## ReviewBot · round <r>: <s>/5 at <sha7> · <b> blocking, <f> should-fix, <k> nits
```

On an outside author's PR, the verdict also carries three lines: need (do we need it), hit (do we hit the problem it fixes, with evidence) and factory (does it upgrade or degrade the factory, and why).

Then, in this order:

- **Spec** (the right thing): every spec line from step 3, marked delivered, partial or missing with where, then each finding as `- [blocking|should-fix|nit] path:line: what is wrong. Fix: what to do. (measured|reasoned)`, quoting the spec line it answers. For a finding that asks for a behaviour, `Fix:` states the behaviour wanted, not only the defect, so the fix cannot be read the other way. When the ticket carries samples, your samples table from step 4 follows, every row at this head. Keep the two axes apart, never merged or re-ranked, so one cannot hide the other.
- **Standards** (built well): the same shape, citing the rule (`AGENTS.md`, a skill, your brief) or naming the smell as a judgement call.
- **Threads**: how many you closed and at which commit, and how many stay open.
- **Checked** and **Not verified**: what was read in full, skimmed and run (VERIFY.md).
- On a 5/5 that was a candidate: one line saying the fresh full read found nothing blocking or should-fix, its nits listed above for the worker to sort by playbook's SESSIONS.md, Fix pushes and nits.
- Last line: `ReviewBot · round <r>. Push back on any finding you think is wrong.` The account is shared, so this line, not the author field, says who wrote it.

A round on a base merge alone says so in one line under the header (`Base merge only: the PR's own work is unchanged since <sha7>.`), keeping the PR's standing score.

Fill the verdict file's blanks with Edit or Write, each fill a call of its own, and right before the post grep the file for every slot the template above holds (`grep -nE '<(r|s|sha7|b|f|k)>' <file>`, plus any slot of your own, such as `<checks>`), posting only when it prints nothing: one verdict posted with its checks slot still in it, after the hook that refuses the publish-step word stopped the one call that both filled the slot with sed and posted a reply.

With each verdict, first give its `Review • <s>/5` label its score's color, which creates the label when missing and recolors it otherwise: `gh label create 'Review • <s>/5' -R <repo> --color <hex> --force`, `<hex>` being the table's color without its `#`, written in the command itself.
Then set the PR's `Review • <s>/5` label and remove any other `Review • ` label, over REST as the verdict posts (`gh api repos/<repo>/issues/<n>/labels -f 'labels[]=Review • <s>/5'`, then `gh api -X DELETE repos/<repo>/issues/<n>/labels/<label>` for each other, its name URL-encoded: `Review%20%E2%80%A2%203%2F5`), so the labels carry the newest score alone.

| Label          | Color     |
| -------------- | --------- |
| `Review • 5/5` | `#22c55e` |
| `Review • 4/5` | `#f97316` |
| `Review • 3/5` | `#ef4444` |
| `Review • 2/5` | `#ef4444` |
| `Review • 1/5` | `#ef4444` |

## Inline findings

Each finding with a line in the diff also goes on that line, as one review per round; a round scoring below 5 posts its nits there too.
A 5/5 verdict's nits stay in the verdict alone, with no inline thread, since [The last 5/5](../SKILL.md#the-last-55) is done only once every thread you opened is resolved.
Post the review with:

```bash
gh api repos/<repo>/pulls/<n>/reviews --input <file.json>
```

```json
{
  "body": "ReviewBot round <r> inline findings at <sha7>; the verdict is the round's comment.",
  "comments": [
    {
      "body": "<finding>. Fix: <fix>.\n\nReviewBot · round <r>",
      "line": 42,
      "path": "a/b.ts",
      "side": "RIGHT"
    }
  ],
  "commit_id": "<head, all 40 characters>",
  "event": "COMMENT"
}
```

- `event` is `COMMENT`: the PR's author is this same account, so GitHub refuses `APPROVE` and `REQUEST_CHANGES`.
- Anchor only to a line inside one of the diff's hunks (added or context); any other line fails the whole call with a 422. A finding on an untouched line stays in the verdict alone.
- A finding on a file under the ship skill's folder goes inline with the file's real `path`: the comment-wording hook reads only bodies, so a `path` field alone never trips it. That comment's body, and the verdict, name the file by role and bare name ("the ship skill's step 5, SKILL.md"), never with its folder: the folder's name is the publish-step word itself, and a body holding it is refused and lost.
- Sign every inline comment with `ReviewBot · round <r>` as its last line: each is read on its own in Files changed, and `state.ts` knows a thread as yours by that word.
- The review's `body` never starts with `## ReviewBot`, so no reader takes it for the verdict.

## Closing threads

After posting, close every thread of yours the head settles; the open list holds only live work. For each thread `state.ts pr` lists:

- **Fixed at the head** (checked in the code, never taken from a reply): reply with the commit that fixed it and resolve, in one mutation.
- **The author replied and is right**: say so in one line, and resolve; "is right" means you reproduced the author's reason with one command and named that command in your reply.
- **The author replied and the finding stands**: reply with the measurement again, rather than the claim, and leave it open.
- **The fix revealed a different problem**: resolve the old thread and open a new one for the new finding.
- **A nit thread from an earlier round**, in a round that scores 5/5: list the nit in the verdict, and resolve.

With GraphQL spent, reply over REST to the thread's first comment, which `state.ts pr` then names as `comment <id>`: `gh api repos/<repo>/pulls/<n>/comments/<id>/replies -F body=@<file>`; resolving waits for the reset. Otherwise write the mutation to a file, at most 8 threads to a mutation, then run `gh api graphql -F query=@<file>`; when one fails partway, read the threads again (`state.ts pr`) before the retry, since some already took their reply or resolve. Its reply names no skill, session or Playground term, since the no-playground-leak hook cannot place a repository from node ids and refuses it; say "another skill" instead:

```graphql
mutation {
  a: addPullRequestReviewThreadReply(
    input: {
      pullRequestReviewThreadId: "PRRT_..."
      body: "Fixed in <sha7>: <how>.\n\nReviewBot · round <r>"
    }
  ) {
    clientMutationId
  }
  b: resolveReviewThread(input: { threadId: "PRRT_..." }) {
    thread {
      isResolved
    }
  }
}
```

Done when every thread `state.ts pr` lists is resolved or named in the verdict as still open.
