import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-live-sign-in"

const root = join(import.meta.dir, "..", "..", "..")

// A made-up portless state folder: the live stack holds the bare aliases' ports 4100 and 4101 and its own names on them, a worktree's stack 4200 and 4201.
const state = mkdtempSync(join(tmpdir(), "no-live-sign-in-"))
writeFileSync(
  join(state, "routes.json"),
  JSON.stringify([
    { hostname: "playground.localhost", port: 4100 },
    { hostname: "api.playground.localhost", port: 4101 },
    { hostname: "dashboard.playground.localhost", port: 4100 },
    { hostname: "dashboard.api.playground.localhost", port: 4101 },
    { hostname: "pg-1.playground.localhost", port: 4200 },
    { hostname: "pg-1.api.playground.localhost", port: 4201 },
  ]),
)
const empty = mkdtempSync(join(tmpdir(), "no-live-sign-in-none-"))
afterAll(() => {
  rmSync(state, { force: true, recursive: true })
  rmSync(empty, { force: true, recursive: true })
})

const input = (command: string, tool = "Bash") =>
  JSON.stringify({
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: tool,
  })
const bash = (command: string, dir = state) => check(input(command), { PORTLESS_STATE_DIR: dir })

describe("a sign-in call to the live dashboard is refused, with the way to sign in on your own stack", () => {
  test.each([
    'curl -X POST -H "Origin: https://playground.localhost" https://api.playground.localhost/api/v1/onboard/sign-in',
    "curl -X POST https://dashboard.api.playground.localhost/api/agents/sign-in-as",
    "curl -X POST https://api.playground.localhost/api/v1/onboard/finish",
    "curl -X POST http://127.0.0.1:4101/api/v1/onboard/sign-in",
    "curl -X POST http://localhost:4101/api/agents/sign-in-as",
    "curl -X POST 'http://[::1]:4101/api/agents/sign-in-as'",
    "H=dashboard.api.playground.localhost; curl -X POST https://$H/api/agents/sign-in-as",
    'curl "https://api.playground.localhost/api/v1/onboard/"sign-in',
    "wget --post-data=x https://api.playground.localhost/api/agents/sign\\-in\\-as",
    'bun -e \'await fetch("https://dashboard.api.playground.localhost/api/v1/onboard/sign-in", { method: "POST" })\'',
  ])("%s", async (command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-live-sign-in hook refuses")
    expect(reason).toContain("your own worktree's stack")
  })

  test("the bare names are the live dashboard's even with no route file to read", async () => {
    expect(
      await bash("curl -X POST https://api.playground.localhost/api/v1/onboard/sign-in", empty),
    ).toContain("no-live-sign-in hook refuses")
  })
})

describe("every other call runs", () => {
  test.each([
    'curl -X POST -H "Origin: https://pg-1.playground.localhost" https://pg-1.api.playground.localhost/api/agents/sign-in-as',
    'WEB=$(bunx portless get playground); API=$(bunx portless get api.playground); curl -sS -c cookies.txt -X POST -H "Origin: $WEB" "$API/api/agents/sign-in-as"',
    // the dev skill's Agent login, with portless's CA from the folder portlessDir() names
    'curl -sS "${CA[@]}" -c cookies.txt -X POST -H "Origin: $WEB" "$API/api/agents/sign-in-as"',
    // the dev skill's Agent login, its URLs asked in the folder portlessDir() names (#2418)
    'WEB=$(PORTLESS_STATE_DIR="$PDIR" bunx portless get playground); API=$(PORTLESS_STATE_DIR="$PDIR" bunx portless get api.playground); curl -sS "${CA[@]}" -c cookies.txt -X POST -H "Origin: $WEB" "$API/api/agents/sign-in-as"',
    // the dev skill's Agent login, portless's folder written as the literal path portlessDir() printed (#2320)
    'WEB=$(PORTLESS_STATE_DIR=/home/me/.portless/fallback bunx portless get playground); API=$(PORTLESS_STATE_DIR=/home/me/.portless/fallback bunx portless get api.playground); curl -sS --cacert /home/me/.portless/fallback/ca.pem -c cookies.txt -X POST -H "Origin: $WEB" "$API/api/agents/sign-in-as"',
    "curl -X POST http://127.0.0.1:4201/api/v1/onboard/sign-in",
    "curl -X POST https://pg-1.playground.localhost:4101/api/agents/sign-in-as",
    "curl https://api.playground.localhost/api/health",
    "curl http://127.0.0.1:4101/api/v1/user",
    "git grep -n sign-in-as",
  ])("%s", async (command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("a tool other than Bash", async () => {
    expect(
      await check(input("https://api.playground.localhost/api/v1/onboard/sign-in", "Write"), {
        PORTLESS_STATE_DIR: state,
      }),
    ).toBeUndefined()
  })
})
