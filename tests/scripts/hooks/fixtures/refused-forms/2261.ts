import { type Group } from "./_shared"

// A reviewer in read mode writing a clone's git folder, whose config and hooks name programs a later git read runs, by a redirect or a file tool; rows are data, as refused-forms.ts says.
const NAME = "p7w3zc-reviewer"

export const groups: Group[] = [
  {
    folders: ["main checkout", "outside clone", "scratch folder"],
    guards: ["no-outside-pr-code"],
    rows: ({ DATA }) => {
      const git = `${DATA}/scratchpad/${NAME}/c/.git`
      return [
        ["a redirect over a clone's git config", `cat evil.config > ${git}/config`],
        ["a redirect into a clone's git hooks", `cat evil.sh > ${git}/hooks/post-checkout`],
        [
          "a Write of a clone's git config",
          { input: { content: "x", file_path: `${git}/config` }, tool: "Write" },
        ],
        [
          "an Edit of a clone's git hook",
          {
            input: { file_path: `${git}/hooks/post-checkout`, new_string: "y", old_string: "x" },
            tool: "Edit",
          },
        ],
        [
          "a NotebookEdit into a clone's git folder",
          { input: { new_source: "x", notebook_path: `${git}/config` }, tool: "NotebookEdit" },
        ],
      ]
    },
  },
]
