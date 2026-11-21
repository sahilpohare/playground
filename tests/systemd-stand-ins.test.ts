import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { liveBusLines, systemdLog, systemdStandIns } from "./systemd-stand-ins"

const bin = mkdtempSync(join(tmpdir(), "systemd-stand-ins-"))
afterAll(() => rmSync(bin, { force: true, recursive: true }))

test("the live-bus check catches a systemd call whose bus or argv names the user's runtime folder", () => {
  expect(
    liveBusLines(
      [
        "systemctl XDG_RUNTIME_DIR=/s/run DBUS_SESSION_BUS_ADDRESS=unix:path=/s/run/bus --user is-active a.service",
        "systemctl XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS= --user stop a.service",
        "systemctl XDG_RUNTIME_DIR= DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus --user stop b.service",
        "",
      ].join("\n"),
    ),
  ).toEqual([
    "systemctl XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS= --user stop a.service",
    "systemctl XDG_RUNTIME_DIR= DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus --user stop b.service",
  ])
})

test("each stand-in refuses and logs its argv with the bus it was given", () => {
  systemdStandIns(bin)
  for (const tool of ["systemctl", "loginctl"]) {
    const run = Bun.spawnSync([join(bin, tool), "--user", "stop", "a.service"], {
      env: {
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/s/bus",
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: "/s",
      },
    })
    expect(run.exitCode).toBe(1)
  }
  expect(systemdLog(bin)).toBe(
    [
      "systemctl XDG_RUNTIME_DIR=/s DBUS_SESSION_BUS_ADDRESS=unix:path=/s/bus --user stop a.service",
      "loginctl XDG_RUNTIME_DIR=/s DBUS_SESSION_BUS_ADDRESS=unix:path=/s/bus --user stop a.service",
      "",
    ].join("\n"),
  )
})
