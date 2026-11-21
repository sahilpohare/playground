// The run run-slot-give-back.test.ts starts through run-slot: it gives its lane back as playground update does before its roll, writes whether it could to <marker>.gave, then waits for <marker>.go and touches <marker>.
import { existsSync, writeFileSync } from "node:fs"

import { giveBackSlot } from "../../../packages/scripts/src/playground/give-back"

const marker = process.argv.at(-1)!
writeFileSync(`${marker}.gave`, String(giveBackSlot()))
while (!existsSync(`${marker}.go`)) await Bun.sleep(50)
writeFileSync(marker, "")
