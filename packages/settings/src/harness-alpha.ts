import { z } from "zod"

// By relative path, as whatsapp.ts imports, since the API's first run reads this file.
import { HARNESSES, type HarnessId } from "./harnesses"
import { defineSettings } from "./settings"

// Every harness id as a tuple, for a z.enum that names them.
export const HARNESS_IDS = HARNESSES.map((harness) => harness.id) as [HarnessId, ...HarnessId[]]

// The harness the first dispatcher starts on, which first run's pick and Settings' Switch write, and the Dashboard's Start passes to spawn.sh as --harness.
export const harnessSettings = defineSettings({
  "harness.alpha": {
    default: "claude-code",
    description:
      "The harness the first dispatcher starts on: claude-code or codex. First run's pick and Settings' Switch write it, and the Dashboard's Start runs spawn.sh --harness with it.",
    schema: z.enum(HARNESS_IDS),
  },
})
