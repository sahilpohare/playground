import { describe, expect, test } from "bun:test"

import { peerArgv } from "../../../../../../api/hono/src/lib/system/peer"

describe("peerArgv", () => {
  test("a key is the only identity ssh tries, and with none ssh keeps its own default", () => {
    expect(peerArgv("you@10.0.0.2", "/k").slice(0, 7)).toEqual([
      "ssh",
      "-i",
      "/k",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
    ])
    expect(peerArgv("you@10.0.0.2")).not.toContain("IdentitiesOnly=yes")
  })
})
