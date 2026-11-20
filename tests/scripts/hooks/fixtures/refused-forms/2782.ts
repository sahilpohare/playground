import type { Group } from "./_shared"

// #2782: a settings set passes with --from-owner-msg <id> as its one option alone, since a CLI from before the flag reads it as an unknown option and writes the key itself once --reason is given; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "data folder", "home"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "a guard key's set with the owner's message flag and a reason",
        "playground settings set wa.alert +15550100444 --from-owner-msg own1 --reason x",
      ],
      [
        "a guard key's set with the owner's message flag, a reason and a scope",
        "playground settings set wa.alert +15550100444 --from-owner-msg own1 --reason x --scope acme",
      ],
      [
        "a guard key's set with the owner's message flag and a by",
        "playground settings set wa.alert +15550100444 --from-owner-msg own1 --by owner",
      ],
      [
        "a guard key's set through a checkout's cli.ts with the owner's message flag and a reason",
        `bun ${CLI_DIR}/cli.ts settings set wa.alert +15550100444 --from-owner-msg own1 --reason x`,
      ],
      [
        "a guard key's set with a third word beside the owner's message flag",
        "playground settings set wa.alert +15550100444 extra --from-owner-msg own1",
      ],
      [
        "a guard key's set with the owner's message flag in a quoted word",
        `playground settings set wa.alert +15550100444 "--from-owner-msg own1"`,
      ],
      [
        "a guard key's set chained after a set from the owner's message",
        "playground settings set factory.repo a/b --from-owner-msg own1 && playground settings set wa.alert +15550100444 --reason x",
      ],
      [
        "a guard key's set with the owner's message flag and no id",
        "playground settings set wa.alert +15550100444 --reason x --from-owner-msg",
      ],
      [
        "a guard key's set with the owner's message flag and an empty id",
        `playground settings set wa.alert +15550100444 --reason x --from-owner-msg ""`,
      ],
      [
        "a guard key's set with an owner's message id the hook cannot read",
        'playground settings set wa.alert +15550100444 --from-owner-msg "$ID"',
      ],
      [
        "a guard key's reset with the owner's message flag",
        "playground settings reset wa.alert --from-owner-msg own1",
      ],
    ],
  },
]
