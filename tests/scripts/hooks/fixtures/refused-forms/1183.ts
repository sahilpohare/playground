import { type Group, NEVER_MADE } from "./_shared"

// #1183: zsh reads a lone `-` before a command as a precommand modifier and runs the command after it, a builtin in the same shell, so each guard judges the command behind the dash; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["process home", "process worktree"],
    guards: ["no-extensions-write", "no-raw-delete"],
    rows: () => [
      ["a delete fed to a shell behind the dash", `echo 'rm -rf ${NEVER_MADE}' | - sh`],
      ["a delete run by eval behind the dash", `- eval 'rm -rf ${NEVER_MADE}'`],
      ["a delete behind the dash", `- rm -rf ${NEVER_MADE}`],
    ],
  },
  {
    folders: ["process home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "tee through a variable that an export behind the dash names",
        "- export D=~/.playground/extensions; tee $D/x < /dev/null",
      ],
      [
        "a redirect through a variable that an export behind the dash names",
        "- export D=~/.playground/extensions; echo x > $D/x",
      ],
    ],
  },
  {
    folders: ["process home", "process worktree"],
    guards: ["no-extensions-write", "no-raw-delete"],
    rows: () => [
      [
        "a delete through a variable that an export behind the dash names",
        `- export D=${NEVER_MADE}; rm -rf $D`,
      ],
    ],
  },
  {
    folders: ["home", "checkout"],
    guards: ["no-extensions-write"],
    rows: ({ LIST, ROOT }) => [
      ["tee into a list behind the dash", `echo [] | - tee ${LIST}`],
      ["touch under the root behind the dash", `- touch ${ROOT}/hooks/new.json`],
    ],
  },
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: () => [["a commit behind the dash", "- git commit --allow-empty -m x"]],
  },
]
