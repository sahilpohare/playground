import type { Group } from "./_shared"

// #2894: a settings set passes with --propose as its one option alone, beside the key and value, since ops-wa then asks the owner and writes on his yes, and a CLI from before the flag reads it as an option that needs a value; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "data folder", "home"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "a guard key's set with the propose flag and a reason",
        "playground settings set wa.replyPolicy x --propose --reason x",
      ],
      [
        "a guard key's set with the propose flag, a reason and a scope",
        "playground settings set wa.replyPolicy x --propose --reason x --scope acme",
      ],
      [
        "a guard key's set with the propose flag and a by",
        "playground settings set wa.replyPolicy x --propose --by owner",
      ],
      [
        "a guard key's set with the propose flag and the owner's message flag",
        "playground settings set wa.replyPolicy x --propose --from-owner-msg own1",
      ],
      [
        "a guard key's set with the propose flag and a dry run",
        "playground settings set wa.replyPolicy x --propose --dry-run",
      ],
      [
        "a guard key's set with the propose flag given a value",
        "playground settings set wa.replyPolicy x --propose=1",
      ],
      [
        "a guard key's set through a checkout's cli.ts with the propose flag and a reason",
        `bun ${CLI_DIR}/cli.ts settings set wa.replyPolicy x --propose --reason x`,
      ],
      [
        "a guard key's set with a third word beside the propose flag",
        "playground settings set wa.replyPolicy x extra --propose",
      ],
      [
        "a guard key's set with the propose flag and no value",
        "playground settings set wa.replyPolicy --propose",
      ],
      [
        "a guard key's set with the propose flag in a quoted word",
        `playground settings set wa.replyPolicy x "--propose --reason x"`,
      ],
      [
        "a guard key's set chained after a proposal",
        "playground settings set wa.replyPolicy x --propose && playground settings set wa.owner +15550100001 --reason x",
      ],
      [
        "a guard key's proposal with a key the hook cannot read",
        'playground settings set "$KEY" x --propose',
      ],
      [
        "a guard key's reset with the propose flag",
        "playground settings reset wa.replyPolicy --propose",
      ],
    ],
  },
]
