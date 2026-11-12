import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { readdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"

import type { BunPlugin } from "bun"

import { guardsIn, preToolUseGuards } from "./ops-tick/guard-probe"

// hooks-bundle: each PreToolUse guard in scripts/hooks/ bundled with everything it imports into scripts/hooks/bundled/<guard>.js, the file its wrapper runs, so a guard starts with no node_modules; the bundles are committed, since a git restore of a deleted checkout brings it back with no install. `--check` builds a tree git holds, the index or with `--merged <ref>` the head merged with ref, in a temp folder of the tree's own files that it removes afterwards, and names each bundle there that differs from that build; write mode builds from the working files, writes each bundle and removes each .js file in the folder no build writes.
export const ROOT = join(import.meta.dir, "..", "..", "..")
export const HOOKS = join("scripts", "hooks")
export const BUNDLED = join(HOOKS, "bundled")
const SETTINGS = join("scripts", "factory-settings.json")

// A tree git holds, read by path from the checkout's root: each folder's file names, every path, and each file's text, read once.
export type Tree = {
  names: (dir: string) => string[]
  paths: () => string[]
  text: (path: string) => string | undefined
}

const gitIn = (root: string, args: string[]) => {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdin: "ignore" })
  return { code: proc.exitCode, err: proc.stderr.toString(), out: proc.stdout.toString() }
}

export function treeAt(root: string, oid: string): Tree {
  const listed = gitIn(root, ["ls-tree", "-r", "-z", oid])
  if (listed.code !== 0) throw new Error(`hooks-bundle: git ls-tree ${oid}: ${listed.err.trim()}`)
  const blobs = new Map<string, string>()
  for (const entry of listed.out.split("\0")) {
    const tab = entry.indexOf("\t")
    const [, type, blob] = entry.slice(0, tab).split(" ")
    if (tab !== -1 && type === "blob" && blob) blobs.set(entry.slice(tab + 1), blob)
  }
  const texts = new Map<string, string>()
  // one git cat-file --batch for every blob on the first text read, in place of one spawn per file
  const readAll = () => {
    if (texts.size) return
    // ignoreBOM keeps the bytes git holds, where a plain decoder would read a leading BOM away
    const decode = new TextDecoder("utf-8", { ignoreBOM: true })
    const proc = Bun.spawnSync(["git", "-C", root, "cat-file", "--batch"], {
      stdin: new TextEncoder().encode([...blobs.values()].map((sha) => `${sha}\n`).join("")),
    })
    const bytes = proc.stdout
    const bySha = new Map<string, string>()
    let at = 0
    while (at < bytes.length) {
      const nl = bytes.indexOf(10, at)
      if (nl === -1) break
      const header = decode.decode(bytes.subarray(at, nl))
      const frame = /^[0-9a-f]{40,64} blob (\d+)$/.exec(header)
      if (!frame)
        throw new Error(`hooks-bundle: git cat-file --batch read a tree blob as "${header}"`)
      const size = Number(frame[1])
      bySha.set(
        header.slice(0, header.indexOf(" ")),
        decode.decode(bytes.subarray(nl + 1, nl + 1 + size)),
      )
      at = nl + 1 + size + 1
    }
    for (const [path, sha] of blobs) {
      const text = bySha.get(sha)
      if (text !== undefined) texts.set(path, text)
    }
  }
  return {
    names: (dir) =>
      [...blobs.keys()].filter((path) => dirname(path) === dir).map((path) => basename(path)),
    paths: () => [...blobs.keys()],
    text: (path) => {
      if (!blobs.has(path)) return undefined
      readAll()
      return texts.get(path)
    },
  }
}

const SOURCE = /\.[cm]?[jt]sx?$/
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

// no-extensions-write runs its check in this Worker, which it starts by URL beside its own file.
const WORKERS = ["no-extensions-write-worker"]

// The checkout a bundle sits in, two folders up from scripts/hooks/bundled/, read at run time.
const BANNER =
  'const __CHECKOUT = import.meta.dir.slice(0, import.meta.dir.lastIndexOf("/scripts/hooks/bundled"));'

// Each module the build reads reads import.meta.dir as its own source's folder under the checkout the bundle sits in, so a path it builds from there (main-checkout.ts's checkout, a guard's own folder) holds as it does from source.
const sourceDirs = (base: string): BunPlugin => ({
  name: "source-dirs",
  setup(build) {
    const filter = new RegExp(`^${escape(base)}/(?!.*/node_modules/).*\\.[cm]?[jt]sx?$`)
    build.onLoad({ filter }, async ({ path }) => {
      const text = await Bun.file(path).text()
      return {
        contents: text.replace(
          /\bimport\.meta\.dir\b/g,
          `(__CHECKOUT + ${JSON.stringify(`/${relative(base, dirname(path))}`)})`,
        ),
        loader: path.endsWith("x") ? "tsx" : /\.[cm]?js$/.test(path) ? "js" : "ts",
      }
    })
  },
})

// The merged tree's sources, tsconfig.json and package.json files, copied into a temp folder in the tree's own layout, so the merged build reads the tree's own files and resolves its imports with the tree's own tsconfigs, per importing file as Bun does, and touches no worktree file; the mirror holds the tree's layout, so import.meta.dir keeps reading as the real checkout's folders. A bare import walks up to node_modules, which the mirror has none of, so each folder of the layout gets the checkout's own entries as links, read only.
const mirrorOf = async (tree: Tree, root: string): Promise<string> => {
  const mirror = realpathSync(mkdtempSync(join(tmpdir(), "hooks-bundle-merged-")))
  try {
    const reads = new Map<string, string>()
    for (const path of tree.paths()) {
      if (path.includes("node_modules/")) continue
      if (
        !SOURCE.test(path) &&
        basename(path) !== "tsconfig.json" &&
        basename(path) !== "package.json"
      )
        continue
      const text = tree.text(path)
      if (text !== undefined) reads.set(path, text)
    }
    for (const [path, text] of reads) {
      const to = join(mirror, path)
      mkdirSync(dirname(to), { recursive: true })
      await Bun.write(to, text)
    }
    // Every folder of the layout gets the checkout's node_modules entries beside it, each as a link to the checkout's own, except a workspace package's: its link resolves outside node_modules, so its mirror entry points at the mirror's same path, and a bare import reads the tree's own copy with the tree's own tsconfigs.
    const realRoot = realpathSync(root)
    const linkModules = async (from: string, to: string): Promise<void> => {
      if (!existsSync(from)) return
      mkdirSync(to, { recursive: true })
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const at = join(from, entry.name)
        const name = join(to, entry.name)
        if (entry.isDirectory() && entry.name.startsWith("@")) {
          await linkModules(at, name)
          continue
        }
        // a dangling entry reads nowhere, so it links to the checkout's own, as the base linked it; only a found workspace path points at the mirror
        let rel = ""
        try {
          rel = relative(realRoot, realpathSync(at))
        } catch {}
        symlinkSync(
          rel && !rel.startsWith("..") && !rel.includes("node_modules/") ? join(mirror, rel) : at,
          name,
        )
      }
    }
    const dirs = new Set<string>([""])
    for (const path of reads.keys())
      for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1))
        dirs.add(path.slice(0, at))
    for (const dir of dirs)
      await linkModules(join(root, dir, "node_modules"), join(mirror, dir, "node_modules"))
    return mirror
  } catch (error) {
    // a throw while the mirror is written removes it here, since bundle holds it only once mirrorOf is whole
    rmSync(mirror, { recursive: true, force: true })
    throw error
  }
}

export const entries = async (root: string, tree?: Tree): Promise<string[]> => [
  ...new Set([
    ...(tree ? guardsIn(tree.text(SETTINGS) ?? '{"hooks":{}}') : await preToolUseGuards(root)),
    ...WORKERS,
  ]),
]

// Each bundle's file name and text, built from root's sources, or the tree's through its mirror when one is given, one build per entry point: Bun compiles an imported module's `if (import.meta.main)` to `if (false)` only when that module is no entry point of the same build, and a guard imports other guards.
export async function bundle(root: string, tree?: Tree): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const cwd = process.cwd()
  let mirror: string | undefined
  try {
    // Bun names each module in a comment by its path from the working folder, so the build runs from the base folder, whose layout the mirror holds, and its text is the same wherever it is called from.
    mirror = tree ? await mirrorOf(tree, root) : undefined
    const base = mirror ?? root
    // A bare npm import reaches the checkout's own store through the mirror's links, so Bun names its modules by the walk back to the checkout; the rewrite names them from the base, as a build there does.
    const store = mirror ? relative(mirror, join(realpathSync(root), "node_modules")) : undefined
    const text = async (output: Bun.BuildArtifact) => {
      const out = await output.text()
      if (!store) return out
      return out.replaceAll(`// ${store}/`, "// node_modules/")
    }
    process.chdir(base)
    try {
      for (const name of await entries(root, tree)) {
        const result = await Bun.build({
          banner: BANNER,
          entrypoints: [join(base, HOOKS, `${name}.ts`)],
          naming: "[name].js",
          plugins: [sourceDirs(realpathSync(base))],
          root: join(base, HOOKS),
          target: "bun",
        })
        if (!result.success) throw new AggregateError(result.logs, "hooks-bundle: the build failed")
        for (const output of result.outputs)
          files.set(output.path.replace(/^.*\//, ""), await text(output))
      }
    } finally {
      process.chdir(cwd)
    }
  } finally {
    if (mirror) rmSync(mirror, { recursive: true, force: true })
  }
  return files
}

// Each file in the bundled folder that a fresh build would write otherwise, or that no build writes: root's working files, or the tree's when one is given.
export async function stale(root: string, tree?: Tree): Promise<string[]> {
  const fresh = await bundle(root, tree)
  const held = tree
    ? tree.names(BUNDLED)
    : await readdir(join(root, BUNDLED)).catch(() => [] as string[])
  const names = [...new Set([...fresh.keys(), ...held])].sort()
  const drift: string[] = []
  for (const name of names) {
    const file = Bun.file(join(root, BUNDLED, name))
    const text = tree
      ? tree.text(join(BUNDLED, name))
      : (await file.exists())
        ? await file.text()
        : undefined
    if (text !== fresh.get(name)) drift.push(name)
  }
  return drift
}

// The tree `--check` reads: the index, which is what a commit carries, or with a ref the head merged with it, as CI's merge ref builds a PR; a merge that conflicts in the bundles alone is read with their conflict markers, which read stale, and one that conflicts elsewhere gives a note in place of a tree, since pr:merge's gate reports it.
export function checkedTree(root: string, ref?: string): { note?: string; tree?: Tree } {
  if (!ref) {
    const index = gitIn(root, ["write-tree"])
    if (index.code !== 0)
      throw new Error(
        `hooks-bundle: the index holds unmerged paths, so --check reads no tree; resolve and stage them, then run it again (${index.err.trim()})`,
      )
    return { tree: treeAt(root, index.out.trim()) }
  }
  const merged = gitIn(root, ["merge-tree", "--write-tree", "--name-only", "HEAD", ref])
  const [oid, ...rest] = merged.out.split("\n")
  // a ref git cannot read exits 1 too, as a conflict does, but with no tree's oid
  if ((merged.code !== 0 && merged.code !== 1) || !/^[0-9a-f]{40,64}$/.test(oid!.trim()))
    throw new Error(`hooks-bundle: git merge-tree HEAD ${ref}: ${merged.err.trim()}`)
  const conflicts = merged.code === 1 ? rest.slice(0, rest.indexOf("")) : []
  const outside = [...new Set(conflicts)].filter((path) => !path.startsWith(`${BUNDLED}/`))
  if (outside.length)
    return {
      note: `hooks-bundle: HEAD conflicts with ${ref} outside ${BUNDLED} (${outside.join(", ")}), so --check --merged reads no merged tree; pr:merge's gate reports the conflict`,
    }
  return { tree: treeAt(root, oid!.trim()) }
}

// `--check --merged`'s fix: the bundles go stale only once merged, so the rebuild runs on the merged tree.
export const MERGED_FIX = (ref: string) =>
  `merge ${ref} into the branch plainly, taking its side in ${BUNDLED}, commit the merge, then run \`bun run hooks:bundle\` and commit the rebuild on its own (\`bun run hooks:merge-canary\` does all of it for origin/canary)`

// The head of `--check`'s line for a stale bundle, which pr:merge's types gate reads as the merged tree's own fault.
export const STALE = `hooks-bundle: stale in ${BUNDLED}:`

export const FIX =
  "run `bun run hooks:bundle` and commit scripts/hooks/bundled; after a merge that conflicts there, take canary's side, commit the merge, then run it again and commit the rebuild on its own"

// Write mode's refusal while a merge is in progress: bundles rebuilt before the merge commit land inside it, where pr:merge's keeps-canary gate reads them as lines lost from canary that no later commit clears.
export const MERGING =
  "hooks-bundle: a merge is in progress, so the rebuilt bundles would land inside the merge commit, where pr:merge's keeps-canary gate reads them as lines lost from canary; commit the merge first, taking canary's bundles in scripts/hooks/bundled as they are, then run `bun run hooks:bundle` again and commit the rebuild on its own"

// Whether root's checkout has a merge in progress, as git marks one with MERGE_HEAD.
export const merging = (root: string): boolean =>
  Bun.spawnSync(["git", "-C", root, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode === 0

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const at = process.argv.indexOf("--merged")
    const ref = at === -1 ? undefined : process.argv[at + 1]
    if (at !== -1 && !ref) {
      console.error("hooks-bundle: --merged takes a ref, such as origin/canary")
      process.exit(1)
    }
    const { note, tree } = checkedTree(ROOT, ref)
    if (note) console.error(note)
    const drift = tree ? await stale(ROOT, tree) : []
    if (drift.length) {
      console.error(
        ref
          ? `${STALE} ${drift.join(", ")} once merged with ${ref}; ${MERGED_FIX(ref)}`
          : `${STALE} ${drift.join(", ")}; ${FIX}`,
      )
      process.exit(1)
    }
  } else if (merging(ROOT)) {
    console.error(MERGING)
    process.exit(1)
  } else {
    const fresh = await bundle(ROOT)
    for (const [name, text] of fresh) await Bun.write(join(ROOT, BUNDLED, name), text)
    // A bundle no build writes, a removed guard's, goes too, since --check names it stale: one .js file at a time, directly in the folder, and nothing else.
    for (const file of await readdir(join(ROOT, BUNDLED), { withFileTypes: true }))
      if (file.isFile() && file.name.endsWith(".js") && !fresh.has(file.name))
        await unlink(join(ROOT, BUNDLED, file.name))
    console.log(`hooks-bundle: wrote ${BUNDLED}`)
  }
}
