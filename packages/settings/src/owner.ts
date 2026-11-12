import { z } from "zod"

// By relative path, as settings.ts imports, since the factory's hooks import this file from outside the package.
import { defineSettings } from "./settings"

// Who the factory works for: the names and handles the owner goes by in chat, so the inbox gate reads a line addressed to the owner by name, and the voice a draft in the owner's name speaks in; none until set.
export const ownerSettings = defineSettings({
  "owner.names": {
    default: [],
    description:
      "The owner's first name and handles as chat writes them, lowercase: the inbox gate refuses a manager's stop on a line that addresses one of them and asks for an action, and never reads @<handle> as an agent.",
    schema: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "a name or handle, lowercase")),
  },
  "owner.voice": {
    default: "",
    description:
      "The voice a draft or a slack decision speaks in as the owner: singular has bun run ask refuse one that says we, us, our, ours or ourselves; empty checks none.",
    schema: z.enum(["", "singular"]),
  },
})
