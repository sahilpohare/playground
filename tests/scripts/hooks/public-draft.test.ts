import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { UNSET_REPOS } from "../../../packages/scripts/src/trace-count/kinds"
import { FIGURE, publicDraftHit, publicRefusal } from "../../../scripts/hooks/public-draft"
import { storeWith } from "./render-set"

const root = join(import.meta.dir, "..", "..", "..")
const SCRIPT = join(root, "scripts", "hooks", "public-draft.ts")
// Made-up values, one per list key, as no-public-leak's own tests use.
const PUBLIC = {
  companies: ["Vantorix"],
  handles: ["qmarsh"],
  linearKeys: ["MADEVX"],
  names: ["Quilla Marsh"],
  slackIds: ["C0MADE0401"],
}
const REPOS = {
  "factory.archiveRepo": "acme/archive",
  "factory.publicRepo": "quillco/playground",
}
const OWN_WORDS =
  "The board is live today: every session on one page, with its state and its last line. Try it and tell me what you think."
const FIGURE_REFUSAL =
  "a draft with no link is a public post's, which holds the owner's own words alone (playground rules public), and this one holds a work figure (a PR, commit or session count). Say what shipped or changed, with no count. A draft to a colleague carries its Slack or Linear link instead, and this check leaves that one alone."
let scratch = ""
let data = ""
let terms: Record<string, unknown> = {}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "public-draft-"))
  data = join(scratch, "data")
  // the repo's own terms plus a made-up tool's name, and a made-up session in the roster
  terms = await Bun.file(join(root, "extensions", "core", "lists", "playground-terms.json")).json()
  storeWith(
    data,
    {
      "no-public-leak.json": JSON.stringify(PUBLIC),
      "playground-terms.json": JSON.stringify({
        ...terms,
        names: [...(terms.names as string[]), "quillforge"],
      }),
    },
    REPOS,
  )
  await Bun.write(
    join(data, "roster.json"),
    JSON.stringify({ agents: [{ name: "zq7v2k-worker", role: "worker" }] }),
  )
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

describe("a work figure is a count beside PR, pull request, commit or session", () => {
  test.each([
    "I merged 12 PRs this week.",
    "1,204 commits since March",
    "1.2k commits",
    "a dozen pull requests a day",
    "hundreds of sessions ran overnight",
    "Twenty-two PRs landed.",
    "twenty-one sessions",
    "40+ commits",
    "three sessions in parallel",
    "12 pull-requests",
    "12 merged PRs",
  ])("catches %j", (text) => {
    expect(FIGURE.test(text)).toBe(true)
  })

  test.each([
    "One commit reverts it.",
    "The PR is open.",
    "12 people came.",
    "3 weeks of work",
    "3 weeks of commits",
    "PR #7 is merged",
    "v2 sessions are faster",
    "In 2026, sessions got faster.",
    "Support runs 24/7 sessions for every team.",
    "the board shows every session",
    "a session a day",
  ])("passes %j", (text) => {
    expect(FIGURE.test(text)).toBe(false)
  })
})

describe("publicDraftHit", () => {
  const hit = (text: string) => publicDraftHit(text, { PLAYGROUND_DATA_DIR: data }, scratch)

  test.each([
    ["a work figure (a PR, commit or session count)", "I merged 12 PRs this week."],
    ["a factory term (a tool's or a session's name)", "Quillforge runs the floor."],
    ["a factory term (a tool's or a session's name)", "Thanks to zq7v2k-worker for the fix."],
    ["a factory term (a tool's or a session's name)", "A worker-envy session did it."],
    ["a person's name", "Quilla Marsh wrote the first draft."],
    ["a handle", "Thanks @qmarsh for the review."],
    ["a company term", "Built with Vantorix."],
    ["a Linear key", "Fixes MADEVX-12."],
    ["a Slack id", "See C0MADE0401 for the thread."],
    ["an email address", `Write to ${["quilla", "example.com"].join("@")} for access.`],
    ["an archive link", "The history is in acme/archive/pull/3, if you want it."],
    ["a ticket or PR number", `It shipped in ${"#"}48 today.`],
    ["a ticket or PR number", "It shipped as PG-48 today."],
    ["a repository's name", "The code is in quillco/playground."],
    ["a repository's name", "See https://github.com/quillco/other-repo for the code."],
  ])("catches %s", async (detail, text) => {
    const checked = await hit(text)
    expect(checked.hit?.detail).toBe(detail)
    expect(checked.refusal).toBeUndefined()
  })

  test("passes a draft in the owner's own words", async () => {
    expect(await hit(OWN_WORDS)).toEqual({})
  })

  test("with factory.publicRepo unset, its default names the checkout's own origin", async () => {
    const unset = join(scratch, "unset")
    storeWith(unset, {
      "no-public-leak.json": JSON.stringify(PUBLIC),
      "playground-terms.json": JSON.stringify(terms),
    })
    expect(UNSET_REPOS.public).toHaveLength(1)
    for (const repo of UNSET_REPOS.public) {
      const checked = await publicDraftHit(
        `The code is in ${repo}.`,
        { PLAYGROUND_DATA_DIR: unset },
        scratch,
      )
      expect(checked.hit?.detail).toBe("a repository's name")
    }
  })

  test("refuses, as the guards do, when a list cannot be read", async () => {
    const broken = join(scratch, "broken")
    storeWith(broken, {
      "no-public-leak.json": "{ not json",
      "playground-terms.json": JSON.stringify(terms),
    })
    const checked = await publicDraftHit(OWN_WORDS, { PLAYGROUND_DATA_DIR: broken }, scratch)
    expect(checked.refusal).toContain("no-public-leak hook refused this call")
    expect(checked.hit).toBeUndefined()
  })

  test("with no store, the owner's words pass on the checkout's own terms and a figure still refuses", async () => {
    const none = { PLAYGROUND_DATA_DIR: join(scratch, "none") }
    expect(await publicDraftHit(OWN_WORDS, none, scratch)).toEqual({})
    expect((await publicDraftHit("12 PRs", none, scratch)).hit?.detail).toBe(
      "a work figure (a PR, commit or session count)",
    )
  })

  test("publicRefusal names the kind and the fix, never the words, and the fix for a colleague's draft", () => {
    expect(
      publicRefusal({
        detail: "a work figure (a PR, commit or session count)",
        fix: "Say what shipped or changed, with no count.",
      }),
    ).toBe(FIGURE_REFUSAL)
  })
})

describe("run as a child with the text as its argument", () => {
  const child = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", SCRIPT, ...args], {
      cwd: root,
      env: { ...process.env, PLAYGROUND_DATA_DIR: data },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "ignore",
    })
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, stderr: stderr.trim() }
  }

  test("exits 2 with the refusal for a figure, 0 for the owner's words, and 1 with its usage for no text", async () => {
    expect(await child("I merged 12 PRs.")).toEqual({ code: 2, stderr: FIGURE_REFUSAL })
    expect(await child(OWN_WORDS)).toEqual({ code: 0, stderr: "" })
    expect(await child()).toEqual({
      code: 1,
      stderr: "usage: bun --no-env-file scripts/hooks/public-draft.ts <text>",
    })
  })
})
