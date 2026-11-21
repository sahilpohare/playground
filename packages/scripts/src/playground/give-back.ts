import { readFileSync, rmdirSync, rmSync } from "node:fs"

// Gives back the run-slot lane this process runs in, which run-slot names in RUN_SLOT_HELD as "<lane folder> <run-slot pid>", the way run-slot's own free() does: only while the lane's holder line still names that run-slot, so a lane another run has taken since stays that run's. The process then goes on outside the queue, and run-slot's free() at its end finds the line gone and leaves the lane alone.
export const giveBackSlot = (held = process.env.RUN_SLOT_HELD): boolean => {
  const [slot, pid] = held?.split(" ") ?? []
  if (!slot || !pid) return false
  let line: string
  try {
    line = readFileSync(`${slot}.holder`, "utf8")
  } catch {
    return false
  }
  if (line.split(" ")[1] !== pid) return false
  for (const file of [".holder", ".child", ".preempted"]) rmSync(`${slot}${file}`, { force: true })
  try {
    rmdirSync(slot)
  } catch {}
  return true
}
