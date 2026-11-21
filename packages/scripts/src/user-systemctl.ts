import { existsSync } from "node:fs"
import { userInfo } from "node:os"

// A `systemctl --user` argv that finds the user's bus from a herdr pane, a cron or ssh, where XDG_RUNTIME_DIR is unset and systemctl prints "Failed to connect to bus: No medium found": with it unset, HOME the user's own home and /run/user/<uid>/bus there, the call runs under env with XDG_RUNTIME_DIR set to that folder. A scratch HOME, a test's or the new-user gate's box, keeps the plain call, so it never reaches the user's live manager.
export const userSystemctl = (
  args: string[],
  env: Record<string, string | undefined> = process.env,
  uid: number = process.getuid!(),
  exists: (path: string) => boolean = existsSync,
  home: string = userInfo().homedir,
): string[] => {
  const runtime = `/run/user/${uid}`
  const head = ["systemctl", "--user", ...args]
  return env.XDG_RUNTIME_DIR || env.HOME !== home || !exists(`${runtime}/bus`)
    ? head
    : ["env", `XDG_RUNTIME_DIR=${runtime}`, ...head]
}
