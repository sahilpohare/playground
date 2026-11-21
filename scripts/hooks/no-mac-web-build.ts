// PreToolUse hook: refuses a web image build on the Mac while the live dashboard's Postgres runs in the same Docker VM, since a tester's web build on 21 Oct took the VM past its memory and its out-of-memory killer took every Postgres in it, the dashboard's included.
import { join } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import {
  DOCKERS,
  type DockerBuild,
  dockerBuild,
  portlessCompose,
  positionals,
  COMPOSE_SERVICE_TAKES,
} from "./docker-build"
import { input } from "./input"
import { fromFactory } from "./role"
import {
  type Env,
  knownVariables,
  lex,
  marked,
  PRINTERS,
  program,
  run,
  type Visit,
  type Word,
} from "./shell"

// docker inspect is killed past this, inside the guards hook's 13 s deadline, so its own reason comes first, and a Docker VM wedged by memory is the case this hook is for; a second later the read gives up even on pipes the killed process left open.
export const INSPECT_TIMEOUT_MS = 8_000
const WEB_DOCKERFILE = "web/next/Dockerfile"
const API_HERE = "The api image still builds here (docker compose build api)."
const BOX_ROUTE = `Build the web image on the box instead: commit, then from the checkout run bash ~/.playground/ops/runner-host/ci.sh web HEAD, which builds HEAD's tree there and never on the Mac. ${API_HERE}`
const NO_HOST_ROUTE = `No runner host is set (RUNNER_HOST, or the data folder's ops/runner-host/ip), so there is no box to build it on, and the live dashboard's Postgres stays up: set one up (a peer machine of your own user, by scripts/ops/README.md's runner-host section, then write its address to that ip file), or build the web image on a machine with no live dashboard running. ${API_HERE}`

// Whether a runner host is set, read as ci.sh's IP= line and its address check read it: RUNNER_HOST, else the data folder's ops/runner-host/ip with its trailing newlines stripped as $(cat) strips them, holding an IPv4 address.
async function hasRunnerHost(environment: Record<string, string | undefined>): Promise<boolean> {
  const ip =
    environment.RUNNER_HOST ||
    (
      await Bun.file(join(dataDirOf(environment), "ops", "runner-host", "ip"))
        .text()
        .catch(() => "")
    ).replace(/\n+$/, "")
  return /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)
}

// compose build, or a compose up, create or run that builds web's missing image (every one without --no-build, since docker-compose.yml names no image), when it names no service, web among them, or a service the hook cannot read; run's first word is its one service.
function composeBuild({ rest, sub }: DockerBuild): string | undefined {
  const words = positionals(rest, COMPOSE_SERVICE_TAKES)
  const services = sub === "run" ? words.slice(0, 1) : words
  if (services.length === 0 || services.some((s) => s.value === "web" || marked(s.value)))
    return `docker compose ${sub} of the web image`
}

// The Dockerfile -f or --file names, attached or as the next word.
function dockerfile(args: Word[]): Word | undefined {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "-f" || v === "--file") return args[k + 1]
    const attached = /^(?:-f|--file=)(.+)$/.exec(v)?.[1]
    if (attached) return { ...args[k], value: attached }
  }
}

// docker build, buildx build, builder build or image build with web's Dockerfile, or one the hook cannot read.
function imageBuild(args: Word[]): string | undefined {
  const file = dockerfile(args)
  if (!file) return
  const path = file.value.replace(/^\.\//, "")
  if (marked(path) || path === WEB_DOCKERFILE || path.endsWith(`/${WEB_DOCKERFILE}`))
    return `docker build -f ${WEB_DOCKERFILE}`
}

// What web image build a docker or docker-compose call runs, if any.
function webBuild(args: Word[], compose: boolean): string | undefined {
  const build = dockerBuild(args, compose)
  if (build?.kind === "compose") return composeBuild(build)
  if (build?.kind === "image") return imageBuild(build.rest)
}

// The live dashboard's Postgres, as the dashboard supervisor last wrote its name to dashboard-db: a reason to refuse when it runs or when the hook cannot tell, undefined when the named container is stopped or gone.
async function dashboardRuns(
  what: string,
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  const route = async () => ((await hasRunnerHost(environment)) ? BOX_ROUTE : NO_HOST_ROUTE)
  const cannot = async (why: string) =>
    `no-mac-web-build hook refuses ${what}: ${why}, so it cannot tell whether the live dashboard's Postgres runs in this Mac's Docker VM, where a web image build's memory takes the VM's out-of-memory killer to the dashboard's database. ${await route()}`
  let name: string
  try {
    name = (
      await Bun.file(join(dataDirOf(environment), "ops", "dashboard", "dashboard-db")).text()
    ).trim()
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return cannot("there is no dashboard-db in the dashboard supervisor's state folder")
    return cannot(`dashboard-db could not be read (${error})`)
  }
  if (!name)
    return cannot(
      "dashboard-db names no container, which the supervisor writes both when the dashboard has none and when its lookup failed",
    )
  const docker = Bun.which("docker", { PATH: environment.PATH ?? "" })
  if (!docker) return cannot("there is no docker on PATH to ask")
  const p = Bun.spawn([docker, "inspect", "-f", "{{.State.Running}}", name], {
    env: { HOME: environment.HOME, PATH: environment.PATH },
    stderr: "pipe",
    stdout: "pipe",
    timeout: INSPECT_TIMEOUT_MS,
  })
  const answer = await Promise.race([
    Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]),
    new Promise<undefined>((done) =>
      setTimeout(() => done(undefined), INSPECT_TIMEOUT_MS + 1000).unref(),
    ),
  ])
  if (!answer || p.signalCode)
    return cannot(`docker inspect ${name} gave no answer in ${INSPECT_TIMEOUT_MS / 1000}s`)
  const [out, err, code] = answer
  if (code === 0 && out.trim() === "false") return
  if (code !== 0 && /no such (?:object|container)/i.test(err)) return
  if (code === 0 && out.trim() === "true")
    return `no-mac-web-build hook refuses ${what}: the live dashboard's Postgres (${name}) runs in this Mac's Docker VM, and a web image build peaks past the VM's memory, so its out-of-memory killer takes the dashboard's database. ${await route()}`
  return cannot(
    `docker inspect ${name} answered ${(err || out).trim().slice(0, 200) || `exit ${code}`}`,
  )
}

const visit: Visit = async (_cmd, { args, first, name }, env) => {
  const judge = async (words: Word[], compose: boolean) => {
    const what = webBuild(words, compose)
    return what ? dashboardRuns(what, env.process) : undefined
  }
  if (DOCKERS.has(name)) return judge(args, name === "docker-compose")
  const compose = portlessCompose(name, args)
  if (compose) return judge(compose, true)
  if (first && (first.unknown || marked(first.value)) && webBuild(args, false))
    return judge(args, false)
  if (PRINTERS.has(name) || name === "ssh") return
  const nested = args.findIndex(
    (a, j) =>
      DOCKERS.has(program(a.value)) &&
      webBuild(args.slice(j + 1), program(a.value) === "docker-compose"),
  )
  if (nested !== -1)
    return judge(args.slice(nested + 1), program(args[nested].value) === "docker-compose")
}

const BARE = (command: string) => command.replace(/[\\'"]/g, "")

// A build or compose named anywhere, since compose up, create and run build a missing image too.
const BUILDS = /build|compose/

// The cheap first look: quotes gone so bu'ild still counts; $'...' can spell any word, so it always counts.
const candidate = (command: string): boolean => command.includes("$'") || BUILDS.test(BARE(command))

const buildCall = (command: string): boolean =>
  /\bdocker/i.test(BARE(command)) && BUILDS.test(BARE(command))

async function inspect(raw: string, environment: Record<string, string | undefined>) {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (typeof payload !== "object" || payload === null)
    return buildCall(raw)
      ? "no-mac-web-build hook could not parse its input, which reads as a docker build, so it refuses the call."
      : undefined
  const { cwd, tool_input: toolInput, tool_name: tool } = payload as Record<string, unknown>
  if (tool !== "Bash") return
  const command = (toolInput as { command?: unknown } | null)?.command
  if (typeof command !== "string" || !candidate(command)) return
  const directory = typeof cwd === "string" ? cwd : undefined
  const env: Env = {
    cwd: directory,
    files: new Map(),
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map(),
  }
  return run(lex(command, env.known), env, visit)
}

// Fails closed only on a call that reads as a docker build: an error on any other call lets it run, so a parser bug cannot block every Bash command.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    return await inspect(raw, environment)
  } catch (error) {
    let command = raw
    try {
      const parsed = JSON.parse(raw) as { tool_input?: { command?: unknown } }
      if (typeof parsed.tool_input?.command === "string") command = parsed.tool_input.command
    } catch {}
    if (!buildCall(command)) return
    return `no-mac-web-build hook could not read this call (${error}), which reads as a docker build, so it refuses it. Split it into plain commands and run them again.`
  }
}

if (import.meta.main) {
  const raw = await input("no-mac-web-build", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
