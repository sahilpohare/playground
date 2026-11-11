import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

const root = join(import.meta.dir, "..")
// The repository install.sh clones, read from install.sh itself.
const REPO = /^REPO=(\S+)$/m.exec(readFileSync(join(root, "install.sh"), "utf8"))![1]!
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "playground-install-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// What install.sh reads from the checkout it clones; the CLI is a stub that says it started.
const SOURCE_FILES = [
  ".gitignore",
  "api/hono/src/lib/dev/proxy.ts",
  "install.sh",
  "package.json",
  "packages/env/src/aliases.ts",
  "packages/env/src/data-dir.ts",
  "packages/scripts/src/ops-herdr/pin.json",
  "packages/scripts/src/ops-herdr/pin.ts",
  "packages/scripts/src/playground/doctor.ts",
  "packages/scripts/src/playground/links.ts",
  "packages/scripts/src/playground/orgs.ts",
  "packages/scripts/src/playground/unlinked.ts",
  "packages/settings/src/rendered.ts",
  "scripts/factory-settings.json",
  "scripts/link-skills.sh",
]

// The tools install.sh checks and the installers it calls: a run reaches only their fakes, so the system's own folders are linked in without them.
const FAKED = [
  "brew",
  "bun",
  "claude",
  "claude-codex",
  "curl",
  "docker",
  "gh",
  "git",
  "herdr",
  "node",
  "open",
  "python3",
  "sudo",
  "uv",
]
const sys = join(scratch, "sys")
mkdirSync(sys)
// each name once: on a merged /usr, /bin is /usr/bin, and existsSync reads a dangling link there as missing
const linked = new Set(FAKED)
for (const dir of ["/bin", "/usr/bin"])
  for (const name of readdirSync(dir))
    if (!linked.has(name)) {
      linked.add(name)
      symlinkSync(join(dir, name), join(sys, name))
    }
const realGit = Bun.which("git")!
// The bun package.json's packageManager names, which install.sh holds every bun to.
const WANTED_BUN = /^bun@(\S+)$/.exec(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
)![1]!

const write = (path: string, text: string, mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

// git with no system config, no GIT_* from a hook that runs the suite, and the scratch HOME's .gitconfig; Claude Code's and Playground's folders are the scratch HOME's too
const gitEnv = (home: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") && !key.startsWith("INSTALL_") && key !== "PLAYGROUND_INSTALL",
    ),
  ),
  CLAUDE_CONFIG_DIR: "",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: home,
  PLAYGROUND_DATA_DIR: "",
  XDG_CONFIG_HOME: "",
})
const git = (cwd: string, home: string, ...args: string[]) =>
  Bun.spawnSync([realGit, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: gitEnv(home),
  })

type Tool =
  | "brew"
  | "bun"
  | "claude"
  | "claude-codex"
  | "docker"
  | "gh"
  | "git"
  | "node"
  | "python3"
  | "uv"
type Setup = {
  // what the terminal answers, given as INSTALL_TTY
  answer?: string
  // each one's sign-in, already made
  claudeLogin?: boolean
  // claude auth login reads its stdin as a Bun program, as Claude Code does
  claudeReadsWithBun?: boolean
  // brew's Docker cask puts docker on PATH; without it Docker Desktop has to be opened once
  dockerOnPath?: boolean
  // the installs that fail, by tool
  fail?: Tool[]
  ghLogin?: boolean
  // the login gh's api reads, and whether its private repo is on GitHub yet; with none, ext init runs with no question
  ghUser?: string
  // the pinned herdr install's exit code and its last stderr line
  herdr?: { code: number; stderr?: string }
  // the tools not on this machine at the start; brew, bun's installer and Claude Code's add them
  missing?: Tool[]
  // a bun of this version first on PATH in place of the current one, whose install refuses the lockfile as an old bun does
  oldBun?: string
  repoExists?: boolean
  // rows a fake doctor.ts adds to its --tools --json list, for a row install.sh has no installer for
  doctorRows?: { detail: string; name: string; status: string }[]
  // portless's proxy: whether it answers on its port (the file INSTALL_PROXY_UP names), whether its service's plist (INSTALL_PORTLESS_PLIST) is in place, and the port portless saved, if any
  proxy?: { answers: boolean; plist: boolean; port?: string }
  // sudo refuses, as a wrong or withheld password does
  sudoFails?: boolean
  // a terminal for the in-place steps, a file of answers given as INSTALL_TTY
  tty?: boolean
}

let made = 0
// A scratch source repo, a sandboxed HOME, a bin of fakes, a fake Homebrew prefix, and every fake's calls in one log; an installer copies its tool's fake from the store into place.
const setup = ({
  answer = "from-tty",
  claudeLogin = true,
  claudeReadsWithBun = false,
  dockerOnPath = true,
  doctorRows = [],
  fail = [],
  ghLogin = true,
  ghUser = "",
  herdr = { code: 0 },
  missing = [],
  oldBun,
  proxy = { answers: true, plist: true },
  repoExists = false,
  sudoFails = false,
  tty = false,
}: Setup = {}) => {
  const box = join(scratch, `box-${++made}`)
  const source = join(box, "source")
  const home = join(box, "home")
  const bin = join(box, "bin")
  const store = join(box, "store")
  const prefix = join(box, "homebrew")
  const log = join(box, "calls.log")
  const ttyFile = join(box, "tty")
  const state = join(box, "state")
  const plist = join(box, "sh.portless.proxy.plist")
  const up = join(box, "proxy-up")
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })
  if (claudeLogin) write(join(state, "claude-login"), "")
  if (ghLogin) write(join(state, "gh-login"), "")
  write(ttyFile, `${answer}\n`)
  if (proxy.plist) write(plist, "")
  if (proxy.answers) write(up, "")
  if (proxy.port) write(join(home, ".portless/proxy.port"), `${proxy.port}\n`)

  for (const file of SOURCE_FILES) cpSync(join(root, file), join(source, file))
  write(
    join(source, "packages/scripts/src/playground/cli.ts"),
    '#!/usr/bin/env bun\nconsole.log(process.argv[2] ? `playground ${process.argv.slice(2).join(" ")}` : "playground started")\n',
    0o755,
  )
  write(
    join(source, "packages/scripts/src/playground/herdr-pin.ts"),
    [
      'import { appendFileSync } from "node:fs"',
      // doctor.ts imports it for the full doctor's herdr row, which --tools never reads, so only a run of its own logs and exits
      "export const checkHerdr = () => ({ code: 0, line: '' })",
      "if (import.meta.main) {",
      `  appendFileSync(${JSON.stringify(log)}, \`herdr-pin \${[import.meta.path, ...process.argv.slice(2)].join(" ")}\\n\`)`,
      herdr.stderr ? `  console.error(${JSON.stringify(herdr.stderr)})` : "",
      `  process.exit(${herdr.code})`,
      "}",
    ].join("\n"),
  )
  if (doctorRows.length > 0) {
    const doctor = join(source, "packages/scripts/src/playground/doctor.ts")
    write(
      doctor,
      [
        `const rows = ${JSON.stringify(doctorRows)}`,
        'if (process.argv.includes("--json")) {',
        "  console.log(JSON.stringify(rows))",
        "  process.exit(1)",
        "}",
      ].join("\n"),
    )
  }
  write(join(source, "skills/playground/fake-skill/SKILL.md"), "# fake\n")
  const reader = join(box, "reader.ts")
  write(
    reader,
    [
      'import { appendFileSync, writeFileSync } from "node:fs"',
      `const said = (line: string) => appendFileSync(${JSON.stringify(log)}, \`claude auth login stdin \${line}\\n\`)`,
      'process.stdin.on("data", () => {})',
      'process.stdin.on("error", (error) => { said(error.message); process.exit(1) })',
      `setTimeout(() => { said("ok"); writeFileSync(${JSON.stringify(join(state, "claude-login"))}, ""); process.exit(0) }, 500)`,
    ].join("\n"),
  )
  git(box, home, "init", "-q", "-b", "main", source)
  git(source, home, "add", ".")
  git(source, home, "commit", "-q", "-m", "seed")

  const fakes: Record<Tool | "curl" | "open" | "portless" | "sudo", string> = {
    brew: [
      `echo "brew $*" >> ${log}`,
      `if [ "$1" = shellenv ]; then echo 'export PATH="${prefix}/bin:$PATH"'; exit 0; fi`,
      `[ "$1" = install ] || exit 1`,
      "shift",
      `if [ "$1" = --cask ]; then tool=docker; else tool=$1; fi`,
      `[ "$tool" = python ] && tool=python3`,
      ...fail.map((tool) => `[ "$tool" = ${tool} ] && exit 1`),
      `[ "$tool" = docker ] && [ ${dockerOnPath ? 1 : 0} = 0 ] && exit 0`,
      `cp ${store}/$tool ${prefix}/bin/$tool`,
    ].join("\n"),
    bun: [
      `[ "$1" = --version ] && { echo ${WANTED_BUN}; exit 0; }`,
      // the workspace packages the home skill set's resolver imports, from this checkout's install
      `if [ "$1" = install ]; then echo "bun $*" >> ${log}; mkdir -p node_modules/.bin packages/scripts/node_modules; ln -sfn ${join(root, "packages", "scripts", "node_modules", "@packages")} packages/scripts/node_modules/@packages`,
      `  printf '#!/bin/sh\\necho "turbo $*" >> ${log}\\n' > node_modules/.bin/turbo; chmod +x node_modules/.bin/turbo; cp ${store}/portless node_modules/.bin/portless; exit 0; fi`,
      `exec ${process.execPath} "$@"`,
    ].join("\n"),
    claude: [
      `echo "claude $*" >> ${log}`,
      `if [ "$1 $2" = "auth status" ]; then [ -e ${state}/claude-login ] && echo '{"loggedIn": true}' || echo '{"loggedIn": false}'; exit 0; fi`,
      claudeReadsWithBun
        ? `if [ "$1 $2" = "auth login" ]; then exec ${process.execPath} ${reader}; fi`
        : `if [ "$1 $2" = "auth login" ]; then read -r answer; echo "claude auth login read $answer" >> ${log}; touch ${state}/claude-login; fi`,
    ].join("\n"),
    "claude-codex": `echo "claude-codex $*" >> ${log}`,
    curl: [
      `echo "curl $*" >> ${log}`,
      "for url; do :; done",
      'case "$url" in',
      `  https://bun.sh/install) ${fail.includes("bun") ? "exit 22" : `echo 'echo "bun installer $*" >> ${log}; mkdir -p "$HOME/.bun/bin" && cp ${store}/bun "$HOME/.bun/bin/bun"'`} ;;`,
      `  https://claude.ai/install.sh) ${fail.includes("claude") ? "exit 22" : `echo 'mkdir -p "$HOME/.local/bin" && cp ${store}/claude "$HOME/.local/bin/claude"'`} ;;`,
      `  https://raw.githubusercontent.com/fcakyon/claude-code-with-codex/main/scripts/install.sh) ${fail.includes("claude-codex") ? "exit 22" : `echo 'mkdir -p "$HOME/.local/bin" && cp ${store}/claude-codex "$HOME/.local/bin/claude-codex"'`} ;;`,
      `  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) ${fail.includes("brew") ? "exit 22" : `echo 'read -r answer; echo "homebrew installer read $answer" >> ${log}; mkdir -p ${prefix}/bin && cp ${store}/brew ${prefix}/bin/brew'`} ;;`,
      "  *) exit 22 ;;",
      "esac",
    ].join("\n"),
    docker: "exit 0",
    gh: [
      `echo "gh $*" >> ${log}`,
      `if [ "$1 $2" = "auth status" ]; then [ -e ${state}/gh-login ]; exit; fi`,
      `if [ "$1 $2" = "auth login" ]; then read -r answer; echo "gh auth login read $answer" >> ${log}; touch ${state}/gh-login; exit 0; fi`,
      `if [ "$1 $2" = "repo clone" ]; then dir=$4; shift 4; [ "$1" = -- ] && shift; exec ${realGit} clone ${source} "$dir" "$@"; fi`,
      ...(ghUser
        ? [
            `if [ "$1 $2" = "api user" ]; then echo ${ghUser}; exit 0; fi`,
            `if [ "$1 $2" = "repo view" ]; then exit ${repoExists ? 0 : 1}; fi`,
          ]
        : []),
      "exit 1",
    ].join("\n"),
    git: `exec ${realGit} "$@"`,
    node: `[ "$1" = --version ] && echo v24.0.0\nexit 0`,
    open: `echo "open $*" >> ${log}`,
    // the service install writes its plist, as portless's own does under /Library/LaunchDaemons, and starts the proxy
    portless: `echo "portless $*" >> ${log}\n[ "$1 $2" = "service install" ] && : > ${plist} && : > ${up}\nexit 0`,
    python3: "exit 0",
    sudo: [
      `echo "sudo $*" >> ${log}`,
      'echo "Password:"',
      sudoFails ? 'echo "sudo: 1 incorrect password attempt" >&2; exit 1' : 'exec "$@"',
    ].join("\n"),
    uv: "exit 0",
  }
  for (const [name, body] of Object.entries(fakes))
    write(join(store, name), `#!/bin/sh\n${body}\n`, 0o755)
  for (const tool of [
    "bun",
    "claude",
    "claude-codex",
    "curl",
    "docker",
    "gh",
    "git",
    "node",
    "open",
    "python3",
    "sudo",
    "uv",
  ] as const)
    if (!missing.includes(tool as Tool)) cpSync(join(store, tool), join(bin, tool))
  if (!missing.includes("brew")) cpSync(join(store, "brew"), join(prefix, "bin/brew"))
  if (oldBun)
    write(
      join(bin, "bun"),
      [
        "#!/bin/sh",
        `[ "$1" = --version ] && { echo ${oldBun}; exit 0; }`,
        `if [ "$1" = install ]; then echo "old bun $*" >> ${log}; echo "error: Unknown lockfile version" >&2; exit 1; fi`,
        `exec ${process.execPath} "$@"`,
      ].join("\n"),
      0o755,
    )

  // with no gh login, git's own https clone of the repo lands on the source
  write(
    join(home, ".gitconfig"),
    `[url "${source}"]\n\tinsteadOf = https://github.com/${REPO}.git\n`,
  )
  const dir = join(home, "playground")
  const runEnv = (env: Record<string, string>) => ({
    ...gitEnv(home),
    INSTALL_BREW_PREFIXES: prefix,
    INSTALL_OS: "Darwin",
    INSTALL_PORTLESS_PLIST: plist,
    INSTALL_PROXY_UP: up,
    INSTALL_TTY: tty ? ttyFile : "",
    PATH: `${bin}:${sys}`,
    SHELL: "/bin/zsh",
    ...env,
  })
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "")
  // install.sh as `curl … | bash` runs it in a terminal: read from a pipe, in a terminal of its own that /dev/tty names
  const runPiped = async () => {
    let out = ""
    const proc = Bun.spawn(["/bin/bash", "-c", `cat '${join(source, "install.sh")}' | /bin/bash`], {
      cwd: box,
      env: runEnv({ INSTALL_TTY: "/dev/tty" }),
      terminal: { cols: 200, data: (_, chunk) => void (out += chunk.toString()), rows: 50 },
    })
    const code = await proc.exited
    return { calls: calls(), code, out }
  }
  const run = ({
    args = [],
    env = {},
  }: { args?: readonly string[]; env?: Record<string, string> } = {}) => {
    const proc = Bun.spawnSync(["/bin/bash", join(source, "install.sh"), ...args], {
      cwd: box,
      env: runEnv(env),
      stdin: "ignore",
    })
    const out = `${proc.stdout}${proc.stderr}`
    return {
      calls: calls(),
      code: proc.exitCode,
      // the "Left for you" items, one per line
      left: out.includes("Left for you:")
        ? out
            .slice(out.indexOf("Left for you:"))
            .split("\n")
            .slice(1)
            .filter((line) => line.startsWith("  - "))
            .map((line) => line.slice(4))
        : [],
      out,
    }
  }
  const rc = (name = ".zshrc") =>
    existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8") : null
  return { bin, box, dir, home, plist, prefix, rc, run, runPiped, source, up }
}

// Every path under the folder, with its link target or its content, so two snapshots differ when anything changed; git's own files are left to the HEAD and status checks.
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (path: string) => {
    const stat = lstatSync(path)
    const key = relative(dir, path) || "."
    if (key.endsWith(".git")) return
    if (stat.isSymbolicLink()) out[key] = `-> ${readlinkSync(path)}`
    else if (stat.isDirectory()) {
      out[key] = "dir"
      for (const name of readdirSync(path)) walk(join(path, name))
    } else out[key] = `${stat.mode} ${Bun.hash(readFileSync(path))}`
  }
  walk(dir)
  return out
}

// bun's own cache, written by any bun run, not by the installer
const bunCache = (path: string) => /^(\.bun\/install|\.cache|Library)(\/|$)/.test(path)
// What the installer itself wrote under HOME
const written = (home: string) =>
  Object.fromEntries(Object.entries(snapshot(home)).filter(([path]) => !bunCache(path)))

const ALL: Tool[] = [
  "brew",
  "bun",
  "claude",
  "claude-codex",
  "docker",
  "gh",
  "git",
  "node",
  "python3",
  "uv",
]
const BREW_LINE = (prefix: string) => `eval "$(${prefix}/bin/brew shellenv)"`
const PATH_LINE = (dir: string) => `export PATH="${dir}:$PATH"`
const count = (text: string, line: string) => text.split("\n").filter((l) => l === line).length

describe("install.sh", () => {
  test("on a machine with every tool and sign-in it installs into a sandboxed HOME, links the command, says it is ready and starts playground", () => {
    const { dir, home, run, source } = setup()
    const { calls, code, left, out } = run()
    expect(code).toBe(0)
    expect(out).toContain("Playground is ready.")
    expect(left).toEqual([])
    expect(out).toEndWith("playground started\n")
    expect(calls).not.toMatch(/^(brew install|curl )/m)
    expect(git(dir, home, "rev-parse", "HEAD").stdout.toString()).toBe(
      git(source, home, "rev-parse", "HEAD").stdout.toString(),
    )
    expect(calls).toContain(`gh repo clone ${REPO}`)
    expect(out.split("\n")).toContain("playground ext init")
    expect(calls).toContain("bun install --frozen-lockfile")
    expect(calls).toContain("turbo run build --filter=./packages/*")
    const orgs = join(home, ".playground/orgs")
    expect(calls).toContain(`claude plugin marketplace add ${orgs}`)
    expect(calls).toContain("claude plugin install ws-home@ws --scope user")
    const { plugins } = JSON.parse(
      readFileSync(join(orgs, ".claude-plugin/marketplace.json"), "utf8"),
    )
    expect(readdirSync(join(orgs, plugins[0].source, "skills"))).toEqual(["fake-skill"])
    expect(() => lstatSync(join(home, ".claude/skills"))).toThrow()
    expect(readlinkSync(join(home, ".bun/bin/playground"))).toBe(
      join(realpathSync(dir), "packages/scripts/src/playground/cli.ts"),
    )
  }, 60_000)

  test("names every place outside its folder before it writes, and writes nowhere else", () => {
    const { home, plist, run } = setup()
    const { out } = run()
    const places = [".bun/bin", ".playground"]
    for (const place of places)
      expect(out.indexOf(join(home, place))).toBeLessThan(out.indexOf("linked "))
    expect(out.indexOf("Claude Code's user settings")).toBeLessThan(out.indexOf("linked "))
    expect(out).toContain("Every ops job starts off but the Dashboard's own and the usage read")
    expect(out).toContain(`${plist}  portless's proxy service`)
    expect(out.indexOf(plist)).toBeLessThan(out.indexOf("linked "))
    const outside = Object.keys(snapshot(home)).filter(
      (path) =>
        path !== "." &&
        path !== ".gitconfig" &&
        path !== ".zshrc" &&
        !bunCache(path) &&
        !path.startsWith("playground") &&
        ![".claude", ".bun"].includes(path) &&
        !places.some((place) => path === place || path.startsWith(`${place}/`)),
    )
    expect(outside).toEqual([])
  }, 60_000)

  test("a second run changes nothing", () => {
    const { dir, home, run } = setup()
    expect(run().code).toBe(0)
    const first = snapshot(home)
    const head = git(dir, home, "rev-parse", "HEAD").stdout.toString()
    expect(run().code).toBe(0)
    expect(snapshot(home)).toEqual(first)
    expect(git(dir, home, "rev-parse", "HEAD").stdout.toString()).toBe(head)
    expect(git(dir, home, "status", "--porcelain").stdout.toString()).toBe("")
  }, 60_000)

  test("with no gh login and no terminal it clones over https and leaves the sign-in on the list", () => {
    const { dir, run } = setup({ ghLogin: false })
    const { calls, left, out } = run()
    expect(calls).not.toContain("repo clone")
    expect(calls).not.toContain("gh auth login")
    expect(out.split("\n")).not.toContain("playground ext init")
    expect(left.some((item) => item.startsWith("GitHub sign-in: gh auth login"))).toBe(true)
    expect(readFileSync(join(dir, "install.sh"), "utf8")).toContain("Installs Playground")
  }, 60_000)

  describe("with no private repo yet, ext init makes one only on a yes", () => {
    const REPO = "made-up-me/playground-made-up-me"

    test("with no terminal to ask on, it makes none and lists the command to run", () => {
      const { calls, code, left, out } = setup({ ghUser: "made-up-me" }).run()
      expect(code).toBe(0)
      expect(left).toContain(
        `${REPO} is not made, since there is no terminal to ask on: run playground ext init in a terminal to make it`,
      )
      expect(out).not.toMatch(/^playground ext init/m)
      expect(calls).not.toContain("gh repo create")
    }, 60_000)

    test("a y typed on the terminal runs ext init --yes, after naming the repo", () => {
      const { code, out } = setup({ answer: "y", ghUser: "made-up-me", tty: true }).run()
      expect(code).toBe(0)
      expect(out).toContain(`Make ${REPO} on GitHub, private, to back up your settings? [y/N]`)
      expect(out).toMatch(/\[y\/N\] playground ext init --yes$/m)
    }, 60_000)

    test("any other answer makes none and lists it", () => {
      const { left, out } = setup({ answer: "", ghUser: "made-up-me", tty: true }).run()
      expect(left).toContain(
        `${REPO} is not made: run playground ext init when you want your settings backed up`,
      )
      expect(out).not.toMatch(/^playground ext init/m)
    }, 60_000)

    test("a repo already there is reused with no question", () => {
      const { out } = setup({
        answer: "n",
        ghUser: "made-up-me",
        repoExists: true,
        tty: true,
      }).run()
      expect(out).not.toContain("[y/N]")
      expect(out.split("\n")).toContain("playground ext init")
    }, 60_000)
  })

  test("installs every missing tool in one run, with no prompt, and is ready at its end", () => {
    const { run } = setup({ claudeLogin: false, ghLogin: false, missing: ALL, tty: true })
    const { calls, code, left, out } = run()
    expect(out).not.toMatch(/\[Y\/n\]/i)
    for (const call of [
      "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh",
      "brew install git",
      "brew install node",
      "brew install gh",
      "brew install python",
      "brew install uv",
      "curl -fsSL https://bun.sh/install",
      "curl -fsSL https://claude.ai/install.sh",
      "curl -fsSL https://raw.githubusercontent.com/fcakyon/claude-code-with-codex/main/scripts/install.sh",
      "brew install --cask docker",
    ])
      expect(calls).toContain(call)
    expect(left).toEqual([])
    expect(out).toContain("Playground is ready.")
    expect(code).toBe(0)
    expect(out).toEndWith("playground started\n")
  }, 60_000)

  test("a failed install goes on the list and the run carries on to the next tool and the build", () => {
    const { run } = setup({ fail: ["python3", "docker"], missing: ["docker", "python3", "uv"] })
    const { calls, code, left, out } = run()
    expect(left).toContain("python3: brew install python")
    expect(left.some((item) => /docker/i.test(item))).toBe(true)
    expect(calls.indexOf("brew install uv")).toBeGreaterThan(calls.indexOf("brew install python"))
    expect(calls).toContain("brew install --cask docker")
    expect(calls).toContain("turbo run build --filter=./packages/*")
    expect(out).toContain("Then run: playground")
    expect(code).toBe(1)
  }, 60_000)

  test("with a terminal it offers Homebrew's installer, Docker's first open, gh auth login and Claude's sign-in in place", () => {
    const { calls, left } = setup({
      claudeLogin: false,
      dockerOnPath: false,
      ghLogin: false,
      missing: ["brew", "docker", "uv"],
      tty: true,
    }).run()
    expect(calls).toContain("homebrew installer read from-tty")
    expect(calls).toContain("brew install uv")
    expect(calls).toContain("open -a Docker")
    expect(calls).toContain("gh auth login read from-tty")
    expect(calls).toContain("claude auth login read from-tty")
    expect(left.some((item) => item.startsWith("Docker Desktop: finish its first start"))).toBe(
      true,
    )
    expect(left.some((item) => item.startsWith("GitHub sign-in"))).toBe(false)
    expect(left.some((item) => item.startsWith("Claude sign-in"))).toBe(false)
  }, 60_000)

  // macOS's kqueue refuses /dev/tty itself, so Claude Code, a Bun program, stopped with "EINVAL: invalid argument, kqueue" when given it; Linux reads /dev/tty either way.
  test("run as curl | bash in a terminal, Claude's sign-in reads that terminal as a Bun program can", async () => {
    const { runPiped } = setup({ claudeLogin: false, claudeReadsWithBun: true })
    const { calls } = await runPiped()
    expect(calls).toContain("claude auth login stdin ok")
    expect(calls).not.toContain("kqueue")
  }, 60_000)

  test("without a terminal it skips each in-place step and lists it with the command that does it", () => {
    const { calls, left } = setup({
      claudeLogin: false,
      ghLogin: false,
      missing: ["brew", "docker", "uv"],
    }).run()
    expect(calls).not.toContain("Homebrew/install")
    expect(calls).not.toContain("open ")
    expect(calls).not.toContain("auth login")
    expect(left.some((item) => item.startsWith("Homebrew: run "))).toBe(true)
    expect(left).toContain("uv: brew install uv")
    expect(left.some((item) => /docker/i.test(item))).toBe(true)
    expect(left.some((item) => item.startsWith("GitHub sign-in: gh auth login"))).toBe(true)
    expect(left).toContain("Claude sign-in: claude auth login")
  }, 60_000)

  test("a gh this run installs gets its sign-in: listed with no terminal, offered with one", () => {
    const listed = setup({ ghLogin: false, missing: ["gh"] }).run()
    expect(listed.calls).toContain("brew install gh")
    expect(listed.calls).not.toContain("auth login")
    expect(listed.left.some((item) => item.startsWith("GitHub sign-in: gh auth login"))).toBe(true)
    const offered = setup({ ghLogin: false, missing: ["gh"], tty: true }).run()
    expect(offered.calls).toContain("gh auth login read from-tty")
    expect(offered.left.some((item) => item.startsWith("GitHub sign-in"))).toBe(false)
  }, 60_000)

  test("a gh install that fails lists both the install and the sign-in after it", () => {
    const { left } = setup({ fail: ["gh"], ghLogin: false, missing: ["gh"], tty: true }).run()
    expect(left).toContain("gh: brew install gh")
    expect(left.some((item) => item.startsWith("GitHub sign-in: gh auth login"))).toBe(true)
  }, 60_000)

  test("a doctor row it has no installer for, such as herdr, which herdr-pin.ts installs, stays off the list", () => {
    const { calls, left } = setup({
      doctorRows: [
        {
          detail: "fix: playground herdr pin (the sessions' terminal)",
          name: "herdr",
          status: "MISSING",
        },
      ],
    }).run()
    expect(calls).toContain("herdr-pin ")
    expect(left.filter((item) => item.startsWith("herdr"))).toEqual([])
  }, 60_000)

  test("with no Homebrew and no terminal it cannot get git and node, so it stops before the clone", () => {
    const { dir, run } = setup({ missing: ["brew", "git", "node"] })
    const { calls, code, left, out } = run()
    expect(code).toBe(1)
    expect(out).toContain(
      "Playground needs git, bun and node before it can clone; nothing else was changed.",
    )
    expect(left).toContain("git: brew install git")
    expect(left).toContain("node: brew install node")
    expect(calls).not.toContain("repo clone")
    expect(() => lstatSync(dir)).toThrow()
  }, 60_000)

  test("with no claude after its installer it stops before any link is written", () => {
    const { home, run } = setup({ fail: ["claude"], missing: ["claude"] })
    const { calls, code, left, out } = run()
    expect(code).toBe(1)
    expect(out).toContain(
      "Playground needs claude before it can link its skills, so it stops here.",
    )
    expect(left).toContain("claude: install Claude Code: https://claude.com/claude-code")
    expect(calls).not.toContain("bun install")
    expect(() => lstatSync(join(home, ".claude/skills"))).toThrow()
  }, 60_000)

  for (const [name, check] of [
    ["--check", { args: ["--check"] }],
    ["PLAYGROUND_INSTALL=0", { env: { PLAYGROUND_INSTALL: "0" } }],
  ] as const) {
    test(`${name} before the clone lists what is missing, installs and writes nothing, and exits 1`, () => {
      const { dir, home, run } = setup({ missing: ["brew", "bun", "node"], tty: true })
      const before = written(home)
      const { calls, code, left } = run(check)
      expect(code).toBe(1)
      expect(left).toContain("node: brew install node")
      expect(left.some((item) => item.startsWith("bun: "))).toBe(true)
      expect(calls).not.toMatch(
        /^(brew install|curl |homebrew installer|gh auth login|claude auth login)/m,
      )
      expect(() => lstatSync(dir)).toThrow()
      expect(written(home)).toEqual(before)
    }, 60_000)

    test(`${name} over a checkout lists a missing tool, the herdr check and the sign-in, and installs nothing`, () => {
      const { bin, home, run } = setup()
      const installed = run()
      expect(installed.code).toBe(0)
      rmSync(join(bin, "docker"))
      rmSync(join(bin, "uv"))
      const before = written(home)
      const { calls, code, left } = run(check)
      const checked = calls.slice(installed.calls.length).split("\n")
      expect(code).toBe(1)
      expect(left).toContain("docker: install Docker Desktop")
      expect(left).toContain("uv: brew install uv")
      expect(checked.find((line) => line.startsWith("herdr-pin "))).toEndWith(" --check")
      expect(
        checked.some((line) => /^(brew install|curl |open |turbo |bun install)/.test(line)),
      ).toBe(false)
      expect(written(home)).toEqual(before)
    }, 60_000)
  }

  test("a tool missing from the first pass goes on the list once, though doctor's rows name it too", () => {
    const { bin, run } = setup()
    expect(run().code).toBe(0)
    rmSync(join(bin, "node"))
    const { left } = run({ args: ["--check"] })
    expect(left.filter((item) => item.startsWith("node: "))).toEqual(["node: brew install node"])
  }, 60_000)

  test("an older bun first on PATH gets package.json's version from bun's installer into ~/.bun, and every later step runs that one", () => {
    const { bin, rc, run } = setup({ oldBun: "1.3.14" })
    const { calls, code, out } = run()
    expect(calls).toContain(`bun installer bun-v${WANTED_BUN}`)
    expect(calls).toContain("bun install --frozen-lockfile")
    expect(calls).not.toContain("old bun")
    expect(out).not.toContain(`${bin}/bun is 1.3.14`)
    expect(rc()).toContain(".bun/bin")
    expect(out).toContain("playground started")
    expect(code).toBe(0)
  })

  test("an older bun ahead of ~/.bun/bin on the login PATH gets a startup line, last and once, that puts ~/.bun/bin first in a new terminal", () => {
    const { bin, home, rc, run } = setup({ oldBun: "1.3.14" })
    const env = { PATH: `${bin}:${join(home, ".bun/bin")}:${sys}` }
    const line = `export PATH="${home}/.bun/bin:$PATH" # Playground: bun ${WANTED_BUN} ahead of ${bin}/bun`
    expect(run({ env }).code).toBe(0)
    expect(rc()?.trimEnd().endsWith(line)).toBe(true)
    expect(run({ env }).code).toBe(0)
    expect(rc()?.split("# Playground: bun").length).toBe(2)
  })

  test("a bun at package.json's version takes no upgrade", () => {
    const { calls, code } = setup().run()
    expect(calls).not.toContain("bun.sh/install")
    expect(calls).toContain("bun install --frozen-lockfile")
    expect(code).toBe(0)
  })

  test("--check names an older bun with the command that upgrades it, and installs nothing", () => {
    const { bin, box, dir, home, run, source } = setup({ oldBun: "1.3.14" })
    git(box, home, "clone", "-q", source, dir)
    const { calls, code, left } = run({ args: ["--check"] })
    expect(left).toContain(
      `bun: ${bin}/bun is 1.3.14, older than ${WANTED_BUN}, which Playground's lockfile needs; run curl -fsSL https://bun.sh/install | bash -s bun-v${WANTED_BUN}`,
    )
    expect(calls).not.toContain("bun.sh/install")
    expect(code).toBe(1)
  })

  test("clones main whatever the repo's default branch is, through gh or over https", () => {
    for (const ghLogin of [true, false]) {
      const { dir, home, run, source } = setup({ ghLogin })
      git(source, home, "checkout", "-q", "-b", "canary")
      const { code } = run()
      expect(git(dir, home, "branch", "--show-current").stdout.toString().trim()).toBe("main")
      expect(code).toBe(0)
    }
  })

  test("a re-run moves a clean checkout left on canary to main at origin/main, and refuses one with uncommitted changes", () => {
    const { dir, home, run, source } = setup()
    expect(run().code).toBe(0)
    git(dir, home, "checkout", "-q", "-b", "canary")
    write(join(dir, "canary.txt"), "canary\n")
    git(dir, home, "add", "canary.txt")
    git(dir, home, "commit", "-q", "-m", "canary")
    write(join(source, "README.md"), "two\n")
    git(source, home, "add", "README.md")
    git(source, home, "commit", "-q", "-m", "two")
    const main = git(source, home, "rev-parse", "HEAD").stdout.toString().trim()
    const head = git(dir, home, "rev-parse", "HEAD").stdout.toString().trim()
    const at = () => [
      git(dir, home, "branch", "--show-current").stdout.toString().trim(),
      git(dir, home, "rev-parse", "HEAD").stdout.toString().trim(),
    ]

    write(join(dir, "install.sh"), "mine\n")
    const dirty = run()
    expect(dirty.out).toContain(`Playground in ${dir} is on canary with uncommitted changes`)
    expect(at()).toEqual(["canary", head])
    expect(dirty.code).toBe(1)

    git(dir, home, "checkout", "-q", "--", "install.sh")
    const clean = run()
    expect(clean.out).toContain(
      `Playground in ${dir} was on canary, so it moves to main at origin/main.`,
    )
    expect(at()).toEqual(["main", main])
    expect(clean.code).toBe(0)
  }, 90_000)

  test("--check on a ready machine says it is ready and exits 0", () => {
    const { run } = setup()
    expect(run().code).toBe(0)
    const { code, left, out } = run({ args: ["--check"] })
    expect(left).toEqual([])
    expect(out).toContain("Playground is ready.")
    expect(code).toBe(0)
  }, 60_000)

  test("Homebrew's folders follow the user's own PATH, so a tool the user put first stays the one that runs", () => {
    const { prefix, run } = setup()
    write(
      join(prefix, "bin/gh"),
      `#!/bin/sh\necho "homebrew gh $*" >> ${join(prefix, "../calls.log")}\nexit 1\n`,
      0o755,
    )
    const { calls, code } = run()
    expect(code).toBe(0)
    expect(calls).toContain(`gh repo clone ${REPO}`)
    expect(calls).not.toContain("homebrew gh")
  }, 60_000)

  test("each PATH line lands in ~/.zshrc once after two runs, and the end says how to load it", () => {
    const { home, prefix, rc, run } = setup({ missing: ["brew", "bun", "claude", "uv"], tty: true })
    const first = run()
    expect(first.out).toContain(`Then open a new terminal, or run: source ${join(home, ".zshrc")}`)
    expect(run().code).toBe(0)
    const zshrc = rc()!
    for (const line of [
      BREW_LINE(prefix),
      PATH_LINE(join(home, ".bun/bin")),
      PATH_LINE(join(home, ".local/bin")),
    ])
      expect(count(zshrc, line)).toBe(1)
  }, 60_000)

  test("a bash login shell gets the lines in ~/.bashrc, and another shell gets them on the list", () => {
    const bash = setup({ missing: ["bun"] })
    bash.run({ env: { SHELL: "/bin/bash" } })
    expect(count(bash.rc(".bashrc") ?? "", PATH_LINE(join(bash.home, ".bun/bin")))).toBe(1)
    expect(bash.rc()).toBeNull()

    const fish = setup({ missing: ["bun"] })
    const { left, out } = fish.run({ env: { SHELL: "/usr/local/bin/fish" } })
    expect(fish.rc()).toBeNull()
    expect(fish.rc(".bashrc")).toBeNull()
    const item = left.find((line) =>
      line.startsWith("your shell: add these lines to its startup file: "),
    )
    expect(item).toContain(PATH_LINE(join(fish.home, ".bun/bin")))
    expect(out).toContain("Then open a new terminal.")
  }, 60_000)

  test("installs the pinned herdr through herdr-pin.ts in the checkout, and a failure goes on the list", () => {
    const { dir, run } = setup()
    expect(run().calls.split("\n")).toContain(
      `herdr-pin ${join(realpathSync(dir), "packages/scripts/src/playground/herdr-pin.ts")}`,
    )

    const { calls: failed, left } = setup({
      herdr: { code: 1, stderr: "herdr 0.5.0 is not the pinned 0.6.1" },
    }).run()
    expect(left).toContain("herdr: herdr 0.5.0 is not the pinned 0.6.1")
    expect(failed).toContain("turbo run build --filter=./packages/*")
  }, 60_000)

  describe("portless's proxy service, which serves the Dashboard's local address", () => {
    const sudos = (calls: string) => calls.split("\n").filter((line) => line.startsWith("sudo "))
    const NONE = { answers: false, plist: false }

    test("with none and a terminal, it says why, asks for the Mac's password once through sudo, installs the service and starts playground", () => {
      const { dir, plist, run } = setup({ proxy: NONE, tty: true })
      const { calls, code, left, out } = run()
      expect(code).toBe(0)
      expect(left).toEqual([])
      const asked = sudos(calls)
      expect(asked).toHaveLength(1)
      expect(asked[0]).toStartWith("sudo env PATH=")
      expect(asked[0]).toEndWith(`${join(dir, "node_modules/.bin/portless")} service install`)
      expect(out.indexOf("sudo asks for it once now")).toBeGreaterThan(-1)
      expect(out.indexOf("sudo asks for it once now")).toBeLessThan(out.indexOf("Password:"))
      expect(calls).not.toContain("portless trust")
      expect(existsSync(plist)).toBe(true)
      expect(out).toEndWith("playground started\n")
    }, 60_000)

    test("a second run, with the service in place, asks for no password and runs no portless", () => {
      const { run } = setup({ proxy: NONE, tty: true })
      const first = run()
      expect(first.code).toBe(0)
      const again = run()
      const later = again.calls.slice(first.calls.length)
      expect(again.code).toBe(0)
      expect(sudos(later)).toEqual([])
      expect(later).not.toMatch(/^portless /m)
      expect(again.out).not.toContain("sudo asks for it once now")
    }, 60_000)

    test("when sudo is refused it says so, lists running install.sh again, and does not start playground", () => {
      const { dir, plist, run } = setup({ proxy: NONE, sudoFails: true, tty: true })
      const { code, left, out } = run()
      expect(code).toBe(1)
      expect(existsSync(plist)).toBe(false)
      expect(left.some((item) => item.includes(`bash ${join(dir, "install.sh")}`))).toBe(true)
      expect(out).toContain("not set up")
      expect(out).not.toContain("playground started")
    }, 60_000)

    test("with no terminal it asks nothing, lists it and does not start playground", () => {
      const { dir, run } = setup({ proxy: NONE })
      const { calls, code, left, out } = run()
      expect(code).toBe(1)
      expect(sudos(calls)).toEqual([])
      expect(left.some((item) => item.includes(`bash ${join(dir, "install.sh")}`))).toBe(true)
      expect(out).not.toContain("playground started")
    }, 60_000)

    test("--check lists a proxy that stopped answering and runs no sudo", () => {
      const { run, up } = setup({ proxy: NONE, tty: true })
      const first = run()
      expect(first.code).toBe(0)
      rmSync(up)
      const { calls, code, left } = run({ args: ["--check"] })
      expect(code).toBe(1)
      expect(sudos(calls.slice(first.calls.length))).toEqual([])
      expect(left.some((item) => item.startsWith("the Dashboard's local address: "))).toBe(true)
    }, 60_000)

    test("a service whose start failed, its plist in place with nothing answering, is installed again", () => {
      const { run } = setup({ proxy: { answers: false, plist: true }, tty: true })
      const { calls, code, out } = run()
      expect(code).toBe(0)
      expect(sudos(calls)).toHaveLength(1)
      expect(out).toEndWith("playground started\n")
    }, 60_000)

    test("a proxy already up, on 443 with no plist, on 1355 or on another port of 1024 or above, asks for no password, even with no terminal", () => {
      for (const proxy of [
        { answers: true, plist: false },
        { answers: true, plist: false, port: "1355" },
        { answers: false, plist: false, port: "8443" },
      ]) {
        const { calls, code, left, out } = setup({ proxy }).run()
        expect(code).toBe(0)
        expect(sudos(calls)).toEqual([])
        expect(left).toEqual([])
        expect(out).toEndWith("playground started\n")
      }
    }, 120_000)

    // the stack's own rule, proxyDown: a saved 1355 that answers nothing reads as 443 down, so playground doctor's fix, running the installer again, sets it up
    test("a saved 1355 that answers nothing is installed on 443", () => {
      const { run } = setup({ proxy: { answers: false, plist: false, port: "1355" }, tty: true })
      const { calls, code, out } = run()
      expect(code).toBe(0)
      expect(sudos(calls)).toHaveLength(1)
      expect(out).toEndWith("playground started\n")
    }, 60_000)

    test("off a Mac it is skipped: no password, no list item, no plist named, and playground starts", () => {
      const { calls, code, left, out } = setup({ proxy: NONE, tty: true }).run({
        env: { INSTALL_OS: "Linux" },
      })
      expect(code).toBe(0)
      expect(sudos(calls)).toEqual([])
      expect(left).toEqual([])
      expect(out).not.toContain("portless's proxy service")
      expect(out).toEndWith("playground started\n")
    }, 60_000)
  })

  // A run outside the sandbox would reach the real Homebrew under /opt/homebrew or /usr/local, so this reads where the script takes the stand-ins rather than running it there.
  test("reads its INSTALL_* stand-ins only under TEST_SANDBOX_HOME", () => {
    const script = readFileSync(join(root, "install.sh"), "utf8")
    const guard = script.match(
      /^if \[ -n "\$\{TEST_SANDBOX_HOME:-\}" \]; then\n([\s\S]*?)^(elif|else|fi)\b/m,
    )
    expect(guard).not.toBeNull()
    for (const name of [
      "INSTALL_TTY",
      "INSTALL_BREW_PREFIXES",
      "INSTALL_OS",
      "INSTALL_PORTLESS_PLIST",
      "INSTALL_PROXY_UP",
    ]) {
      expect(guard![1]).toContain(name)
      expect(script.replace(guard![1], "")).not.toContain(name)
    }
  })
})
