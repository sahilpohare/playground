import { z } from "zod"

// By relative path, as owner.ts imports, since no-main-checkout imports this file from outside the package.
import { defineSettings } from "./settings"

// The live dashboard's pair: the branch its checkout stays on and the container holding its database, which every stack elsewhere refuses, so a test row never reaches the board the owner reads.
export const liveSettings = defineSettings({
  "live.branch": {
    default: "live/dashboard",
    description:
      "The branch the live dashboard's checkout stays on: a stack on it reads the live machine, and ops-dashboard's roll resets it to the head of the branch the main checkout sits on.",
    schema: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "a git branch name"),
  },
  "live.container": {
    default: "playground-dashboard-db",
    description:
      "The Docker container holding the live dashboard's database, which every stack off the live checkout refuses.",
    schema: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "a Docker container name"),
  },
})
