# Reading many PRs in one query

A sweep over many PRs (an inventory, a recovery scan, an org-wide check) reads through one batched GraphQL query, not paced REST: 50 PRs a query, each node carrying its files, reviews and dates, cost one point a query measured (a dry run gave `cost: 1` for 50 PRs with files and reviews), and 996 PRs took 20 queries, estimated from that cost,
where the same sweep through paced REST spent about 2,000 calls, estimated, and the shared 5,000/h quota at 04:31Z on 26 Oct ([rules/github.md](../../rules/github.md), the **github** rule).
code-review-loop's `state.ts scan` batches its PR reads too (`SCAN_QUERY`), and names the shape to copy.
A single PR's read stays REST.

1. Probe the budget before the first batch.
   Done when you know what a batch may spend.

   ```bash
   gh api graphql -f query='query { rateLimit { cost remaining resetAt } }'
   ```

2. Page the batched query, 50 PRs a page.
   Ask only the fields the sweep reads; every extra field spends points.
   `states` takes `OPEN`, `CLOSED` and `MERGED`, so an inventory passes all three; `files(first: 50)` cuts a PR with more files, so the query asks the connection's `pageInfo`, and step 3 reads the rest of each PR whose files say `hasNextPage`; a sweep that raises the count raises its cost with it.
   Carry `rateLimit { cost remaining }` in the query, so each page reports what it spent.
   Write the query inline in the command, so `no-release-comment` can read it before the command runs: the hook reads a query only as text in the command or in a file the command names, so it refuses one held in a shell variable ([scripts/hooks/README.md](../../../../scripts/hooks/README.md#no-release-comment); measured: the inline form and the file form below pass, the variable form refuses).
   A long query keeps the file form, made before the call.
   Done when the page returns and `rateLimit` shows what it spent.

   ```graphql
   query ($owner: String!, $name: String!, $cursor: String, $states: [PullRequestState!]) {
     rateLimit {
       cost
       remaining
     }
     repository(owner: $owner, name: $name) {
       pullRequests(first: 50, after: $cursor, states: $states) {
         pageInfo {
           hasNextPage
           endCursor
         }
         nodes {
           number
           title
           updatedAt
           headRefName
           isDraft
           files(first: 50) {
             pageInfo {
               hasNextPage
               endCursor
             }
             nodes {
               path
             }
           }
           reviews(last: 1) {
             nodes {
               state
               submittedAt
               author {
                 login
               }
             }
           }
         }
       }
     }
   }
   ```

   ```bash
   gh api graphql -f owner=<owner> -f name=<repo> -f cursor= -F query=@query.graphql
   ```

3. Feed each page's `pageInfo.endCursor` back as `$cursor` until `hasNextPage` is false.
   To let `gh api graphql --paginate` page it for you, rename the variable `$endCursor` and keep `pageInfo { hasNextPage endCursor }`, since `--paginate` fills only that name (`gh api --help`): a sweep that kept `$cursor` under `--paginate` refetched page 1 554 times and spent 50 GraphQL points (measured).
   A PR whose `files` say `hasNextPage` reads its whole list through REST, `gh api --paginate repos/<owner>/<repo>/pulls/<n>/files --jq '.[].filename'`, since `gh pr view <n> --json files` stops at 100 with no sign it cut the list (one PR read 100 of its 143 files, measured).
   When several PRs' files say `hasNextPage`, one query reads the rest of each from its files' own `endCursor`, one aliased `pullRequest` a PR, and runs again with each new `endCursor` until no PR's files say `hasNextPage`.

   ```graphql
   query ($owner: String!, $name: String!) {
     repository(owner: $owner, name: $name) {
       pr169: pullRequest(number: 169) {
         files(first: 100, after: "<its endCursor>") {
           pageInfo {
             hasNextPage
             endCursor
           }
           nodes {
             path
           }
         }
       }
     }
   }
   ```

   Done when the sweep holds every PR the filters name, with each one's whole file list where the sweep reads files, and nothing was read twice.

On a refused call, wait for the reset the rule names and retry nothing before it: the probe's `remaining` is the budget, and a sweep that would outspend it waits or narrows its filters first.

## On a rate limit

Wait until the reset the failing call's own `X-RateLimit-Reset` header gives (`gh api -i` prints it), or, when no header came back, each quota's `reset` from `gh api rate_limit`, though that can disagree, and retry nothing before then.
code-review-loop's `state.ts wait` and `state.ts checks` do both.
Done when the reset has passed and the retried call answers.

## Reading canary's own checks

The suite and the build run only on `pull_request` (`auto-test.yml`, `auto-check-build.yml`), so every such run `gh run list --branch canary` lists belongs to a canary-into-main PR.
The bot opens that PR, so its `opened` runs are **held runs**: zero jobs, waiting for the approval `bun run ship:approve-held <n>` gives, `action_required` while that PR is open and reported as `failure` once it merges.
A held run is no failure: an audit of canary's runs over 25 hours on 31 Oct and 1 Nov found 21 red runs, 20 of them held runs, and one real break (measured).
`gh run list --limit 100` reached back only 3 of those 25 hours, so a window's list pages the REST read below.

- **Canary now**: read the check runs on the open canary-into-main PR's head, which hold no held run.
  From a publish step until canary's next push no such PR is open, and canary's head is the newest merged one's, so read that PR's head instead.
  A head that has only held runs shows its push checks alone (`Audit canary` and `Auto create PR to merge canary into main`); its suite and build have no reading at that head until the next push to canary.
  Done when every check on the head has a conclusion.

  ```bash
  sha=$(gh api "repos/<owner>/<repo>/pulls?head=<owner>:canary&base=main&state=open" --jq '.[0].head.sha // empty')
  [ -n "$sha" ] || sha=$(gh api "repos/<owner>/<repo>/pulls?head=<owner>:canary&base=main&state=closed&per_page=100" --jq 'map(select(.merged_at)) | max_by(.merged_at) | .head.sha')
  gh api "repos/<owner>/<repo>/commits/$sha/check-runs" --jq '.check_runs[] | [.name, .conclusion] | @tsv'
  ```

- **A past window**: keep each red run with at least one job, then read its failing step with `gh run view <id> --log-failed`; `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<job id>/logs` reads a job's whole log, where `--log-failed` cuts it.
  Done when every red run in the window is kept or set aside as a held run.

  ```bash
  gh api --paginate "repos/<owner>/<repo>/actions/runs?branch=canary&created=>=<YYYY-MM-DDTHH:MM:SSZ>&per_page=100" \
    --jq '.workflow_runs[] | select(.conclusion == "failure") | .id' |
    while read -r id; do
      if [ "$(gh api "repos/<owner>/<repo>/actions/runs/$id/jobs" --jq .total_count)" -gt 0 ]; then echo "$id"; fi
    done
  ```
