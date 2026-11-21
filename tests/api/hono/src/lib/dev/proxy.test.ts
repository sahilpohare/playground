import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FALLBACK_PORT,
  fallbackDir,
  listening,
  portlessDir,
  prefixOf,
  proxyDown,
  proxySetup,
  serviceDir,
  shareCa,
  startFallback,
} from "../../../../../../api/hono/src/lib/dev/proxy"
import { discard } from "../../../../../../api/hono/src/lib/trash"

describe("proxyDown", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-proxy-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))
  const saved = (name: string, port: string) => {
    const path = join(dir, name)
    mkdirSync(path)
    writeFileSync(join(path, "proxy.port"), `${port}\n`)
    return path
  }
  const silent = async () => false
  const answers = async () => true

  test("a fresh machine, whose proxy portless would start on 443 with sudo, names 443", async () => {
    expect(await proxyDown({}, join(dir, "fresh"), silent)).toBe(443)
  })

  test("a service on 443 that stopped names 443", async () => {
    expect(await proxyDown({}, saved("stopped", "443"), silent)).toBe(443)
  })

  test("passes once the service holds 443", async () => {
    expect(await proxyDown({}, saved("service", "443"), answers)).toBeNull()
  })

  test("passes a proxy portless keeps on an unprivileged port of the owner's own, and a 1355 that answers", async () => {
    expect(await proxyDown({}, saved("own", "8443"), silent)).toBeNull()
    expect(await proxyDown({ PORTLESS_PORT: "8443" }, join(dir, "fresh"), silent)).toBeNull()
    expect(await proxyDown({}, saved("up1355", "1355"), answers)).toBeNull()
  })

  // a 1355 proxy that ended uncleanly leaves its port saved, and portless's own start would trust the CA with no click, so the launcher starts it again through startFallback
  test("a saved 1355 that answers nothing reads as 443 down", async () => {
    expect(await proxyDown({}, saved("dead1355", "1355"), silent)).toBe(443)
    expect(await proxyDown({ PORTLESS_PORT: "1355" }, join(dir, "fresh"), silent)).toBe(443)
  })

  // the 1355 proxy keeps its own folder, so a service install, which reads portless's own folder, leaves it running
  test("the 1355 proxy's folder sits in portless's own, and maps back to it", () => {
    expect(fallbackDir("/h/.portless")).toBe("/h/.portless/fallback")
    expect(serviceDir("/h/.portless/fallback")).toBe("/h/.portless")
    expect(serviceDir("/h/.portless")).toBe("/h/.portless")
  })

  // a process outside the stack (the supervisor's web route, health-beat) has no PORTLESS_STATE_DIR, so it finds the 1355 proxy's folder by whose proxy serves
  test("portlessDir names the fallback folder while only its proxy serves", () => {
    const home = join(dir, "home")
    const own = join(home, ".portless")
    mkdirSync(fallbackDir(own), { recursive: true })
    const dead = String(Bun.spawnSync(["true"]).pid)
    const live = String(process.pid)
    const pids = (main: string, fallback: string) => {
      writeFileSync(join(own, "proxy.pid"), main)
      writeFileSync(join(fallbackDir(own), "proxy.pid"), fallback)
      return portlessDir({ HOME: home })
    }
    expect(pids(dead, live)).toBe(fallbackDir(own))
    expect(pids(live, live)).toBe(own)
    expect(pids(dead, dead)).toBe(own)
    expect(portlessDir({ HOME: home, PORTLESS_STATE_DIR: "/set" })).toBe("/set")
  })

  const never = (path: string): string => {
    throw new Error(`discard ran on ${path}`)
  }

  // one CA for both proxies: the 1355 proxy serves under the CA the owner trusted for 443
  test("shareCa copies portless's own CA into an empty fallback folder, the key at mode 600", () => {
    const own = join(dir, "share-own")
    mkdirSync(own)
    writeFileSync(join(own, "ca.pem"), "own cert")
    writeFileSync(join(own, "ca-key.pem"), "own key", { mode: 0o600 })
    const fresh = fallbackDir(own)
    expect(shareCa(own, fresh, never)).toBe(true)
    expect(readFileSync(join(fresh, "ca.pem"), "utf8")).toBe("own cert")
    expect(readFileSync(join(fresh, "ca-key.pem"), "utf8")).toBe("own key")
    expect(statSync(join(fresh, "ca-key.pem")).mode & 0o777).toBe(0o600)
    writeFileSync(join(fresh, "server.pem"), "leaf")
    expect(shareCa(own, fresh, never)).toBe(true)
    expect(readFileSync(join(fresh, "server.pem"), "utf8")).toBe("leaf")
    const none = join(dir, "share-none")
    expect(shareCa(none, fallbackDir(none), never)).toBe(false)
    expect(existsSync(fallbackDir(none))).toBe(false)
  })

  // a Mac that ran on 1355 under a CA of the fallback's own, then set 443 up by the click, then lost 443: 1355 moves to the trusted CA
  test("shareCa replaces a fallback CA that differs, its leaves going to the trash, and leaves portless's own folder as it was", () => {
    const own = join(dir, "replace-own")
    mkdirSync(own)
    writeFileSync(join(own, "ca.pem"), "trusted cert")
    writeFileSync(join(own, "ca-key.pem"), "trusted key", { mode: 0o600 })
    writeFileSync(join(own, "server.pem"), "443 leaf")
    const fallback = fallbackDir(own)
    mkdirSync(join(fallback, "host-certs"), { recursive: true })
    const planted: [string, string][] = [
      ["ca.pem", "old cert"],
      ["ca-key.pem", "old key"],
      ["server.pem", "old leaf"],
      ["server-key.pem", "old leaf key"],
      ["host-certs/web_localhost.pem", "old host leaf"],
      ["routes.json", "[]"],
    ]
    for (const [name, words] of planted) writeFileSync(join(fallback, name), words)
    const before = ["ca.pem", "ca-key.pem", "server.pem"].map((name) =>
      readFileSync(join(own, name), "utf8"),
    )
    const roots = { home: dir, main: join(dir, "main"), trash: join(dir, "data", "trash") }
    const sent: string[] = []
    const toTrash = (path: string) => (
      sent.push(path),
      discard(path, { reason: "test", session: "test" }, roots)
    )
    expect(shareCa(own, fallback, toTrash)).toBe(true)
    expect(sent).toEqual([join(fallback, "host-certs")])
    expect(existsSync(join(fallback, "host-certs"))).toBe(false)
    expect(readFileSync(join(fallback, "ca.pem"), "utf8")).toBe("trusted cert")
    expect(readFileSync(join(fallback, "ca-key.pem"), "utf8")).toBe("trusted key")
    expect(statSync(join(fallback, "ca-key.pem")).mode & 0o777).toBe(0o600)
    expect(existsSync(join(fallback, "server.pem"))).toBe(false)
    expect(existsSync(join(fallback, "server-key.pem"))).toBe(false)
    expect(readFileSync(join(fallback, "routes.json"), "utf8")).toBe("[]")
    expect(
      ["ca.pem", "ca-key.pem", "server.pem"].map((name) => readFileSync(join(own, name), "utf8")),
    ).toEqual(before)
    expect(shareCa(own, fallback, never)).toBe(true)
  })

  test("shareCa keeps a fallback CA that differs, and answers false, when the trash refuses its leaves", () => {
    const own = join(dir, "refused-own")
    mkdirSync(own)
    writeFileSync(join(own, "ca.pem"), "trusted cert")
    writeFileSync(join(own, "ca-key.pem"), "trusted key", { mode: 0o600 })
    const fallback = fallbackDir(own)
    mkdirSync(fallback)
    writeFileSync(join(fallback, "ca.pem"), "old cert")
    writeFileSync(join(fallback, "server.pem"), "old leaf")
    expect(shareCa(own, fallback, () => "refused")).toBe(false)
    expect(readFileSync(join(fallback, "ca.pem"), "utf8")).toBe("old cert")
    expect(readFileSync(join(fallback, "server.pem"), "utf8")).toBe("old leaf")
  })

  test("passes a stack that skips portless", async () => {
    expect(await proxyDown({ PORTLESS: "0" }, join(dir, "fresh"), silent)).toBeNull()
  })

  test("the setup a stack cannot do names the sudo commands and fixed ports", () => {
    const setup = proxySetup(443)
    expect(setup).toContain("port 443 needs sudo")
    expect(setup).toContain("`sudo node_modules/.bin/portless service install`")
    expect(setup).toContain("`PORTLESS=0 bun run dev`")
  })
})

// #810: with the proxy down, the stack starts portless on 1355 as this user, its trust step skipped; a fake portless records its argv, and the listening reader is injected, so nothing here binds 1355 or touches a keychain.
describe("startFallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-fallback-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))
  const fake = (name: string, body: string) => {
    const cli = join(dir, name)
    writeFileSync(cli, `#!/bin/sh\necho "$@" > "${cli}.argv"\n${body}\n`, { mode: 0o755 })
    return cli
  }

  test("runs portless proxy start on 1355 with --skip-trust, and passes once 1355 answers", async () => {
    const cli = fake("up", "exit 0")
    const asked: number[] = []
    const failed = await startFallback(cli, { PATH: process.env.PATH }, async (port) => {
      asked.push(port)
      return true
    })
    expect(failed).toBeNull()
    expect(FALLBACK_PORT).toBe(1355)
    expect((await Bun.file(`${cli}.argv`).text()).trim()).toBe("proxy start -p 1355 --skip-trust")
    expect(asked).toEqual([1355])
  })

  test("a start that leaves 1355 silent answers with portless's last line", async () => {
    const cli = fake("down", 'echo "Error: something held the port" >&2; exit 1')
    expect(await startFallback(cli, { PATH: process.env.PATH }, async () => false)).toBe(
      "Error: something held the port",
    )
  })
})

describe("listening", () => {
  test("reads a loopback port taking connections, and one that refuses them", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const { port } = server
    try {
      expect(await listening(port)).toBe(true)
    } finally {
      server.stop(true)
    }
    expect(await listening(port)).toBe(false)
  })
})

describe("prefixOf", () => {
  test("cleans the branch's last segment as portless does", () => {
    const cases: [string, string | null][] = [
      ["feat/a", "a"],
      ["feat/Desk", "desk"],
      ["feat/desk-", "desk"],
      ["feat/desk_", "desk"],
      ["feat/_desk", "desk"],
      ["live/desk", "desk"],
      ["feat/a.b__c", "a-b-c"],
      ["feat/main", "main"],
    ]
    for (const [branch, prefix] of cases)
      expect([branch, prefixOf(branch)]).toEqual([branch, prefix])
  })

  test("gives none on main or master, or when nothing is left", () => {
    for (const branch of ["main", "master", "feat/___", "feat/--"]) {
      expect([branch, prefixOf(branch)]).toEqual([branch, null])
    }
  })
})
