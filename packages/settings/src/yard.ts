import { z } from "zod"

// By relative path, as live.ts imports, since a test outside the package imports this file.
import { defineSettings } from "./settings"

// The bots this Mac answers a read of the dispatcher's log for, each Yard login, botLogin's <name>[bot] (@packages/message), to the DM it was made with, which a revoke deletes, so a bot made again under the name reads nothing; playground yard bot add --log adds one and bot revoke takes it off.
export const yardSettings = defineSettings({
  "yard.logReaders": {
    default: {} as Record<string, string>,
    description:
      "The bots whose read of the dispatcher's log this Mac answers through the relay, each Yard login to the DM it was made with; a bot Yard lets read the log reads nothing until its login and its DM are here.",
    schema: z.record(
      z.string().regex(/^[a-z\d][a-z\d-]{0,29}\[bot\]$/, "a bot's login, <name>[bot]"),
      z.string().min(1).max(64),
    ),
  },
})
