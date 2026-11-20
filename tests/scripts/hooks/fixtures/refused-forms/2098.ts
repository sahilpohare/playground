import type { Group } from "./_shared"

// #2098: a path naming the CLI by its name was dropped when a folder of that name stood in any folder the hook reads, though the runner's own folder holds a link to the CLI there; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ HOME, WORK }) => [
      [
        "ext add by bunx bun of a CLI link in its --cwd",
        `cd ${WORK} && bunx --cwd=${HOME}/.bun/bin bun ./playground ext add login list x y`,
      ],
      [
        "ext add by bun x bun of a CLI link in its --cwd",
        `cd ${WORK} && bun x --cwd=${HOME}/.bun/bin bun ./playground ext add login list x y`,
      ],
      [
        "ext add by bun of a CLI link in its --cwd",
        `cd ${WORK} && bun --cwd=${HOME}/.bun/bin ./playground ext add login list x y`,
      ],
    ],
  },
]
