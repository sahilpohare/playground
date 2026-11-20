import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"

import { SQL } from "bun"

import { testContainerName } from "../../../../container"

const ROOT = resolve(import.meta.dir, "../../../../..")
const API = join(ROOT, "api/hono")
const HOSTED = join(API, "src/hosted.ts")
const MIGRATIONS = join(ROOT, "packages/db/drizzle")
const SCENARIO = join(import.meta.dir, "yard-scenario.ts")
const RELAY = join(import.meta.dir, "yard-relay-scenario.ts")
const GITHUB = join(import.meta.dir, "yard-github.ts")
const BOT = join(import.meta.dir, "yard-bot-scenario.ts")
const BOT_LOG = join(import.meta.dir, "yard-bot-log-scenario.ts")
const SWAP = join(import.meta.dir, "yard-swap-scenario.ts")
const WEB = "http://127.0.0.1:3000"
const PASSWORD = crypto.randomUUID()

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

// A child Bun in the API's folder, so its tsconfig's @/ resolves, on the hosted build's environment: the hosted switch, the Vercel adapter and the database URL are read once, when their modules load.
const child = (script: string, env: Record<string, string>) => {
  const run = Bun.spawnSync(["bun", "-e", script], {
    cwd: API,
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      BETTER_AUTH_SECRET: "yard-test-secret",
      GITHUB_CLIENT_ID: "yard-test-client",
      GITHUB_CLIENT_SECRET: "yard-test-client-secret",
      HONO_APP_URL: "http://127.0.0.1:4000",
      HONO_TRUSTED_ORIGINS: WEB,
      HONO_WEB_URL: WEB,
      NODE_ENV: "test",
      PLAYGROUND_HOSTED: "1",
      PORT: "0",
      YARD_HOSTED: HOSTED,
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  })
  return { code: run.exitCode, err: run.stderr.toString(), out: run.stdout.toString() }
}

// The last line a child printed, after the request log.
const last = (out: string) => out.trim().split("\n").at(-1) ?? ""

// A made-up relay-on token for a user, in the shape Yard mints one, which reads and posts; a plain yard_ token reads alone.
const relayOn = (id: string) => `yard_relay_${id.repeat(32).slice(0, 32)}`

// A one-time token as Better Auth's plugin keeps it, hashed, pointing at a live session.
const ottHash = (token: string) => createHash("sha256").update(token).digest("base64url")

describe.skipIf(!dockerUp())("Yard's routes on the hosted build", () => {
  let container = ""
  let sql: SQL
  let url = ""

  // Mints a one-time token for a member's session, as GET /api/auth/one-time-token/generate would.
  const ott = async (userId: string) => {
    const token = crypto.randomUUID()
    const session = crypto.randomUUID()
    const later = new Date(Date.now() + 600_000)
    await sql`insert into session (id, token, user_id, expires_at, updated_at) values (${session}, ${session}, ${userId}, ${later}, now())`
    await sql`insert into verification (id, identifier, value, expires_at) values (${crypto.randomUUID()}, ${`one-time-token:${ottHash(token)}`}, ${session}, ${later})`
    return token
  }

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("routers-yard"),
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18-alpine",
    ])
      .stdout.toString()
      .trim()
    const port = Bun.spawnSync(["docker", "port", container, "5432/tcp"])
      .stdout.toString()
      .trim()
      .split(":")
      .at(-1)
    url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`
    for (let i = 0; i < 60; i++) {
      try {
        sql = new SQL(url, { max: 1 })
        await sql`select 1`
        break
      } catch {
        await Bun.sleep(500)
      }
    }
    const journal = await Bun.file(join(MIGRATIONS, "meta/_journal.json")).json()
    for (const { tag } of journal.entries as { tag: string }[])
      for (const statement of (await Bun.file(join(MIGRATIONS, `${tag}.sql`)).text()).split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await sql.unsafe(statement)
    for (const id of ["bo", "di"]) {
      await sql`insert into "user" (id, name, email, login, role) values (${id}, ${id}, ${`${id}@example.com`}, ${id}, 'member')`
      await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update(relayOn(id)).digest("hex")}, ${"studio"}, ${id})`
    }
  }, 60_000)

  afterAll(async () => {
    await sql?.close()
    if (container)
      Bun.spawnSync(["docker", "rm", "-fv", container], { stderr: "ignore", stdout: "ignore" })
  })

  test("refuse what they should, take a token's calls, and push a sent message to a member's socket", async () => {
    const run = child(await Bun.file(SCENARIO).text(), {
      BO_TOKEN: relayOn("bo"),
      DI_OTT: await ott("di"),
      DI_TOKEN: relayOn("di"),
      POSTGRES_URL: url,
    })
    expect(run.err).not.toContain("error:")
    const out = JSON.parse(last(run.out))
    expect(out).toMatchObject({
      cookieWriteNoOrigin: 403,
      created: 201,
      held: "pending",
      me: { login: "bo", owner: false },
      noAuth: 401,
      ownChannelsAfterNoAuth: 0,
      ottVerify: 404,
      posted: [201, "sent"],
      socket: "open",
      socketNoOrigin: 4403,
      socketNoToken: 4401,
      tokenOnWebOnly: 403,
      waiting: [{ items: [] }, 400],
    })
    expect(
      out.tokenList.data.channels.map((c: { joined: boolean; name: string }) => [c.name, c.joined]),
    ).toEqual([
      ["general", true],
      ["releases", true],
    ])
    expect(out.frames).toEqual([
      {
        message: expect.objectContaining({
          from: { device: "studio", login: "bo" },
          text: "anyone up?",
        }),
        type: "message",
      },
    ])
  })

  test("the relay carries the owner's reads, pair request and signed writes to a Mac holding it with a relay-on token the owner's browser mints, which reads and posts too, and refuses a member's relay-on token, a read-only token, a wrong Origin, an unsigned write and the first-run routes", async () => {
    await sql`insert into "user" (id, name, email, login, role) values ('ow', 'ow', ${["ow", "example.com"].join("@")}, 'ow', 'owner')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update("yard_ow").digest("hex")}, ${"mac"}, 'ow')`
    const run = child(await Bun.file(RELAY).text(), {
      MEMBER_ID: "bo",
      MEMBER_TOKEN: relayOn("bo"),
      OWNER_ID: "ow",
      POSTGRES_URL: url,
      READ_ONLY_TOKEN: "yard_ow",
    })
    expect(run.err).not.toContain("error:")
    expect(JSON.parse(last(run.out))).toEqual({
      afterClose: 503,
      cookieSocket: 4403,
      macSocket: "open",
      member: 403,
      memberSocket: 4403,
      mint: [201, true],
      mintMember: 201,
      offline: 503,
      onboard: 403,
      pair: [202, { fingerprint: "a0a2 32c2 f194 a535" }],
      pairMember: 403,
      pairNoOrigin: 403,
      pairNotAKey: 400,
      pairs: [
        {
          key: {
            crv: "P-256",
            kty: "EC",
            x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
            y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
          },
          login: "ow",
          type: "pair",
        },
      ],
      read: [200, { data: ["w1"] }, "no-store", "inline", "default-src 'none'; sandbox", "nosniff"],
      readOnlyMe: 200,
      readOnlyRead: 200,
      readOnlySocket: 4403,
      readOnlyWrite: [403, "A read-only token reads alone"],
      relayMe: 200,
      relayRead: 200,
      relayWrite: 201,
      requests: [{ login: "ow", method: "GET", path: "/api/v1/workers?x=1" }],
      status: { online: true, since: null },
      statusAfter: { online: false, since: "string" },
      statusReplaced: { online: false, since: null },
      signedWrite: [201, { sent: true }],
      write: 404,
      writeMember: 403,
      writeNoOrigin: 403,
      writeNotAFrame: 400,
      writeOffList: 403,
      writeOtherLogin: 403,
      writeWrongOrigin: 403,
      writes: [{ login: "ow", path: "/api/v1/messages", type: "write" }],
      wrongOrigin: 403,
    })
    // the hub forwards a write's body from memory alone: no log line of the hosted side holds it
    expect(`${run.out}${run.err}`).not.toContain("body-kept-nowhere")
    expect(run.out).toMatch(/\[relay\] write [0-9a-f-]{36} \/api\/v1\/messages 201 \d{4}-/)
  })

  // A member of its own with a token, so a test's posts meet no other test's one-a-second limit.
  const tokenFor = async (id: string) => {
    await sql`insert into "user" (id, name, email, login, role) values (${id}, ${id}, ${`${id}@example.com`}, ${id}, 'member')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update(relayOn(id)).digest("hex")}, ${"studio"}, ${id})`
    return relayOn(id)
  }

  // a fan-out runs after the write has committed, so one that fails must not turn the answer into a 500
  test("a post and a read answer what they wrote while KV_URL's Redis refuses every command", async () => {
    const script = `const redis = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: (socket) => { socket.write("-ERR refused\\r\\n") } } }); process.env.KV_URL = "redis://127.0.0.1:" + redis.port; const server = Bun.serve((await import(process.env.YARD_HOSTED)).default); const api = "http://127.0.0.1:" + server.port + "/api/v1/yard"; const headers = { authorization: "Bearer " + process.env.TOKEN, "content-type": "application/json" }; const made = await fetch(api + "/channels", { body: JSON.stringify({ name: "quiet" }), headers, method: "POST" }); const { id } = (await made.json()).data.channel; const posted = await fetch(api + "/channels/" + id + "/messages", { body: JSON.stringify({ kind: "text", text: "hello" }), headers, method: "POST" }); const read = await fetch(api + "/channels/" + id + "/read", { body: "{}", headers, method: "POST" }); console.log(JSON.stringify([made.status, posted.status, read.status])); process.exit(0)`
    const run = child(script, { POSTGRES_URL: url, TOKEN: await tokenFor("ed") })
    expect(JSON.parse(last(run.out))).toEqual([201, 201, 200])
  })

  test("a post and a read answer what they wrote while nothing takes KV_URL's connection", async () => {
    const script = `const server = Bun.serve((await import(process.env.YARD_HOSTED)).default); const api = "http://127.0.0.1:" + server.port + "/api/v1/yard"; const headers = { authorization: "Bearer " + process.env.TOKEN, "content-type": "application/json" }; const made = await fetch(api + "/channels", { body: JSON.stringify({ name: "unreached" }), headers, method: "POST" }); const { id } = (await made.json()).data.channel; const posted = await fetch(api + "/channels/" + id + "/messages", { body: JSON.stringify({ kind: "text", text: "hello" }), headers, method: "POST" }); const read = await fetch(api + "/channels/" + id + "/read", { body: "{}", headers, method: "POST" }); console.log(JSON.stringify([made.status, posted.status, read.status])); process.exit(0)`
    const run = child(script, {
      KV_URL: "redis://127.0.0.1:1",
      POSTGRES_URL: url,
      TOKEN: await tokenFor("fy"),
    })
    expect(JSON.parse(last(run.out))).toEqual([201, 201, 200])
  })

  test("the owner's token makes a bot that reads and posts in its own DM alone, by its id or by the bot routes that find it from the token (#1995), never held, and a revoke cuts it with a 401", async () => {
    await sql`insert into "user" (id, name, email, login, role) values ('ox', 'ox', ${["ox", "example.com"].join("@")}, 'ox', 'owner')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update(relayOn("ox")).digest("hex")}, ${"mac"}, 'ox')`
    await sql`insert into "user" (id, name, email, login, role) values ('gh', 'ghost', ${["gh", "example.com"].join("@")}, 'ghost[bot]', 'member')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update("yard_ghost").digest("hex")}, ${"bot"}, 'gh')`
    const run = child(await Bun.file(BOT).text(), {
      GHOST_TOKEN: "yard_ghost",
      MEMBER_LOGIN: "mo",
      MEMBER_TOKEN: await tokenFor("mo"),
      OWNER_TOKEN: relayOn("ox"),
      POSTGRES_URL: url,
    })
    expect(run.err).not.toContain("error:")
    const out = JSON.parse(last(run.out))
    const bot = {
      createdAt: expect.any(String),
      dm: expect.any(String),
      login: "grok[bot]",
      name: "grok",
      readsLog: false,
    }
    expect(out).toEqual({
      add: [201, bot, "string"],
      addAgain: 409,
      afterRevoke: 401,
      afterRevokeRoute: 401,
      badName: 400,
      botSocket: 4403,
      botPost: [201, "sent", { device: "bot", login: "grok[bot]" }],
      botRead: ["hello owner", "hello bot"],
      botReadAfter: [200, ["hello bot"]],
      botRoutePost: [201, "sent", true],
      botRouteRead: ["hello owner", "hello bot", "via the bot route"],
      botRouteReadAfter: [200, ["hello bot", "via the bot route"]],
      controls: [200, 200],
      dmToBot: 400,
      ghost: 401,
      list: [bot],
      listAfter: [],
      memberAdd: 403,
      memberList: 403,
      memberRevoke: 403,
      personOnBotRoute: [403, 403],
      refused: {
        botRouteHeldKind: 403,
        botRouteMention: 403,
        bots: 403,
        channels: 403,
        dms: 403,
        heldKind: 403,
        link: 403,
        me: 403,
        mention: 403,
        newChannel: 403,
        otherPost: 403,
        otherRead: 403,
        read: 403,
        relayStatus: 403,
        relayWrite: 403,
        tokens: 403,
        waiting: 403,
      },
      revoke: 200,
      revokeAgain: 404,
    })
    // the bot's token is stored only as its hash, and no log line of the hosted side holds it
    expect(await sql`select count(*)::int as n from yard_bot`).toEqual([{ n: 0 }])
    expect(run.out).not.toMatch(/yard_[A-Za-z0-9_-]{32}/)
  })

  test("a bot the owner lets read the log from the browser reads a page through the owner's Mac, a line in its DM says so and cards nothing, and every other caller is refused, a token's grant included (#1888, #2032)", async () => {
    await sql`insert into "user" (id, name, email, login, role) values ('lo', 'lo', ${["lo", "example.com"].join("@")}, 'lo', 'owner')`
    // the Mac's one token, relay on, which makes the bots and holds the relay
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update(relayOn("lo")).digest("hex")}, ${"mac"}, 'lo')`
    const run = child(await Bun.file(BOT_LOG).text(), {
      OWNER_ID: "lo",
      OWNER_TOKEN: relayOn("lo"),
      POSTGRES_URL: url,
    })
    expect(run.err).not.toContain("error:")
    const out = JSON.parse(last(run.out))
    expect(out).toEqual({
      add: [201, true, false],
      afterOff: 403,
      afterRevoke: 401,
      dm: [
        ["scout[bot]", "text", "hello owner"],
        [
          "scout[bot]",
          "log",
          expect.stringMatching(/^Read the dispatcher's log at \S+Z: entries 5 to 6$/),
        ],
      ],
      frameCount: 1,
      frames: [
        {
          bindsScoutsDm: true,
          bot: "scout[bot]",
          login: "lo",
          method: "GET",
          path: "/api/v1/dashboard/dispatcher/log?after=4",
          type: "bot",
        },
      ],
      offline: 503,
      read: [200, [5, 6]],
      refused: { badCursor: 400, browser: 403, owner: 403, quiet: 403 },
      remade: [201, true, 403, 2],
      revoke: 200,
      switchOff: [200, false],
      switchOn: true,
      switchToken: 403,
      tokenLog: 403,
      waiting: [["scout[bot]", "text"]],
    })
    expect(run.out).not.toMatch(/yard_[A-Za-z0-9_-]{32}/)
  })

  test("a token swaps itself in place for a new one of its own kind, the old one reading 401 after, and a bot's token, a browser and a swap to the other kind are refused", async () => {
    const readOnly = `yard_${"q".repeat(32)}`
    await sql`insert into "user" (id, name, email, login, role) values ('sw', 'sw', ${["sw", "example.com"].join("@")}, 'sw', 'owner')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update(relayOn("sw")).digest("hex")}, ${"mac"}, 'sw')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash("sha256").update(readOnly).digest("hex")}, ${"studio"}, 'sw')`
    await sql`insert into "user" (id, name, email, login, role) values ('sb', 'sb', ${["sb", "example.com"].join("@")}, 'swapper[bot]', 'member')`
    await sql`insert into yard_bot (user_id, made_by) values ('sb', 'sw')`
    await sql`insert into yard_token (id, hash, name, user_id) values (${crypto.randomUUID()}, ${createHash(
      "sha256",
    )
      .update(`yard_${"s".repeat(32)}`)
      .digest("hex")}, ${"bot"}, 'sb')`
    const run = child(await Bun.file(SWAP).text(), {
      BOT_TOKEN: `yard_${"s".repeat(32)}`,
      OWNER_ID: "sw",
      POSTGRES_URL: url,
      READ_ONLY_TOKEN: readOnly,
      RELAY_TOKEN: relayOn("sw"),
    })
    expect(run.err).not.toContain("error:")
    expect(JSON.parse(last(run.out))).toEqual({
      afterRefusals: [200, 200],
      answerHoldsSecret: false,
      answerKeys: ["createdAt", "id", "lastUsedAt", "name", "revokedAt"],
      badShape: 400,
      bot: 403,
      browser: 403,
      newReadOnly: 200,
      newReadOnlyWrites: 403,
      newRelay: 200,
      newRelayWrites: 201,
      oldAgain: 401,
      oldReadOnly: 401,
      oldRelay: 401,
      readOnlySwap: 200,
      relaySwap: [200, "mac"],
      tokens: [
        ["mac", null],
        ["studio", null],
      ],
      readOnlyToRelay: 400,
      toOtherKind: 400,
    })
    // the swap made no token: the bot's and the member's two rows alone, each swapped row still its maker's, holding only the new secret's hash
    const hash = (secret: string) => createHash("sha256").update(secret).digest("hex")
    expect(
      await sql`select name, user_id, hash from yard_token where user_id in ('sw', 'sb') order by name`,
    ).toEqual([
      { hash: hash(`yard_${"s".repeat(32)}`), name: "bot", user_id: "sb" },
      { hash: hash(`yard_relay_${"n".repeat(32)}`), name: "mac", user_id: "sw" },
      { hash: hash(`yard_${"r".repeat(32)}`), name: "studio", user_id: "sw" },
    ])
    // no log line of the hosted side holds a secret, the old ones or the new
    expect(`${run.out}${run.err}`).not.toMatch(/yard_[A-Za-z0-9_-]{32}/)
  })

  test("GitHub's sign-in stamps the login and takes it from a stale holder, and no client sets one", async () => {
    await sql`insert into "user" (id, name, email, login, role) values ('old', 'old', ${["old", "example.com"].join("@")}, 'Taken', 'member')`
    const run = child(await Bun.file(GITHUB).text(), { GH_LOGIN: "taken", POSTGRES_URL: url })
    expect(run.err).not.toContain("error:")
    expect(JSON.parse(last(run.out))).toMatchObject({ callback: 302, update: 200 })
    // the new holder keeps GitHub's login through its own update-user, and the stale holder has let it go
    const [stale] = await sql`select login from "user" where id = 'old'`
    const [fresh] =
      await sql`select login from "user" where email = ${["new", "example.com"].join("@")}`
    expect([stale.login, fresh.login]).toEqual([null, "taken"])
  })

  // Yard's member rung keys on user.login, so a sign-up that carries one is refused or stored without it, and stampLogin drops a login off GitHub's callback
  test("a sign-up carrying a login stores no login, and stampLogin drops it off the callback", async () => {
    const email = ["signup", "example.com"].join("@")
    const script = `const { stampLogin } = await import("@packages/auth"); const server = Bun.serve((await import(process.env.YARD_HOSTED)).default); const signUp = await fetch("http://127.0.0.1:" + server.port + "/api/auth/sign-up/email", { body: JSON.stringify({ email: process.env.EMAIL, login: "signedup", name: "Signed Up", password: "a-long-test-password" }), headers: { "content-type": "application/json", origin: process.env.HONO_WEB_URL }, method: "POST" }); const stamped = await stampLogin({ login: "signedup" }, { params: {}, path: "/sign-up/email" }); console.log(JSON.stringify({ dropped: Boolean(stamped) && "login" in stamped.data && stamped.data.login === undefined, signUp: signUp.status })); process.exit(0)`
    const run = child(script, { EMAIL: email, POSTGRES_URL: url })
    expect(run.err).not.toContain("error:")
    const { dropped, signUp } = JSON.parse(last(run.out))
    expect(dropped).toBe(true)
    const rows = await sql`select login from "user" where email = ${email} or login = 'signedup'`
    expect(signUp >= 400 ? rows : rows.map((row: { login: string | null }) => row.login)).toEqual(
      signUp >= 400 ? [] : [null],
    )
  })

  test("the socket upgrades on the Vercel export, a server that never listened", async () => {
    const script = `const server = (await import(${JSON.stringify(HOSTED)})).default; await new Promise((done) => server.listen(0, "127.0.0.1", done)); const socket = new WebSocket("ws://127.0.0.1:" + server.address().port + "/api/v1/yard/socket?token=${await ott("bo")}", { headers: { origin: ${JSON.stringify(WEB)} } }); socket.onopen = () => { console.log("open"); process.exit(0) }; socket.onerror = () => { console.log("error"); process.exit(1) }`
    const run = child(script, { POSTGRES_URL: url, VERCEL: "1" })
    expect(run.err).not.toContain("error:")
    expect(last(run.out)).toBe("open")
  })
})
