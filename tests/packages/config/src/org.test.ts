import { describe, expect, test } from "bun:test"

import { orgOf } from "../../../../packages/config/src/org"

describe("orgOf", () => {
  test("with nothing set, every value is a generic default, and no integration is read", () => {
    expect(orgOf({})).toEqual({
      cluster: { key: undefined, peers: [] },
      ledger: { title: "Firefighting" },
      local: { models: [], url: "http://127.0.0.1:18000" },
      owner: { name: "Owner" },
      work: { label: "Work", org: undefined },
    })
  })

  test("a full config reads every key", () => {
    expect(
      orgOf({
        PLAYGROUND_LEDGER_TITLE: "Ledger",
        PLAYGROUND_LOCAL_MODEL_URL: "http://127.0.0.1:18001",
        PLAYGROUND_LOCAL_MODELS: "M=ornith-1.5-122b-nvfp4",
        PLAYGROUND_OWNER_NAME: "Merritt",
        PLAYGROUND_PEER_KEY: "/home/you/.ssh/cluster",
        PLAYGROUND_PEERS: "machine-b=you@10.0.0.2",
        WORK_GITHUB_ORG: "example",
        WORK_LABEL: "Day job",
      }),
    ).toEqual({
      cluster: {
        key: "/home/you/.ssh/cluster",
        peers: [{ name: "machine-b", target: "you@10.0.0.2" }],
      },
      ledger: { title: "Ledger" },
      local: {
        models: [{ id: "ornith-1.5-122b-nvfp4", label: "M" }],
        url: "http://127.0.0.1:18001",
      },
      owner: { name: "Merritt" },
      work: { label: "Day job", org: "example" },
    })
  })

  test("an empty value reads as unset", () => {
    expect(
      orgOf({
        PLAYGROUND_OWNER_NAME: "",
        WORK_GITHUB_ORG: "",
      }),
    ).toMatchObject({
      owner: { name: "Owner" },
      work: { org: undefined },
    })
  })

  test("peers are a comma list of name=user@host, each read in its order, spaces around an entry dropped", () => {
    expect(
      orgOf({ PLAYGROUND_PEERS: "machine-b=you@10.0.0.2, machine-c=me@machine-c" }).cluster.peers,
    ).toEqual([
      { name: "machine-b", target: "you@10.0.0.2" },
      { name: "machine-c", target: "me@machine-c" },
    ])
  })

  test("a peer that could become an ssh flag or a second argument, or has no name, is refused, and so is a key that is not an absolute path", () => {
    for (const peers of [
      "machine-b=-oProxyCommand=x@h",
      "machine-b=you@-h",
      "machine-b=you @h",
      "you@10.0.0.2",
      "-b=you@h",
      "machine-b=host",
    ]) {
      expect(() => orgOf({ PLAYGROUND_PEERS: peers })).toThrow()
    }
    expect(() => orgOf({ PLAYGROUND_PEER_KEY: "~/.ssh/cluster" })).toThrow()
  })

  test("local models are a comma list of label=model-id, each read in its order", () => {
    expect(
      orgOf({ PLAYGROUND_LOCAL_MODELS: "M=ornith-1.5-122b-nvfp4, K=ornith-1.5-35b-a3b-nvfp4" })
        .local.models,
    ).toEqual([
      { id: "ornith-1.5-122b-nvfp4", label: "M" },
      { id: "ornith-1.5-35b-a3b-nvfp4", label: "K" },
    ])
  })

  test("a local model id that could become a flag, one with no label, and a server url that is not http are refused", () => {
    for (const env of [
      { PLAYGROUND_LOCAL_MODELS: "M=-x" },
      { PLAYGROUND_LOCAL_MODELS: "M=a b" },
      { PLAYGROUND_LOCAL_MODELS: "ornith" },
      { PLAYGROUND_LOCAL_MODELS: "-M=ornith" },
      { PLAYGROUND_LOCAL_MODEL_URL: "file:///etc/passwd" },
    ])
      expect(() => orgOf(env)).toThrow()
  })

  // a peer's password item takes its name lowercased, so two names equal but for case would share one (#2535)
  test("two peers whose names differ only in case are refused, and so is a name listed twice", () => {
    expect(() =>
      orgOf({ PLAYGROUND_PEERS: "Spark-9DFB=you@10.0.0.2, spark-9dfb=me@10.0.0.3" }),
    ).toThrow("each peer name is listed once, in any case")
    expect(() =>
      orgOf({ PLAYGROUND_PEERS: "machine-b=you@10.0.0.2, machine-b=me@10.0.0.3" }),
    ).toThrow()
    expect(
      orgOf({ PLAYGROUND_PEERS: "machine-b=you@10.0.0.2, machine-c=you@10.0.0.2" }).cluster.peers,
    ).toHaveLength(2)
  })

  test("a work org that is not a GitHub login is refused, so it adds nothing to the search", () => {
    expect(() => orgOf({ WORK_GITHUB_ORG: "example is:closed" })).toThrow()
  })
})
