import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// systemctl and loginctl stand-ins for a test's bin, first on its PATH: each logs its argv and the XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS it saw to bin/systemd.log and refuses, as the user's manager does with no bus, so a test's render or retire never reaches the live units.
export const systemdStandIns = (bin: string) => {
  for (const tool of ["loginctl", "systemctl"])
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\necho "${tool} XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS $*" >> "${join(bin, "systemd.log")}"\nexit 1\n`,
      { mode: 0o755 },
    )
}

export const systemdLog = (bin: string) => {
  const path = join(bin, "systemd.log")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

// The lines of a stand-in's log that name the user's live runtime folder, /run/user/<uid>, which no test's call may reach.
export const liveBusLines = (log: string) =>
  log.split("\n").filter((line) => line.includes("/run/user/"))
