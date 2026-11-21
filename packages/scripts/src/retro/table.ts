// The retro's per-PR table: every factory PR updated since a time (and before one, with --until), read through GraphQL's search a page at a time, each page asked again when it fails, one tab-separated row each, from its first commit to its merge (or now), with its commits, force pushes, review rounds and their scores, and tester verdicts, each verdict read as the merge gate reads it.
import { verdictsOf } from "@packages/config/verdicts"

import { factoryRepoOf } from "../playground/setting"

export const QUERY = `query ($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        state
        title
        mergedAt
        firstCommit: commits(first: 1) { nodes { commit { authoredDate } } }
        allCommits: commits { totalCount }
        comments(first: 100) { totalCount nodes { author { login } body } }
        timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 1) { filteredCount }
      }
    }
  }
}`

export type Pr = {
  allCommits: { totalCount: number }
  comments: {
    nodes: ({ author: { login: string } | null; body: string } | null)[]
    totalCount: number
  }
  firstCommit: { nodes: { commit: { authoredDate: string } }[] }
  mergedAt: string | null
  number: number
  state: string
  timelineItems: { filteredCount: number }
  title: string
}

export type Page = {
  issueCount?: number
  nodes: (Pr | null)[]
  pageInfo: { endCursor: string | null; hasNextPage: boolean }
}

export const searchOf = (repo: string, since: string, until?: string): string =>
  `repo:${repo} is:pr updated:${until ? `${since}..${until}` : `>=${since}`}`

export const TRIES = 3
export const RETRY_MS = 5_000

type Answer = { stderr: string; stdout: string }

// One page, asked again after RETRY_MS up to TRIES times in all when it holds no search (gh exiting non-zero on a 5xx) or its body does not parse, since GitHub cuts off or 502s a large search answer now and then; a body is read whatever gh's exit code, since gh exits 1 on an answer whose errors sit beside its data; the last failure names the page's cursor.
export const pageOf = async (
  ask: () => Answer,
  after: string | null,
  wait: (ms: number) => Promise<void> = Bun.sleep,
): Promise<Page> => {
  let why = ""
  for (let tried = 1; tried <= TRIES; tried++) {
    if (tried > 1) await wait(RETRY_MS)
    const gh = ask()
    let answer: { data?: { search?: Page }; errors?: unknown } | null = null
    if (gh.stdout.trim())
      try {
        answer = JSON.parse(gh.stdout)
      } catch {
        why = `a body that does not parse: ${gh.stdout.slice(0, 80)}`
        continue
      }
    if (answer?.errors) console.error(JSON.stringify(answer.errors))
    if (answer?.data?.search) return answer.data.search
    why = gh.stderr.trim() || JSON.stringify(answer?.errors ?? answer)
  }
  throw new Error(
    `the page after cursor ${after ?? "(the first page)"} failed ${TRIES} times: ${why}`,
  )
}

// Every page of the search, each read from the last one's end, so no PR past the first page is left out.
export const readAll = async (read: (after: string | null) => Promise<Page>): Promise<Pr[]> => {
  const prs: Pr[] = []
  let after: string | null = null
  do {
    const page = await read(after)
    prs.push(...page.nodes.filter((p): p is Pr => p !== null))
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return prs
}

const clock = (iso: string | null | undefined) => iso?.slice(11, 16) ?? "-"

// Pure: the table's header, one row per PR by number, then a line for each PR whose comments ran past one read, since its later verdicts are missing from its row. Only the owner's comments count, as the merge gate counts them.
export const rowsOf = (prs: Pr[], owner: string, now: Date): string[] => {
  const sorted = [...prs].sort((a, b) => a.number - b.number)
  return [
    "pr\tstate\tfirst\tmerged\ttook\tcommits\tfp\trounds\tscores\ttests\ttitle",
    ...sorted.map((p) => {
      const first = p.firstCommit.nodes[0]?.commit.authoredDate
      const end = p.mergedAt ?? now.toISOString()
      const verdicts = p.comments.nodes.flatMap((c) =>
        c?.author?.login.toLowerCase() === owner.toLowerCase() ? verdictsOf(c.body) : [],
      )
      const reviews = verdicts.filter((v) => v.gate === "review")
      const tests = verdicts.filter((v) => v.gate === "tester")
      return [
        p.number,
        p.state[0],
        clock(first),
        clock(p.mergedAt),
        first ? `${Math.round((Date.parse(end) - Date.parse(first)) / 60_000)}m` : "-",
        `c${p.allCommits.totalCount}`,
        `fp${p.timelineItems.filteredCount}`,
        `r${reviews.length}`,
        `[${reviews.map((v) => `${v.round}:${v.score}`).join(" ")}]`,
        `t${tests.filter((v) => v.pass).length}/${tests.length}`,
        p.title.slice(0, 60),
      ].join("\t")
    }),
    ...sorted
      .filter((p) => p.comments.totalCount > p.comments.nodes.length)
      .map(
        (p) =>
          `#${p.number}: read ${p.comments.nodes.length} of ${p.comments.totalCount} comments, so later verdicts are missing from its row`,
      ),
  ]
}

if (import.meta.main) {
  const flag = (name: string) => {
    const at = process.argv.indexOf(name)
    return at === -1 ? null : (process.argv[at + 1] ?? "")
  }
  const since = flag("--since")
  const until = flag("--until")
  if (
    !since ||
    Number.isNaN(Date.parse(since)) ||
    (until !== null && Number.isNaN(Date.parse(until)))
  ) {
    console.error("usage: table.ts --since <ISO 8601 time> [--until <ISO 8601 time>]")
    process.exit(2)
  }
  const repo = await factoryRepoOf()
  let found = 0
  let seen = 0
  const prs = await readAll(async (after) => {
    const ask = () => {
      const gh = Bun.spawnSync(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${QUERY}`,
          "-f",
          `q=${searchOf(repo, since, until ?? undefined)}`,
          ...(after ? ["-f", `after=${after}`] : []),
        ],
        { stderr: "pipe", stdout: "pipe" },
      )
      return { stderr: gh.stderr.toString(), stdout: gh.stdout.toString() }
    }
    const page = await pageOf(ask, after).catch((error: Error) => {
      console.error(error.message)
      process.exit(1)
    })
    found = page.issueCount ?? found
    seen += page.nodes.length
    return page
  })
  console.log(rowsOf(prs, repo.split("/")[0]!, new Date()).join("\n"))
  // GitHub's search returns at most 1000 results, so a since that far back reads short; a PR GraphQL nulled beside its error was read, so it counts as seen
  if (found > seen) console.log(`read ${seen} of ${found} PRs: give a later --since`)
}
