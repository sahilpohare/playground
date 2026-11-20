import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const skill = () =>
  Bun.file(join(import.meta.dir, "../../../../skills/zerostarter/ui-verify/SKILL.md")).text()
const bullet = async (name: string) =>
  (await skill()).match(new RegExp(`^- \\*\\*${name}:\\*\\*.*(?:\\n  .*)*`, "m"))?.[0] ?? ""

describe("ui-verify names the CDP call for each check agent-browser's own commands cannot make (#203)", () => {
  test("a socket's host reads from Network.webSocketCreated, since the request list leaves socket opens out", async () => {
    const line = await bullet("Socket host")
    expect(line).toContain("`Network.enable`")
    expect(line).toContain("`Network.webSocketCreated`")
  })

  test("a mocked error status answers Fetch.requestPaused with Fetch.fulfillRequest, since network route answers 200 alone", async () => {
    const line = await bullet("Error status")
    expect(line).toContain("`Fetch.enable`")
    expect(line).toContain("`Fetch.fulfillRequest`")
    expect(line).toContain("`access-control-allow-credentials`")
  })
})

describe("ui-verify's Theme bullet names the two traps of a theme set through localStorage", () => {
  test("a set theme applies after a reload, since a hash-only reopen keeps the page", async () => {
    const line = await bullet("Theme")
    expect(line).toContain('`localStorage.setItem("theme", …)`')
    expect(line).toContain("reload")
    expect(line).toContain("`#hash`")
  })

  test("localStorage is per origin, so the theme is set again on each host", async () => {
    const line = await bullet("Theme")
    expect(line).toContain("per origin")
    expect(line).toContain("each host")
  })
})

// issue 2030: two traps in a sign-in and a Yard shot
describe("ui-verify names the sign-in cookie's plain form and a Yard page's shot", () => {
  test("a sign-in cookie is set with the plain form, since --curl can print Done and set nothing", async () => {
    const line = await bullet("Sign-in cookie")
    expect(line).toContain(
      "`agent-browser cookies set --curl <json>` can print Done and set nothing",
    )
    expect(line).toContain(
      "`agent-browser cookies set <name> <value> --domain <host> --path / --secure --http-only`",
    )
    expect(await skill()).not.toContain(
      "load that file with the same `agent-browser cookies set --curl <file>`",
    )
  })

  test("a Yard page's shot runs a fixture stack built hosted, its API reads mocked", async () => {
    const line = await bullet("Yard page")
    expect(line).toContain("`NEXT_PUBLIC_PLAYGROUND_HOSTED=1`")
    expect(line).toContain("`network route`")
  })
})

// issue 2180: a new test browser build asks macOS for notification rights on its first run
describe("ui-verify's Cross-browser bullet reuses one decided copy per browser", () => {
  test("Firefox and WebKit run a pinned Playwright from its shared cache, never a scratch folder", async () => {
    const line = await bullet("Cross-browser")
    expect(line).toContain("`bunx playwright@1.65.1 install firefox webkit`")
    expect(line).toContain("`~/Library/Caches/ms-playwright`")
    expect(line).toContain("never set `PLAYWRIGHT_BROWSERS_PATH`")
    expect(line).toContain("agent-browser's own Chrome for Testing")
  })

  test("a pin bump or an agent-browser upgrade is a new build that can ask once, so the session waits and tells its lead", async () => {
    const line = await bullet("Cross-browser")
    expect(line).toContain("new build")
    expect(line).toContain("Playwright pin bump")
    expect(line).toContain("agent-browser upgrade")
    expect(line).toContain("tells its lead")
    expect(line).toContain("Inbox")
  })
})
