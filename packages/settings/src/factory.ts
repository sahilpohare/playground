import { z } from "zod"

// By relative path, as owner.ts imports, so a test outside the package type-checks it.
import { defineSettings } from "./settings"

const repo = z
  .string()
  .regex(/^(?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?$/, "a repository as owner/name, or empty for unset")

// The repositories the factory works in, each empty until set, so no default names one: where its pull requests land (unset, the checkout's origin), the public ones its guards keep private text out of (unset, the checkout's origin), and the archive the trace ratchet counts links to (unset, the trace ratchet counts nothing).
export const factorySettings = defineSettings({
  "factory.archiveRepo": {
    default: "",
    description:
      "The archive repository: a link to it is private history, so the trace ratchet counts it and no-public-leak refuses it in a public write.",
    schema: repo,
  },
  "factory.publicRepo": {
    default: "",
    description:
      "The public repository, or a list of them, the checkout's origin when unset: no-public-leak refuses a write to one that holds private text, and the trace ratchet reads past each one's own name.",
    schema: z.union([repo, z.array(repo)]),
  },
  "factory.repo": {
    default: "",
    description:
      "The repository the factory's pull requests land in, the checkout's origin when unset: pr:merge needs GitGuardian's check there, Checks reads its PRs, and the roster links a bare PR number into it.",
    schema: repo,
  },
})
