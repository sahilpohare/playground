import { type Group } from "./_shared"

// What bun x runs, read as bun runs it: the tool after an option's value stands in for x, any program in the runner's folder, and next build's folder; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  // the main checkout runs no turbo, build or commit, whichever program bun x runs in it
  {
    folders: ["checkout"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      [
        "bun x after an option's value that stands in for x",
        `bun --env-file x --cwd=/ --cwd=${MAIN.slice(1)} x turbo run build`,
      ],
      ["bunx running bun's build in its --cwd", `bunx --cwd=${MAIN} bun run build`],
      [
        "bunx running bun's build in a --cwd read from the one before",
        `bunx --cwd=/ --cwd=${MAIN.slice(1)} bun run build`,
      ],
      [
        "bunx running a commit in a --cwd read from the one before",
        `bunx --cwd=/ --cwd=${MAIN.slice(1)} git commit -m x`,
      ],
    ],
  },
  // a worktree's build takes a run-slot, whichever program bun x runs there and whichever folder next build names
  {
    folders: ["main checkout"],
    guards: ["no-unslotted-run"],
    rows: ({ MAIN }) => [
      [
        "bunx running bun's build in a --cwd in a worktree read from the one before",
        `bunx --cwd=/ --cwd=${MAIN.slice(1)}/.claude/worktrees/a bun run build`,
      ],
      ["bunx next build naming a worktree", `bunx next build ${MAIN}/.claude/worktrees/a`],
    ],
  },
]
