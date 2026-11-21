import { expect, spyOn, test } from "bun:test"
import { chmodSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type Page,
  type Pr,
  pageOf,
  QUERY,
  readAll,
  RETRY_MS,
  rowsOf,
  searchOf,
  TRIES,
} from "../../../../../packages/scripts/src/retro/table"

const by = (login: string, body: string) => ({ author: { login }, body })
const NOW = new Date("2026-10-31T12:00:00Z")
// GitHub's totalCount counts the whole timeline and ignores itemTypes, so a row that read it would show fp61
const forcePushes = { filteredCount: 1, totalCount: 61 }
const noForcePush = { filteredCount: 0, totalCount: 61 }

const pr = (over: Partial<Pr> = {}): Pr => ({
  allCommits: { totalCount: 4 },
  comments: {
    nodes: [
      by("acme", "## ReviewBot · round 1: 3/5 at 1717063 · 1 blocking"),
      by("acme", "a note from the author"),
      by("acme", "## ReviewBot · round 2: 5/5 at 0f4d307 · 0 blocking"),
      by("acme", "## TesterBot · FAIL at 1717063 · the card is blank"),
      by("acme", "## TesterBot · PASS at 0f4d307 · drove it"),
      by("someone", "## ReviewBot · round 3: 5/5 at 0f4d307 · copied"),
    ],
    totalCount: 6,
  },
  firstCommit: { nodes: [{ commit: { authoredDate: "2026-10-31T10:00:00Z" } }] },
  mergedAt: "2026-10-31T11:30:00Z",
  number: 12,
  state: "MERGED",
  timelineItems: forcePushes,
  title: "fix(PG-12): a title",
  ...over,
})

test("a merged PR reads its first commit to merge, commits, force pushes, the owner's review rounds, and its tester passes out of its tester verdicts", () => {
  expect(rowsOf([pr()], "acme", NOW)).toEqual([
    "pr\tstate\tfirst\tmerged\ttook\tcommits\tfp\trounds\tscores\ttests\ttitle",
    "12\tM\t10:00\t11:30\t90m\tc4\tfp1\tr2\t[1:3 2:5]\tt1/2\tfix(PG-12): a title",
  ])
})

test("an open PR counts to now, rows sort by number, a PR with no commit reads its gap as -, a PR with no force push reads fp0 however long its timeline (#2441), and comments past one read are named", () => {
  const open = pr({ mergedAt: null, number: 30, state: "OPEN" })
  const empty = pr({
    comments: { nodes: [], totalCount: 140 },
    firstCommit: { nodes: [] },
    mergedAt: null,
    number: 7,
    state: "CLOSED",
    timelineItems: noForcePush,
  })
  expect(rowsOf([open, empty], "acme", NOW).slice(1)).toEqual([
    "7\tC\t-\t-\t-\tc4\tfp0\tr0\t[]\tt0/0\tfix(PG-12): a title",
    "30\tO\t10:00\t-\t120m\tc4\tfp1\tr2\t[1:3 2:5]\tt1/2\tfix(PG-12): a title",
    "#7: read 0 of 140 comments, so later verdicts are missing from its row",
  ])
})

test("every page of the search is read, each from the last one's end", async () => {
  const asked: (string | null)[] = []
  const pages: Record<string, Page> = {
    first: { nodes: [pr({ number: 1 })], pageInfo: { endCursor: "c1", hasNextPage: true } },
    c1: { nodes: [pr({ number: 2 })], pageInfo: { endCursor: "c2", hasNextPage: false } },
  }
  const prs = await readAll(async (after) => (asked.push(after), pages[after ?? "first"]!))
  expect(prs.map((p) => p.number)).toEqual([1, 2])
  expect(asked).toEqual([null, "c1"])
})

test("the search reads the factory's PRs updated since a time, and the query pages and asks for every field rowsOf reads", () => {
  expect(searchOf("acme/factory", "2026-10-31T00:00:00Z")).toBe(
    "repo:acme/factory is:pr updated:>=2026-10-31T00:00:00Z",
  )
  expect(searchOf("acme/factory", "2026-10-31T00:00:00Z", "2026-10-31T06:00:00Z")).toBe(
    "repo:acme/factory is:pr updated:2026-10-31T00:00:00Z..2026-10-31T06:00:00Z",
  )
  for (const field of [
    "after: $after",
    "allCommits",
    "author { login }",
    "endCursor",
    "firstCommit",
    "hasNextPage",
    "mergedAt",
    "timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 1) { filteredCount }",
    "totalCount",
  ])
    expect(QUERY).toContain(field)
  expect(QUERY).toContain("first: 25, after: $after")
})

const TABLE = join(import.meta.dir, "../../../../../packages/scripts/src/retro/table.ts")
const answer = (page: Page) => JSON.stringify({ data: { search: { issueCount: 1, ...page } } })

// A fake gh first on PATH: the first page's read and each read after a cursor answer in turn from the folder's numbered files, each an exit code, an answer and a stderr line.
const fakeGh = async (answers: { code: number; err?: string; out: string }[]) => {
  const dir = mkdtempSync(join(tmpdir(), "retro-gh-"))
  for (const [i, a] of answers.entries()) {
    await Bun.write(join(dir, `${i}.out`), a.out)
    await Bun.write(join(dir, `${i}.err`), a.err ?? "")
    await Bun.write(join(dir, `${i}.code`), String(a.code))
  }
  await Bun.write(
    join(dir, "gh"),
    `#!/bin/bash
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "${dir}/count"
printf '%s' "$*" > "${dir}/args.$n"
cat "${dir}/$n.out"
cat "${dir}/$n.err" >&2
exit "$(cat "${dir}/$n.code")"
`,
  )
  chmodSync(join(dir, "gh"), 0o755)
  return dir
}

// a case that waits out the retries gets their full wait on top of the run's own time
const RETRIES_TIMEOUT = (TRIES - 1) * RETRY_MS + 20_000

const runTable = async (dir: string, args = ["--since", "2026-10-31T00:00:00Z"]) => {
  const proc = Bun.spawn(["bun", "--no-env-file", TABLE, ...args], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, err, out }
}

test(
  "a page that fails once with a 502 is read again, and its rows print",
  async () => {
    const dir = await fakeGh([
      { code: 1, err: "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)", out: "" },
      {
        code: 0,
        out: answer({ nodes: [pr()], pageInfo: { endCursor: null, hasNextPage: false } }),
      },
    ])
    const run = await runTable(dir)
    expect(run.err).toBe("")
    expect(run.code).toBe(0)
    expect(run.out).toContain("12\tM\t10:00\t11:30\t90m")
  },
  RETRIES_TIMEOUT,
)

test(
  "a page that fails three times, cut off and then 502s, exits 1 naming its cursor",
  async () => {
    const dir = await fakeGh([
      {
        code: 0,
        out: answer({ nodes: [pr()], pageInfo: { endCursor: "Y3Vyc29yOjI1", hasNextPage: true } }),
      },
      { code: 0, out: '{"data":{"search":{"issueCount":1,"nodes":[{"num' },
      { code: 1, err: "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)", out: "" },
      { code: 1, err: "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)", out: "" },
    ])
    const run = await runTable(dir)
    expect(run.code).toBe(1)
    expect(run.err).toContain("Y3Vyc29yOjI1")
    expect(run.err).toContain("3 times")
    expect(await Bun.file(join(dir, "args.3")).text()).toContain("after=Y3Vyc29yOjI1")
  },
  RETRIES_TIMEOUT,
)

test("a page that answers with data and errors, which gh exits 1 on, returns its data and prints the errors", async () => {
  const page = { nodes: [pr()], pageInfo: { endCursor: null, hasNextPage: false } }
  const errors = [{ message: "Something went wrong while resolving a comment" }]
  const printed = spyOn(console, "error").mockImplementation(() => {})
  const read = await pageOf(
    () => ({
      stderr: "gh: Something went wrong while resolving a comment",
      stdout: JSON.stringify({ data: { search: page }, errors }),
    }),
    null,
    async () => {},
  )
  expect(read).toEqual(page)
  expect(printed).toHaveBeenCalledWith(JSON.stringify(errors))
  printed.mockRestore()
})

test("a page gh exits 1 on with data beside its errors prints its rows from one read", async () => {
  const errors = [{ message: "Something went wrong while resolving a comment" }]
  const dir = await fakeGh([
    {
      code: 1,
      err: "gh: Something went wrong while resolving a comment",
      out: JSON.stringify({
        data: {
          search: {
            issueCount: 1,
            nodes: [pr()],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
        errors,
      }),
    },
  ])
  const run = await runTable(dir)
  expect(run.code).toBe(0)
  expect(run.out).toContain("12\tM\t10:00\t11:30\t90m")
  expect(run.err).toContain(JSON.stringify(errors))
  expect(await Bun.file(join(dir, "count")).text()).toBe("1\n")
}, 30_000)

test("an --until with no time after it is a usage error", async () => {
  const dir = await fakeGh([])
  const run = await runTable(dir, ["--since", "2026-10-31T00:00:00Z", "--until"])
  expect(run.code).toBe(2)
  expect(run.err).toContain("usage: table.ts")
  expect(await Bun.file(join(dir, "count")).exists()).toBe(false)
}, 30_000)

test(
  "a page whose errors come with no data is asked again and then exits 1, never an empty table",
  async () => {
    const limited = {
      code: 1,
      err: "gh: API rate limit exceeded",
      out: JSON.stringify({
        data: null,
        errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }],
      }),
    }
    const dir = await fakeGh([limited, limited, limited])
    const run = await runTable(dir)
    expect(run.code).toBe(1)
    expect(run.out).toBe("")
    expect(run.err).toContain("the page after cursor (the first page) failed 3 times")
    expect(await Bun.file(join(dir, "count")).text()).toBe("3\n")
  },
  RETRIES_TIMEOUT,
)

test("a comment and a PR that GraphQL nulled beside their errors are skipped, and the other rows print", async () => {
  const errors = [
    {
      message: "Something went wrong while resolving a comment",
      path: ["search", "nodes", 0, "comments", "nodes", 1, "body"],
    },
    {
      message: "Something went wrong while resolving a PR",
      path: ["search", "nodes", 1, "timelineItems"],
    },
  ]
  const nulled = pr()
  nulled.comments.nodes[1] = null
  const dir = await fakeGh([
    {
      code: 1,
      err: "gh: Something went wrong while resolving a comment",
      out: JSON.stringify({
        data: {
          search: {
            issueCount: 2,
            nodes: [nulled, null],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
        errors,
      }),
    },
  ])
  const run = await runTable(dir)
  expect(run.code).toBe(0)
  expect(run.out).toContain("12\tM\t10:00\t11:30\t90m\tc4\tfp1")
  expect(run.out).not.toContain("give a later --since")
  expect(run.err).toContain(JSON.stringify(errors))
}, 30_000)
