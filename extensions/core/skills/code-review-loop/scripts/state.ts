#!/usr/bin/env -S bun --no-env-file
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative, dirname, basename, isAbsolute } from "node:path"

export const VERDICT = /^##\s*ReviewBot\s*·\s*round\s+(\d+):\s*(\d)\/5\s+at\s+`?([0-9a-f]{7,40})/i
export const WAIT_SECONDS = 300

export const PR_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
number state isDraft headRefOid body
comments(last:100){pageInfo{hasPreviousPage} nodes{author{login} body createdAt url}}
reviews(last:50){pageInfo{hasPreviousPage} nodes{author{login} body submittedAt state}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved path line originalLine
opener:comments(first:1){nodes{author{login} body}} comments(last:1){nodes{author{login} body createdAt}}}}}}}`

export const SCAN_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
number title isDraft headRefOid author{login} comments(last:100){nodes{author{login} body}}}}}}`

type Json = Record<string, any>

// A failed gh or git call: subprocess.CalledProcessError's shape, the fields the handlers read.
export class Called extends Error {
  cmd: string[]
  stdout: string
  stderr: string
  constructor(cmd: string[], stdout: string, stderr: string) {
    super(`${cmd.join(" ")} failed: ${stderr.trim()}`)
    this.cmd = cmd
    this.stdout = stdout
    this.stderr = stderr
  }
  get output(): string {
    return this.stdout
  }
}

// The seam the tests swap: run() is one gh or git call's stdout, gh skipped while ghDown names why, sleep() waits, time() reads the clock in seconds.
// io.tests's command: RUN_SLOT_HERE=1 keeps the run on this machine, since run-slot sends a test:file run to the runner box by default, whose junit report never comes back, so every red would read as NO-REPORT.
export const testsArgv = (
  session: string,
  clone: string,
  files: string[],
  report: string,
): string[] => [
  join(homedir(), ".playground", "ops", "run-slot.sh"),
  session,
  "--",
  "env",
  "RUN_SLOT_HERE=1",
  "bun",
  `--cwd=${clone}`,
  "run",
  "test:file",
  "--reporter=junit",
  `--reporter-outfile=${report}`,
  ...files,
]

// GH_STALE_MS in packages/scripts/src/gh-read.ts, in seconds, which a test holds equal; a skill's script imports nothing outside its folder, so ghDown's rule is kept here too.
export const GH_STALE_SECONDS = 120

// Why gh fails, from ops-tick's gh sign-in probe (ops/tick/gh-auth.json in the data folder) while its result reads failed and is under GH_STALE_SECONDS old, else null, so a waiter skips gh rather than flood a broken one.
export const ghDown = (
  data = process.env.PLAYGROUND_DATA_DIR || join(homedir(), ".playground"),
  now = Date.now(),
): string | null => {
  try {
    const last = JSON.parse(readFileSync(join(data, "ops", "tick", "gh-auth.json"), "utf8"))
    return last.ok === false && now - Date.parse(String(last.at)) <= GH_STALE_SECONDS * 1000
      ? last.reason || "gh fails"
      : null
  } catch {
    return null
  }
}

export const io = {
  run: (...args: string[]): string => {
    const down = args[0] === "gh" ? ghDown() : null
    if (down) throw new Called(args, "", `gh unreachable: ${down}`)
    const out = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
    const stdout = out.stdout.toString()
    const stderr = out.stderr.toString()
    if (out.exitCode !== 0) throw new Called(args, stdout, stderr)
    return stdout
  },
  sleep: (s: number): Promise<void> => Bun.sleep(s * 1000),
  // One run of test files in the clone through run-slot, green or not, its junit report written to <report>.
  tests: (session: string, clone: string, files: string[], report: string): boolean =>
    Bun.spawnSync(testsArgv(session, clone, files, report), {
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode === 0,
  time: (): number => Date.now() / 1000,
}

export const verdictOf = (body: string | null | undefined): [number, number, string] | null => {
  const m = VERDICT.exec((body || "").replace(/^\s+/, "").split("\n", 1)[0]!)
  return m ? [Number(m[1]), Number(m[2]), m[3]!.toLowerCase()] : null
}

export const latestVerdict = (
  comments: Json[],
  login: string,
): [[number, number, string] | null, Json | null] => {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!
    if ((c.author || {}).login === login && verdictOf(c.body)) return [verdictOf(c.body), c]
  }
  return [null, null]
}

export const atHead = (sha: string, head: string): boolean =>
  Boolean(sha) && head.toLowerCase().startsWith(sha.toLowerCase())

export const scanRow = (pr: Json, login: string): Json => {
  const [verdict] = latestVerdict(pr.comments.nodes, login)
  const head = pr.headRefOid as string
  const status = !verdict
    ? "UNREVIEWED"
    : atHead(verdict[2], head)
      ? `SCORED ${verdict[1]}/5`
      : `STALE ${verdict[1]}/5 at ${verdict[2].slice(0, 7)}`
  return {
    author: (pr.author || {}).login,
    draft: pr.isDraft,
    head: head.slice(0, 7),
    number: pr.number,
    status,
    title: pr.title,
  }
}

// A relative PLAYGROUND_DATA_DIR is refused, as packages/env/src/data-dir.ts refuses it.
export const dataDir = (): string => {
  const named = process.env.PLAYGROUND_DATA_DIR
  if (named && !isAbsolute(named))
    throw new Error(
      `PLAYGROUND_DATA_DIR is relative (${named}), so each process would read it from its own folder: set it to an absolute path`,
    )
  return named || `${process.env.HOME}/.playground`
}

export const rosterPath = (): string => join(dataDir(), "roster.json")

export const prUrl = (repo: string, n: number | string): RegExp =>
  new RegExp(
    `^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/${n}(?:[/?#]|$)`,
    "i",
  )

export const liveAgents = (roster: Json | null): Json[] =>
  ((roster || {}).agents || []).filter(
    (a: Json) =>
      typeof a === "object" && a !== null && a.status !== "ended" && typeof a.name === "string",
  )

export const holders = (roster: Json | null, repo: string, n: number): string[] => {
  const url = prUrl(repo, n)
  return liveAgents(roster)
    .filter((a) => typeof a.pr === "string" && url.test(a.pr))
    .map((a) => a.name as string)
    .sort()
}

export const planPath = (): string =>
  process.env.PLAYGROUND_PLAN_PATH || join(dataDir(), "bundles", "plan.json")

export const readPlan = (): Json[] => {
  let plan: Json
  try {
    plan = JSON.parse(readFileSync(planPath(), "utf8")) as Json
  } catch {
    return []
  }
  const lanes =
    typeof plan === "object" && plan !== null && Array.isArray((plan as Json).lanes)
      ? (plan as Json).lanes
      : null
  return (lanes || []).flatMap((lane: Json) =>
    typeof lane === "object" && lane !== null && Array.isArray(lane.items)
      ? lane.items.filter((item: Json) => typeof item === "object" && item !== null)
      : [],
  )
}

export const plansDir = (): string =>
  process.env.PLAYGROUND_PLANS_DIR || join(dataDir(), "notes", ".github", "notes", "plans")

export const readPlans = (): Record<string, string> => {
  let names: string[]
  try {
    names = readdirSync(plansDir())
      .filter((n) => n.endsWith(".md"))
      .sort()
  } catch {
    return {}
  }
  const texts: Record<string, string> = {}
  for (const name of names) {
    try {
      texts[name] = readFileSync(join(plansDir(), name), "utf8")
    } catch {
      continue
    }
  }
  return texts
}

export const plansNaming = (plans: Record<string, string>, n: number | string): string[] => {
  const mention = new RegExp(`(?<![\\w#])#${n}(?!\\d)`)
  return Object.keys(plans).filter((name) => mention.test(plans[name]!))
}

export const holderTag = (
  roster: Json | null,
  plans: Record<string, string>,
  repo: string,
  n: number,
  author?: string,
  me?: string,
  plan: Json[] = [],
): [string, boolean] => {
  const held = [
    ...new Set([...holders(roster, repo, n), ...planHolders(roster, plan, repo, n)]),
  ].sort()
  if (held.length) return [held.join(", "), false]
  if (author && me && author !== me)
    return [
      "outside author {AUTHOR}: the builder triages (a colleague's: the dispatcher decides per the org's channel triage; another's app PR: read-only review then the gate; skills/factory: closed)".replace(
        "{AUTHOR}",
        author,
      ),
      false,
    ]
  const named = (planNaming(plan, repo, n).length ? ["plan.json"] : []).concat(
    plansNaming(plans, n),
  )
  if (!named.length) return ["no agent, in no plan: lost", true]
  return [
    `no agent; parked in ${named[0]}${named.length > 1 ? ` (+${named.length - 1})` : ""}`,
    false,
  ]
}

export const readRoster = (): [Json | null, string | null] => {
  try {
    return [JSON.parse(readFileSync(rosterPath(), "utf8")) as Json, null]
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return [null, null]
    return [null, `roster unreadable: ${e}`]
  }
}

export const openThreads = (threads: Json[]): Json[] => {
  const out: Json[] = []
  for (const t of threads) {
    const opener = t.opener && t.opener.nodes !== undefined ? t.opener : t.comments
    const notes = t.comments.nodes as Json[]
    if (t.isResolved || !opener.nodes.length) continue
    const ours = ((opener.nodes[0] as Json)?.body || "").includes("ReviewBot")
    const line = t.line || t.originalLine
    out.push({
      by: (opener.nodes[0] as Json)?.author?.login ?? "?",
      first: firstLine(opener.nodes[0]!.body),
      id: t.id,
      last: (notes.at(-1) as Json)?.author?.login ?? "?",
      ours,
      replied:
        ours && notes.length > 0 && !((notes.at(-1) as Json).body || "").includes("ReviewBot"),
      unknown: t.isResolved === null,
      where: line ? `${t.path}:${line}` : `${t.path} (outdated)`,
    })
  }
  return out
}

export const cutLists = (pr: Json): string[] => {
  const pages: Record<string, string> = {
    comments: "hasPreviousPage",
    reviews: "hasPreviousPage",
    reviewThreads: "hasNextPage",
  }
  return Object.keys(pages).filter((k) => ((pr[k] || {}).pageInfo || {})[pages[k]!])
}

export const saidSince = (
  comments: Json[],
  reviews: Json[],
  since: string | null,
): [string, string, string][] => {
  const out: [string, string, string][] = []
  for (const c of comments) {
    if (since && c.createdAt <= since) continue
    if (verdictOf(c.body)) continue
    out.push([c.createdAt, (c.author || {}).login ?? "?", firstLine(c.body)])
  }
  for (const r of reviews) {
    if (!r.submittedAt || (since && r.submittedAt <= since) || !(r.body || "").trim()) continue
    out.push([r.submittedAt, (r.author || {}).login ?? "?", firstLine(r.body)])
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return out.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]))
}

export const firstLine = (body: string | null | undefined): string =>
  (body || "").trim().split("\n", 1)[0]!.slice(0, 120)

// A text's lines as Python's splitlines() gives them, with no empty last line after a final newline
const linesOf = (text: string): string[] => {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export const normalize = (diff: string): string[] =>
  linesOf(diff).filter(
    (line) => !line.startsWith("index ") && !line.startsWith("@@") && !line.startsWith(" "),
  )

export const perFile = (diff: string): Record<string, string> => {
  const out: Record<string, string> = {}
  let name: string | null = null
  let body: string[] = []
  for (const line of linesOf(diff)) {
    if (line.startsWith("diff --git a/")) {
      if (name) out[name] = normalize(body.join("\n")).join("\n")
      name = line.slice("diff --git a/".length).split(" b/", 1)[0]!
      body = []
    }
    body.push(line)
  }
  if (name) out[name] = normalize(body.join("\n")).join("\n")
  return out
}

export const deltaKind = (
  oldDiff: string,
  newDiff: string,
  own: string[] = [],
): ["BASE-MERGE", string[]] | ["OWN", string[]] => {
  const old = perFile(oldDiff)
  const neu = perFile(newDiff)
  const moved = [
    ...new Set(
      [...new Set([...Object.keys(old), ...Object.keys(neu)])]
        .filter((f) => old[f] !== neu[f])
        .concat(own),
    ),
  ].sort()
  return moved.length === 0 ? ["BASE-MERGE", []] : ["OWN", moved]
}

const author = (item: Json): Json => ({ login: (item.user || {}).login })

export const restThreads = (reviewComments: Json[]): Json[] => {
  const threads: Record<string, Json[]> = {}
  for (const c of [...reviewComments].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    const root = c.in_reply_to_id || c.id
    ;(threads[root] ||= []).push(c)
  }
  const out: Json[] = []
  for (const [root, notes] of Object.entries(threads)) {
    const first = notes[0]!
    const last = notes.at(-1)!
    out.push({
      comments: { nodes: [{ author: author(last), body: last.body, createdAt: last.created_at }] },
      id: `comment ${root}`,
      isResolved: null,
      line: first.line,
      opener: { nodes: [{ author: author(first), body: first.body }] },
      originalLine: first.original_line,
      path: first.path,
    })
  }
  return out
}

export const restState = (view: Json): string =>
  view.merged ? "MERGED" : (view.state as string).toUpperCase()

export const restPr = (
  view: Json,
  comments: Json[],
  reviews: Json[],
  reviewComments: Json[],
): Json => ({
  body: view.body,
  comments: {
    nodes: comments.map((c) => ({
      author: author(c),
      body: c.body,
      createdAt: c.created_at,
      url: c.html_url,
    })),
    pageInfo: {},
  },
  headRefOid: view.head.sha,
  isDraft: view.draft,
  number: view.number,
  reviewThreads: { nodes: restThreads(reviewComments), pageInfo: {} },
  reviews: {
    nodes: reviews.map((r) => ({
      author: author(r),
      body: r.body,
      state: r.state,
      submittedAt: r.submitted_at,
    })),
    pageInfo: {},
  },
  state: restState(view),
})

export const restScanPr = (view: Json, comments: Json[]): Json => ({
  author: author(view),
  comments: { nodes: comments.map((c) => ({ author: author(c), body: c.body })) },
  headRefOid: view.head.sha,
  isDraft: view.draft,
  number: view.number,
  title: view.title,
})

const spent = (error: Called): boolean => (error.stderr || "").toLowerCase().includes("rate limit")

export const graphql = (query: string, variables: Record<string, string | number>): Json =>
  (() => {
    const args = ["gh", "api", "graphql", "-f", `query=${query}`]
    for (const [k, v] of Object.entries(variables))
      args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`)
    return JSON.parse(io.run(...args)).data.repository as Json
  })()

export const rest = (path: string): Json[] =>
  (JSON.parse(io.run("gh", "api", "--paginate", "--slurp", path)) as Json[][]).flat()

export const login = (): string => io.run("gh", "api", "user", "--jq", ".login").trim()

export const splitRepo = (repo: string): [string, string] => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) exitWith(`not an owner/repo: ${repo}`)
  return repo.split("/", 2) as [string, string]
}

export const number = (text: string): number => {
  if (!/^\d+$/.test(text)) exitWith(`not a PR number: ${text}`)
  return Number(text)
}

// The factory repo's own name, lowercased: PLAYGROUND_FACTORY_REPO when set (the tests' seam), else factory.repo from the data folder's policy.json (setting.ts's factoryRepo rule), else this checkout's origin. A plan row whose pr is a bare number names a PR of this repo alone; empty when none of the three reads, so no number row matches.
const factoryRepoCache: { repo?: string } = {}
export const factoryRepoName = (): string => {
  const named = process.env.PLAYGROUND_FACTORY_REPO
  if (named) return named.toLowerCase()
  if (factoryRepoCache.repo === undefined) {
    let repo = ""
    try {
      const policy = JSON.parse(
        readFileSync(join(dataDir(), "extensions", "policy.json"), "utf8"),
      ) as Json
      const value = ((policy || {}).values || {})["factory.repo"]
      if (typeof value === "string" && value) repo = value.toLowerCase()
    } catch {}
    if (!repo) {
      try {
        const url = io.run(
          "git",
          "-C",
          join(import.meta.dir, "..", "..", "..", "..", ".."),
          "remote",
          "get-url",
          "origin",
        )
        repo = (
          /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1] ?? ""
        ).toLowerCase()
      } catch {}
    }
    factoryRepoCache.repo = repo
  }
  return factoryRepoCache.repo
}

const planNaming = (plan: Json[], repo: string, n: number): Json[] => {
  const url = prUrl(repo, n)
  const factory = factoryRepoName() === repo.toLowerCase()
  return plan.filter(
    (i) =>
      typeof i === "object" &&
      i !== null &&
      ((typeof i.pr === "string" && url.test(i.pr)) ||
        (factory && typeof i.pr === "number" && i.pr === n)),
  )
}

const planHolders = (roster: Json | null, plan: Json[], repo: string, n: number): string[] => {
  const live = new Set(liveAgents(roster).map((a) => a.name as string))
  const words = planNaming(plan, repo, n).flatMap((i) =>
    typeof i.worker === "string" ? i.worker.trim().split(/\s+/).slice(0, 1) : [],
  )
  return [...new Set(words.filter((w) => w && live.has(w)))].sort()
}

const exitWith = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

export const cmdPr = async (repo: string, n: string): Promise<void> => {
  const [owner, name] = splitRepo(repo)
  const readAt = isoSeconds(io.time())
  let pr: Json
  try {
    pr = graphql(PR_QUERY, { name, n: number(n), owner }).pullRequest as Json
  } catch (e) {
    if (!(e instanceof Called) || !spent(e)) throw e
    console.log("GraphQL spent: read over REST; thread resolution unknown")
    const base = `repos/${repo}`
    pr = restPr(
      JSON.parse(io.run("gh", "api", `${base}/pulls/${n}`)) as Json,
      rest(`${base}/issues/${n}/comments?per_page=100`),
      rest(`${base}/pulls/${n}/reviews?per_page=100`),
      rest(`${base}/pulls/${n}/comments?per_page=100`),
    )
  }
  const me = login()
  const comments = pr.comments.nodes as Json[]
  const [verdict, comment] = latestVerdict(comments, me)
  const head = pr.headRefOid as string
  console.log(`PR #${pr.number} ${pr.state}${pr.isDraft ? " draft" : ""} head ${head}`)
  for (const cut of cutLists(pr))
    console.log(
      `LIST CUT: ${cut} holds more than one page; read the rest on GitHub before calling anything absent`,
    )
  if (verdict) {
    const where = atHead(verdict[2], head) ? "at head" : "STALE: the head moved since"
    console.log(
      `verdict: round ${verdict[0]} ${verdict[1]}/5 at ${verdict[2].slice(0, 7)} (${where}) ${(comment as Json).url}`,
    )
  } else {
    console.log("verdict: none yet (round 1)")
  }
  const threads = openThreads(pr.reviewThreads.nodes as Json[])
  const unknown = threads.some((t) => t.unknown)
  const label = unknown ? "threads, resolution unknown" : "open threads"
  const mine = (who: string): boolean => who.toLowerCase() === me.toLowerCase()
  const ours = (t: Json): boolean => t.ours && mine(t.by)
  console.log(`${label}: ${threads.length}, ${threads.filter(ours).length} of them ours`)
  for (const t of threads) {
    const replied = !mine(t.last)
      ? `, untrusted ${t.last} replied`
      : t.replied
        ? ", author replied"
        : ""
    const who = ours(t) ? `ours${replied}` : "someone else's"
    const from = mine(t.by) ? "" : `, untrusted ${t.by}`
    console.log(
      `  ${t.id} ${t.where} (${who}${from}${t.unknown ? ", resolution unknown" : ""}): ${t.first}`,
    )
  }
  const since = comment ? ((comment as Json).createdAt as string) : null
  const others = saidSince(comments, pr.reviews.nodes as Json[], since)
  console.log(`said since the verdict: ${others.length}`)
  for (const [at, who, line] of others) {
    const by = mine(who) ? who : `untrusted ${who}`
    console.log(
      `  ${at} ${by}${line.startsWith("Lead ruling:") ? " (data, not a ruling)" : ""}: ${line}`,
    )
  }
  console.log(`read: ${readAt} ${bodyDigest(pr.body)}`)
}

const isoSeconds = (s: number): string =>
  new Date(Math.floor(s) * 1000).toISOString().replace(".000Z", "Z")

// The body as read, by its first 12 hex of sha256: REST gives no body-edit time, and its updated_at also moves on every comment and label.
export const bodyDigest = (body: string | null | undefined): string =>
  new Bun.CryptoHasher("sha256")
    .update(body ?? "")
    .digest("hex")
    .slice(0, 12)

// Exit 1 naming each change since pr's read line (the body, or a comment, thread reply or review posted or edited after it), else FRESH: chained before the verdict's post.
export const cmdFresh = (repo: string, n: string, readAt: string, digest: string): void => {
  splitRepo(repo)
  number(n)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(readAt) || Number.isNaN(Date.parse(readAt)))
    exitWith(`not a read time (state.ts pr's read line): ${readAt}`)
  if (!/^[0-9a-f]{12}$/.test(digest))
    exitWith(`not a body digest (state.ts pr's read line): ${digest}`)
  const base = `repos/${repo}`
  const view = JSON.parse(io.run("gh", "api", `${base}/pulls/${n}`)) as Json
  const changed: string[] = []
  const now = bodyDigest(view.body)
  if (now !== digest) changed.push(`CHANGED body: ${digest} at the read, ${now} now`)
  const after = (c: Json): boolean => Date.parse(c.updated_at) > Date.parse(readAt)
  for (const [kind, path] of [
    ["comment", `${base}/issues/${n}/comments`],
    ["review comment", `${base}/pulls/${n}/comments`],
  ] as const)
    for (const c of rest(`${path}?since=${readAt}&per_page=100`).filter(after))
      changed.push(
        `CHANGED ${kind} ${c.html_url} by ${(c.user || {}).login} at ${c.updated_at}: ${firstLine(c.body)}`,
      )
  for (const r of rest(`${base}/pulls/${n}/reviews?per_page=100`))
    if (r.submitted_at && Date.parse(r.submitted_at) > Date.parse(readAt) && (r.body || "").trim())
      changed.push(
        `CHANGED review ${r.html_url} by ${(r.user || {}).login} at ${r.submitted_at}: ${firstLine(r.body)}`,
      )
  if (!changed.length) {
    console.log(`FRESH since ${readAt}`)
    return
  }
  for (const line of changed) console.log(line)
  process.exitCode = 1
}

export const cmdScan = async (repo: string): Promise<void> => {
  const [owner, name] = splitRepo(repo)
  let prs: Json[]
  try {
    prs = graphql(SCAN_QUERY, { name, owner }).pullRequests.nodes as Json[]
  } catch (e) {
    if (!(e instanceof Called) || !spent(e)) throw e
    console.log("GraphQL spent: read over REST")
    prs = (rest(`repos/${repo}/pulls?state=open&per_page=100`) as Json[]).map((view) =>
      restScanPr(view, rest(`repos/${repo}/issues/${view.number}/comments?per_page=100`)),
    )
  }
  const me = login()
  const [roster, problem] = readRoster()
  if (problem) console.log(problem)
  const plans = readPlans()
  const plan = readPlan()
  const rows = prs
    .map((pr) => scanRow(pr, me))
    .sort((a, b) => (a.number as number) - (b.number as number))
  let lost = 0
  for (const r of rows) {
    const [tag, isLost] = holderTag(
      roster,
      plans,
      repo,
      r.number as number,
      r.author as string,
      me,
      plan,
    )
    lost += isLost ? 1 : 0
    console.log(`#${r.number} ${r.head} ${r.status}${r.draft ? " draft" : ""} [${tag}]: ${r.title}`)
  }
  const unscored = rows.filter((r) => !(r.status as string).startsWith("SCORED"))
  console.log(`RESULT: ${rows.length} open, ${unscored.length} with an unscored head, ${lost} lost`)
}

export const cmdDelta = (worktree: string, base: string, old: string, neu: string): void => {
  const oldDiff = io.run("git", "-C", worktree, "diff", `${base}...${old}`)
  const newDiff = io.run("git", "-C", worktree, "diff", `${base}...${neu}`)
  const own = io
    .run(
      "git",
      "-C",
      worktree,
      "log",
      "--no-merges",
      "--format=",
      "--name-only",
      `${old}..${neu}`,
      `^${base}`,
    )
    .split(/\s+/)
    .filter(Boolean)
  const [kind, moved] = deltaKind(oldDiff, newDiff, own)
  console.log(kind === "BASE-MERGE" ? kind : `OWN: ${moved.join(" ")}`)
}

const SCAN_TS = "ls-files|Bun\\.Glob|new Glob\\(|readdirSync|readdir\\("
const SCAN_RE = new RegExp(SCAN_TS)
const skipQuoted = (text: string, from: number, close: string): number => {
  let j = from
  while (j < text.length && text.charAt(j) !== "\n") {
    if (text.charAt(j) === "\\") j += 2
    else if (text.charAt(j) === close) return j + 1
    else j += 1
  }
  return -1
}
const charBefore = (text: string, from: number): string => {
  let j = from
  while (j > 0 && /\s/.test(text.charAt(j - 1))) j -= 1
  return text.charAt(j - 1)
}
const skipRegex = (text: string, from: number): number => {
  let j = from
  let inClass = false
  while (j < text.length && text.charAt(j) !== "\n") {
    const d = text.charAt(j)
    if (d === "\\") j += 2
    else if (inClass) {
      if (d === "]") inClass = false
      j += 1
    } else if (d === "[") {
      inClass = true
      j += 1
    } else if (d === "/") return j + 1
    else j += 1
  }
  return -1
}
// a / after one of these opens a regex literal, never a comment or a division
const REGEX_BEFORE = "([=:!&|?{};>,"
// A scan word counts only where the test calls it, so what a string merely holds comes out before the regexes read: a string or template is kept by default and dropped only when it opens a value, straight after = : + ? or >, so fixture strings quoting readdirSync read as no scanner while a call, an argv element or a regex literal reads as one, a / after ( = : [ ! & | ? { } ; > or , opens a regex literal that stays whole, so a quote inside one cannot drop or pair, and a quote or template pairs on its own line alone, so a stray backtick in a comment cannot swallow one (PG-1651's reviewer, PG-1661, PG-1708's rounds 1 to 3)
const stripValues = (text: string): string => {
  let out = ""
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === "[") {
      depth += 1
      out += c
      i += 1
    } else if (c === "]") {
      depth = Math.max(0, depth - 1)
      out += c
      i += 1
    } else if (
      c === "/" &&
      text.charAt(i + 1) !== "/" &&
      text.charAt(i + 1) !== "*" &&
      REGEX_BEFORE.includes(charBefore(text, i))
    ) {
      const end = skipRegex(text, i + 1)
      if (end < 0) {
        out += c
        i += 1
      } else {
        out += text.slice(i, end)
        i = end
      }
    } else if (c === "`" || c === '"' || c === "'") {
      const prev = charBefore(text, i)
      const keeps = depth > 0 || !["=", ":", "+", "?", ">"].includes(prev)
      const end = skipQuoted(text, i + 1, c)
      if (end < 0) {
        out += c
        i += 1
      } else {
        if (keeps) out += text.slice(i, end)
        i = end
      }
    } else {
      out += c
      i += 1
    }
  }
  return out
}
// A git grep run as a shell line or an argv, wrapped across lines or with options before the subcommand (PG-2323's old-proxy)
const GIT_GREP =
  /\bgit["'`]?(?:[\s,\[]+(?:["']?-[\w-]+["']?|\$?\{?[\w.$]+\}?|["'][^"'\n]*["'])){0,3}?[\s,\[]+["'`]?grep\b/
const SCAN_PY = "rglob\\(|\\.glob\\(|os\\.walk|read_text\\("
// A Python test that walks the whole repo, a guard reading every file's text, which names no changed path: one PR's touched tests ran green while CI went red on such a guard; a walk joins whatever paths its text names, since a root walk can still name one to skip
const PY_TEST = /^tests\/(.+\/)?test_[^/]+\.py$/
const WALKS_REPO = /ls-files|os\.walk\(|rglob\(/
// Tests whose imported source scans the repo, so no grep of their own text finds them
const SCANS_THROUGH_SOURCE = [
  "tests/packages/scripts/src/parity/record.test.ts",
  "tests/packages/scripts/src/trace-count/count.test.ts",
  "tests/packages/scripts/src/verify/dashboard-map.test.ts",
  "tests/packages/scripts/src/verify/prebuild.test.ts",
  "tests/scripts/hooks/no-bare-slack-link.test.ts",
  "tests/scripts/hooks/no-playground-leak.test.ts",
  "tests/skills/built-in-names.test.ts",
]
// A prompt template, and the tests that pin a built prompt's digest, which name no template's path
const TEMPLATE = /^src\/(.+\/)?templates\/[^/]+\.md$/
const DIGEST_PIN = "sha256\\(.*prompt|DIGEST"
const PATH_CHAIN = /["'][\w./-]+["'](?:\s*\/\s*["'][\w./-]+["'])*/g

export const isTest = (path: string, python: boolean): boolean => {
  const name = path.split("/").at(-1)!
  return (
    path.startsWith("tests/") &&
    (name.endsWith(".test.ts") ||
      name.endsWith(".test.tsx") ||
      (python && name.startsWith("test_") && name.endsWith(".py")))
  )
}

// A path with its last name's extension cut, so a dotfile (.gitignore) or a dotted folder keeps its whole name
export const stemOf = (path: string): string => {
  const start = path.lastIndexOf("/") + 1
  const dot = path.lastIndexOf(".")
  return dot > start && /[^.]/.test(path.slice(start, dot)) ? path.slice(0, dot) : path
}

export const mirrors = (path: string): Set<string> => {
  const stem = stemOf(path)
  return new Set([`tests/${stem}.test.ts`, `tests/${stem}.test.tsx`])
}

const QUOTES = ['"', "'", "`"]

export const spellings = (path: string): string[] => {
  const stem = stemOf(path)
  const ext = path.slice(stem.length)
  const out = [stem]
  for (const pkg of ["api/hono/", "web/next/"]) {
    if (stem.startsWith(`${pkg}src/`)) {
      const relBody = stem.slice(pkg.length + "src/".length)
      const relPkg = stem.slice(pkg.length)
      for (const rel of [relBody, relPkg]) {
        if (rel.includes("/")) for (const q of QUOTES) out.push(`${q}${rel}${q}`)
        for (const q of QUOTES) out.push(`${q}${rel}${ext}${q}`)
      }
    }
  }
  if (stem.startsWith("web/next/src/")) out.push(`@/${stem.slice("web/next/src/".length)}`)
  return out
}

export const spelledNear = (text: string, path: string, test: string): boolean => {
  const stem = stemOf(path)
  const folder = dirname(test)
  const rel = relative(folder, stem)
  const names = [rel.startsWith("../") ? rel : `./${rel}`]
  if (folder === join("tests", dirname(path))) names.push(basename(stem))
  return names.some((n) =>
    new RegExp(`["']${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.\\w+)?["']`).test(text),
  )
}

export const scannedPaths = (text: string, paths: Set<string>): Set<string> => {
  const out = new Set<string>()
  for (const m of text.matchAll(PATH_CHAIN)) {
    const p = (m[0].match(/["']([\w./-]+)["']/g) || [])
      .map((s) => s.slice(1, -1))
      .join("/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/^\.\//, "")
    if (paths.has(p)) out.add(p)
  }
  return out
}

export const covers = (scanned: Set<string>, changed: string[]): boolean =>
  [...scanned].some((p) => changed.some((f) => f === p || f.startsWith(`${p}/`)))

export const folders = (tree: Set<string>): Set<string> => {
  const out = new Set<string>()
  for (const f of tree)
    for (let i = 1; i <= f.split("/").length - 1; i++) out.add(f.split("/").slice(0, i).join("/"))
  return out
}

const grep = (clone: string, head: string, mode: string, patterns: string[]): Set<string> => {
  if (!patterns.length) return new Set()
  const args = ["git", "-C", clone, "grep", "-l", mode]
  for (const p of patterns) args.push("-e", p)
  const out = Bun.spawnSync([...args, head, "--", "tests"], { stdout: "pipe", stderr: "pipe" })
  const code = out.exitCode ?? 1
  if (code > 1) throw new Called(args, out.stdout.toString(), out.stderr.toString())
  return new Set(
    out.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf(":") + 1)),
  )
}

// The one child_process call: Bun.spawnSync's input never reaches the child's stdin in this Bun (1.4.4), so cat-file would read nothing.
const readBlobs = (
  clone: string,
  head: string,
  paths: Iterable<string>,
): Record<string, string> => {
  const sorted = [...paths].sort()
  const args = ["git", "-C", clone, "cat-file", "--batch"]
  const out = spawnSync(args[0]!, args.slice(1), {
    input: sorted.map((p) => `${head}:${p}\n`).join(""),
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (out.status !== 0) throw new Called(args, out.stdout.toString(), out.stderr.toString())
  const buf = out.stdout as Buffer
  const texts: Record<string, string> = {}
  let at = 0
  for (const p of sorted) {
    const end = buf.indexOf(10, at)
    const size = Number(buf.subarray(at, end).toString().split(" ")[2])
    texts[p] = buf.subarray(end + 1, end + 1 + size).toString()
    at = end + 2 + size
  }
  return texts
}

export const touchedTests = (clone: string, base: string, head: string): string[] => {
  const changed = io
    .run("git", "-C", clone, "diff", "--name-only", "--no-renames", "-z", `${base}...${head}`)
    .split("\0")
    .filter(Boolean)
  const tree = new Set(
    io
      .run("git", "-C", clone, "ls-tree", "-r", "--name-only", "-z", head)
      .split("\0")
      .filter(Boolean),
  )
  const python = tree.has("pyproject.toml")
  const tests = new Set([...tree].filter((f) => isTest(f, python)))
  const picked = new Set<string>([
    ...[...changed].flatMap((f) => [...mirrors(f)]),
    ...changed,
    ...SCANS_THROUGH_SOURCE,
  ])
  for (const f of grep(
    clone,
    head,
    "-F",
    changed.flatMap((f) => spellings(f)),
  ))
    picked.add(f)
  const near = new Set(
    [
      ...grep(
        clone,
        head,
        "-F",
        changed.map((f) => basename(stemOf(f))),
      ),
    ].filter((t) => tests.has(t)),
  )
  const nearTexts = readBlobs(clone, head, near)
  for (const [t, text] of Object.entries(nearTexts))
    if (changed.some((f) => spelledNear(text, f, t))) picked.add(t)
  const tsScanCandidates = [...grep(clone, head, "-E", [SCAN_TS])].filter((f) => !f.endsWith(".py"))
  const tsScanTexts = readBlobs(clone, head, tsScanCandidates)
  for (const [f, text] of Object.entries(tsScanTexts))
    if (SCAN_RE.test(stripValues(text))) picked.add(f)
  const grepping = new Set(
    [...grep(clone, head, "-F", ["grep"])].filter((f) => tests.has(f) && !f.endsWith(".py")),
  )
  const grepTexts = readBlobs(clone, head, grepping)
  for (const [f, text] of Object.entries(grepTexts))
    if (GIT_GREP.test(stripValues(text))) picked.add(f)
  if (python) {
    const scanners = [...grep(clone, head, "-E", [SCAN_PY])].filter(
      (f) => tests.has(f) && f.endsWith(".py"),
    )
    const paths = new Set([...tree, ...folders(tree)])
    const scannerTexts = readBlobs(clone, head, scanners)
    for (const [f, text] of Object.entries(scannerTexts))
      if (covers(scannedPaths(text, paths), changed)) picked.add(f)
    if (changed.some((f) => TEMPLATE.test(f)))
      for (const f of grep(clone, head, "-E", [DIGEST_PIN])) picked.add(f)
  }
  const listed = new Set([...picked].filter((f) => tests.has(f)))
  const addsText = io
    .run("git", "-C", clone, "diff", "--numstat", "--no-renames", `${base}...${head}`)
    .split("\n")
    .some((line) => /^[1-9]/.test(line))
  if (addsText)
    for (const [f, text] of Object.entries(
      readBlobs(
        clone,
        head,
        [...tree].filter((f) => PY_TEST.test(f)),
      ),
    ))
      if (WALKS_REPO.test(text)) listed.add(f)
  return [...listed].sort()
}

export const cmdTouchedTests = (clone: string, base: string, head: string): void => {
  for (const f of touchedTests(clone, base, head)) console.log(f)
}

const LOCKS = /(^|\/)(bun\.lock|package\.json)$/

// Pure: a red run's junit report read for its files: failed, each with a failed testcase, and leftOut, each test file the report leaves out, as bun leaves out a file that throws as it loads and one that defines no test; a report that is missing names none.
export const redIn = (
  xml: string | undefined,
  files: string[],
): { failed: string[]; leftOut: string[] } => {
  if (xml === undefined) return { failed: [], leftOut: [] }
  const listed = new Set(
    [...xml.matchAll(/<test(?:suite|case)\b[^>]*\bfile="([^"]*)"/g)].map((m) => m[1]),
  )
  const failed = new Set(
    [...xml.matchAll(/<testcase\b[^>]*\bfile="([^"]*)"[^>]*(?<!\/)>([\s\S]*?)<\/testcase>/g)]
      .filter((m) => /<(failure|error)\b/.test(m[2]!))
      .map((m) => m[1]),
  )
  return {
    failed: files.filter((f) => failed.has(f)),
    leftOut: files.filter((f) => !failed.has(f) && /\.test\.tsx?$/.test(f) && !listed.has(f)),
  }
}

// A file's failed testcases in a junit report, by classname and name, so a red at the head and at <base> reads as the same red only when no case of the head's fails there alone
export const casesIn = (xml: string | undefined, file: string): Set<string> =>
  new Set(
    [...(xml ?? "").matchAll(/<testcase\b([^>]*?)(?<!\/)>([\s\S]*?)<\/testcase>/g)]
      .filter((m) => m[1]!.includes(`file="${file}"`) && /<(failure|error)\b/.test(m[2]!))
      .map((m) =>
        ["classname", "name"]
          .map((key) => new RegExp(`\\b${key}="([^"]*)"`).exec(m[1]!)?.[1] ?? "")
          .join(" > "),
      ),
  )

// Each round's first read: the PR's merge with <base>, as merge-tree writes it, then its touched tests on that merge, a test red there run again at the head; the clone ends at <head> whatever happens. --conflict-only stops after merge-tree, running none of the PR's code, for an outside author's PR.
export const cmdMerge = (...args: string[]): void => {
  const conflictOnly = args.includes("--conflict-only")
  const [clone = "", head = "", base = "", session = ""] = args.filter(
    (a) => a !== "--conflict-only",
  )
  if (args.length !== 4) exitWith(USAGE)
  const headSha = io.run("git", "-C", clone, "rev-parse", head).trim()
  const baseSha = io.run("git", "-C", clone, "rev-parse", base).trim()
  let tree: string
  try {
    tree = io.run(
      "git",
      "-C",
      clone,
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      headSha,
      baseSha,
    )
  } catch (e) {
    if (!(e instanceof Called) || !e.stdout.trim()) throw e
    const files = e.stdout.trim().split("\n").slice(1)
    console.log(`CONFLICT on ${baseSha.slice(0, 7)}: ${files.join(" ")}`)
    process.exitCode = 1
    return
  }
  if (conflictOnly) {
    console.log(`CLEAN on ${baseSha.slice(0, 7)}: no conflict; --conflict-only ran no tests`)
    return
  }
  const merge = io
    .run(
      "git",
      "-C",
      clone,
      "commit-tree",
      tree.trim(),
      "-p",
      headSha,
      "-p",
      baseSha,
      "-m",
      "merge check",
    )
    .trim()
  const locks = io
    .run("git", "-C", clone, "diff", "--name-only", headSha, merge)
    .split("\n")
    .filter((f) => LOCKS.test(f))
  if (locks.length) {
    console.log(`LOCK-CHANGED on ${baseSha.slice(0, 7)}: ${locks.join(" ")}; no tests ran`)
    return
  }
  const tests = touchedTests(clone, baseSha, merge)
  // A run's red files, read from its report; a red one-file run is its file, and a file the report leaves out runs alone, red when that run is red or its report lists the file (it threw as it loaded beside the others), and not red when that green run wrote no report (it defines no test, or runs in the test sandbox's serial pass, which writes none); a red run whose report names none counts every file it ran as red, and says where.
  const report = join(tmpdir(), `merge-check-${process.pid}.xml`)
  const unnamed: string[] = []
  const cases = new Map<string, Set<string>>()
  const readReport = (files: string[]): string | undefined => {
    let xml: string | undefined
    try {
      xml = readFileSync(report, "utf8")
    } catch {}
    for (const f of files) cases.set(f, casesIn(xml, f))
    return xml
  }
  const redAlone = (f: string): boolean => {
    rmSync(report, { force: true })
    if (!io.tests(session, clone, [f], report)) return true
    const xml = readReport([f])
    return xml !== undefined && redIn(xml, [f]).leftOut.length === 0
  }
  const red = (files: string[], where: string): string[] => {
    if (!files.length) return []
    rmSync(report, { force: true })
    if (io.tests(session, clone, files, report)) return []
    const xml = readReport(files)
    if (files.length === 1) return files
    const { failed, leftOut } = redIn(xml, files)
    const named = files.filter((f) => failed.includes(f) || (leftOut.includes(f) && redAlone(f)))
    if (named.length) return named
    unnamed.push(where)
    return files
  }
  const treeOf = (sha: string): Set<string> =>
    new Set(io.run("git", "-C", clone, "ls-tree", "-r", "--name-only", "-z", sha).split("\0"))
  const at = (sha: string, files: string[], where: string): string[] => {
    const tree = treeOf(sha)
    const there = files.filter((f) => tree.has(f))
    if (!there.length) return []
    io.run("git", "-C", clone, "checkout", "-q", "--detach", sha)
    return red(there, where)
  }
  let branch = ""
  try {
    branch = io.run("git", "-C", clone, "symbolic-ref", "-q", "--short", "HEAD").trim()
  } catch (e) {
    if (!(e instanceof Called)) throw e
  }
  // A clone on a branch at the head (a fixture-stack round's review-<n>) goes back to that branch.
  const back =
    branch && io.run("git", "-C", clone, "rev-parse", branch).trim() === headSha
      ? [branch]
      : ["--detach", headSha]
  const c7 = baseSha.slice(0, 7)
  // The merge's red files run once more on the merge (green there: red only beside the others, BATCH-RED), a run whose report named none running every touched test again; what stays red runs at the head and at <base>: red at <base> with the head's failed cases read and each failing there too is canary's own, else red at the head (one that throws as it loads, with no case read, included) is the PR's own, so CANARY-RED keeps only a red the merge alone makes.
  let first: string[]
  let onMerge: string[]
  let atHead: string[]
  let atBase: string[]
  const headCases = new Map<string, Set<string>>()
  try {
    first = at(merge, tests, `on the merge, so all ${tests.length} touched tests ran again`)
    onMerge = red(first, "on the merge's second run")
    atHead = at(headSha, onMerge, "at the head")
    for (const f of atHead) headCases.set(f, cases.get(f) ?? new Set())
    atBase = at(baseSha, onMerge, `at ${c7}`).filter((f) => {
      const own = headCases.get(f)
      return !own || (own.size > 0 && [...own].every((c) => cases.get(f)?.has(c)))
    })
    atHead = atHead.filter((f) => !atBase.includes(f))
  } finally {
    rmSync(report, { force: true })
    io.run("git", "-C", clone, "checkout", "-q", ...back)
  }
  const together = first.filter((f) => !onMerge.includes(f))
  const canaryOnly = onMerge.filter((f) => !atHead.includes(f) && !atBase.includes(f))
  if (canaryOnly.length) {
    console.log(`CANARY-RED on ${c7}: ${canaryOnly.join(" ")}`)
    process.exitCode = 1
  } else if (!together.length) console.log(`CLEAN on ${c7}: ${tests.length} touched tests`)
  if (together.length)
    console.log(
      `BATCH-RED on ${c7}: ${together.join(" ")} (merged with head ${headSha.slice(0, 7)}); open or link one issue for each by code-review-loop's step 2, never a second rerun`,
    )
  if (atHead.length) console.log(`HEAD-RED: ${atHead.join(" ")}`)
  if (atBase.length) console.log(`BASE-RED on ${c7}: ${atBase.join(" ")}`)
  if (unnamed.length)
    console.log(
      `NO-REPORT on ${c7}: a red run's report named no red file ${unnamed.join("; ")}; each such run counts every file it ran as red`,
    )
}

const splitResponse = (text: string): [Record<string, string>, string] => {
  const [head = "", body = ""] = (text || "").replace(/\r\n/g, "\n").split("\n\n", 2)
  const lines = head.split("\n").slice(1)
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const i = line.indexOf(":")
    if (i >= 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return [headers, body]
}

export const pauseAfter = (error: Called): number => {
  // A rate limit waits for its own reset, from the failing call's headers; any other failure waits a poll.
  const [headers] = splitResponse(error.output || "")
  const reset = headers["x-ratelimit-reset"] ?? ""
  if (headers["x-ratelimit-remaining"] === "0" && /^\d+$/.test(reset))
    return Math.max(Number(reset) - Math.floor(io.time()), 0) + 5
  return WAIT_SECONDS
}

// One REST read through `gh api -i`, or null once a failed read has waited out its pause.
const readRest = async (path: string, jq: string): Promise<Json | null> => {
  try {
    return JSON.parse(splitResponse(io.run("gh", "api", "-i", path, "--jq", jq))[1])
  } catch (e) {
    const pause = pauseAfter(e as Called)
    process.stderr.write(
      `gh api failed, trying again in ${pause}s: ${(e as Called).stderr || e}\n`.trimEnd() + "\n",
    )
    await io.sleep(pause)
    return null
  }
}

// Polls the PR until its head moves off <sha> or it closes; atHeadDone(), given the open PR's full head, ends it with true, or reads again at once with null after its own pause.
const watch = async (
  repo: string,
  n: string,
  sha: string,
  atHeadDone: (head: string) => Promise<boolean | null>,
): Promise<void> => {
  splitRepo(repo)
  number(n)
  if (!/^[0-9a-f]{7,40}$/.test(sha)) exitWith(`not a commit SHA: ${sha}`)
  // a waiter outlives its round, so it leaves the folder it started in, which may be a review worktree the cleanup removes once the PR merges
  process.chdir(tmpdir())
  let closed = false
  for (;;) {
    const view = await readRest(`repos/${repo}/pulls/${n}`, "{merged, sha: .head.sha, state}")
    if (!view) continue
    // a PR closed unmerged is read once more a poll later, since Checks closes and reopens a PR to rebuild its merge commit (PG-1701)
    if (view.state !== "open" && (view.merged || closed)) {
      console.log(`CLOSED ${view.merged ? "MERGED" : "CLOSED"}`)
      return
    }
    closed = view.state !== "open"
    if (!closed && !atHead(sha, view.sha as string)) {
      console.log(`MOVED ${view.sha}`)
      return
    }
    if (!closed) {
      const done = await atHeadDone(view.sha as string)
      if (done) return
      if (done === null) continue
    }
    await io.sleep(WAIT_SECONDS)
  }
}

export const cmdWait = (repo: string, n: string, sha: string): Promise<void> =>
  watch(repo, n, sha, async () => false)

// The ci rule's checks, pr:merge's REQUIRED_CHECKS (packages/scripts/src/pr-merge/gates.ts), which a test holds equal.
export const GATE_CHECKS = ["Audit, Lint, and Build", "test"]

// Of two runs one name lists (filter=latest lists a re-run in place of its first), the higher id is the newer; a red that concluded before the waiter started is waited past until a newer run concludes, so a re-run after a reported red is seen. Names given after the sha are another repo's gate checks, in place of GATE_CHECKS.
export const cmdChecks = (
  repo: string,
  n: string,
  sha: string,
  ...given: string[]
): Promise<void> => {
  const names = given.length ? given : GATE_CHECKS
  const started = io.time()
  return watch(repo, n, sha, async (head) => {
    const runs = await readRest(
      `repos/${repo}/commits/${head}/check-runs?per_page=100`,
      "[.check_runs[] | {completed_at, conclusion, id, name}]",
    )
    if (!runs) return null
    const newest = names.map((name) =>
      (runs as Json[])
        .filter((r) => r.name === name)
        .reduce<Json | undefined>((a, r) => (a && a.id > r.id ? a : r), undefined),
    )
    const counts = (r: Json | undefined): boolean =>
      !!r?.conclusion &&
      (r.conclusion === "success" || Date.parse(r.completed_at) / 1000 >= started)
    if (!newest.every(counts)) return false
    for (const [i, name] of names.entries()) console.log(`CHECK ${newest[i]!.conclusion} ${name}`)
    return true
  })
}

const COMMANDS: Record<
  string,
  { argc: number; more?: true; run: (...args: string[]) => void | Promise<void> }
> = {
  checks: { argc: 3, more: true, run: cmdChecks },
  delta: { argc: 4, run: cmdDelta },
  fresh: { argc: 4, run: cmdFresh },
  merge: { argc: 3, more: true, run: cmdMerge },
  pr: { argc: 2, run: cmdPr },
  scan: { argc: 1, run: cmdScan },
  "touched-tests": { argc: 3, run: cmdTouchedTests },
  wait: { argc: 3, run: cmdWait },
}

const USAGE = `A PR's review state, read from GitHub and git each time, with no memory of its own.

  state.ts pr <owner/repo> <n>                          one PR: head, newest verdict, open (over REST, unknown) threads, what was said since, another account's lines marked untrusted
  state.ts scan <owner/repo>                            every open PR: is its head scored, and who holds it? (the recovery scan)
  state.ts delta <worktree> <base> <old head> <new head>  did a push change the PR's own work, or only merge the base?
  state.ts fresh <owner/repo> <n> <read-at> <digest>    exit 1 naming each body edit, comment, thread reply or review since pr's read line, else FRESH; chain it before the verdict's post
  state.ts wait <owner/repo> <n> <sha>                  block until the PR's head moves off <sha> or the PR closes (REST, every 5 minutes)
  state.ts checks <owner/repo> <n> <sha> [<check>...]  as wait, and also return once each gate check concludes at <sha>, one CHECK <conclusion> <name> line each; a red from before it started waits for its re-run. The gate checks are the names given after <sha>, else Audit, Lint, and Build and test
  state.ts merge <clone> <head> <base> <session>        the head's merge with <base>: CONFLICT <files> (exit 1); LOCK-CHANGED <files>, no tests run; else the touched tests on a local merge through run-slot as <session>, kept on this machine, the reds their junit report names run again on the merge, at the head and at <base>: CANARY-RED <tests> (exit 1), BATCH-RED <tests> for a red only beside the others, naming the issue to open or link for each in place of a second rerun, or CLEAN, then HEAD-RED (the PR's own), BASE-RED (canary's own, a red the head shares counted there when the head's failed cases are read and all fail at <base>) and NO-REPORT (a red run that named no file, all its files counted red); the clone ends at <head>
  state.ts merge --conflict-only <clone> <head> <base>  the head's merge with <base> by merge-tree alone, running none of the PR's code (an outside author's PR): CONFLICT <files> (exit 1), else CLEAN
  state.ts touched-tests <clone> <base> <head>          the tests a change touches, one path per line, by SKILL.md's four rules

A verdict is a comment by this gh account whose first line is
\`## ReviewBot · round <r>: <s>/5 at <sha7>\`, the line \`bun run pr:merge\` reads.`

const main = async (argv: string[]): Promise<void> => {
  const cmd = argv[0] === undefined ? "" : argv[0]!
  const entry = COMMANDS[cmd]
  const argc = argv.length - 1
  if (!entry || argc < entry.argc || (argc > entry.argc && !entry.more)) exitWith(USAGE)
  try {
    await entry.run(...argv.slice(1))
  } catch (e) {
    if (e instanceof Called)
      exitWith(`${e.cmd.slice(0, 3).join(" ")} failed: ${(e.stderr || "").trim()}`)
    throw e
  }
}

if (import.meta.main) await main(process.argv.slice(2))
