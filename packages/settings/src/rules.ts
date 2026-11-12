import { z } from "zod"

// By relative path, as settings.ts imports, since the rules hook imports this file from outside the package.
import { defineSettings } from "./settings"

const percent = z.number().int().min(1).max(100)

// The values the standing rules name through their {key} slots, defaulting to what the code that holds each rule reads today; a piece that moves that code onto a key reads the one defined here.
export const ruleSettings = defineSettings({
  "battery.alert": {
    default: 5,
    description:
      "The battery percent, while the charge falls on battery or on a charger losing to the load, at which the battery check posts its red alert and the heavy runs wait in run-slot.",
    schema: percent,
  },
  "battery.ask": {
    default: 10,
    description:
      "The battery percent, while the Mac discharges on battery, at which the battery check posts its orange ask.",
    schema: percent,
  },
  "clock.ownerZone": {
    default: "UTC",
    description: "The time zone, by its IANA name, a time shown to the owner reads in.",
    schema: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, "an IANA time zone, such as UTC or America/New_York"),
  },
  "context.window": {
    default: 400_000,
    description: "The context window, in tokens, every session compacts itself in.",
    schema: z.number().int().positive(),
  },
  "github.pollMinutes": {
    default: 5,
    description: "The fewest minutes between two polls of one pull request by a session.",
    schema: z.number().int().positive(),
  },
  "glm.readOnlyLoad5": {
    default: 15,
    description:
      "The 5-minute load average above which a GLM session may not install, commit or push.",
    schema: z.number().positive(),
  },
  "release.hours": {
    default: 4,
    description: "The hours of merging after which Ops ships canary to main, whatever the count.",
    schema: z.number().positive(),
  },
  "release.merges": {
    default: 3,
    description: "The user-facing merges since the last ship at which Ops ships canary to main.",
    schema: z.number().int().positive(),
  },
  "tickets.tracker": {
    default: "the tracker",
    description:
      "The issue tracker the tickets rule names, read inside its sentence, such as Linear.",
    schema: z.string().min(1),
  },
  "unstick.escalateMinutes": {
    default: 5,
    description:
      "The minutes a session stays stuck with no turn before ops-session-resume tells the primary dispatcher.",
    schema: z.number().int().positive(),
  },
})
