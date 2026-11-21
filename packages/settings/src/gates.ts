import { z } from "zod"

import { defineSettings } from "@/settings"

// The lines spawn.sh's capacity gate holds a start to, read at each start, so moving one is a settings write.
export const gateSettings = defineSettings({
  "gates.glmLoad5Max": {
    default: 30,
    description: "The load5 a GLM session starts under.",
    schema: z.number().positive(),
  },
  "gates.glmSwapinsMax": {
    default: 100,
    description: "The swap-ins a second a GLM session, and a fresh Claude worker, starts under.",
    schema: z.number().int().positive(),
  },
  "gates.memoryFreeMin": {
    default: 8,
    description: "The free memory share, in percent, a Claude session starts at or over.",
    schema: z.number().int().min(0).max(100),
  },
  "gates.reviewReserve": {
    default: 0.125,
    description:
      "The share of the load gate's line a small worker keeps back for reviewers and testers, so a held review starts first; set it under gates.smallReserve, or a small worker's line falls below a medium one's.",
    schema: z.number().min(0).lt(1),
  },
  "gates.sessionCap": {
    default: 0,
    description:
      "The live workers, reviewers and testers in the roster a new one starts under, so the floor keeps to the cap the factory runs to; 0 caps nothing.",
    schema: z.number().int().min(0),
  },
  "gates.smallReserve": {
    default: 0.25,
    description:
      "The share of the load gate's line kept for small items, so a big plan never blocks a small one.",
    schema: z.number().min(0).lt(1),
  },
  "gates.startsWindow": {
    default: 300,
    description:
      "The seconds a start counts toward the load gate, since the load average lags a session's start.",
    schema: z.number().int().positive(),
  },
})
