import { z } from "zod"

import { defineSettings, extLinksSchema, extOrderSchema, extScopeSchema } from "./settings"

// The extensions this checkout ships under extensions/, beside core, each off until the owner turns it on in ext.bundled.
export const BUNDLED_EXTENSIONS = ["slack", "whatsapp"] as const

// The extensions: the bundled ones turned on, the repository each one's clone syncs with, the order a name is taken from them, and the orgs whose repos read each; extChain in settings.ts reads the last two.
export const extSettings = defineSettings({
  "ext.bundled": {
    default: [],
    description:
      "The extensions Playground ships under extensions/ that you have turned on, each read as a scope after your installed extensions and before core; one not named here loads no skill.",
    schema: z
      .array(z.enum(BUNDLED_EXTENSIONS))
      .refine((names) => new Set(names).size === names.length, "a bundled extension is on once"),
  },
  "ext.links": {
    default: {},
    description:
      "Each extension to the GitHub orgs whose repos read it, lowercase, or * for every repo; your login's is read by every repo, and an extension it does not name by none.",
    schema: extLinksSchema,
  },
  "ext.order": {
    default: [],
    description:
      "The extensions in priority order, first wins when two hold the same name; your login's comes first unless named here, and core always comes last.",
    schema: extOrderSchema,
  },
  "ext.repos": {
    default: {},
    description:
      "The private GitHub repository each extension syncs with, as name to owner/name; one it does not name syncs with <login>/playground-<name>.",
    schema: z.record(
      extScopeSchema,
      z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "a repository as owner/name"),
    ),
  },
})

// The orgs the guards keep the factory's terms and GLM out of: every org any extension links, * aside, lowercase, A to Z; none when ext.links is unset, and a value its schema refuses throws.
export const guardedOrgs = (values: Record<string, unknown>): string[] => {
  const links = extLinksSchema.parse(values["ext.links"] ?? {})
  return [...new Set(Object.values(links).flat())].filter((link) => link !== "*").sort()
}
