import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { machineRoots, sessionName } from "../trash"
import {
  diffSkills,
  download,
  manifestFor,
  parseManifest,
  UPSTREAMS,
  upstreamNamed,
  vendored,
  vendor,
} from "./stage"

const USAGE = `Usage: bun run vendor:upstream <name> [<sha or ref>]

Vendors the skills core keeps from one upstream (${UPSTREAMS.map(({ name }) => name).join(", ")}),
byte for byte, into extensions/core/skills/ at the ref's head (default that
upstream's own branch): downloads that sha's tarball, stages the kept skills and
licenses in core, checks every staged byte against MANIFEST, swaps each skill
folder and upstream/<name>/ in, and prints the skills added and removed since
the old MANIFEST. It never commits.`

const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const CORE = join(ROOT, "extensions", "core")

const gh = (...args: string[]): Buffer => {
  const run = Bun.spawnSync(["gh", "api", ...args], { stderr: "pipe", stdout: "pipe" })
  if (run.exitCode !== 0) {
    console.error(
      `vendor:upstream: gh api ${args.join(" ")} failed: ${run.stderr.toString().trim()}`,
    )
    process.exit(1)
  }
  return run.stdout
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { help: { short: "h", type: "boolean" } },
})
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
const upstream = upstreamNamed(positionals[0] ?? "")
if (!upstream) {
  console.error(USAGE)
  process.exit(2)
}
const ref = positionals[1] ?? upstream.ref

const sha = gh(`repos/${upstream.repo}/commits/${ref}`, "--jq", ".sha").toString().trim()
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`vendor:upstream: ${ref} resolved to ${sha}, which is not a sha`)
  process.exit(1)
}

const { kept, missing } = await download(gh, upstream, sha)
if (missing.length > 0) {
  console.error(`vendor:upstream: the tarball of ${sha} is missing ${missing.join(", ")}`)
  process.exit(1)
}
const files = vendored(upstream, kept)

const manifest = manifestFor(files)
const oldManifest = join(CORE, "upstream", upstream.name, "MANIFEST")
const oldText = existsSync(oldManifest) ? readFileSync(oldManifest, "utf8") : null
const done = vendor({
  coreDir: CORE,
  files,
  manifest,
  name: upstream.name,
  repo: upstream.repo,
  roots: machineRoots(),
  session: await sessionName(),
  sha,
})
if (!done.ok) {
  console.error(`vendor:upstream: the staged bytes do not match MANIFEST, leaving core as it was:
${done.mismatches.join("\n")}`)
  process.exit(1)
}
console.log(`vendored ${upstream.repo} at ${sha}: ${done.files} files`)
for (const line of diffSkills(oldText, parseManifest(manifest))) console.log(line)
