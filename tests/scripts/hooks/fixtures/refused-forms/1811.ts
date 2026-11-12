import { join } from "node:path"

import { type Group } from "./_shared"

// #1811: each guard that judges a file tool's write refuses one, so every edit guard has an edit row, which refused-forms.test.ts also feeds in both of Codex's edit shapes; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      [
        "a Write into the main checkout",
        { input: { content: "x", file_path: join(MAIN, "AGENTS.md") }, tool: "Write" },
      ],
      [
        "an Edit in the main checkout",
        {
          input: { file_path: join(MAIN, "AGENTS.md"), new_string: "b", old_string: "a" },
          tool: "Edit",
        },
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-linear-ticket"],
    rows: ({ DATA }) => [
      [
        "a Write into the ticket approvals",
        {
          input: { content: "{}", file_path: join(DATA, "ticket-approvals", "a.json") },
          tool: "Write",
        },
      ],
      [
        "an Edit in the ticket approvals",
        {
          input: {
            file_path: join(DATA, "ticket-approvals", "a.json"),
            new_string: "b",
            old_string: "a",
          },
          tool: "Edit",
        },
      ],
    ],
  },
]
