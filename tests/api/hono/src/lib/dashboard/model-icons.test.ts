import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type Fetch,
  iconFor,
  isMaker,
  makersOf,
  MODELS_DEV_IDS,
  servedIconHeaders,
  serveModelIcon,
} from "../../../../../../api/hono/src/lib/dashboard/model-icons"
import { orgOf } from "../../../../../../packages/config/src/org"

// models.dev's fallback, as measured: one SVG it answers every unknown provider id with, at 200
const FALLBACK = '<svg viewBox="0 0 24 24" fill="none"><path d="M9.8 15.9L9 18.7"/></svg>\n'
const LOGO = '<svg viewBox="0 0 40 40"><path d="M26.9 9.8H22.1" fill="currentColor"/></svg>\n'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
// a maker with no models.dev logo and no MODELS_DEV_IDS entry, so its Hugging Face avatar is fetched
const HF = "https://huggingface.co/api/organizations/heron-ai/avatar"
const CDN = "https://cdn-avatars.huggingface.co/v1/production/uploads/x/heron.png"

// A fetch stub answering by URL, as models.dev does for a URL it does not hold (its fallback) and Hugging Face for an org it does not know (404); every URL asked is recorded, so no test reaches the network.
const stub = (answers: Record<string, () => Response> = {}) => {
  const asked: string[] = []
  const fetch: Fetch = async (url) => {
    asked.push(url)
    const answer = answers[url]
    if (answer) return answer()
    if (url.startsWith("https://models.dev/logos/")) return new Response(FALLBACK)
    return new Response("not found", { status: 404 })
  }
  return { asked, fetch }
}

const offline: Fetch = async () => {
  throw new TypeError("fetch failed")
}

const scratch = () => mkdtempSync(join(tmpdir(), "model-icons-"))

describe("makersOf", () => {
  test("each backend's maker, then the Hugging Face org of each local model's repo id; a bare id has none", () => {
    expect(
      makersOf([
        { id: "ornith-ai/Ornith-1.5-122B-NVFP4" },
        { id: "RecursiveSI/Thing-7B" },
        { id: "ornith-1.5-122b-nvfp4" },
      ]),
    ).toEqual(new Set(["anthropic", "zai", "ornith-ai", "RecursiveSI"]))
    expect(makersOf([])).toEqual(new Set(["anthropic", "zai"]))
  })

  test("the local models PLAYGROUND_LOCAL_MODELS names, as the route reads them through orgOf, give each org/repo id's org", () => {
    const { local } = orgOf({
      PLAYGROUND_LOCAL_MODELS: "M=ornith-ai/Ornith-1.5-122B-NVFP4,K=ornith-1.5-35b-a3b-nvfp4",
    })
    expect(makersOf(local.models)).toEqual(new Set(["anthropic", "zai", "ornith-ai"]))
    expect(makersOf(orgOf({}).local.models)).toEqual(new Set(["anthropic", "zai"]))
  })

  test("a maker is a plain name, never a path or a URL", () => {
    for (const ok of ["anthropic", "ornith-ai", "RecursiveSI", "a.b_c"])
      expect(isMaker(ok)).toBe(true)
    for (const bad of ["", "../x", "a/b", "-x", "x?y", "a b", "x".repeat(97)])
      expect(isMaker(bad)).toBe(false)
  })
})

describe("iconFor", () => {
  test("a new maker's models.dev logo is fetched once, by its lowercased name, and served from the cache after", async () => {
    const dir = scratch()
    const { asked, fetch } = stub({
      "https://models.dev/logos/recursivesi.svg": () => new Response(LOGO),
    })
    const first = await iconFor("RecursiveSI", { dir, fetch })
    expect(first).toEqual({ bytes: new TextEncoder().encode(LOGO), type: "image/svg+xml" })
    // the cached file's own mtime is the clock, so the row holds under a clock set ahead
    const now = () => statSync(join(dir, "RecursiveSI.svg")).mtimeMs
    const again = await iconFor("RecursiveSI", { dir, fetch, now })
    expect(again).toEqual(first)
    expect(asked).toEqual([
      "https://models.dev/logos/playground-no-such-maker.svg",
      "https://models.dev/logos/recursivesi.svg",
    ])
    expect(readdirSync(dir)).toEqual(["RecursiveSI.svg"])
  })

  test("models.dev's fallback counts as no logo, so the maker's Hugging Face avatar is taken, typed by its bytes", async () => {
    const dir = scratch()
    const { asked, fetch } = stub({
      [CDN]: () => new Response(PNG, { headers: { "content-type": "text/html" } }),
      [HF]: () => Response.json({ avatarUrl: CDN }),
    })
    expect(await iconFor("heron-ai", { dir, fetch })).toEqual({ bytes: PNG, type: "image/png" })
    expect(asked.slice(1)).toEqual(["https://models.dev/logos/heron-ai.svg", HF, CDN])
  })

  test("an avatar URL on a host other than huggingface.co, or an answer that is no image, is refused and never served", async () => {
    for (const avatarUrl of [
      "https://example.com/a.png",
      "http://cdn-avatars.huggingface.co/a.png",
      "https://huggingface.co.example.com/a.png",
    ]) {
      const { asked, fetch } = stub({ [HF]: () => Response.json({ avatarUrl }) })
      expect(await iconFor("heron-ai", { dir: scratch(), fetch })).toBeNull()
      expect(asked).not.toContain(avatarUrl)
    }
    const html = stub({
      [CDN]: () => new Response("<script>alert(1)</script>"),
      [HF]: () => Response.json({ avatarUrl: CDN }),
    })
    expect(await iconFor("heron-ai", { dir: scratch(), fetch: html.fetch })).toBeNull()
  })

  test("a maker with neither is cached as none for a day, then asked again", async () => {
    const dir = scratch()
    const { asked, fetch } = stub()
    expect(await iconFor("nobody", { dir, fetch })).toBeNull()
    // the marker's own mtime is the clock, so the row holds on any day and under a clock set ahead
    let now = statSync(join(dir, "nobody.none")).mtimeMs
    const once = asked.length
    expect(await iconFor("nobody", { dir, fetch, now: () => now })).toBeNull()
    expect(asked).toHaveLength(once)
    now += 25 * 60 * 60 * 1000
    expect(await iconFor("nobody", { dir, fetch, now: () => now })).toBeNull()
    expect(asked.length).toBeGreaterThan(once)
  })

  test("offline gives no icon and caches nothing, so the next ask fetches again", async () => {
    const dir = scratch()
    expect(await iconFor("anthropic", { dir, fetch: offline })).toBeNull()
    expect(readdirSync(dir)).toEqual([])
    const { fetch } = stub({ "https://models.dev/logos/anthropic.svg": () => new Response(LOGO) })
    expect((await iconFor("anthropic", { dir, fetch }))?.type).toBe("image/svg+xml")
  })

  test("a 429 or a 5xx from a source reads as out of reach and caches nothing, where a 404 is no icon", async () => {
    for (const status of [429, 500, 503]) {
      const dir = scratch()
      const { fetch } = stub({ [HF]: () => new Response("busy", { status }) })
      expect(await iconFor("heron-ai", { dir, fetch })).toBeNull()
      expect(readdirSync(dir)).toEqual([])
    }
    const dir = scratch()
    expect(await iconFor("heron-ai", { dir, fetch: stub().fetch })).toBeNull()
    expect(readdirSync(dir)).toEqual(["heron-ai.none"])
  })

  test("an answer past 1 MB is refused, whether its length is declared or not", async () => {
    const big = new Uint8Array(1024 * 1024 + 1)
    big.set(PNG)
    const streamed = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(big)
            controller.close()
          },
        }),
      )
    for (const answer of [() => new Response(big), streamed]) {
      const { fetch } = stub({ [CDN]: answer, [HF]: () => Response.json({ avatarUrl: CDN }) })
      expect(await iconFor("heron-ai", { dir: scratch(), fetch })).toBeNull()
    }
  })
})

describe("servedIconHeaders", () => {
  test("a cached icon is served as the type the cache gave it, with no script able to run", () => {
    expect(servedIconHeaders("image/svg+xml")).toEqual({
      "cache-control": "private, max-age=86400",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "content-type": "image/svg+xml",
      "x-content-type-options": "nosniff",
    })
  })
})

describe("serveModelIcon", () => {
  const LOCAL = [{ id: "RecursiveSI/Thing-7B", label: "R" }]

  test("a new maker in config, with the fetch mocked, is fetched, cached and served with servedIconHeaders", async () => {
    const dir = scratch()
    const { fetch } = stub({ "https://models.dev/logos/recursivesi.svg": () => new Response(LOGO) })
    const served = await serveModelIcon("RecursiveSI", { dir, fetch, local: LOCAL })
    expect(served.status).toBe(200)
    expect(Object.fromEntries(served.headers)).toMatchObject(servedIconHeaders("image/svg+xml"))
    expect(await served.text()).toBe(LOGO)
    const cachedOnly = await serveModelIcon("RecursiveSI", { dir, fetch: offline, local: LOCAL })
    expect(await cachedOnly.text()).toBe(LOGO)
  })

  test("a maker config does not name, a bad name, no icon or offline is a 404, and only a named maker is fetched", async () => {
    const { asked, fetch } = stub()
    for (const maker of ["RecursiveSI", "someone-else", "../etc", "nobody"])
      await expect(serveModelIcon(maker, { dir: scratch(), fetch, local: [] })).rejects.toThrow(
        "No icon for that maker",
      )
    expect(asked).toEqual([])
    await expect(
      serveModelIcon("anthropic", { dir: scratch(), fetch: offline, local: [] }),
    ).rejects.toThrow("No icon for that maker")
  })
})

// Ornith's models are listed on models.dev under DeepReinforce, the team that makes them, whose logo there is models.dev's placeholder for now: the owner takes it, drawn as the other makers' logos are (PG-2662).
describe("a maker models.dev lists under another id", () => {
  test("Ornith takes deepreinforce's models.dev logo as it is, its placeholder included, and never its Hugging Face avatar", async () => {
    expect(MODELS_DEV_IDS["ornith-ai"]).toBe("deepreinforce")
    const { asked, fetch } = stub()
    const icon = await iconFor("ornith-ai", { dir: scratch(), fetch })
    expect(icon).toEqual({ bytes: new TextEncoder().encode(FALLBACK), type: "image/svg+xml" })
    expect(asked).toEqual(["https://models.dev/logos/deepreinforce.svg"])
  })

  test("it is cached under that id, so an avatar cached for ornith-ai before is never served again", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "ornith-ai.webp"), PNG)
    const { fetch } = stub({
      "https://models.dev/logos/deepreinforce.svg": () => new Response(LOGO),
    })
    expect((await iconFor("ornith-ai", { dir, fetch }))?.type).toBe("image/svg+xml")
    expect(readdirSync(dir).sort()).toEqual(["deepreinforce.svg", "ornith-ai.webp"])
    expect(await iconFor("ornith-ai", { dir, fetch: offline })).toEqual({
      bytes: new TextEncoder().encode(LOGO),
      type: "image/svg+xml",
    })
  })

  test("offline, with nothing cached, gives no icon and caches nothing", async () => {
    const dir = scratch()
    expect(await iconFor("ornith-ai", { dir, fetch: offline })).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })
})

// A found logo is fetched again once a week, so a maker's new logo, or a real one in place of models.dev's placeholder, comes in by itself, while a failed fetch keeps the old one served (PG-2662).
describe("a cached logo's weekly refresh", () => {
  const DAY = 24 * 60 * 60 * 1000
  const OLD = '<svg viewBox="0 0 24 24"><path d="M1 1H2"/></svg>\n'
  // a written file's own mtime, days on, is the clock, so the rows hold under a clock set ahead
  const aged = (file: string, days: number) => {
    const at = statSync(file).mtimeMs + days * DAY
    return () => at
  }

  test("a logo cached under 7 days ago is served from the cache, with no fetch", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "anthropic.svg"), OLD)
    const { asked, fetch } = stub({
      "https://models.dev/logos/anthropic.svg": () => new Response(LOGO),
    })
    expect(
      await iconFor("anthropic", { dir, fetch, now: aged(join(dir, "anthropic.svg"), 6) }),
    ).toEqual({
      bytes: new TextEncoder().encode(OLD),
      type: "image/svg+xml",
    })
    expect(asked).toEqual([])
  })

  test("past 7 days it is fetched again, and the new logo found replaces it, an old file of another type removed", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "anthropic.png"), PNG)
    const { fetch } = stub({ "https://models.dev/logos/anthropic.svg": () => new Response(LOGO) })
    const icon = { bytes: new TextEncoder().encode(LOGO), type: "image/svg+xml" as const }
    const now = aged(join(dir, "anthropic.png"), 8)
    expect(await iconFor("anthropic", { dir, fetch, now })).toEqual(icon)
    expect(readdirSync(dir)).toEqual(["anthropic.svg"])
    expect(await iconFor("anthropic", { dir, fetch: offline, now })).toEqual(icon)
  })

  test("past 7 days with the fetch failing, offline or with no logo found, the old logo stays and is served", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "heron-ai.png"), PNG)
    const old = { bytes: PNG, type: "image/png" as const }
    const now = aged(join(dir, "heron-ai.png"), 8)
    expect(await iconFor("heron-ai", { dir, fetch: offline, now })).toEqual(old)
    expect(await iconFor("heron-ai", { dir, fetch: stub().fetch, now })).toEqual(old)
    expect(readdirSync(dir)).toEqual(["heron-ai.png"])
  })
})
