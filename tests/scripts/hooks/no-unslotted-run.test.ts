import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-unslotted-run"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-unslotted-run.ts")
// real directories, since the reader follows a cd only into one that exists
const MAIN = mkdtempSync(join(tmpdir(), "no-unslotted-run-main-"))
const WORKTREE = `${MAIN}/.claude/worktrees/a`
const LEADS = `${MAIN}/.claude/worktrees/leads`
const OUTSIDE = mkdtempSync(join(tmpdir(), "no-unslotted-run-outside-"))
mkdirSync(join(WORKTREE, "api", "hono"), { recursive: true })
mkdirSync(LEADS, { recursive: true })
afterAll(() => {
  rmSync(MAIN, { force: true, recursive: true })
  rmSync(OUTSIDE, { force: true, recursive: true })
})

const SLOT = "~/.playground/ops/run-slot.sh worker-x --"

const bash = (command: string, cwd = WORKTREE) =>
  check(
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    { HOME: "/u" },
    MAIN,
  )

describe("a heavy run in a worktree outside run-slot is refused, naming the run-slot form", () => {
  test.each([
    ["bun install", "bun install"],
    ["bun install with its flags", "bun install --ignore-scripts"],
    ["bun i", "bun i"],
    ["a node_modules clone into it", `cp -cR ${LEADS}/node_modules ${WORKTREE}/`],
    ["a node_modules clone with a trailing slash", `cp -R ${LEADS}/node_modules/ ./`],
    ["a node_modules clone by --recursive", `cp --recursive ${LEADS}/node_modules .`],
    ["bun run build", "bun run build"],
    ["bun run check-types", "bun run check-types"],
    ["bun run test", "bun run test"],
    ["bun run test behind nice's -<number>", "nice -10 bun run test"],
    ["bun run test behind nice -n with its value in a variable", "nice -n $N bun run test"],
    ["bun run test behind a timeout option it does not know", "timeout -Q 5 bun run test"],
    ["check-types by its bare name", "bun check-types"],
    ["the whole suite through bun test", "bun test"],
    ["the whole suite through bun run test:file", "bun run test:file"],
    ["bun test with a flag and its value only", "bun test --timeout 20000"],
    ["bun test with --max-concurrency and its value only", "bun test --max-concurrency 2"],
    ["bun test with --seed and its value only", "bun test --seed 2"],
    ["bun test with --shard and its value only", "bun test --shard 1/2"],
    ["bun test with --retry and its value only", "bun test --retry 1"],
    ["bun test with --coverage-reporter and its value only", "bun test --coverage-reporter lcov"],
    [
      "bun test with --path-ignore-patterns and its value only",
      "bun test --path-ignore-patterns x",
    ],
    ["bun test with --parallel-delay and its value only", "bun test --parallel-delay 0"],
    ["bun test with --timings and its value only", "bun test --timings t.json"],
    ["bun test with --reporter and its value only", "bun test --reporter dots"],
    ["bun test with --reporter-outfile and its value only", "bun test --reporter-outfile o.xml"],
    ["bun test with --rerun-each and its value only", "bun test --rerun-each 2"],
    ["bun test with --coverage-dir and its value only", "bun test --coverage-dir c"],
    ["bun test with --preload and its value only", "bun test --preload ./p.ts"],
    ["bun test with -t and its value only", "bun test -t name"],
    ["bun test with --test-name-pattern and its value only", "bun test --test-name-pattern name"],
    ["bun test with --env-file and its value only", "bun test --env-file .env"],
    ["bun test with -r and its value only", "bun test -r ./p.ts"],
    ["bun test with --require and its value only", "bun test --require ./p.ts"],
    ["bun test with --tsconfig-override and its value only", "bun test --tsconfig-override t.json"],
    ["bun test with --define and its value only", "bun test --define A:1"],
    ["next build", "next build"],
    ["next build through bunx -p", "bunx -p next next build"],
    ["next build through bunx --bun", "bunx --bun next build"],
    ["next build through bunx", "bunx next build"],
    ["next build through bun x", "bun x next build"],
    ["turbo build by name (#2018)", "turbo run build"],
    ["the packages build by its path", "node_modules/.bin/turbo run build --filter=./packages/*"],
    ["turbo build by its absolute path", `${WORKTREE}/node_modules/.bin/turbo run build`],
    ["turbo build through bunx", "bunx turbo run build --filter=./packages/*"],
    ["turbo build through npx", "npx turbo run build"],
    ["turbo build through bun x", "bun x turbo run build"],
    ["turbo build through npx -y", "npx -y turbo run build"],
    ["turbo build through npx --yes", "npx --yes turbo run build"],
    ["turbo build through npx -p", "npx -p turbo turbo run build"],
    ["turbo build through bunx -p", "bunx -p turbo turbo run build"],
    ["turbo build by its versioned package through bunx", "bunx turbo@latest run build"],
    ["turbo build by its versioned package through npx", "npx turbo@2 run build"],
    ["turbo build by its versioned package through bun x", "bun x turbo@latest run build"],
    ["turbo build behind env", "env NODE_ENV=production SKIP_ENV_VALIDATION=true turbo run build"],
    ["turbo check-types", "turbo run check-types"],
    ["turbo test", "turbo run test"],
    ["turbo lint", "turbo run lint"],
    ["turbo's shorthand without run", "turbo build"],
    ["a heavy task among others", "turbo run format build"],
    ["inside a shell it starts", "bash -c 'bun run test'"],
    ["after other commands", "git status && bun run build"],
    ["after a run-slot run", `${SLOT} bun install && bun run test`],
    ["a cd within it", "cd api/hono && bun test"],
  ])("%s", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-unslotted-run hook refuses")
    expect(reason).toContain("~/.playground/ops/run-slot.sh <your name> -- ")
    expect(command.replaceAll("'", "")).toContain(reason?.split("<your name> -- ")[1] ?? "unset")
  })

  test("the fix keeps the command's assignments behind env and its quoting, and shows an unread value as a space", async () => {
    expect(await bash("NODE_ENV=test bun test -t 'a b'")).toEndWith(
      "-- env NODE_ENV=test bun test -t 'a b'",
    )
    expect(await bash("env SKIP_ENV_VALIDATION=true bun run test")).toEndWith(
      "-- env SKIP_ENV_VALIDATION=true bun run test",
    )
    expect(await bash("exec bun run test")).toEndWith("<your name> -- bun run test")
    expect(await bash('FOO="a b" bun run test')).toEndWith("-- env 'FOO=a b' bun run test")
    expect(
      await bash('NODE_ENV=production SKIP_ENV_VALIDATION="true" bun run check-types'),
    ).toEndWith("-- env NODE_ENV=production 'SKIP_ENV_VALIDATION=true' bun run check-types")
    const unread = await bash("bun test --timeout $NOPE")
    expect(unread).toContain("no-unslotted-run hook refuses")
    expect(unread).not.toContain("\u0000")
  })

  test("the fix starts in the folder an earlier cd moved to, so it runs where the hook judged it", async () => {
    for (const cwd of [MAIN, OUTSIDE]) {
      expect(await bash(`cd ${WORKTREE} && bun install`, cwd)).toEndWith(
        `Run it as cd ${WORKTREE} && ~/.playground/ops/run-slot.sh <your name> -- bun install`,
      )
    }
    expect(await bash("bun install")).toContain("Run it as ~/.playground/ops/run-slot.sh")
  })

  test.each([
    ["bun run's --cwd", `bun run --cwd ${WORKTREE} test`],
    ["bun's --cwd before run", `bun --cwd ${WORKTREE} run build`],
    ["bun's --cwd=", `bun --cwd=${WORKTREE} run check-types`],
    ["bun install's own --cwd", `bun install --ignore-scripts --cwd ${WORKTREE}`],
    ["bun test's own --cwd", `bun test --cwd ${WORKTREE}`],
    ["a cd into it", `cd ${WORKTREE} && bun run check-types`],
    ["a node_modules clone by its destination", `cp -cR ${LEADS}/node_modules ${WORKTREE}/`],
  ])("from anywhere, by %s", async (_name, command) => {
    for (const cwd of [MAIN, LEADS, OUTSIDE]) {
      expect(await bash(command, cwd)).toContain("no-unslotted-run hook refuses")
    }
  })
})

describe("a run through run-slot, a light run, or one outside the worktrees runs", () => {
  test.each([
    ["an install through run-slot", `${SLOT} bun install --ignore-scripts --cwd ${WORKTREE}`],
    ["a clone through run-slot", `${SLOT} cp -cR ${LEADS}/node_modules ${WORKTREE}/`],
    ["the suite through run-slot", `${SLOT} bun run test`],
    ["a package runner's -p turbo build through run-slot", `${SLOT} bunx -p turbo turbo run build`],
    ["bun x's -p turbo build through run-slot", `${SLOT} bun x -p turbo turbo run build`],
    ["a shell beside -p turbo through run-slot", `${SLOT} bunx -p turbo sh -c 'turbo run "build"'`],
    ["a shell beside -p next through run-slot", `${SLOT} npx -p next sh -c 'next build>log'`],
    [
      "a runner --cwd in a worktree through run-slot",
      `${SLOT} bun --cwd=${WORKTREE} x --cwd=. next build`,
    ],
    [
      "a runner --cwd the hook cannot read through run-slot",
      `${SLOT} bunx --cwd="$D" turbo run build`,
    ],
    [
      "check-types through run-slot with env in front",
      `NODE_ENV=production ${SLOT} env SKIP_ENV_VALIDATION=true bun run check-types`,
    ],
    ["a script through run-slot", `${SLOT} bash /tmp/bisect.sh`],
    ["run-slot by env", `env NODE_ENV=production ${SLOT} bun run build`],
    ["bun test on a file", "bun test tests/scripts/hooks/no-stash.test.ts"],
    ["bun test on a folder", "bun test tests/scripts/hooks"],
    ["bun run test:file on a folder", "bun run test:file tests/scripts/hooks"],
    ["bun test on a file after a value flag", "bun test --timeout 20000 tests/x.test.ts"],
    ["test:skills", "bun run test:skills"],
    ["bun test --help", "bun test --help"],
    ["bun install --help", "bun install --help"],
    ["bun install --dry-run", "bun install --dry-run"],
    ["bun's own bundler", "bun build ./x.ts --outdir /tmp/out"],
    ["a copy that is not node_modules", `cp -R ${LEADS}/docs ./docs`],
    ["a read of node_modules", "ls node_modules/.bin"],
    ["git", "git status --short"],
    ["turbo --help", "turbo --help"],
    ["turbo run build --help", "turbo run build --help"],
    ["turbo --version", "turbo --version"],
    ["turbo --version through npx -y", "npx -y turbo@latest --version"],
    ["turbo run build --dry-run", "turbo run build --dry-run"],
    ["turbo run build --dry-run=json", "turbo run build --dry-run=json"],
    ["a light turbo task", "turbo run format"],
    ["turbo build through run-slot", `${SLOT} turbo run build --filter='./packages/*'`],
  ])("%s", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test.each([
    ["in the main checkout", "bun run build", MAIN],
    ["an install in the main checkout", "bun install", MAIN],
    ["outside the repo", "bun run test", OUTSIDE],
    ["the worktrees folder itself", "bun install", `${MAIN}/.claude/worktrees`],
  ])("%s", async (_name, command, cwd) => {
    expect(await bash(command, cwd)).toBeUndefined()
  })

  test("a cd the hook cannot follow leaves the command alone", async () => {
    expect(await bash("cd $DIR && bun run build", OUTSIDE)).toBeUndefined()
  })

  // #573: a cd an && joins to what follows names the folder those commands run from, so the worktree line the Workflow rule types reaches the new worktree, where its install needs the slot that rule names
  test("the Workflow rule's worktree line runs with its install slotted", async () => {
    const command = `git fetch origin canary && git worktree add ${MAIN}/.claude/worktrees/new -b PG-1-x origin/canary && cd ${MAIN}/.claude/worktrees/new && ${SLOT} bun install`
    expect(await bash(command, MAIN)).toBeUndefined()
  })

  test("the same line with a bare install is refused, since its cd names a worktree", async () => {
    const command = `git fetch origin canary && git worktree add ${MAIN}/.claude/worktrees/new -b PG-1-x origin/canary && cd ${MAIN}/.claude/worktrees/new && bun install`
    expect(await bash(command, MAIN)).toContain("no-unslotted-run hook refuses")
  })
})

// #1083: a docker build fills the one Docker VM every folder shares, the live dashboard's Postgres among them, so it goes through run-slot from any folder.
describe("a docker build outside run-slot is refused from any folder, naming the run-slot form (#1083)", () => {
  test.each([
    ["docker build", "docker build ."],
    ["docker image build", "docker image build -t a ."],
    ["docker builder build", "docker builder build ."],
    ["docker buildx build", "docker buildx build ."],
    ["docker buildx b", "docker buildx b ."],
    ["docker buildx build past buildx's --builder", "docker buildx --builder x build ."],
    ["docker build past docker's --context", "docker --context desktop-linux build ."],
    ["docker build past docker's -c", "docker -c desktop-linux build ."],
    ["docker build past docker's -H", "docker -H unix:///var/run/docker.sock build ."],
    ["docker build past docker's --host", "docker --host unix:///x build ."],
    ["docker build past docker's --config", "docker --config /tmp/c build ."],
    ["docker build past docker's -l", "docker -l debug build ."],
    ["docker build past docker's --log-level", "docker --log-level debug build ."],
    ["docker build past docker's TLS files", "docker --tlscacert a --tlscert b --tlskey c build ."],
    ["docker build past docker's flags", "docker -D --tls --tlsverify build ."],
    ["docker build by its path", "/usr/local/bin/docker build ."],
    ["docker build behind env words", "env DOCKER_BUILDKIT=1 docker build ."],
    ["docker build inside bash -c", "bash -c 'docker build .'"],
    ["docker compose build", "docker compose build"],
    ["docker compose build of one service", "docker compose build api"],
    ["docker compose build --no-cache", "docker compose build --no-cache"],
    ["docker-compose build", "docker-compose build"],
    ["docker compose build past -f", "docker compose -f docker-compose.yml build"],
    ["docker compose build past --file", "docker compose --file a.yml build"],
    ["docker compose build past -p", "docker compose -p x build"],
    ["docker compose build past --project-name", "docker compose --project-name x build"],
    ["docker compose build past --project-directory", "docker compose --project-directory . build"],
    ["docker compose build past --profile", "docker compose --profile a build"],
    ["docker compose build past --env-file", "docker compose --env-file .env build"],
    ["docker compose build past --ansi", "docker compose --ansi never build"],
    ["docker compose build past --parallel", "docker compose --parallel 1 build"],
    ["docker compose build past --progress", "docker compose --progress plain build"],
    ["docker compose build past its flags", "docker compose --all-resources --compatibility build"],
    ["docker compose build past docker's own options", "docker --context x compose build"],
    [
      "docker-compose build past the docker CLI's --log-level",
      "docker-compose --log-level debug build web",
    ],
    ["docker-compose build past the docker CLI's -H", "docker-compose -H tcp://h build"],
    ["portless's compose build", "portless compose build"],
    [
      "portless's compose build through npx and a versioned portless",
      "npx -y portless@0.16.0 compose build web",
    ],
  ])("%s", async (_name, command) => {
    for (const cwd of [WORKTREE, OUTSIDE]) {
      const reason = await bash(command, cwd)
      expect(reason).toContain("no-unslotted-run hook refuses")
      expect(reason).toContain("from any folder")
      expect(reason).toContain("~/.playground/ops/run-slot.sh <your name> -- ")
    }
  })

  test.each([
    ["docker buildx bake", "docker buildx bake", "one run-slot run at a time"],
    [
      "docker bake, the docker CLI's alias for buildx bake",
      "docker bake",
      "one run-slot run at a time",
    ],
    ["docker bake of one target", "docker bake web", "one run-slot run at a time"],
    ["docker buildx f, bake's alias", "docker buildx f", "one run-slot run at a time"],
    [
      "docker builder bake, which builder forwards to buildx",
      "docker builder bake",
      "one run-slot run at a time",
    ],
    ["docker builder bake of one target", "docker builder bake web", "one run-slot run at a time"],
    ["docker builder f", "docker builder f", "one run-slot run at a time"],
    ["docker compose up --build", "docker compose up --build", "up --no-build"],
    ["docker compose up, which builds a missing image", "docker compose up -d", "up --no-build"],
    ["docker compose run --build", "docker compose run --build api", "up --no-build"],
    [
      "docker compose run whose command takes -h",
      "docker compose run --rm api df -h",
      "up --no-build",
    ],
    [
      "docker compose run whose command takes --help",
      "docker compose run api node --help",
      "up --no-build",
    ],
    [
      "docker compose run whose command holds --no-build",
      "docker compose run api echo --no-build",
      "up --no-build",
    ],
    ["docker compose create --build", "docker compose create --build", "up --no-build"],
    ["docker compose watch, which builds and rebuilds", "docker compose watch", "up --no-build"],
    [
      "docker compose watch --no-up, which still rebuilds",
      "docker compose watch --no-up",
      "up --no-build",
    ],
    ["docker compose alpha watch", "docker compose alpha watch", "up --no-build"],
    [
      "docker-compose up past the docker CLI's --context",
      "docker-compose --context x up -d",
      "up --no-build",
    ],
    ["portless's compose up through bunx", "bunx portless compose up -d", "up --no-build"],
    ["portless's compose up through bun x", "bun x portless compose up", "up --no-build"],
  ])(
    "%s, which builds its images at once, is refused with run-slot's own fix",
    async (_name, command, fix) => {
      for (const cwd of [WORKTREE, OUTSIDE]) {
        const reason = await bash(command, cwd)
        expect(reason).toContain("no-unslotted-run hook refuses")
        expect(reason).toContain("from any folder, which run-slot refuses too")
        expect(reason).toContain(fix)
      }
    },
  )

  test.each([
    ["docker --version", "docker --version"],
    ["docker -v", "docker -v"],
    ["docker version", "docker version"],
    ["docker build --help", "docker build --help"],
    ["docker buildx build -h", "docker buildx build -h"],
    ["docker buildx version", "docker buildx version"],
    ["docker compose build --help", "docker compose build --help"],
    ["docker compose version", "docker compose version"],
    ["docker bake --help", "docker bake --help"],
    ["docker builder f --help", "docker builder f --help"],
    ["docker compose watch --help", "docker compose watch --help"],
    ["docker compose up --no-build", "docker compose up --no-build -d"],
    [
      "docker compose run --no-build before its service",
      "docker compose run --no-build --rm api df -h",
    ],
    ["docker compose run --help", "docker compose run --help"],
    ["docker run", "docker run --rm alpine true"],
    ["portless get", "bunx portless get api"],
    ["portless's compose up --no-build", "bunx portless compose up --no-build -d"],
    ["docker compose build through run-slot", `${SLOT} docker compose build`],
    ["docker build through run-slot", `${SLOT} docker build .`],
  ])("%s runs", async (_name, command) => {
    for (const cwd of [WORKTREE, OUTSIDE]) expect(await bash(command, cwd)).toBeUndefined()
  })
})

describe("it fails open, and acts for a factory session alone", () => {
  test("on input it cannot read", async () => {
    expect(await check("{not json", {}, MAIN)).toBeUndefined()
  })

  test("on any tool but Bash", async () => {
    const raw = JSON.stringify({
      cwd: WORKTREE,
      tool_input: { file_path: "x" },
      tool_name: "Write",
    })
    expect(await check(raw, {}, MAIN)).toBeUndefined()
  })

  const own = (env: Record<string, string | undefined>) => {
    const worktree = join(root, ".claude", "worktrees", "a")
    const raw = JSON.stringify({
      cwd: worktree,
      tool_input: { command: `bun run --cwd ${worktree} test` },
      tool_name: "Bash",
    })
    return Bun.spawn(["bun", "--no-env-file", script], {
      env,
      stderr: "pipe",
      stdin: new Blob([raw]),
    })
  }

  test("as its own process, it refuses a factory session with exit 2", async () => {
    const proc = own({ ...process.env, PLAYGROUND_ROLE: "worker" })
    expect(await proc.exited).toBe(2)
    expect(await new Response(proc.stderr).text()).toContain("no-unslotted-run hook refuses")
  })

  test("as its own process, it passes a session outside the factory", async () => {
    const { PLAYGROUND_ROLE: _role, ...rest } = process.env
    const proc = own({ ...rest, CLAUDE_CONFIG_DIR: OUTSIDE })
    expect(await proc.exited).toBe(0)
  })

  test("as its own process, on input it cannot read", async () => {
    const proc = Bun.spawn(["bun", "--no-env-file", script], {
      env: { ...process.env, PLAYGROUND_ROLE: "worker" },
      stderr: "pipe",
      stdin: new Blob(["{not json"]),
    })
    expect(await proc.exited).toBe(0)
  })
})

// a checkout with commitlint and the repo's config, as a factory worktree has, where commit-msg would lint the message
const REPO = mkdtempSync(join(tmpdir(), "no-unslotted-run-repo-"))
Bun.spawnSync(["git", "init", "-q", REPO])
await Bun.write(
  join(REPO, "package.json"),
  JSON.stringify({ commitlint: { extends: ["@commitlint/config-conventional"] } }),
)
symlinkSync(join(root, "node_modules"), join(REPO, "node_modules"))
const BAD = "fix(scope): ABC keys leave core"
const GOOD = "fix(scope): keys leave core"
await Bun.write(join(REPO, "bad.txt"), `${BAD}\n`)
await Bun.write(join(REPO, "good.txt"), `${GOOD}\n`)
afterAll(() => rmSync(REPO, { force: true, recursive: true }))

// commitlint --edit asks git for the checkout's top, so the lint runs with the session's PATH
const commit = (command: string, cwd = REPO) =>
  check(
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    { HOME: "/u", PATH: process.env.PATH },
    MAIN,
  )

const forms = (subject: string, file: string): [string, string][] => [
  ["-m", `git commit -m "${subject}"`],
  ["--message=", `git commit --message="${subject}"`],
  ["-F with a path", `git commit -F ${file}`],
  ["-F with an absolute path", `git commit -F ${join(REPO, file)}`],
  ["-F - from a heredoc", `git commit -F - <<'EOF'\n${subject}\n\nbody line\nEOF`],
  [
    "-m from a heredoc substitution",
    `git commit -m "$(cat <<'EOF'\n${subject}\n\nbody line\nEOF\n)"`,
  ],
  ["several -m", `git commit -m "${subject}" -m "body line" -m "another line"`],
  ["git -C from another folder", `cd ${OUTSIDE} && git -C ${REPO} commit -m "${subject}"`],
  ["through run-slot", `${SLOT} git commit -m "${subject}"`],
  ["-F after a git add, which writes no file", `git add bad.txt good.txt && git commit -F ${file}`],
  ["-m from a file read by its own cat", `git commit -m "$(cat ${file})"`],
  ["-F after a cd", `cd ${REPO} && git commit -F ${file}`],
  ["-F after a builtin that writes no file", `set -e; git commit -F ${file}`],
  [
    "-F - from a heredoc after a command that may write a file",
    `touch x && git commit -F - <<'EOF'\n${subject}\nEOF`,
  ],
]

describe("a git commit whose message commitlint refuses is refused before its pre-commit slot wait", () => {
  test.each(forms(BAD, "bad.txt"))("%s", async (_, command) => {
    const reason = await commit(command)
    expect(reason).toContain("no-unslotted-run hook refuses this git commit")
    expect(reason).toContain("subject-case")
  })
})

describe("a git commit whose message commitlint passes, or one the hook cannot read, runs", () => {
  test.each([
    ...forms(GOOD, "good.txt"),
    ["a message from a variable", `git commit -m "$MSG"`],
    ["a message file the hook cannot name", `git commit -F "$FILE"`],
    ["an editor commit", "git commit"],
    ["a merge's own message", "git commit --no-edit"],
    ["--no-verify, which skips commit-msg too", `git commit --no-verify -m "${BAD}"`],
    ["-n, which skips commit-msg too", `git commit -n -m "${BAD}"`],
    ["--edit, whose editor changes the message", `git commit -e -m "${BAD}"`],
    ["a checkout with no commitlint", `git commit -m "${BAD}"`, OUTSIDE],
    ["a # line commit-msg reads as a comment", `git commit -m "${GOOD}" -m "# ${"x".repeat(120)}"`],
    ["-F a file a cp before it may rewrite", `cp good.txt m.txt && git commit -F bad.txt`],
    [
      "-F a file a program before it may rewrite",
      `python3 -c "open('bad.txt','w').write('fix: ok')" && git commit -F bad.txt`,
    ],
    [
      "-m from a file a cp before it may rewrite",
      `cp good.txt bad.txt; git commit -m "$(cat bad.txt)"`,
    ],
    ["-F after a script a shell runs", "sh gen.sh; git commit -F bad.txt"],
    ["-F after a script named by a variable", `bash "$S"; git commit -F bad.txt`],
    ["-F after a script a source reads", "source gen.sh; git commit -F bad.txt"],
  ] as [string, string, string?][])("%s", async (_, command, cwd = REPO) => {
    expect(await commit(command, cwd)).toBeUndefined()
  })
})

// a conventional header of the given length, as commitlint's header-max-length counts it
const header = (length: number) => {
  const head = "fix(scope): "
  return head + "a".repeat(length - head.length)
}

describe("a git commit -m whose header runs over commitlint's 100 characters is refused, naming the limit", () => {
  test.each([
    ["101 characters", `git commit -m "${header(101)}"`],
    ["101 characters over a short body", `git commit -m "${header(101)}" -m "body line"`],
  ])("%s", async (_, command) => {
    const reason = await commit(command)
    expect(reason).toContain("no-unslotted-run hook refuses this git commit")
    expect(reason).toContain("header-max-length")
    expect(reason).toContain("100")
  })
})

describe("a git commit whose header is 100 characters or fewer, or one the hook reads no header of, runs", () => {
  test.each([
    ["exactly 100 characters", `git commit -m "${header(100)}"`],
    ["99 characters", `git commit -m "${header(99)}"`],
    ["a -F message file", "git commit -F good.txt"],
    ["an editor commit", "git commit"],
    ["a multi-line -m whose first line is under the limit", `git commit -m "${GOOD}\n\nbody line"`],
  ])("%s", async (_, command) => {
    expect(await commit(command)).toBeUndefined()
  })
})
