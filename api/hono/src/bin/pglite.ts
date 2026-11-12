// `bun src/bin/pglite.ts <home>`: serves the PGlite database in <home>/data on 127.0.0.1 (lib/pglite.ts), the process startPglite starts detached.
import { serve } from "@/lib/pglite"

const home = process.argv[2]
if (!home) {
  console.error("pglite: give the database's folder, as startPglite does")
  process.exit(2)
}
await serve(home)
