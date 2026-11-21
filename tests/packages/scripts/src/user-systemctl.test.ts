import { expect, test } from "bun:test"

import { userSystemctl } from "../../../../packages/scripts/src/user-systemctl"

const bus = (path: string) => path === "/run/user/1000/bus"
const own = { HOME: "/home/u" }
const plain = ["systemctl", "--user", "daemon-reload"]

test("with XDG_RUNTIME_DIR unset, HOME the user's own and the user's bus there, systemctl --user runs with it set to that folder", () => {
  expect(userSystemctl(["enable", "--now", "a.service"], own, 1000, bus, "/home/u")).toEqual([
    "env",
    "XDG_RUNTIME_DIR=/run/user/1000",
    "systemctl",
    "--user",
    "enable",
    "--now",
    "a.service",
  ])
})

test("a set XDG_RUNTIME_DIR, or no bus in the user's folder, leaves the plain call", () => {
  expect(
    userSystemctl(
      ["daemon-reload"],
      { ...own, XDG_RUNTIME_DIR: "/run/user/1000" },
      1000,
      bus,
      "/home/u",
    ),
  ).toEqual(plain)
  expect(userSystemctl(["daemon-reload"], own, 1001, bus, "/home/u")).toEqual(plain)
})

// a test's scratch HOME, or the new-user gate's box, never reaches the user's live manager, whose units the call would stop or start
test("a HOME other than the user's own leaves the plain call, so a scratch home never reaches the live manager", () => {
  expect(
    userSystemctl(["stop", "a.service"], { HOME: "/tmp/scratch" }, 1000, bus, "/home/u"),
  ).toEqual(["systemctl", "--user", "stop", "a.service"])
  expect(userSystemctl(["daemon-reload"], {}, 1000, bus, "/home/u")).toEqual(plain)
})
