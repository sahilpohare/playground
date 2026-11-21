import { afterEach, expect, test } from "bun:test"

import { BOX_ENV_KEYS, boxEnv } from "../../../../packages/scripts/src/box-env"

const LIVE = {
  HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock",
  PLAYGROUND_DATA_DIR: "/home/owner/.playground",
  PORTLESS_STATE_DIR: "/home/owner/.portless/fallback",
  XDG_RUNTIME_DIR: "/run/user/1000",
}
const saved = Object.fromEntries(Object.keys(LIVE).map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
})

test("no live-state variable reaches the box: the portless state folder, a herdr socket, the data folder", () => {
  Object.assign(process.env, LIVE)
  const env = boxEnv("/tmp/box/h")
  for (const key of Object.keys(LIVE)) expect(env).not.toHaveProperty(key)
  expect(env.HOME).toBe("/tmp/box/h")
  expect(env.PATH).toBe(process.env.PATH!)
})

test("extra sets or drops a key over the base, and keys widens the list", () => {
  process.env.PORTLESS_STATE_DIR = LIVE.PORTLESS_STATE_DIR
  expect(boxEnv("/tmp/box/h", { PATH: undefined, PORTLESS_SYNC_HOSTS: "0" })).toEqual({
    ...Object.fromEntries(
      BOX_ENV_KEYS.filter((key) => key !== "PATH" && process.env[key] !== undefined).map((key) => [
        key,
        process.env[key]!,
      ]),
    ),
    HOME: "/tmp/box/h",
    PORTLESS_SYNC_HOSTS: "0",
  })
  expect(boxEnv("/tmp/box/h", {}, [...BOX_ENV_KEYS, "PORTLESS_STATE_DIR"]).PORTLESS_STATE_DIR).toBe(
    LIVE.PORTLESS_STATE_DIR,
  )
})
