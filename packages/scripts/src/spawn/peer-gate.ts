import { parsePeer } from "../../../../api/hono/src/lib/system/parse"
import { peerArgv } from "../../../../api/hono/src/lib/system/peer"

// spawn.sh's gate for an --ssh start reads the target through the System view's peer read: `bun peer-gate.ts <user@host> <key>` prints the target's cores, load1, load5 and free share (MemAvailable's whole share of MemTotal) as JSON, or the problem when it does not read.
const [target, key] = process.argv.slice(2)
if (!target || !key) {
  console.error("usage: peer-gate.ts <user@host> <key>")
  process.exit(2)
}
const run = Bun.spawnSync(peerArgv(target, key), { stdin: "ignore", timeout: 15_000 })
const reading = run.exitCode === 0 ? parsePeer(run.stdout.toString()) : null
if (!reading) {
  const said = run.stderr.toString().trim().split("\n").at(-1)
  console.log(
    JSON.stringify({
      problem:
        said || `its read printed no load, memory or cores (exit ${run.exitCode ?? "timeout"})`,
    }),
  )
} else {
  const { totalBytes, usedBytes } = reading.memory
  const free = usedBytes === null ? null : Math.floor(((totalBytes - usedBytes) * 100) / totalBytes)
  console.log(
    JSON.stringify({ cores: reading.cores, free, load1: reading.load[0], load5: reading.load[1] }),
  )
}
