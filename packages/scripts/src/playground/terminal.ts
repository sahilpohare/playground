import { join } from "node:path"

// Starts every ops job that is down (up.py), the dashboard's stack and its follower among them, each in herdr's Ops workspace, so they outlive this terminal; restarted names the jobs whose start grace a herdr restart ends (up.py --restarted).
export const startJobs = async (repo: string, restarted: string[] = []): Promise<number> => {
  const flags = restarted.length ? ["--restarted", restarted.join(",")] : []
  const child = Bun.spawn(["python3", "-I", join(repo, "scripts", "ops", "up.py"), ...flags], {
    stderr: "inherit",
    stdout: "inherit",
  })
  return child.exited
}
