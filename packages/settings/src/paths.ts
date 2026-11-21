import { dirname } from "node:path"

import { z } from "zod"

import { defineSettings, type Settings } from "@/settings"

// Where the factory's code lives, empty until set, so no default names a person's folder.
export const pathsSettings = defineSettings({
  "paths.codeRoot": {
    default: "",
    description:
      "The folder that holds your code, the folder that holds the checkout when unset: spawn.sh answers Claude's folder trust prompt there and moves a session off the Desktop into it.",
    schema: z.string().regex(/^(?:\/.*)?$/, "an absolute path, or empty for unset"),
  },
  "paths.factoryHomes": {
    default: ["{data}", "{checkout}", "~/models"],
    description:
      "The folders the factory may put things in, each an absolute path, a ~/ path, {data} (the data folder) or {checkout} (the Playground clone): the machine record's daily check names a new path outside them as misplaced.",
    schema: z
      .array(
        z.string().regex(/^(?:\/.+|~\/.+|\{data\}|\{checkout\})$/, "a path, {data} or {checkout}"),
      )
      .min(1),
  },
})

// Pure: the factory's homes as absolute paths, {data} and {checkout} filled in and ~/ read under home.
export const factoryHomes = (
  settings: Settings,
  places: { checkout: string; data: string; home: string },
): string[] =>
  pathsSettings
    .get(settings, "paths.factoryHomes")
    .map((home) =>
      home === "{data}"
        ? places.data
        : home === "{checkout}"
          ? places.checkout
          : home.startsWith("~/")
            ? `${places.home}/${home.slice(2)}`
            : home,
    )

// The code root: paths.codeRoot when set, else the folder that holds the checkout.
export const codeRoot = (settings: Settings, checkout: string): string =>
  pathsSettings.get(settings, "paths.codeRoot") || dirname(checkout)
