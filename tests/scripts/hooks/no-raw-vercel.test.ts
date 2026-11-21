import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-raw-vercel"

let scratch = ""

// Made-up sessions: the Ops lead, the Builder (a lead of another kind) and a worker, each placed by its registry name and the roster's kind.
type Session = "builder" | "ops" | "worker"
const ROLE: Record<Session, string> = { builder: "lead", ops: "lead", worker: "worker" }

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-raw-vercel-"))
  await mkdir(join(scratch, "config", "sessions"), { recursive: true })
  // the step's folder and the Yard CLI's, so a cd into either lands where it does in a checkout
  for (const dir of ["ship", "playground"])
    await mkdir(join(scratch, "packages", "scripts", "src", dir), { recursive: true })
  await Bun.write(
    join(scratch, "data", "roster.json"),
    JSON.stringify({
      agents: [
        { kind: "builder", name: "builder", status: "working" },
        { kind: "ops", name: "ops", status: "working" },
        { kind: "worker", name: "abc-worker", status: "working" },
      ],
    }),
  )
  for (const [session, name] of [
    ["s-builder", "builder"],
    ["s-ops", "ops"],
    ["s-worker", "abc-worker"],
  ])
    await Bun.write(
      join(scratch, "config", "sessions", `${session}.json`),
      JSON.stringify({ name, sessionId: session }),
    )
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const as = (session: Session, command: string) =>
  check(
    JSON.stringify({
      cwd: scratch,
      hook_event_name: "PreToolUse",
      session_id: `s-${session}`,
      tool_input: { command },
      tool_name: "Bash",
    }),
    {
      CLAUDE_CONFIG_DIR: join(scratch, "config"),
      PLAYGROUND_DATA_DIR: join(scratch, "data"),
      PLAYGROUND_ROLE: ROLE[session],
    },
  )

const REFUSED = "no-raw-vercel hook refuses"

// Each moves what production serves: a production deploy, a redeploy that keeps the original's environment, a promote, a rollback, an alias and a rolling release.
const PRODUCTION: [string, string][] = [
  ["a bare production deploy", "vercel --prod"],
  ["a production deploy", "vercel deploy --prod"],
  ["the vc name", "vc deploy --prod"],
  ["a capitalised program", "Vercel deploy --prod"],
  ["the environment as the next word", "vercel deploy --environment production"],
  ["the environment attached", "vercel deploy --environment=production"],
  ["the old target flag", "vercel deploy --target=production"],
  ["the target as the next word", "vercel --target production"],
  ["a path deploy", "vercel ./web --prod"],
  ["a prebuilt deploy", "vercel deploy --prebuilt --prod --yes"],
  ["a global option first", "vercel --cwd web deploy --prod"],
  ["a scope first", "vercel -S acme-labs deploy --prod"],
  ["an environment built at run time", 'vercel deploy --environment "$E"'],
  ["a redeploy into the original's environment", "vercel redeploy demo-abc.vercel.app"],
  ["a redeploy to production", "vercel redeploy demo-abc.vercel.app -e production"],
  ["a promote", "vercel promote demo-abc.vercel.app"],
  ["a rollback", "vercel rollback"],
  ["a rollback to a deployment", "vercel rollback demo-abc.vercel.app --yes"],
  ["an alias set", "vercel alias set demo-abc.vercel.app demo.example.com"],
  ["an alias by its default", "vercel alias demo-abc.vercel.app demo.example.com"],
  ["a bare alias", "vercel alias"],
  ["a rolling release start", "vercel rolling-release start --deployment=dpl_123"],
  ["a rolling release approve", "vercel rolling-release approve"],
  ["an alias set by ln", "vercel ln set demo-abc.vercel.app demo.example.com"],
  ["an alias by ln's default", "vercel ln demo-abc.vercel.app demo.example.com"],
  ["an alias set by aliases", "vercel aliases set demo-abc.vercel.app demo.example.com"],
  ["an alias by aliases' default", "vercel aliases demo-abc.vercel.app demo.example.com"],
  ["a rolling release start by rr", "vercel rr start --deployment=dpl_1"],
  ["a rolling release approve by rr", "vercel rr approve"],
  ["a promote after the team option", "vercel --team acme promote demo-abc.vercel.app"],
  ["a production deploy after deploy's force letter", "vercel deploy -f --prod"],
  ["a bare production deploy after the force letter", "vercel -f --prod"],
  ["a production target after the force letter", "vercel deploy -f --target production"],
  [
    "a production deploy after an option the hook does not know",
    "vercel deploy --made-up=x --prod",
  ],
  ["a manual deploy's continue", "vercel deploy continue --deployment dpl_madeup1"],
  ["a production manual deploy", "vercel deploy init --prod"],
  ["deploy's -e with no KEY=VALUE", "vercel deploy -e production"],
  ["deploy's -e attached", "vercel deploy -e=production"],
  ["deploy's -e naming production short", "vercel deploy -e prod"],
  ["a bare deploy's -e", "vercel -e production"],
]

// Each is no read the guard allows: it writes the project's secrets to disk, prints them or hands them to a command, or changes the project, its domains or its settings.
const OTHERS: [string, string][] = [
  ["a deployment remove", "vercel remove demo-abc.vercel.app --yes"],
  ["a deployment remove by rm", "vercel rm demo-abc.vercel.app"],
  ["a project remove", "vercel project rm demo"],
  ["a domain remove", "vercel domains rm demo.example.com"],
  ["a dns add", "vercel dns add example.com www A 192.0.2.1"],
  ["a dns remove", "vercel dns rm rec_123"],
  ["an env add", "vercel env add DEMO_KEY production"],
  ["an env remove", "vercel env rm DEMO_KEY production --yes"],
  ["an env update", "vercel env update DEMO_KEY production"],
  ["a redirects promote", "vercel redirects promote"],
  ["a redirects restore", "vercel redirects restore"],
  ["a firewall write", "vercel firewall rules add --name demo"],
  ["a flags write", "vercel flags create demo-flag"],
  ["a deploy hook create", "vercel deploy-hooks create demo main"],
  ["a made-up subcommand", "vercel frobnicate"],
  ["a team switch", "vercel teams switch acme"],
  ["an integration add that keeps the env off disk", "vercel integration add neon --no-env-pull"],
  ["an env pull", "vercel env pull"],
  ["an env pull of production", "vercel env pull .env.production --environment production"],
  ["a decrypted env list", "vercel env ls --json"],
  ["a decrypted env list by its long name", "vercel env list --json"],
  ["a pull", "vercel pull"],
  ["a pull of production", "vercel pull --environment=production"],
  ["an env run", "vercel env run -- printenv"],
  ["a link", "vercel link"],
  ["a link to a project", "vercel link --yes --project demo"],
  ["an integration add that pulls the env", "vercel integration add neon"],
  ["a subcommand built at run time", 'vercel "$CMD"'],
  ["an env subcommand built at run time", 'vercel env "$SUB"'],
  ["an api read of the env", "vercel api /v9/projects/demo/env"],
  ["an api read of the env decrypted", 'vercel api "/v9/projects/demo/env?decrypt=true"'],
  ["an api read of one env variable", "vercel api /v1/projects/demo/env/abc"],
  ["an api POST", "vercel api /v13/deployments -X POST -F name=demo"],
  ["an api method attached", "vercel api /v9/projects/demo --method=PATCH"],
  ["an api body, which POSTs", "vercel api /v10/projects -F name=demo"],
  ["an api string field", "vercel api /v10/projects -f name=demo"],
  ["an api input file", "vercel api /v9/projects/demo --input body.json"],
  ["an api method built at run time", 'vercel api /v2/user -X "$M"'],
  ["an api endpoint built at run time", 'vercel api "$P"'],
  ["an install, which adds an integration", "vercel install neon"],
  ["an install by its letter", "vercel i neon"],
  ["an integration install", "vercel integration install neon"],
  ["an env list in json format", "vercel env ls --format json"],
  ["an env list in json format attached", "vercel env ls --format=json"],
  ["an env list in json format by its letter", "vercel env ls -F json"],
  ["an env list in json format in capitals", "vercel env list --format JSON --project demo"],
  ["an env pull after the team letter", "vercel -T acme env pull"],
  ["a link after the api option", "vercel --api https://api.example.com link"],
  ["a build", "vercel build --yes"],
  ["a production build", "vercel build --prod --yes --project demo"],
  ["an api GET with a field", "vercel api /v2/user -X GET -F a=b"],
  ["an api GET with a string field", "vercel api /v2/user -X GET -f a=b"],
  ["an api GET with an input file", "vercel api /v2/user -X GET --input x"],
  ["a deploy describe", "vercel deploy describe --deployment dpl_madeup1"],
  ["a deploy subcommand the hook does not know", "vercel deploy madeupsub"],
  ["a word after an option of deploy's the hook does not know", "vercel deploy --made-up x --prod"],
  ["a word built at run time after deploy", 'vercel deploy "$WORD"'],
]

// The prefixes a call can come behind.
const PREFIXES: [string, string][] = [
  ["a cd", "cd web && vercel --prod"],
  ["an env wrapper", "env VERCEL_ORG_ID=team_x vercel --prod"],
  ["an assignment", "VERCEL_ORG_ID=team_x vercel env pull"],
  ["bun x", "bun x vercel --prod"],
  ["bunx at a version", "bunx vercel@latest deploy --prod"],
  ["npx", "npx vercel link"],
  ["a -c script", "bash -c 'vercel env pull'"],
  ["a pipe", "yes | vercel deploy --prod"],
  ["run-slot", "~/.playground/ops/run-slot.sh s-worker -- vercel deploy --prod"],
  ["xargs, whose words the hook cannot read", "echo --prod | xargs vercel"],
  ["a program in a variable on a line naming vercel", "V=vercel; $V --prod"],
]

describe("a factory session's Vercel call that moves production or reads its secrets is refused", () => {
  test.each([...PRODUCTION, ...OTHERS, ...PREFIXES])("for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toContain(REFUSED)
  })

  test.each(PRODUCTION)("for a lead that is not Ops: %s", async (_, command) => {
    expect(await as("builder", command)).toContain(REFUSED)
  })

  test.each([
    ["an env pull xargs feeds", "echo env pull | xargs vercel"],
    ["a link xargs feeds", "echo link | xargs vercel"],
    ["an env pull xargs feeds after a production flag", "echo env pull | xargs vercel --prod"],
    ["a subcommand in xargs' replace string", "echo env | xargs -I{} vercel {} pull"],
    ["a link in xargs' replace string", "echo link | xargs -I{} vercel {}"],
    ["a subcommand in a spaced replace string", "echo env | xargs -I % vercel % pull"],
    ["a subcommand in BSD xargs' -J string", "echo env | xargs -J % vercel % pull"],
    ["a production deploy xargs feeds", "echo demo | xargs vercel deploy --prod"],
  ])("for the Ops lead, words xargs feeds: %s", async (_, command) => {
    expect(await as("ops", command)).toContain(REFUSED)
  })

  test.each(OTHERS)("for the Ops lead too: %s", async (_, command) => {
    expect(await as("ops", command)).toContain(REFUSED)
  })

  test("the reason names Ops' ship as the route to production", async () => {
    expect(await as("worker", "vercel --prod")).toContain("ship:merge")
  })
})

// The call ship:yard makes for each hosted project, and Ops' hand form of it: one production deploy a project, its ids in the call's environment; the ids are made up.
const OPS_SHIP: [string, string][] = [
  [
    "with the project's ids as assignments",
    "VERCEL_ORG_ID=team_madeup1 VERCEL_PROJECT_ID=prj_madeup1 vercel deploy --prod --yes",
  ],
  [
    "with the project's ids through env",
    "env VERCEL_ORG_ID=team_madeup1 VERCEL_PROJECT_ID=prj_madeup2 vercel deploy --prod --yes",
  ],
]

describe("a runner's option the reader does not list hides no production deploy (PG-2103)", () => {
  test.each([
    ["npx past a user config option's value", "npx --userconfig /tmp/u vercel deploy --prod"],
    ["bun x past bun's own env file option", "bun --env-file /tmp/e x vercel deploy --prod"],
  ])("for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toContain(REFUSED)
  })

  test.each([
    ["npx -y's preview deploy", "npx -y vercel deploy"],
    ["npx -y's whoami", "npx -y vercel whoami"],
  ])("for a worker: %s runs", async (_, command) => {
    expect(await as("worker", command)).toBeUndefined()
  })
})

// 22 runners each started by the one before, each past three unlisted options' values, so the readings pass their cap once six levels nest
const DEEP = Array.from({ length: 22 }, (_, i) => `npx --a${i} a --b${i} b --c${i} c`).join(" ")

describe("a runner started by a runner hides no production deploy (PG-2163)", () => {
  const nested: [string, string][] = [
    ["npx started by npx", "npx npx vercel deploy --prod"],
    ["npx started by bunx", "bunx npx vercel deploy --prod"],
    ["bunx started by npx", "npx bunx vercel deploy --prod"],
    [
      "npx started by npx past an unlisted option's value",
      "npx --userconfig /tmp/u npx vercel deploy --prod",
    ],
    ["npx started by bun x", "bun x npx vercel deploy --prod"],
    ["bun x started by npx", "npx bun x vercel deploy --prod"],
    ["bunx started by bunx, by vc", "bunx bunx vc --prod"],
    ["npx's -c line, npx started by bunx", 'bunx npx -c "vercel deploy --prod"'],
    ["npx's -c line, npx started by bun x", 'bun x npx -c "vercel deploy --prod"'],
    ["npx's spaced --call line, npx started by bunx", 'bunx npx --call "vercel deploy --prod"'],
    ["npx's --call= line, npx started by bunx", 'bunx npx --call="vercel deploy --prod"'],
    ["npx's shell-mode line, npx started by bunx", 'bunx npx --shell-mode "vercel deploy --prod"'],
    ["npx's --call= line, npx started by bun x", 'bun x npx --call="vercel deploy --prod"'],
    ["npx's -c line, npx started by two bunx", 'bunx bunx npx -c "vercel deploy --prod"'],
    ["npx's -c line by vc, npx started by bunx", 'bunx npx -c "vc --prod"'],
    ["bun run's script, bun started by npx", "npx bun run vercel deploy --prod"],
    ["bun's program, bun started by npx", "npx bun vercel deploy --prod"],
    ["bun's program, bun started by bunx", "bunx bun vercel deploy --prod"],
  ]

  test.each(nested)("for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toContain(REFUSED)
  })

  test.each(nested)("for the Ops lead, as one runner's: %s passes", async (_, command) => {
    expect(await as("ops", command)).toBeUndefined()
  })

  test.each([
    ["an env pull three runners deep", "npx npx npx vercel env pull"],
    ["a deploy by runners nested past the readings' cap", `${DEEP} vercel deploy --prod`],
  ])("for the Ops lead too: %s", async (_, command) => {
    expect(await as("ops", command)).toContain(REFUSED)
  })

  test("a runner past the readings' cap runs on a line that names vercel only inside a word", async () => {
    expect(await as("worker", `${DEEP} cat vercel.json`)).toBeUndefined()
  })

  test("a deploy by one runner stays refused", async () => {
    expect(await as("worker", "npx vercel deploy --prod")).toContain(REFUSED)
  })

  test.each([
    ["a whoami", "npx npx vercel whoami"],
    ["a preview deploy", "bunx npx vercel deploy"],
    ["a runner's version beside a whoami", "npx npx --version && vercel whoami"],
    ["a harmless program", "npx bunx cowsay vercel"],
    ["npx's -c whoami", 'bunx npx -c "vercel whoami"'],
  ])("for a worker: %s under a runner a runner starts runs", async (_, command) => {
    expect(await as("worker", command)).toBeUndefined()
  })
})

// bun run runs a package's bin and a command on PATH by name, and bare bun a package's bin (bun.com/docs/cli/run's resolution order), so a runner either names is started
describe("a runner started by bun's run or bare path hides no production deploy (PG-2189)", () => {
  const started: [string, string][] = [
    ["npx by bun run", "bun run npx vercel deploy --prod"],
    ["npx by bare bun", "bun npx vercel deploy --prod"],
    ["bunx by bun run", "bun run bunx vercel deploy --prod"],
    ["bunx by bare bun", "bun bunx vercel deploy --prod"],
    ["bun x by bun run", "bun run bun x vercel deploy --prod"],
    ["npx by its path, by bun run", "bun run ./node_modules/.bin/npx vercel deploy --prod"],
    ["npx in a folder built at run time, by bare bun", 'bun "$P/npx" vercel deploy --prod'],
    ["npx by bun run past bun's --cwd", "bun --cwd /tmp run npx vercel deploy --prod"],
    ["npx by bun run past an option's value", "bun run --shell system npx vercel deploy --prod"],
    ["npx by bun run, by vc", "bun run npx vc --prod"],
    ["npx's -c line, npx by bun run", 'bun run npx -c "vercel deploy --prod"'],
    ["npx's --call= line, npx by bare bun", 'bun npx --call="vercel deploy --prod"'],
    ["the Yard step through npx by bun run", "bun run npx bun run ship:yard v0.0.111"],
    ["the Yard step through npx by bare bun", "bun npx bun run ship:yard v0.0.111"],
    ["the Yard step through bunx by bun run", "bun run bunx bun run ship:yard v0.0.111"],
    ["the Yard step through bun by bun run", "bun run bun run ship:yard v0.0.111"],
    ["the Yard step through npm exec by bun run", "bun run npm exec bun run ship:yard v0.0.111"],
  ]

  test.each(started)("for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toContain(REFUSED)
  })

  test.each(started)("for the Ops lead, as one runner's: %s passes", async (_, command) => {
    expect(await as("ops", command)).toBeUndefined()
  })

  // a runner's program built at run time may be any runner, so on a line naming vercel it ends the chain as one the hook cannot read
  test.each([
    ["bun run's", 'bun run "$X" vercel deploy --prod'],
    ["bare bun's", 'bun "$X" vercel deploy --prod'],
    ["npx's", 'npx "$X" vercel deploy --prod'],
    ["bun x's", 'bun x "$X" vercel deploy --prod'],
    ["bunx's", 'bunx "$X" vercel deploy --prod'],
  ])("for the Ops lead too: %s program built at run time", async (_, command) => {
    expect(await as("ops", command)).toContain(REFUSED)
  })

  test.each([
    ["a script that deploys nothing", "bun run build && vercel whoami"],
    ["bare bun's script beside a whoami", "bun dev && vercel whoami"],
    ["bun test beside a whoami", "bun test && vercel whoami"],
    ["an install beside a whoami", "bun install && vercel whoami"],
    ["a filtered build beside a whoami", "bun run --filter web build && vercel ls"],
    ["bun x's preview deploy", "bun x vercel deploy"],
    ["npx's preview deploy by bun run", "bun run npx vercel deploy"],
    ["npx's whoami by bare bun", "bun npx vercel whoami"],
    ["npx's -c whoami by bun run", 'bun run npx -c "vercel whoami"'],
    ["a harmless program through npx by bun run", "bun run npx cowsay vercel"],
    ["a literal program by npx", "npx cowsay vercel"],
    ["a literal program by bun x", "bun x cowsay vercel"],
    ["a literal program by bun run", "bun run cowsay vercel"],
    [
      "a program built at run time on a line naming vercel inside a word",
      'npx "$X" cat vercel.json',
    ],
    ["a written-out file in a folder built at run time", 'bun "$P/probe.ts" && vercel whoami'],
    ["a written-out file by bun run in such a folder", "bun run $P/probe.ts vercel deploy --prod"],
  ])("for a worker: %s runs", async (_, command) => {
    expect(await as("worker", command)).toBeUndefined()
  })
})

describe("Ops' ship of the hosted build", () => {
  test.each(OPS_SHIP)("passes for the Ops lead %s", async (_, command) => {
    expect(await as("ops", command)).toBeUndefined()
  })

  test.each(OPS_SHIP)("is refused for a worker %s", async (_, command) => {
    expect(await as("worker", command)).toContain(REFUSED)
  })
})

// The release skill's Yard ship step, which runs vercel deploy --prod itself, so the hook reads the step's own command line as the production move it makes.
const YARD_SHIP: [string, string][] = [
  ["by its script", "bun run ship:yard v0.0.111"],
  ["after a cd", "cd /Users/x/playground && bun run ship:yard v0.0.111 --since v0.0.110"],
  ["through run-slot", "~/.playground/ops/run-slot.sh ops-ship -- bun run ship:yard v0.0.111"],
  ["by its file", "bun packages/scripts/src/ship/yard.ts v0.0.111 --schema-cleared i123"],
  ["by its file's full path", "bun /Users/x/playground/packages/scripts/src/ship/yard.ts v0.0.111"],
  ["by its script with no run", "bun ship:yard v0.0.111"],
  ["by its file after run", "bun run packages/scripts/src/ship/yard.ts v0.0.111"],
  ["by its file from bun's --cwd", "bun --cwd packages/scripts src/ship/yard.ts v0.0.111"],
  ["by its file after run from --cwd=", "bun --cwd=packages/scripts run src/ship/yard.ts v0.0.111"],
  ["by its file after a cd", "cd packages/scripts && bun src/ship/yard.ts v0.0.111"],
  ["from its own folder", "cd packages/scripts/src/ship && bun yard.ts v0.0.111"],
  ["by a path with ..", "bun packages/scripts/src/ship/../ship/yard.ts v0.0.111"],
  ["by a path with a doubled slash", "bun packages//scripts/src/ship/yard.ts v0.0.111"],
  ["from a folder the hook cannot read", 'cd "$D" && bun yard.ts v0.0.111'],
  [
    "with a help word after --, which bun hands the step as a tag",
    "bun run ship:yard v0.0.111 -- --help",
  ],
  ["by npm", "npm run ship:yard -- v0.0.111"],
  ["by npm with a help word", "npm run ship:yard -- --help"],
  ["by pnpm", "pnpm ship:yard v0.0.111"],
  ["by yarn", "yarn run ship:yard v0.0.111"],
  ["through bunx", "bunx bun run ship:yard v0.0.111"],
  ["through bun x", "bun x bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through npx", "npx bun ship:yard v0.0.111"],
  ["through bun x by its script", "bun x bun run ship:yard v0.0.111"],
  ["through npx by its script", "npx bun run ship:yard v0.0.111"],
  ["through pnpm dlx", "pnpm dlx bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through bun x's --cwd", "bun x --cwd packages/scripts bun src/ship/yard.ts v0.0.111"],
  ["through pnpm -C and dlx", "pnpm -C packages/scripts dlx bun src/ship/yard.ts v0.0.111"],
  ["through pnpm --dir and dlx", "pnpm --dir packages/scripts dlx bun src/ship/yard.ts v0.0.111"],
  [
    "through npm exec, its -- after bun",
    "npm exec bun -- packages/scripts/src/ship/yard.ts v0.0.111",
  ],
  [
    "through npm exec, its -- before bun",
    "npm exec -- bun packages/scripts/src/ship/yard.ts v0.0.111",
  ],
  ["through npm x", "npm x bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through yarn dlx", "yarn dlx bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through pnpm exec", "pnpm exec bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through pnpm by bun's name", "pnpm bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through yarn by bun's name", "yarn bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through bunx at a version", "bunx bun@1 packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through npx, then bun x", "npx bun x bun packages/scripts/src/ship/yard.ts v0.0.111"],
  ["through bun's --cwd, then x", "bun --cwd packages/scripts x bun src/ship/yard.ts v0.0.111"],
  [
    "through npx, bun as -p's value first",
    "npx -p bun bun packages/scripts/src/ship/yard.ts v0.0.111",
  ],
  [
    "through npx, bun as --package's value first",
    "npx --package bun bun packages/scripts/src/ship/yard.ts v0.0.111",
  ],
  [
    "through bunx, bun as --package's value first",
    "bunx --package bun bun packages/scripts/src/ship/yard.ts v0.0.111",
  ],
  [
    "through bunx, bun as -p's value first",
    "bunx -p bun bun packages/scripts/src/ship/yard.ts v0.0.111",
  ],
  ["through pnpm --filter and exec", "pnpm --filter scripts exec bun src/ship/yard.ts v0.0.111"],
  ["through pnpm -F and exec", "pnpm -F scripts exec bun src/ship/yard.ts v0.0.111"],
  ["through yarn workspace and exec", "yarn workspace scripts exec bun src/ship/yard.ts v0.0.111"],
  ["in npm exec's -c line", "npm exec -c 'bun run ship:yard v0.0.111'"],
  ["in npx's -c line", "npx -c 'bun run ship:yard v0.0.111'"],
  ["in npx's --call= line", "npx --call='bun packages/scripts/src/ship/yard.ts v0.0.111'"],
  [
    "in a -c line the hook cannot read, on a line naming the step",
    'S="bun run ship:yard v0.0.111"; npx -c "$S"',
  ],
  ["behind env", "env FOO=1 bun run ship:yard v0.0.111"],
  ["after a pushd", "pushd packages/scripts && bun src/ship/yard.ts v0.0.111"],
  ["in a subshell", "(cd packages/scripts/src/ship && bun yard.ts v0.0.111)"],
  ["in sh -c", "sh -c 'bun run ship:yard v0.0.111'"],
]

describe("the Yard ship step", () => {
  test.each(YARD_SHIP)("passes for the Ops lead %s", async (_, command) => {
    expect(await as("ops", command)).toBeUndefined()
  })

  test.each(YARD_SHIP)("is refused for a worker %s", async (_, command) => {
    expect(await as("worker", command)).toContain(REFUSED)
  })

  test.each(YARD_SHIP)("is refused for a lead that is not Ops %s", async (_, command) => {
    expect(await as("builder", command)).toContain(REFUSED)
  })

  test("loses the Ops lead's pass with the role as a prefix", async () => {
    expect(await as("ops", "PLAYGROUND_ROLE=lead bun run ship:yard v0.0.111")).toContain(REFUSED)
  })

  test.each([
    ["its help", "bun run ship:yard --help"],
    ["its short help by its file", "bun packages/scripts/src/ship/yard.ts -h"],
    ["the Yard CLI's file", "bun packages/scripts/src/playground/yard.ts channels"],
    [
      "the Yard CLI's file from its own folder",
      "cd packages/scripts/src/playground && bun yard.ts channels",
    ],
    ["a read naming the step", "grep -n ship:yard package.json"],
    [
      "the Yard CLI's file through bunx",
      "bunx bun packages/scripts/src/playground/yard.ts channels",
    ],
    [
      "the Yard CLI's file through npm exec",
      "npm exec -- bun packages/scripts/src/playground/yard.ts channels",
    ],
    ["the step's help through npx", "npx bun run ship:yard --help"],
    ["a build through pnpm --filter", "pnpm --filter web exec bun run build"],
    ["an install of bun", "npm install bun"],
    ["an add of bun and its types", "pnpm add -D bun @types/bun"],
    ["bun's version through npx", "npx bun --version"],
    [
      "a -c line running the Yard CLI",
      "npx -c 'bun packages/scripts/src/playground/yard.ts channels'",
    ],
  ])("passes for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toBeUndefined()
  })
})

describe("the Ops lead's production moves", () => {
  test.each(PRODUCTION.filter(([, command]) => !command.includes("$")))(
    "pass: %s",
    async (_, command) => {
      expect(await as("ops", command)).toBeUndefined()
    },
  )

  test.each([
    ["with the role as a prefix", "PLAYGROUND_ROLE=lead vercel --prod"],
    ["with the role exported", "export PLAYGROUND_ROLE=lead; vercel --prod"],
    ["with the role through env", "env PLAYGROUND_ROLE=lead vercel --prod"],
    [
      "with the role in a -c script",
      "bash -c 'PLAYGROUND_ROLE=lead vercel promote demo-abc.vercel.app'",
    ],
    ["after a source", "source ./roles.sh && vercel --prod"],
    ["after a dot", ". ./roles.sh && vercel rollback"],
  ])("lose the pass %s", async (_, command) => {
    expect(await as("ops", command)).toContain(REFUSED)
  })
})

describe("a read, a preview and a help run", () => {
  test.each([
    ["whoami", "vercel whoami"],
    ["ls", "vercel ls"],
    ["list of production", "vercel list --environment production"],
    ["inspect", "vercel inspect demo-abc.vercel.app"],
    ["logs", "vercel logs demo-abc.vercel.app"],
    ["logs of production", "vercel logs -e production"],
    ["logs of production by the log alias", "vercel log --environment production"],
    [
      "logs with more options than the readings bound",
      "vercel logs demo --since 1h --until 2h --limit 5 --json --follow --level error --query x",
    ],
    ["an env list in table format", "vercel env ls --format table"],
    ["a redeploy to preview by its letter", "vercel redeploy demo-abc.vercel.app -e preview"],
    ["an integration list", "vercel integration ls"],
    ["a bare preview deploy", "vercel"],
    ["a preview deploy", "vercel deploy --yes"],
    ["a manual preview deploy", "vercel deploy init"],
    ["a preview deploy by name", "vercel deploy --name demo"],
    ["a preview deploy by name's letter", "vercel deploy -n demo"],
    ["a preview deploy with meta by its letter", "vercel deploy -m k=v"],
    ["a preview deploy with a run-time env var by its letter", "vercel deploy -e K=preview"],
    [
      "a preview deploy with a build env var by its letter",
      "vercel deploy -b K=v --no-logs --no-clipboard",
    ],
    ["a preview deploy of a folder", "vercel deploy ./web"],
    ["a preview by its environment", "vercel deploy --environment preview"],
    ["a redeploy to preview", "vercel redeploy demo-abc.vercel.app --environment preview"],
    ["an env list", "vercel env ls"],
    [
      "VERCEL.md's api read",
      "vercel api --raw /v6/deployments?projectId=demo | grep -o '{.*' | jq",
    ],
    ["an api read", "vercel api /v2/user"],
    ["an api GET named", "vercel api /v9/projects/demo -X GET"],
    ["an api endpoint list", "vercel api list"],
    ["a promote status", "vercel promote status"],
    ["a rollback status", "vercel rollback status demo"],
    ["an alias list", "vercel alias list"],
    ["an alias ls", "vercel alias ls"],
    ["a team list", "vercel teams ls"],
    ["a domain list", "vercel domains ls"],
    ["a dns list", "vercel dns ls"],
    ["a project list", "vercel project ls"],
    ["a help command", "vercel help deploy"],
    ["a rolling release inspect", "vercel rolling-release inspect"],
    ["help", "vercel --help"],
    ["a subcommand's help", "vercel deploy --prod --help"],
    ["the version", "vercel --version"],
    ["an echo", "echo vercel --prod"],
    ["a commit message", 'git commit -m "vercel --prod"'],
    ["a program in a variable beside a file named Vercel", '"$BUN" test tests/x/VERCEL.test.ts'],
  ])("for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toBeUndefined()
  })
})
