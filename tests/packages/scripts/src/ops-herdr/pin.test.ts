import { describe, expect, test } from "bun:test"

import {
  ASSET_NAMES,
  assetOf,
  herdrPath,
  PIN_SOURCE,
  pinnedSum,
} from "../../../../../packages/scripts/src/ops-herdr/pin"

describe("the herdr pin", () => {
  test("pins herdr 0.9.5 by GitHub's digest of each macOS and Linux release asset", () => {
    expect(PIN_SOURCE.version).toBe("0.9.5")
    expect(pinnedSum("darwin-arm64")).toBe(
      "fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2",
    )
    expect(pinnedSum("darwin-x64")).toBe(
      "5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369",
    )
    expect(pinnedSum("linux-arm64")).toBe(
      "17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c",
    )
    expect(pinnedSum("linux-x64")).toBe(
      "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d",
    )
  })

  test("names an asset only for macOS or Linux, each on arm64 or x64", () => {
    expect(assetOf("darwin", "arm64")).toBe("darwin-arm64")
    expect(assetOf("darwin", "x64")).toBe("darwin-x64")
    expect(assetOf("linux", "arm64")).toBe("linux-arm64")
    expect(assetOf("linux", "x64")).toBe("linux-x64")
    expect(ASSET_NAMES).toEqual({
      "darwin-arm64": "herdr-macos-aarch64",
      "darwin-x64": "herdr-macos-x86_64",
      "linux-arm64": "herdr-linux-aarch64",
      "linux-x64": "herdr-linux-x86_64",
    })
    expect(assetOf("linux", "ia32")).toBeNull()
    expect(assetOf("win32", "x64")).toBeNull()
    expect(pinnedSum("win32-x64")).toBe("")
  })

  test("keeps the binary in HOME's data folder, whatever Claude login or data folder the env names", () => {
    expect(herdrPath({ HOME: "/scratch/home" })).toBe("/scratch/home/.playground/bin/herdr")
    expect(
      herdrPath({
        CLAUDE_CONFIG_DIR: "/scratch/other-login",
        HOME: "/scratch/home",
        PLAYGROUND_DATA_DIR: "/scratch/data",
        PLAYGROUND_HERDR_DIR: "/scratch/herdr",
      }),
    ).toBe(herdrPath({ HOME: "/scratch/home" }))
  })
})
