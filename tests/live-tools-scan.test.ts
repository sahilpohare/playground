import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const RULE =
  "a test reaches a tool that changes the live machine only through the sandbox's fake or a stub of its own first on PATH (packages/scripts/src/sandbox.ts), so it names the tool bare, never by an absolute path, portless's CLI path, a package runner, a proxy or service verb in an argv, or inside a shell string, each of which gets past the fake"

const TOOL = "(?:herdr|launchctl|loginctl|systemctl)"

const VERB = String.raw`(?:proxy["'\`,\s]+(?:start|stop)|service["'\`,\s]+install|clean)`

// Each way past the PATH fakes: an absolute path to a tool; portless's own CLI or bin path, whatever its line's verb, since a const carries it to a later spawn; a package runner, which takes the checkout's node_modules/.bin before PATH; a proxy or service verb in an argv, whose program may be an imported CLI path; and a tool named inside a shell's -c string.
const RULES: [string, RegExp][] = [
  [
    "an absolute path to a live tool",
    new RegExp(`(?:^|[\\s"'\`(=])/(?:usr/(?:local/)?|opt/homebrew/)?s?bin/${TOOL}\\b`),
  ],
  ["portless's CLI or bin path", /portless\/dist\/cli\.js|\.bin\/portless\b/],
  [
    "a package runner running portless with a proxy, service or clean verb",
    new RegExp(
      String.raw`\b(?:bunx|npx|bun["'\`,\s]+x)["'\`,\s]+(?:-y["'\`,\s]+)?portless\b.*\b${VERB}\b`,
    ),
  ],
  [
    "a proxy start or stop or a service install in an argv",
    /["'`]proxy["'`]\s*,\s*["'`](?:start|stop)["'`]|["'`]service["'`]\s*,\s*["'`]install["'`]/,
  ],
  [
    "a live tool inside a shell's -c string",
    new RegExp(
      `\\b(?:ba|z)?sh["'\`]?(?:\\s*,\\s*["'\`]|\\s+)-l?c["'\`]?(?:\\s*,\\s*|\\s+)["'\`][^"'\`\\n]*\\b(?:${TOOL}|portless\\s+(?:proxy|service))\\b`,
    ),
  ],
]

// Each line kept on purpose: file, then the line trimmed, then why
const KEPT: Record<string, Record<string, string>> = {
  "tests/api/hono/src/lib/dev/proxy.test.ts": {
    'expect(setup).toContain("`sudo node_modules/.bin/portless service install`")':
      "the setup note's text, never a spawn",
  },
  "tests/api/hono/src/lib/onboard/fix.test.ts": {
    'const cli = join(import.meta.dir, "../../../../../../node_modules/portless/dist/cli.js")':
      "the expected argv the stubbed osascript and pkexec record, never a spawn",
  },
  "tests/install.test.ts": {
    "`  printf '#!/bin/sh\\\\necho \"turbo $*\" >> ${log}\\\\n' > node_modules/.bin/turbo; chmod +x node_modules/.bin/turbo; cp ${store}/portless node_modules/.bin/portless; exit 0; fi`,":
      "the fake bun's install copies the test's own stub portless into its scratch clone",
    'expect(asked[0]).toEndWith(`${join(dir, "node_modules/.bin/portless")} service install`)':
      "the command the stubbed admin prompt records, never a spawn",
  },
  "tests/packages/scripts/src/health-beat/running.test.ts": {
    '"  4100  4000 node /x/node_modules/.bin/portless --script dev:app",':
      "a ps row the health beat parses, never a spawn",
  },
  "tests/packages/scripts/src/ops-herdr/herdr.test.ts": {
    'path: "/opt/homebrew/bin/herdr",': "a made-up herdr found on PATH, never spawned",
    'expect(pinProblem(PIN, null)).toContain("/opt/homebrew/bin/herdr")':
      "the pin problem's text, never a spawn",
    "throw new Error(\"ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/herdr'\")":
      "a fake spawn's thrown error, never a spawn",
  },
  "tests/packages/scripts/src/ops-tick/orphans.test.ts": {
    "`bun ${gone}/node_modules/portless/dist/cli.js proxy start --foreground -p 1355 --skip-trust`,":
      "a ps row the orphan reader parses, never a spawn",
    "row(731, 1, `${gone}/node_modules/.bin/portless proxy start -p 1355`),":
      "a ps row the orphan reader parses, never a spawn",
  },
  "tests/packages/scripts/src/playground/doctor.test.ts": {
    'expect(herdrCheck(path, SUM, "0.9.5", "/opt/homebrew/bin/herdr").detail).toBe(':
      "a made-up herdr on PATH that doctor names, never spawned",
    "`0.9.5 pinned at ${path}; your own herdr at /opt/homebrew/bin/herdr is left alone`,":
      "doctor's text, never a spawn",
  },
}

// Each place whose rows are text fed to a checker, never a spawn: the hooks' tests feed each command to a guard (fixtures-are-data.test.ts), and test_kill_by_name.py feeds each row to its own problems_in
const DATA = ["tests/scripts/hooks/", "tests/test_kill_by_name.py"]

// Pure: each line of text that breaks a rule, with the rule's name
const liveToolHits = (text: string) =>
  text.split("\n").flatMap((line, i) =>
    RULES.filter(([, rule]) => rule.test(line)).map(([name]) => ({
      line: i + 1,
      name,
      text: line.trim(),
    })),
  )

test("the scan catches each way past the PATH fakes, and leaves a bare tool and a fake's body alone", () => {
  const fed = [
    'Bun.spawnSync(["/usr/bin/systemctl", "--user", "stop", "a.service"])',
    "run(['/bin/launchctl', 'bootout', 'gui/501'])",
    'Bun.spawnSync(["/usr/local/bin/herdr", "pane", "close", "w1:p2"])',
    'run([join(repo, "node_modules/portless/dist/cli.js"), "proxy", "stop", "-p", "443"])',
    'run([`${repo}/node_modules/.bin/portless`, "service", "install"])',
    'Bun.spawnSync(["sh", "-c", "systemctl --user stop a.service"])',
    'Bun.spawnSync(["bash", "-lc", "loginctl enable-linger 1000"])',
    "execSync(`sh -c 'portless service install'`)",
    'const cli = join(ROOT, "node_modules/portless/dist/cli.js")',
    'Bun.spawnSync([cli, "proxy", "stop", "-p", "1355"], { env })',
    'Bun.spawnSync(["bunx", "portless", "proxy", "stop", "-p", "1355"], { env })',
    "execSync(`npx -y portless clean`)",
    "subprocess.run(['bun', 'x', 'portless', 'proxy', 'start', '-p', '1355'])",
  ]
  const path = "portless's CLI or bin path"
  const runner = "a package runner running portless with a proxy, service or clean verb"
  const argv = "a proxy start or stop or a service install in an argv"
  expect(fed.map((line) => liveToolHits(line).map((hit) => hit.name))).toEqual([
    ["an absolute path to a live tool"],
    ["an absolute path to a live tool"],
    ["an absolute path to a live tool"],
    [path, argv],
    [path, argv],
    ["a live tool inside a shell's -c string"],
    ["a live tool inside a shell's -c string"],
    ["a live tool inside a shell's -c string"],
    [path],
    [argv],
    [runner, argv],
    [runner],
    [runner, argv],
  ])
  for (const line of [
    'Bun.spawnSync(["systemctl", "--user", "is-active", "a.service"], { env })',
    'writeFileSync(join(bin, "systemctl"), "#!/bin/sh\\necho \\"$*\\" >> said\\nexit 1\\n")',
    'Bun.spawnSync(["bunx", "portless", "get", "playground"], { env })',
  ])
    expect(liveToolHits(line)).toEqual([])
})

test("no test reaches a live tool past the sandbox's fakes", async () => {
  const files = Bun.spawnSync(
    ["git", "-C", ROOT, "ls-files", ":(glob)tests/**/*.ts", ":(glob)tests/**/*.py"],
    {
      stdout: "pipe",
    },
  )
    .stdout.toString()
    .split("\n")
    .filter(
      (file) =>
        file &&
        file !== "tests/live-tools-scan.test.ts" &&
        !DATA.some((data) => file.startsWith(data)),
    )
  // without :(glob), tests/**/*.ts needs a folder under tests/ and skips every file directly in it
  expect(files).toContain("tests/install.test.ts")
  expect(files).toContain("tests/test_ops_jobs.py")
  const found: string[] = []
  for (const file of files)
    for (const hit of liveToolHits(readFileSync(join(ROOT, file), "utf8")))
      if (!KEPT[file]?.[hit.text]) found.push(`${file}:${hit.line}: ${hit.name}: ${hit.text}`)
  expect(found, RULE).toEqual([])
})
