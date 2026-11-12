import { expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ACTION = join(import.meta.dir, "../../../.github/actions/install-zsh/action.yml")
const BREW = "/home/linuxbrew/.linuxbrew/bin/brew"

type Step = { name?: string; run?: string; uses?: string; with?: { key?: string; path?: string } }
const steps = async () =>
  (Bun.YAML.parse(await Bun.file(ACTION).text()) as { runs: { steps: Step[] } }).runs.steps

type Case = {
  aptFails?: number
  brewFails?: boolean
  cached?: boolean
  dpkgFails?: number
  present?: boolean
}

// The action's install block under GitHub's bash, on a PATH of fakes that log each call: apt-get, brew and dpkg fail as the case says, and apt-get's install leaves zsh's two .deb files in its archives folder
async function install(c: Case) {
  const dir = mkdtempSync(join(tmpdir(), "install-zsh-"))
  const [bin, home] = [join(dir, "bin"), join(dir, "home")]
  const [calls, output, path] = [join(dir, "calls"), join(dir, "output"), join(dir, "path")]
  mkdirSync(bin)
  mkdirSync(home)
  for (const file of [calls, output, path]) writeFileSync(file, "")
  for (const tool of ["cat", "ls", "mkdir", "sh"]) symlinkSync(`/bin/${tool}`, join(bin, tool))
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const log = `echo "\${0##*/} $*" >> ${calls}`
  const nth = (counter: string) =>
    `n=$(( $(cat ${join(dir, counter)} 2>/dev/null || echo 0) + 1 )); echo $n > ${join(dir, counter)}`
  fake("sudo", `exec "$@"`)
  fake("timeout", `${log}\nshift 3\nexec "$@"`)
  fake("sleep", log)
  fake("ln", log)
  fake("dpkg", `${log}\n${nth("dpkg")}\n[ $n -gt ${c.dpkgFails ?? 0} ]`)
  fake(
    "brew",
    `[ "$1" = --prefix ] && { echo /home/linuxbrew/.linuxbrew; exit 0; }\n${log}\nexit ${c.brewFails ? 1 : 0}`,
  )
  fake(
    "apt-get",
    `${log}\n[ "$1" = install ] || exit 0\n${nth("apt")}\n[ $n -le ${c.aptFails ?? 0} ] && exit 100\nfor a in "$@"; do case "$a" in Dir::Cache::archives=*) d=\${a#Dir::Cache::archives=} ;; esac; done\n: > "$d/zsh_5.9_amd64.deb"; : > "$d/zsh-common_5.9_all.deb"`,
  )
  if (c.present) fake("zsh", "exit 0")
  if (c.cached) {
    mkdirSync(join(home, ".cache/zsh-debs"), { recursive: true })
    for (const deb of ["zsh_5.9_amd64.deb", "zsh-common_5.9_all.deb"])
      writeFileSync(join(home, ".cache/zsh-debs", deb), "")
  }
  const block = (await steps()).find((step) => step.name === "Install zsh" && step.run)?.run
  if (!block) throw new Error("no Install zsh run step in action.yml")
  writeFileSync(join(dir, "block.sh"), block.replaceAll(BREW, join(bin, "brew")))
  const proc = Bun.spawn(
    ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", join(dir, "block.sh")],
    {
      env: { GITHUB_OUTPUT: output, GITHUB_PATH: path, HOME: home, PATH: bin },
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  const code = await proc.exited
  const lines = readFileSync(calls, "utf8")
    .replaceAll(home, "<home>")
    .replaceAll(dir, "<dir>")
    .trim()
    .split("\n")
    .filter(Boolean)
  return {
    code,
    output: readFileSync(output, "utf8"),
    path: readFileSync(path, "utf8"),
    stdout: await new Response(proc.stdout).text(),
    tools: lines.map((line) => line.split(" ")[0]),
    lines,
  }
}

const APT_TRY = ["timeout", "apt-get", "apt-get"]

test("zsh already on PATH: no call at all", async () => {
  const r = await install({ present: true })
  expect([r.code, r.tools, r.output, r.path]).toEqual([0, [], "", ""])
  expect(r.stdout).toContain("zsh is present at")
})

test("a cache hit installs the cached packages with no apt call", async () => {
  const r = await install({ cached: true })
  expect([r.code, r.tools, r.output, r.path]).toEqual([0, ["dpkg"], "", ""])
  expect(r.stdout).toContain("zsh from the cache: no apt call")
})

test("cached packages that fail to install are fetched again", async () => {
  const r = await install({ cached: true, dpkgFails: 1 })
  expect([r.code, r.tools, r.output]).toEqual([0, ["dpkg", ...APT_TRY, "dpkg"], "fetched=true\n"])
})

test("one failed apt try waits 15 s, then the second fetches and marks the packages for saving", async () => {
  const r = await install({ aptFails: 1 })
  expect([r.code, r.tools, r.output, r.path]).toEqual([
    0,
    [...APT_TRY, "sleep", ...APT_TRY, "dpkg"],
    "fetched=true\n",
    "",
  ])
  expect(r.lines).toContain(
    'timeout -k 10 140 sh -c apt-get update -q && apt-get install -y -q --download-only -o Dir::Cache::archives="$1" zsh sh <home>/.cache/zsh-debs',
  )
  expect(r.lines).toContain("sleep 15")
})

test("two failed apt tries fall back to Homebrew, link its zsh at /usr/bin/zsh and put its bin on PATH, saving nothing", async () => {
  const r = await install({ aptFails: 2 })
  expect([r.code, r.output, r.path]).toEqual([0, "", "/home/linuxbrew/.linuxbrew/bin\n"])
  expect(r.tools).toEqual([...APT_TRY, "sleep", ...APT_TRY, "timeout", "brew", "ln"])
  expect(r.lines.slice(-3)).toEqual([
    "timeout -k 10 120 <dir>/bin/brew install zsh",
    "brew install zsh",
    "ln -sf /home/linuxbrew/.linuxbrew/bin/zsh /usr/bin/zsh",
  ])
})

test("when Homebrew fails too, the step exits 1 and names the wider fault", async () => {
  const r = await install({ aptFails: 2, brewFails: true })
  expect([r.code, r.tools, r.output, r.path]).toEqual([
    1,
    [...APT_TRY, "sleep", ...APT_TRY, "timeout", "brew"],
    "",
    "",
  ])
  expect(r.stdout).toContain("Homebrew failed too")
})

// apt, run as root, leaves root's lock and _apt's partial/ in the archives folder, which the runner user's tar cannot read, so a cache of the whole folder never saves
test("the restore and save steps cache the same key and the .deb files alone", async () => {
  const cache = (await steps()).filter((step) => step.uses?.startsWith("actions/cache/"))
  expect(cache.map((step) => [step.uses, step.with?.path, step.with?.key])).toEqual([
    ["actions/cache/restore@v4", "~/.cache/zsh-debs/*.deb", "${{ steps.zsh-key.outputs.key }}"],
    ["actions/cache/save@v4", "~/.cache/zsh-debs/*.deb", "${{ steps.zsh-key.outputs.key }}"],
  ])
})
