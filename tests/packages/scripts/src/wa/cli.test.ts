import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { sender } from "../../../../../packages/scripts/src/ops-wa/bridge"
import { serve, socketPath } from "../../../../../packages/scripts/src/ops-wa/server"
import { fakeSocket, OWNER, SPARE } from "../ops-wa/fake-socket"

const HOUR = 3_600_000
const CLI = join(import.meta.dir, "../../../../../packages/scripts/src/wa/cli.ts")
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A data folder of its own, under /tmp so its socket's path stays inside the 104 bytes macOS takes, with a body file holding the text given.
const machine = (text: string) => {
  const data = mkdtempSync("/tmp/wa-cli-")
  dirs.push(data)
  mkdirSync(join(data, "whatsapp"), { mode: 0o700 })
  const body = join(data, "body.md")
  writeFileSync(body, text)
  return { body, data }
}

const wa = async (data: string, args: string[]) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
    env: { ...process.env, PLAYGROUND_DATA_DIR: data },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, out: (out + err).trim() }
}

describe("ops-wa's socket", () => {
  test("sends one connection's body once, whatever bytes follow its line", async () => {
    const { data } = machine("")
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      return "sent"
    })
    try {
      const answer = Promise.withResolvers<string>()
      let text = ""
      const socket = await Bun.connect({
        socket: {
          close: () => answer.resolve(text),
          data: (_, chunk) => void (text += chunk.toString()),
        },
        unix: socketPath(data),
      })
      socket.write('{"body":"first"}\n')
      await Bun.sleep(5)
      socket.write('{"body":"second"}\n')
      expect(await answer.promise).toBe('{"sent":true}\n')
      expect(got).toEqual(["first"])
    } finally {
      server.stop(true)
    }
  })
})

describe("playground wa send", () => {
  test("takes a body by its absolute path alone", async () => {
    const { data } = machine("hi")
    const { code, out } = await wa(data, ["send", "body.md"])
    expect(code).toBe(2)
    expect(out).toStartWith("usage: playground wa send [--to alert] <file>")
  })

  test("refuses a token-shaped body before it reaches ops-wa", async () => {
    const { body, data } = machine(`the key is xoxb-${"1".repeat(12)}-made-up`)
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      return "sent"
    })
    try {
      expect(await wa(data, ["send", body])).toEqual({
        code: 1,
        out: "wa send: the body holds a Slack token, which never goes over WhatsApp",
      })
      expect(got).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("says so when ops-wa is not running", async () => {
    const { body, data } = machine("hi")
    const { code, out } = await wa(data, ["send", body])
    expect(code).toBe(1)
    expect(out).toStartWith("wa send: ops-wa is not running")
  })

  test("hands the body to ops-wa's socket, mode 600, and prints its answer", async () => {
    const { body, data } = machine("all green\n")
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      if (got.length > 1)
        throw new Error("ops-wa is not connected to WhatsApp now; try again in a minute")
      return "sent"
    })
    try {
      expect(statSync(socketPath(data)).mode & 0o777).toBe(0o600)
      expect(await wa(data, ["send", body])).toEqual({ code: 0, out: "wa send: sent" })
      expect(got).toEqual(["all green"])
      expect(await wa(data, ["send", body])).toEqual({
        code: 1,
        out: "wa send: ops-wa is not connected to WhatsApp now; try again in a minute",
      })
    } finally {
      server.stop(true)
    }
  })
})

describe("playground wa send --to alert (#2756)", () => {
  test("hands the body to ops-wa as a guest's reply, and a stray word after it is refused", async () => {
    const { body, data } = machine("glad you asked\n")
    const got: [string, string][] = []
    const server = serve(socketPath(data), async (b, kind) => {
      got.push([b, kind])
      return "sent"
    })
    try {
      expect(await wa(data, ["send", "--to", "alert", body])).toEqual({
        code: 0,
        out: "wa send: sent",
      })
      expect((await wa(data, ["send", "--to", "owner", body])).code).toBe(2)
      expect((await wa(data, ["alert", "--to", "alert", body])).code).toBe(2)
      expect(got).toEqual([["glad you asked", "guest"]])
    } finally {
      server.stop(true)
    }
  })
})

describe("playground wa react (#2755)", () => {
  test("hands one emoji to ops-wa as a reaction, on the owner's latest, the guest's, or a message by its id", async () => {
    const { data } = machine("")
    const got: unknown[] = []
    const server = serve(
      socketPath(data),
      async () => "sent",
      undefined,
      async (emoji, on) => {
        got.push([emoji, on])
        return "sent"
      },
    )
    try {
      expect(await wa(data, ["react", "✅"])).toEqual({ code: 0, out: "wa react: sent" })
      expect(await wa(data, ["react", "👀", "--to", "alert"])).toEqual({
        code: 0,
        out: "wa react: sent",
      })
      expect((await wa(data, ["react", "👍🏽", "--id", "ABC123"])).code).toBe(0)
      expect(got).toEqual([
        ["✅", { who: "owner" }],
        ["👀", { who: "alert" }],
        ["👍🏽", { id: "ABC123", who: "owner" }],
      ])
    } finally {
      server.stop(true)
    }
  })

  test("refuses words, a missing emoji or a stray flag, before it reaches ops-wa", async () => {
    const { data } = machine("")
    for (const args of [
      ["react"],
      ["react", "ok"],
      ["react", "✅", "--to", "owner"],
      ["react", "✅", "--id"],
    ])
      expect((await wa(data, args)).code).toBe(2)
  })

  test("prints ops-wa's refusal", async () => {
    const { data } = machine("")
    const server = serve(
      socketPath(data),
      async () => "sent",
      undefined,
      async () => {
        throw new Error("the owner has no message kept to react to")
      },
    )
    try {
      expect(await wa(data, ["react", "✅"])).toEqual({
        code: 1,
        out: "wa react: the owner has no message kept to react to",
      })
    } finally {
      server.stop(true)
    }
  })
})

describe("playground wa alert (#2748)", () => {
  test("hands the body to ops-wa as an alert to the owner first, with its source, or to both at once with --now-both, while wa send's stays a reply", async () => {
    const { body, data } = machine("ops-tick is down\n")
    const got: [string, string, string | undefined][] = []
    const server = serve(socketPath(data), async (b, kind, source) => {
      got.push([b, kind, source])
      return "sent"
    })
    try {
      expect(await wa(data, ["alert", body])).toEqual({ code: 0, out: "wa alert: sent" })
      expect(await wa(data, ["alert", "--source", "test:2026-11-18T15:40Z", body])).toEqual({
        code: 0,
        out: "wa alert: sent",
      })
      expect(await wa(data, ["alert", "--now-both", body])).toEqual({
        code: 0,
        out: "wa alert: sent",
      })
      expect(await wa(data, ["send", body])).toEqual({ code: 0, out: "wa send: sent" })
      expect(got).toEqual([
        ["ops-tick is down", "first", undefined],
        ["ops-tick is down", "first", "test:2026-11-18T15:40Z"],
        ["ops-tick is down", "alert", undefined],
        ["ops-tick is down", "reply", undefined],
      ])
      const bad = await wa(data, ["alert", "--source", "no-kind", body])
      expect(bad.code).toBe(2)
      expect(bad.out).toContain("--source takes <kind>:<ref>")
    } finally {
      server.stop(true)
    }
  })

  test("prints who it reached when it reached one number alone", async () => {
    const { body, data } = machine("ops-tick is down")
    const server = serve(
      socketPath(data),
      async () => "sent to the owner alone: the alert number has never written to this number",
    )
    try {
      expect(await wa(data, ["alert", body])).toEqual({
        code: 0,
        out: "wa alert: sent to the owner alone: the alert number has never written to this number",
      })
    } finally {
      server.stop(true)
    }
  })

  test("refuses a token-shaped body before it reaches ops-wa", async () => {
    const { body, data } = machine(`the key is xoxb-${"1".repeat(12)}-made-up`)
    const { code, out } = await wa(data, ["alert", body])
    expect(code).toBe(1)
    expect(out).toBe("wa alert: the body holds a Slack token, which never goes over WhatsApp")
  })

  test("wa status reads the numbers from the settings and each one's last message", async () => {
    const { data } = machine("")
    mkdirSync(join(data, "extensions"))
    writeFileSync(
      join(data, "extensions", "policy.json"),
      JSON.stringify({ values: { "wa.owner": "+15550100001" } }),
    )
    writeFileSync(
      join(data, "whatsapp", "owner.json"),
      JSON.stringify({ jid: `${"15550100001"}@s.whatsapp.net`, ownerAt: 0 }),
    )
    expect(await wa(data, ["status"])).toEqual({
      code: 0,
      out: [
        "wa status: owner ••••0001: written since 1970-01-01T00:00:00.000Z, so alerts reach it; its 24 hours for replies are over until it writes",
        "wa status: alert: none set (wa.alert)",
      ].join("\n"),
    })
  })
})

describe("playground wa alert-set", () => {
  test("asks ops-wa to set the second number from the owner's message by its id, and prints its answer", async () => {
    const { data } = machine("")
    const asked: string[] = []
    const server = serve(
      socketPath(data),
      async () => "sent",
      async (id) => {
        asked.push(id)
        return "set the second number to ...0444 from the owner's message own1; it was unset"
      },
    )
    try {
      expect(await wa(data, ["alert-set", "--from-owner-msg", "own1"])).toEqual({
        code: 0,
        out: "wa alert-set: set the second number to ...0444 from the owner's message own1; it was unset",
      })
      expect(asked).toEqual(["own1"])
    } finally {
      server.stop(true)
    }
  })

  test("prints ops-wa's refusal and exits 1", async () => {
    const { data } = machine("")
    const server = serve(
      socketPath(data),
      async () => "sent",
      async () => {
        throw new Error("no message of the owner's in the last 24 hours has the id in9")
      },
    )
    try {
      expect(await wa(data, ["alert-set", "--from-owner-msg", "in9"])).toEqual({
        code: 1,
        out: "wa alert-set: no message of the owner's in the last 24 hours has the id in9",
      })
    } finally {
      server.stop(true)
    }
  })

  test("takes --from-owner-msg and an id alone", async () => {
    const { data } = machine("")
    for (const args of [["alert-set"], ["alert-set", "own1"], ["alert-set", "--from-owner-msg"]])
      expect((await wa(data, args)).code).toBe(2)
  })
})

describe("playground wa send --file (#2783)", () => {
  test("hands the file's path to ops-wa beside the body, to the owner or as a guest's reply, and alone with no body", async () => {
    const { body, data } = machine("the new board\n")
    const shot = join(data, "wa", "outbox", "board.png")
    mkdirSync(join(data, "wa", "outbox"), { recursive: true })
    writeFileSync(shot, "made-up bytes")
    const got: [string, string, string | undefined][] = []
    const server = serve(socketPath(data), async (b, kind, _source, extra) => {
      got.push([b, kind, extra.file])
      return "sent"
    })
    try {
      expect(await wa(data, ["send", "--file", shot, body])).toEqual({
        code: 0,
        out: "wa send: sent",
      })
      expect(await wa(data, ["send", "--to", "alert", "--file", shot, body])).toEqual({
        code: 0,
        out: "wa send: sent",
      })
      expect(await wa(data, ["send", "--file", shot])).toEqual({ code: 0, out: "wa send: sent" })
      expect(got).toEqual([
        ["the new board", "reply", shot],
        ["the new board", "guest", shot],
        ["", "reply", shot],
      ])
    } finally {
      server.stop(true)
    }
  })

  test("takes the file by its absolute path alone, and wa alert takes none", async () => {
    const { body, data } = machine("hi")
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      return "sent"
    })
    try {
      for (const args of [
        ["send", "--file", "board.png", body],
        ["send", "--file", join(data, "gone.png"), body],
        ["send", "--file"],
        ["alert", "--file", body, body],
      ]) {
        const { code, out } = await wa(data, args)
        expect(code).toBe(2)
        expect(out).toContain("playground wa send [--to alert] --file <path> [<file>]")
      }
      expect(got).toEqual([])
    } finally {
      server.stop(true)
    }
  })
})

describe("playground wa send's structure (#2799)", () => {
  test("hands a location, a quote, an edit and a delete to ops-wa, and prints the ids ops-wa sent", async () => {
    const { body, data } = machine("Made-up Cafe\n")
    const got: [string, string, unknown][] = []
    const server = serve(socketPath(data), async (b, kind, _source, extra) => {
      got.push([b, kind, extra])
      return { ids: got.length === 1 ? ["m1", "m2"] : got.length === 2 ? ["m3"] : [], said: "sent" }
    })
    try {
      expect(await wa(data, ["send", "--location", "12.5,-45.25", body])).toEqual({
        code: 0,
        out: "wa send: sent (ids m1, m2)",
      })
      expect(await wa(data, ["send", "--to", "alert", "--quote", "own1", body])).toEqual({
        code: 0,
        out: "wa send: sent (id m3)",
      })
      expect(await wa(data, ["send", "--edit", "m3", body])).toEqual({
        code: 0,
        out: "wa send: sent",
      })
      expect(await wa(data, ["send", "--delete", "m3"])).toEqual({ code: 0, out: "wa send: sent" })
      expect(got).toEqual([
        ["Made-up Cafe", "reply", { location: { lat: 12.5, lon: -45.25 } }],
        ["Made-up Cafe", "guest", { quote: "own1" }],
        ["Made-up Cafe", "reply", { edit: "m3" }],
        ["", "reply", { delete: "m3" }],
      ])
    } finally {
      server.stop(true)
    }
  })

  test("hands --status to ops-wa, and prints whether the live status was edited or sent", async () => {
    const { body, data } = machine("3 PRs in review\n")
    const got: [string, string, unknown][] = []
    const server = serve(socketPath(data), async (b, kind, _source, extra) => {
      got.push([b, kind, extra])
      return { ids: ["m1"], said: got.length === 1 ? "sent" : "edited the live status" }
    })
    try {
      expect(await wa(data, ["send", "--status", body])).toEqual({
        code: 0,
        out: "wa send: sent (id m1)",
      })
      expect(await wa(data, ["send", "--status", body])).toEqual({
        code: 0,
        out: "wa send: edited the live status (id m1)",
      })
      expect(got).toEqual([
        ["3 PRs in review", "reply", { status: true }],
        ["3 PRs in review", "reply", { status: true }],
      ])
    } finally {
      server.stop(true)
    }
  })

  test("refuses a bad location, two extras and a bodiless edit before ops-wa", async () => {
    const { body, data } = machine("x")
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      return "sent"
    })
    try {
      expect(await wa(data, ["send", "--location", "91,0", body])).toEqual({
        code: 1,
        out: "wa send: a location takes a latitude from -90 to 90 and a longitude from -180 to 180",
      })
      expect((await wa(data, ["send", "--location", "1,2,3", body])).code).toBe(1)
      expect((await wa(data, ["send", "--location", "north", body])).code).toBe(1)
      expect(await wa(data, ["send", "--edit", "m1", "--delete", "m1", body])).toEqual({
        code: 1,
        out: "wa send: a send takes one of a file, a location, an edit and a delete",
      })
      expect((await wa(data, ["send", "--edit", "m1"])).code).toBe(2)
      expect((await wa(data, ["send", "--quote"])).code).toBe(2)
      expect((await wa(data, ["alert", "--quote", "own1", body])).code).toBe(2)
      expect(got).toEqual([])
    } finally {
      server.stop(true)
    }
  })
})

describe("quiet hours (#2887)", () => {
  test("a held reply prints that it is held, and a refused poll's kin, a location or a quote, prints one refusal line, which the whatsapp skill reads as nothing sent", async () => {
    const { body, data } = machine("the train is green\n")
    const dir = join(data, "whatsapp")
    const now = Date.parse("2026-11-11T03:00:00Z")
    writeFileSync(
      join(dir, "owner.json"),
      JSON.stringify({ firstAt: now - 2 * HOUR, ownerAt: now - 2 * HOUR }),
    )
    const fake = fakeSocket()
    const send = sender({
      device: SPARE,
      dir,
      now: () => now,
      owner: OWNER,
      quiet: async () => ({ end: 6, start: 0, zone: "UTC" }),
      sleep: async () => {},
      sock: fake.sock,
    })
    const server = serve(socketPath(data), send.out)
    try {
      const held = await wa(data, ["send", body])
      expect(held.code).toBe(0)
      expect(held.out).toStartWith("wa send: held for quiet hours")
      for (const extra of [
        ["--location", "12.5,-45.25"],
        ["--quote", "in1"],
      ]) {
        const refused = await wa(data, ["send", ...extra, body])
        expect(refused.code).toBe(1)
        expect(refused.out).toStartWith("wa send: quiet hours: ")
        expect(refused.out.split("\n")).toHaveLength(1)
      }
      expect(fake.sent).toEqual([])
    } finally {
      server.stop(true)
    }
  })
})
