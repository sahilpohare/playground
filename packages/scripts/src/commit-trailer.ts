// AGENTS.md's Commits rule keeps a Co-authored-by trailer out of every commit: commit-msg runs this on the message file, which drops each such line, in any case, and says so, so the commit goes through on its first try; with `--push <remote>` pre-push refuses a pushed commit whose message holds one and that no live branch of that remote holds yet, since a commit made with --no-verify skips commit-msg, and names the amend that drops it. The same push step refuses such a commit whose message, or a pushed ref whose name, holds a term from no-public-leak's list, by sha or ref and kind alone.
import { heldBy } from "../../safe-delete/src/live-refs"
import { listKindsIn, readList } from "./trace-count/count"
import { type PublicList, publicListPath } from "./trace-count/kinds"

const TRAILER = /^co-authored-by:/i

// The message less every trailer line, or null when it holds none.
export const dropTrailers = (message: string): string | null => {
  const lines = message.split("\n")
  const kept = lines.filter((line) => !TRAILER.test(line))
  return kept.length === lines.length ? null : kept.join("\n")
}

const ZERO = /^0+$/

// The refs the push writes, as git hands them on stdin: [local ref, local sha, remote ref], a delete (a zero local sha) left out.
const pushedRefs = (stdin: string): [string, string, string][] =>
  stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/) as [string, string, string])
    .filter(([, sha]) => !!sha && !ZERO.test(sha))

// Each commit the push sends that the remote it pushes to (pre-push's first argument, a name or a URL) holds no live branch of now (heldBy), newest first, as [sha, subject, message]: what is already there was read when it went there, and every commit is read when the remote cannot be.
const newCommits = (locals: string[], remote: string): [string, string, string][] => {
  if (locals.length === 0) return []
  const held = heldBy(process.cwd(), remote, 30_000)
  const log = Bun.spawnSync(
    ["git", "log", "--no-color", "--format=%H%x00%s%x00%B%x01", ...locals, "--not", ...held],
    { stderr: "pipe", stdout: "pipe" },
  )
  if (log.exitCode !== 0) {
    console.error(`commit-trailer: git log failed: ${log.stderr.toString().trim()}`)
    process.exit(1)
  }
  return log.stdout
    .toString()
    .split("\x01")
    .map((entry) => entry.replace(/^\n/, "").split("\x00"))
    .filter(([sha, , body]) => sha && body !== undefined)
    .map(([sha, subject, body]) => [sha!, subject!, body!])
}

// Each list term the push carries, by the commit's sha or the ref and the kind alone, so the refusal never prints the term.
const listed = (
  refs: [string, string, string][],
  commits: [string, string, string][],
  list: PublicList,
): string[] => [
  ...commits.flatMap(([sha, , body]) =>
    listKindsIn(body, list).map((kind) => `${sha.slice(0, 9)}'s message holds a ${kind} term`),
  ),
  ...[...new Set(refs.flatMap(([local, , remote]) => [local, remote]))].flatMap((ref) =>
    listKindsIn(ref.replace(/^refs\/(?:heads|tags)\//, ""), list).map(
      (kind) => `the pushed ref's name holds a ${kind} term`,
    ),
  ),
]

if (import.meta.main) {
  if (process.argv[2] !== "--push") {
    const file = Bun.file(process.argv[2]!)
    const kept = dropTrailers(await file.text())
    if (kept !== null) {
      await Bun.write(file, kept)
      console.log(
        "commit-trailer: dropped the Co-authored-by trailer, which AGENTS.md's Commits rule keeps out of every commit",
      )
    }
    process.exit(0)
  }
  const refs = pushedRefs(await Bun.stdin.text())
  const commits = newCommits(
    refs.map(([, sha]) => sha),
    process.argv[3] ?? "",
  )
  const list = await readList(publicListPath())
  if (typeof list === "string") console.error(`commit-trailer: ${list}`)
  const terms = typeof list === "object" ? [...new Set(listed(refs, commits, list))] : []
  if (terms.length)
    console.error(
      `commit-trailer: ${terms.join(", ")} from no-public-leak's list, which keeps it out of every public write: reword each message in plain words (\`git commit --amend\` for the newest) or push the branch or tag under another name, then push again`,
    )
  const found = commits
    .filter(([, , body]) => dropTrailers(body) !== null)
    .map(([sha, subject]) => [sha, subject] as [string, string])
  if (found.length === 0) process.exit(terms.length || typeof list === "string" ? 1 : 0)
  const oldest = found.at(-1)![0].slice(0, 9)
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString()
  // the checked-out commit alone takes a plain amend
  const fix =
    found.length === 1 && found[0]![0] === head.trim()
      ? "`git commit --amend --no-edit`"
      : `\`git rebase --rebase-merges --exec 'git commit --amend --no-edit' ${oldest}^\``
  console.error(
    `commit-trailer: ${found.map(([sha, subject]) => `${sha.slice(0, 9)} ${subject}`).join(", ")} ${found.length === 1 ? "holds" : "hold"} a Co-authored-by trailer, which AGENTS.md's Commits rule keeps out, since a commit made with --no-verify skips commit-msg: drop it with ${fix}, whose commit-msg step drops the line, then push again`,
  )
  process.exit(1)
}
