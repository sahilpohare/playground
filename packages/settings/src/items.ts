import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { dirname, extname, join, relative } from "node:path"

// By relative path, as settings.ts imports, since tests outside the package import this file.
import { contentProblem } from "./content"
import { stableJson } from "./diff"
import {
  commitExt,
  deriveHooks,
  extGit,
  extLog,
  filesIn,
  mustGit,
  mustGitRaw,
  scopesIn,
  withLock,
  writeAtomically,
  writeTree,
} from "./folder"
import { CORE, coreDir, extensionsDir, GUARD_LISTS, itemPath, loginOf, scopeDir } from "./rendered"
import { secretIn } from "./secrets"
import { type Kind, KINDS, REVIEWED_KINDS } from "./settings"

// An extension's items as files in its scope's folder: a list as lists/<key>.json, a skill, or a script added from a folder, as <kind>s/<key>/, any other script as scripts/<key>, every other kind as <kind>s/<key>.md. A write is a whole copy, never an edit, and lands as one commit: a list accepted at once, any other kind under proposed/ until a 5/5 or the owner's accept moves it out, but for the owner's own write, which is accepted at once. A revision is the commit that wrote it.

export type Ref = { key: string; kind: Kind; scope: string }
export type Content = {
  attachments: { bytes: string; mime: string; name: string }[]
  body: string | null
  // the files that run directly, written 755 so git stores them 100755: a name in files, or . for the body
  executable?: string[]
  files: Record<string, string> | null
  value: unknown
}
export type Who = { actor: string; author: string; inboxRef: number | null; reason: string }
export type Outcome<T> =
  | ({ ok: true } & T)
  | { message: string; ok: false; status: 400 | 404 | 409 }

// The largest attachment an extension takes: GitHub warns at 50 MB and refuses at 100 MB.
export const ATTACHMENT_LIMIT = 50 * 1024 * 1024
const PROPOSED = "proposed"

const isFolder = (kind: Kind, files: unknown) => kind === "skill" || (kind === "script" && !!files)

// The paths an item can take in a folder, the one it holds first.
const candidates = (kind: Kind, key: string): string[] => {
  const base = itemPath(kind, key)
  return kind === "list"
    ? [`${base}.json`]
    : kind === "script"
      ? [base]
      : kind === "skill"
        ? [base]
        : [`${base}.md`]
}

const safe = (path: string): boolean =>
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

// The item's content as the folder at dir holds it, or null when it holds none.
const readIn = (dir: string, ref: Ref): Content | null => {
  const [path] = candidates(ref.kind, ref.key)
  const at = join(dir, path!)
  if (!existsSync(at)) return null
  const content: Content = { attachments: [], body: null, files: null, value: null }
  if (statSync(at).isDirectory())
    content.files = Object.fromEntries(
      filesIn(at).map((file) => [file, readFileSync(join(at, file), "utf8")]),
    )
  else if (ref.kind === "list") content.value = JSON.parse(readFileSync(at, "utf8"))
  else content.body = readFileSync(at, "utf8")
  return content
}

const place = (dir: string, ref: Ref, content: Content) => {
  const [path] = candidates(ref.kind, ref.key)
  const at = join(dir, path!)
  rmSync(at, { force: true, recursive: true })
  if (isFolder(ref.kind, content.files))
    for (const [file, text] of Object.entries(content.files ?? {}))
      writeAtomically(join(at, file), text)
  else if (ref.kind === "list") writeAtomically(at, stableJson(content.value))
  else writeAtomically(at, content.body ?? "")
  for (const name of content.executable ?? []) chmodSync(name === "." ? at : join(at, name), 0o755)
}

const trailers = (ref: Ref, who: Who, extra: [string, string][] = []): [string, string][] => [
  ["Item", `${ref.kind} ${ref.key}`],
  ["Actor", who.actor],
  ...(who.inboxRef === null ? [] : ([["Inbox", `#i${who.inboxRef}`]] as [string, string][])),
  ...extra,
]

// The guards' lists at the root, rebuilt after a list lands accepted, when the login is known.
const lists = (data: string, ref: Ref, root: string) => {
  const login = ref.kind === "list" ? loginOr(data) : undefined
  if (login) deriveHooks(data, login, root)
}

const loginOr = (data: string): string | undefined => {
  try {
    return loginOf(data)
  } catch {
    return undefined
  }
}

const refused = (error: unknown): { message: string; ok: false; status: 400 } => ({
  message: (error as Error).message,
  ok: false,
  status: 400,
})

// An item's next revision, a whole copy with a reason.
export const putItem = (
  data: string,
  ref: Ref,
  content: Content,
  who: Who,
  acceptNow: boolean,
): Outcome<{ rev: string; state: string }> => {
  const shape = contentProblem(ref.kind, { ...content, meta: null })
  if (shape) return { message: shape, ok: false, status: 400 }
  if (content.files && !Object.keys(content.files).every(safe))
    return { message: "a file of the item names a path outside its folder", ok: false, status: 400 }
  const folder = isFolder(ref.kind, content.files)
  if (
    !(content.executable ?? []).every((name) =>
      folder ? Object.hasOwn(content.files ?? {}, name) : name === ".",
    )
  )
    return { message: "executable names a file the item does not hold", ok: false, status: 400 }
  const secret = secretIn({ body: content.body, files: content.files, value: content.value })
  if (secret)
    return {
      message: `the revision holds ${secret}; keep the secret in the Keychain or the environment and name it`,
      ok: false,
      status: 400,
    }
  const files = content.attachments.map((file) => ({
    ...file,
    bytes: Buffer.from(file.bytes, "base64"),
  }))
  const large = files.find((file) => file.bytes.length > ATTACHMENT_LIMIT)
  if (large)
    return { message: `${large.name} is over 50 MB, which GitHub refuses`, ok: false, status: 400 }
  const state = acceptNow || !REVIEWED_KINDS.includes(ref.kind) ? "accepted" : "proposed"
  let sha: string | undefined
  try {
    sha = commitExt(
      data,
      ref.scope,
      { author: who.author, reason: who.reason, trailers: trailers(ref, who, [["State", state]]) },
      (dir, root) => {
        place(state === "accepted" ? dir : join(dir, PROPOSED), ref, content)
        for (const file of files) {
          const hash = new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex")
          writeAtomically(join(dir, "attachments", `${hash}${extname(file.name)}`), file.bytes)
        }
        if (state === "accepted") lists(data, ref, root)
      },
      state === "accepted" && ref.kind === "list",
    )
  } catch (error) {
    return refused(error)
  }
  if (!sha) return { message: "the item already holds this content", ok: false, status: 409 }
  return { ok: true, rev: sha, state }
}

export type Verdict = { kind: "accept" } | { kind: "reject" } | { kind: "score"; score: number }

// A proposal judged: a score below 5 is recorded as an empty commit, a 5 or the owner's accept moves it out of proposed/ over the accepted copy, and a reject removes it. Each refuses unless the proposal is still the revision named, so a judge never decides a proposal written after it read, and a score is its author's, refused from the proposal's own author.
export const judgeItem = (
  data: string,
  ref: Ref,
  rev: string,
  verdict: Verdict,
  who: Who,
): Outcome<{ rev: string; state: string }> => {
  if (verdict.kind === "accept" && who.author !== "owner")
    return { message: "accept is the owner's call; a reviewer scores it", ok: false, status: 400 }
  const dir = scopeDir(data, ref.scope)
  const [path] = candidates(ref.kind, ref.key)
  const proposed = join(PROPOSED, path!)
  if (!existsSync(join(dir, proposed)))
    return {
      message: `no proposal of ${ref.kind} ${ref.key} in ${ref.scope}`,
      ok: false,
      status: 404,
    }
  const head = extGit(dir, ["log", "-1", "--format=%H", "--", proposed]).out
  if (!rev || !head.startsWith(rev))
    return {
      message: `the proposal is at ${head.slice(0, 12)}, not ${rev}; read it again`,
      ok: false,
      status: 409,
    }
  if (verdict.kind === "score") {
    const writer = extGit(dir, ["log", "-1", "--format=%an", head]).out
    if (who.author === writer)
      return {
        message: `${writer} wrote this proposal, so another session scores it`,
        ok: false,
        status: 400,
      }
  }
  const accepts = verdict.kind === "accept" || (verdict.kind === "score" && verdict.score === 5)
  const state = accepts ? "accepted" : verdict.kind === "reject" ? "rejected" : "proposed"
  const extra: [string, string][] = [
    ["Verdict", verdict.kind],
    ...(verdict.kind === "score"
      ? ([
          ["Score", String(verdict.score)],
          ["Reviewer", who.author],
        ] as [string, string][])
      : []),
    ["State", state],
  ]
  let sha: string | undefined
  try {
    sha = commitExt(
      data,
      ref.scope,
      {
        allowEmpty: true,
        author: who.author,
        reason: who.reason,
        trailers: trailers(ref, who, extra),
      },
      (at, root) => {
        if (state === "rejected") rmSync(join(at, proposed), { force: true, recursive: true })
        if (state !== "accepted") return
        rmSync(join(at, path!), { force: true, recursive: true })
        mkdirSync(dirname(join(at, path!)), { recursive: true })
        renameSync(join(at, proposed), join(at, path!))
        lists(data, ref, root)
      },
      state === "accepted" && ref.kind === "list",
    )
  } catch (error) {
    return refused(error)
  }
  return { ok: true, rev: sha!, state }
}

const scopes = (data: string): string[] => [
  ...scopesIn(data),
  ...(existsSync(coreDir()) ? [CORE] : []),
]

const keyOf = (name: string, kind: Kind) =>
  kind === "list"
    ? name.replace(/\.json$/, "")
    : kind === "skill" || kind === "script"
      ? name
      : name.replace(/\.md$/, "")

// Every item each scope holds, accepted or proposed, by scope, kind and key, core's marked read-only since it ships with the checkout; a folder's .gitkeep is no item.
export const listItems = (data: string, filter: { kind?: Kind; scope?: string } = {}) => {
  const rows: {
    accepted: boolean
    key: string
    kind: Kind
    proposed: boolean
    readOnly: boolean
    scope: string
  }[] = []
  for (const scope of scopes(data)) {
    if (filter.scope && filter.scope !== scope) continue
    const dir = scopeDir(data, scope)
    for (const kind of KINDS) {
      if (filter.kind && filter.kind !== kind) continue
      const seen = new Map<string, { accepted: boolean; proposed: boolean }>()
      for (const [where, at] of [
        ["accepted", join(dir, `${kind}s`)],
        ["proposed", join(dir, PROPOSED, `${kind}s`)],
      ] as const)
        for (const name of existsSync(at) ? readdirSync(at).sort() : []) {
          if (name === ".gitkeep") continue
          const key = keyOf(name, kind)
          seen.set(key, {
            ...(seen.get(key) ?? { accepted: false, proposed: false }),
            [where]: true,
          })
        }
      for (const [key, found] of seen)
        rows.push({ ...found, key, kind, readOnly: scope === CORE, scope })
    }
  }
  return rows
}

// An item as it stands, its accepted copy else its proposal, or as the revision named wrote it.
export const showItem = (data: string, ref: Ref, rev?: string) => {
  const dir = scopeDir(data, ref.scope)
  if (!rev) {
    const accepted = readIn(dir, ref)
    const content = accepted ?? readIn(join(dir, PROPOSED), ref)
    return content && { ...ref, content, state: accepted ? "accepted" : "proposed" }
  }
  const [path] = candidates(ref.kind, ref.key)
  const proposed = join(PROPOSED, path!)
  // a revision that wrote or judged this item reads from the paths its trailers name: a proposal from proposed/, a reject from proposed/ just before it removed it
  const trailers = extGit(dir, [
    "log",
    "-1",
    "--format=%(trailers:key=Item,valueonly)%x00%(trailers:key=State,valueonly)",
    "--end-of-options",
    rev,
  ])
  const [item, written] = trailers.out.split("\0").map((part) => part.trim())
  const ownRead = {
    accepted: ["accepted", path!, rev],
    proposed: ["proposed", proposed, rev],
    rejected: ["rejected", proposed, `${rev}^`],
  } as const
  const ownState =
    item === `${ref.kind} ${ref.key}`
      ? written === "accepted" || written === "rejected"
        ? written
        : "proposed"
      : null
  const reads = ownState ? [ownRead[ownState]] : [ownRead.accepted, ownRead.proposed]
  // a proposal that has since landed reads accepted: the commit that next changed proposed/ is its accept, its reject, or the proposal that replaced it, since judgeItem accepts only that path's last writer
  const next =
    ownState === "proposed"
      ? extGit(dir, [
          "log",
          "--reverse",
          "--ancestry-path",
          "--format=%(trailers:key=State,valueonly)%x00",
          "--end-of-options",
          `${rev}..HEAD`,
          "--",
          proposed,
        ])
          .out.split("\0")[0]
          ?.trim()
      : undefined
  for (const [state, at, tree] of reads) {
    const listed = extGit(dir, ["ls-tree", "-r", "--name-only", tree, "--", at])
    if (listed.code !== 0) return null
    const names = listed.out.split("\n").filter(Boolean)
    if (!names.length) continue
    const show = (name: string) => mustGitRaw(dir, ["show", `${tree}:${name}`])
    const content: Content = { attachments: [], body: null, files: null, value: null }
    if (names.length > 1 || names[0] !== at)
      content.files = Object.fromEntries(names.map((name) => [relative(at, name), show(name)]))
    else if (ref.kind === "list") content.value = JSON.parse(show(at))
    else content.body = show(at)
    return {
      ...ref,
      content,
      rev,
      state: next === "accepted" ? "accepted" : state,
    }
  }
  return null
}

// Each script's or skill's tracked file, as <scope> <path>, that starts with #! but is stored without its executable bit, read and never changed: playground ext check-modes, run once to find what a put wrote at 644 before put kept the bit.
export const lostModes = (data: string): string[] =>
  scopesIn(data).flatMap((scope) => {
    const dir = scopeDir(data, scope)
    return mustGit(dir, ["ls-files", "-s", "-z"])
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const [info = "", path = ""] = entry.split("\t")
        const lost =
          info.startsWith("100644 ") &&
          /^(?:proposed\/)?(?:scripts|skills)\//.test(path) &&
          readFileSync(join(dir, path)).subarray(0, 2).toString() === "#!"
        return lost ? [`${scope} ${path}`] : []
      })
  })

// Every commit that wrote or judged the item, newest first: playground ext why.
export const itemHistory = (data: string, ref: Ref) =>
  extLog(data, ref.scope, ["Item", `${ref.kind} ${ref.key}`])

// The item's change between two revisions, as git's diff of its paths.
export const diffItem = (data: string, ref: Ref, from: string, to: string): string[] | null => {
  const [path] = candidates(ref.kind, ref.key)
  const diff = extGit(scopeDir(data, ref.scope), [
    "diff",
    from,
    to,
    "--",
    path!,
    join(PROPOSED, path!),
  ])
  return diff.code === 0 ? diff.out.split("\n").filter(Boolean) : null
}

// The words in each scope's accepted items, by line, at most 50.
export const searchItems = (data: string, words: string, kind?: Kind) => {
  const found: { key: string; kind: Kind; line: string; scope: string }[] = []
  for (const scope of scopes(data)) {
    const dirs = (kind ? [kind] : KINDS).map((k) => `${k}s`)
    const grep = extGit(scopeDir(data, scope), [
      "grep",
      "-n",
      "-I",
      "-i",
      "-F",
      "-e",
      words,
      "--",
      ...dirs,
    ])
    for (const line of grep.code === 0 ? grep.out.split("\n") : []) {
      const [file, number, ...text] = line.split(":")
      const [folder, name] = file!.split("/")
      const k = folder!.slice(0, -1) as Kind
      found.push({
        key: keyOf(name!, k),
        kind: k,
        line: `${file}:${number}: ${text.join(":").trim()}`,
        scope,
      })
      if (found.length === 50) return found
    }
  }
  return found
}

// A scope's name: a GitHub login or org, as its folder and its repository take it.
export const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/

// Every scope's folder cloned into dir/<scope>, its history with it: playground ext export.
export const exportTo = (data: string, dir: string): string[] => {
  if (existsSync(dir) && readdirSync(dir).length)
    throw new Error(`${dir} is not empty: export into a new folder`)
  mkdirSync(dir, { recursive: true })
  return withLock(data, () =>
    scopesIn(data).map((scope) => {
      mustGit(dir, ["clone", "-q", scopeDir(data, scope), scope])
      return `exported ${scope} to ${join(dir, scope)}`
    }),
  )
}

// Every scope's tracked files as <scope>/<path> to its bytes, read under the lock: what the nightly backup writes until ext sync takes it over.
export const extFiles = (data: string): Map<string, Buffer> =>
  withLock(data, () => {
    const files = new Map<string, Buffer>()
    for (const scope of scopesIn(data)) {
      const dir = scopeDir(data, scope)
      for (const path of mustGit(dir, ["ls-files", "-z"]).split("\0").filter(Boolean))
        files.set(`${scope}/${path}`, readFileSync(join(dir, path)))
    }
    return files
  })

const secretsUnder = (dir: string): string[] =>
  filesIn(dir).flatMap((file) => {
    const found = secretIn(readFileSync(join(dir, file), "utf8"))
    return found ? [`${file} holds ${found}`] : []
  })

// An export brought in, each dir/<scope> on its own: a scope this machine lacks is cloned, one whose history the export carries on fast-forwards, and any other has the export's files copied over as one commit; with dryRun, only what each would do and git's stat of it. Refused whole when any file holds something secret-shaped.
export const importFrom = (
  data: string,
  dir: string,
  dryRun: boolean,
  who: Who,
): Outcome<{ lines: string[] }> => {
  const scopes = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SCOPE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (scopes.includes(CORE))
    return {
      message: "core ships with the checkout; leave it out of an import",
      ok: false,
      status: 400,
    }
  const secrets = scopes.flatMap((scope) =>
    secretsUnder(join(dir, scope)).map((line) => `${scope}/${line}`),
  )
  if (secrets.length)
    return { message: `refused, nothing imported: ${secrets.join("; ")}`, ok: false, status: 400 }
  const lines: string[] = []
  for (const scope of scopes) {
    const from = join(dir, scope)
    const into = scopeDir(data, scope)
    if (!existsSync(join(into, ".git"))) {
      lines.push(`+ ${scope}: new, ${filesIn(from).length} files`)
      if (!dryRun)
        withLock(data, () => {
          mkdirSync(extensionsDir(data), { recursive: true })
          if (existsSync(join(from, ".git"))) {
            mustGit(extensionsDir(data), ["clone", "-q", from, scope])
            mustGit(into, ["remote", "remove", "origin"])
          }
        })
      if (!dryRun && !existsSync(join(from, ".git"))) copyTree(data, scope, from, who)
      continue
    }
    const fetched =
      existsSync(join(from, ".git")) &&
      withLock(data, () => extGit(into, ["fetch", "-q", from, "HEAD"]).code === 0, {
        scopes: [scope],
      })
    const forward =
      fetched && extGit(into, ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).code === 0
    const stat = fetched
      ? mustGit(into, ["diff", "--stat", "HEAD", "FETCH_HEAD"])
      : `${filesIn(from).length} files`
    lines.push(
      `~ ${scope}: ${forward ? "fast-forward" : "copied as one commit"}`,
      ...stat.split("\n").filter(Boolean),
    )
    if (dryRun) continue
    if (forward)
      withLock(data, () => mustGit(into, ["merge", "-q", "--ff-only", "FETCH_HEAD"]), {
        scopes: [scope],
      })
    else copyTree(data, scope, from, who)
  }
  const login = dryRun ? undefined : loginOr(data)
  if (login) withLock(data, () => deriveHooks(data, login))
  return { lines, ok: true }
}

const copyTree = (data: string, scope: string, from: string, who: Who) =>
  writeTree(
    data,
    scope,
    new Map(filesIn(from).map((file) => [file, readFileSync(join(from, file))])),
    {
      author: who.author,
      reason: who.reason,
      trailers: [
        ["Actor", who.actor],
        ["Import", from],
      ],
    },
    undefined,
    (file) => (statSync(join(from, file)).mode & 0o111) !== 0,
  )

// The guards' list files of a folder (extensions/core/lists in a checkout) into the login's lists, one commit, then the root's lists derived: what a fresh machine seeds its guards with. With keep, a list the login already holds stays as it is, so a second seed changes nothing.
export const importLists = (
  data: string,
  dir: string,
  dryRun: boolean,
  who: Who,
  keep = false,
): Outcome<{ lines: string[] }> => {
  let login: string
  try {
    login = loginOf(data)
  } catch (error) {
    return refused(error)
  }
  const lines: string[] = []
  const files = new Map<string, string>()
  for (const name of GUARD_LISTS) {
    const file = join(dir, `${name}.json`)
    if (keep && existsSync(join(scopeDir(data, login), "lists", `${name}.json`))) {
      lines.push(`= list ${login} ${name} kept`)
      continue
    }
    if (!existsSync(file)) {
      lines.push(
        `- ${name}: no ${file}; add it with playground ext put ${login} list ${name} <file> --reason <why>`,
      )
      continue
    }
    const text = readFileSync(file, "utf8")
    const secret = secretIn(text)
    if (secret) return { message: `${file} holds ${secret}`, ok: false, status: 400 }
    files.set(`lists/${name}.json`, stableJson(JSON.parse(text)))
    lines.push(`+ list ${login} ${name} from ${file}`)
  }
  if (dryRun || !files.size) return { lines, ok: true }
  try {
    const sha = commitExt(
      data,
      login,
      {
        author: who.author,
        reason: who.reason,
        trailers: [
          ["Actor", who.actor],
          ["Import", dir],
        ],
      },
      (at, root) => {
        for (const [path, text] of files) writeAtomically(join(at, path), text)
        deriveHooks(data, login, root)
      },
    )
    lines.push(sha ? `committed ${sha.slice(0, 12)}` : "unchanged")
  } catch (error) {
    return refused(error)
  }
  return { lines, ok: true }
}
