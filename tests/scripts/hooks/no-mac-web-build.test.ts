import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check, INSPECT_TIMEOUT_MS } from "../../../scripts/hooks/no-mac-web-build"

const root = join(import.meta.dir, "..", "..", "..")
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A scratch config folder with the dashboard supervisor's dashboard-db (`missing`, `unreadable` or the text to write), a runner host (`ip`, the data folder's ip file's text, and `runnerHost`, RUNNER_HOST, each left out when unset) and a stub docker whose inspect answers as `answer` says, logging each call.
const dashboard = (
  answer: "error" | "gone" | "hung" | "running" | "stopped",
  db: string = "playground-dashboard-db",
  host: { ip?: string; runnerHost?: string } = { ip: "203.0.113.7\n" },
) => {
  const dir = mkdtempSync(join(tmpdir(), "no-mac-web-build-"))
  dirs.push(dir)
  const state = join(dir, "config", "playground", "ops", "dashboard")
  mkdirSync(state, { recursive: true })
  if (db === "unreadable") mkdirSync(join(state, "dashboard-db"))
  else if (db !== "missing") writeFileSync(join(state, "dashboard-db"), db === "" ? "" : `${db}\n`)
  const bin = join(dir, "bin")
  mkdirSync(bin)
  const reply = {
    error: 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1',
    gone: 'echo "Error: No such object: ${@: -1}" >&2; exit 1',
    hung: "sleep 20",
    running: "echo true",
    stopped: "echo false",
  }[answer]
  writeFileSync(join(bin, "docker"), `#!/bin/bash\necho "$*" >> "${dir}/calls"\n${reply}\n`)
  chmodSync(join(bin, "docker"), 0o755)
  const data = join(dir, "config", "playground")
  if (host.ip !== undefined) {
    mkdirSync(join(data, "ops", "runner-host"), { recursive: true })
    writeFileSync(join(data, "ops", "runner-host", "ip"), host.ip)
  }
  const environment = {
    CLAUDE_CONFIG_DIR: join(dir, "config"),
    PLAYGROUND_DATA_DIR: data,
    HOME: dir,
    PATH: `${bin}:/usr/bin:/bin`,
    ...(host.runnerHost === undefined ? {} : { RUNNER_HOST: host.runnerHost }),
  }
  const bash = (command: string) =>
    check(
      JSON.stringify({
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_input: { command },
        tool_name: "Bash",
      }),
      environment,
    )
  const calls = () =>
    existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : ""
  return { bash, calls }
}

describe("a web image build on the Mac is refused while the live dashboard's Postgres runs", () => {
  test.each([
    ["compose build with no service", "docker compose build"],
    ["compose build --no-cache", "docker compose build --no-cache"],
    ["compose build web", "docker compose build web"],
    ["docker in capitals", "DOCKER compose build web"],
    ["web among the services", "docker compose build --no-cache api web"],
    [
      "compose build past a project option, which names no service",
      "docker compose build --profile p",
    ],
    ["compose build past -f, which names no service", "docker compose build -f a.yml"],
    ["compose options before build", "docker compose -f docker-compose.yml -p x build web"],
    ["compose up --build", "docker compose up --build"],
    ["compose up, which builds a missing image", "docker compose up"],
    ["portless's compose up through bunx (#1083)", "bunx portless compose up -d"],
    ["compose up -d web", "docker compose up -d web"],
    ["compose create", "docker compose create"],
    ["compose run web", "docker compose run --rm -e X=1 web sh"],
    ["docker-compose", "docker-compose build web"],
    ["docker build -f", "docker build -f web/next/Dockerfile --secret id=dotenv,src=.env ."],
    ["docker build --file=./", "docker build --file=./web/next/Dockerfile ."],
    [
      "an absolute Dockerfile path",
      "docker build -f /x/dispatcher/web/next/Dockerfile /x/dispatcher",
    ],
    ["docker buildx build", "docker buildx build -f web/next/Dockerfile ."],
    ["docker image build", "docker image build -fweb/next/Dockerfile ."],
    ["after cd &&", "cd /tmp && docker compose build web"],
    ["through bash -c", "bash -c 'docker compose build web'"],
    ["through run-slot", "~/.playground/ops/run-slot.sh w -- docker compose build web"],
    ["through env", "env NODE_ENV=production docker compose build"],
    ["a service it cannot read", "docker compose build $SERVICE"],
    ["a Dockerfile it cannot read", "docker build -f $(cat which) ."],
  ])("%s", async (_, command) => {
    const { bash, calls } = dashboard("running")
    const reason = await bash(command)
    expect(reason).toContain("no-mac-web-build hook refuses")
    expect(reason).toContain("playground-dashboard-db")
    expect(reason).toContain("ci.sh web HEAD")
    expect(calls()).toBe("inspect -f {{.State.Running}} playground-dashboard-db\n")
  })
})

describe("every other build runs, and asks Docker nothing", () => {
  test.each([
    ["the api image alone", "docker compose build --no-cache api"],
    ["the api image alone past a project option", "docker compose build --progress plain api"],
    ["the api Dockerfile", "docker build -f api/hono/Dockerfile ."],
    ["a build sent to the box", "bash ~/.playground/ops/runner-host/ci.sh web HEAD"],
    ["a build over ssh", "ssh root@203.0.113.7 docker compose build web"],
    ["up with --no-build", "docker compose up -d --no-build web"],
    ["up of the api alone", "docker compose up -d api"],
    ["run of the api, web only in its command", "docker compose run --rm api echo web"],
    ["another docker call", "docker ps"],
    ["compose build's help", "docker compose build --help"],
    ["a printed command", "echo docker compose build web"],
    ["a commit message", "git commit -m 'docker compose build web'"],
  ])("%s", async (_, command) => {
    const { bash, calls } = dashboard("running")
    expect(await bash(command)).toBeUndefined()
    expect(calls()).toBe("")
  })
})

describe("with no runner host set, the dashboard's container decides, and a refusal names the routes that exist", () => {
  test.each([
    ["no RUNNER_HOST and no ip file, the container stopped", "stopped" as const, {}],
    ["no RUNNER_HOST and no ip file, the container gone", "gone" as const, {}],
    [
      "an ip file holding no address, the container stopped",
      "stopped" as const,
      { ip: "not-an-address\n" },
    ],
  ])("%s: the build runs", async (_, answer, host) => {
    const { bash, calls } = dashboard(answer, "playground-dashboard-db", host)
    expect(await bash("docker compose build web")).toBeUndefined()
    expect(calls()).toBe("inspect -f {{.State.Running}} playground-dashboard-db\n")
  })

  test.each([
    [
      "runs",
      "running" as const,
      "playground-dashboard-db",
      "the live dashboard's Postgres (playground-dashboard-db) runs in this Mac's Docker VM",
    ],
    ["is missing", "stopped" as const, "missing", "there is no dashboard-db"],
    ["is unreadable", "stopped" as const, "unreadable", "dashboard-db could not be read"],
    [
      "Docker cannot answer for",
      "error" as const,
      "playground-dashboard-db",
      "Cannot connect to the Docker daemon",
    ],
  ])("a dashboard Postgres that %s refuses, naming no ci.sh route", async (_, answer, db, why) => {
    const reason = await dashboard(answer, db, {}).bash("docker compose build web")
    expect(reason).toContain("no-mac-web-build hook refuses docker compose build of the web image")
    expect(reason).toContain(why)
    expect(reason).toContain(
      "No runner host is set (RUNNER_HOST, or the data folder's ops/runner-host/ip), so there is no box to build it on, and the live dashboard's Postgres stays up: set one up (scripts/ops/runner-host/host.sh setup <ip>, then write its address to that ip file), or build the web image on a machine with no live dashboard running.",
    )
    expect(reason).toContain("The api image still builds here (docker compose build api).")
    expect(reason).not.toContain("ci.sh")
  })

  test("a RUNNER_HOST ending in a newline is no host, as ci.sh reads it", async () => {
    const { bash } = dashboard("running", "playground-dashboard-db", {
      runnerHost: "203.0.113.7\n",
    })
    expect(await bash("docker compose build web")).toContain("No runner host is set")
  })

  test.each([
    ["the ip file holds an address", { ip: "203.0.113.7\n" }],
    ["RUNNER_HOST is set", { runnerHost: "203.0.113.7" }],
  ])("when %s, the refusal stays as it was", async (_, host) => {
    const { bash, calls } = dashboard("running", "playground-dashboard-db", host)
    expect(await bash("docker compose build web")).toBe(
      "no-mac-web-build hook refuses docker compose build of the web image: the live dashboard's Postgres (playground-dashboard-db) runs in this Mac's Docker VM, and a web image build peaks past the VM's memory, so its out-of-memory killer takes the dashboard's database. Build the web image on the box instead: commit, then from the checkout run bash ~/.playground/ops/runner-host/ci.sh web HEAD, which builds HEAD's tree there and never on the Mac. The api image still builds here (docker compose build api).",
    )
    expect(calls()).toBe("inspect -f {{.State.Running}} playground-dashboard-db\n")
  })
})

describe("the dashboard's container decides", () => {
  test.each([
    ["not running", "stopped" as const],
    ["gone", "gone" as const],
  ])("a web build runs when dashboard-db names a container that is %s", async (_, answer) => {
    expect(await dashboard(answer).bash("docker compose build web")).toBeUndefined()
  })

  test.each([
    ["missing", "running" as const, "missing", "no dashboard-db"],
    ["empty", "stopped" as const, "", "dashboard-db names no container"],
    ["unreadable", "stopped" as const, "unreadable", "dashboard-db could not be read"],
    [
      "named but Docker errs",
      "error" as const,
      "playground-dashboard-db",
      "Cannot connect to the Docker daemon",
    ],
  ])(
    "a dashboard-db that is %s refuses, since the hook cannot tell",
    async (_, answer, db, why) => {
      const reason = await dashboard(answer, db).bash("docker compose build web")
      expect(reason).toContain("no-mac-web-build hook refuses")
      expect(reason).toContain(why)
      expect(reason).toContain("ci.sh web HEAD")
    },
  )

  test("with no docker on PATH it refuses, since it cannot ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-mac-web-build-"))
    dirs.push(dir)
    mkdirSync(join(dir, "playground", "ops", "dashboard"), { recursive: true })
    writeFileSync(
      join(dir, "playground", "ops", "dashboard", "dashboard-db"),
      "playground-dashboard-db\n",
    )
    const raw = JSON.stringify({
      cwd: root,
      tool_input: { command: "docker compose build web" },
      tool_name: "Bash",
    })
    const reason = await check(raw, {
      CLAUDE_CONFIG_DIR: dir,
      PLAYGROUND_DATA_DIR: join(dir, "playground"),
      HOME: dir,
      PATH: join(dir, "none"),
      RUNNER_HOST: "203.0.113.7",
    })
    expect(reason).toContain("no docker on PATH")
  })

  // The timeout of guards, which runs the hook on Bash, in each settings file Claude Code reads, in ms.
  const registered = ["scripts/factory-settings.json", ".claude/settings.json"].map((settings) => {
    const { hooks } = JSON.parse(readFileSync(join(root, settings), "utf8")) as {
      hooks: { PreToolUse: { hooks: { command: string; timeout: number }[] }[] }
    }
    const timeout =
      hooks.PreToolUse.flatMap((e) => e.hooks).find((h) =>
        h.command.includes("scripts/hooks/bundled/guards.js"),
      )?.timeout ?? NaN
    return [settings, timeout * 1000] as const
  })

  test.each(registered)(
    "%s registers a timeout past the inspect's, with room to answer",
    (_, ms) => {
      expect(ms).toBeGreaterThan(INSPECT_TIMEOUT_MS + 4000)
    },
  )

  // The stub's sleep outlives the killed bash and holds its pipes, so this reaches the read's backstop too; a hook that waited on them would run past this test's time, the hook's registered timeout.
  test(
    "a Docker that never answers refuses inside the hook's registered timeout",
    async () => {
      const reason = await dashboard("hung").bash("docker compose build web")
      expect(reason).toContain(`gave no answer in ${INSPECT_TIMEOUT_MS / 1000}s`)
      expect(reason).toContain("ci.sh web HEAD")
    },
    Math.min(...registered.map(([, ms]) => ms)),
  )
})
