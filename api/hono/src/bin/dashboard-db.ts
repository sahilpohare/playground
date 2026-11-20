import { locate } from "@/lib/sessions/guard"
import { runner } from "@/lib/setup/container"
import { moveIfExposed } from "@/lib/setup/move"

// Prints the name of the dashboard's database container: the one running container that publishes the port of POSTGRES_URL (from the .env of the folder it runs in) on loopback alone, the rule bun run ingest proves before its first write. ops-dashboard's supervisor reads it, so the dashboard's database runs under any name; it exits 1 with the reason when no container passes.
// With `move`, the supervisor's roll moves a container the guard refuses as exposed onto 127.0.0.1 alone (lib/setup/move.ts) and prints what it did; it prints nothing for one already on loopback, and exits 1 with the reason when the move fails.
try {
  if (!process.env.POSTGRES_URL) throw new Error("POSTGRES_URL is not set")
  if (process.argv[2] === "move") {
    for (const line of await moveIfExposed(process.env.POSTGRES_URL, runner("docker"))) {
      console.log(line)
    }
  } else {
    console.log(locate(process.env.POSTGRES_URL).owner.name)
  }
} catch (err) {
  console.error(`dashboard-db: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
