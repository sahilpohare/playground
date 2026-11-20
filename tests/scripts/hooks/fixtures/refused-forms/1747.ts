import { type Group } from "./_shared"

// What bun x runs, read as bun runs it: the tool after an option's value stands in for x, any program in the runner's folder, next build's folder, and the CLI in the folder bun x runs it in or a bun that a package runner starts reads its own --cwd from; rows are data, as refused-forms.ts says.
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
  // the CLI that bunx or bun x starts is read in the folder their --cwd options chain to, each read from the one before
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "ext add by bun x bun in a runner --cwd read from bun's own",
        `bun --cwd=${CLI_DIR.slice(0, -"/playground".length)} x --cwd=playground bun cli.ts ext add login list x y`,
      ],
      [
        "ext add by bun x bun in a runner --cwd read from the one before",
        `bun x --cwd=${CLI_DIR.slice(0, -"/scripts/src/playground".length)} --cwd=scripts/src/playground bun cli.ts ext add login list x y`,
      ],
      [
        "ext add by bunx bun in a --cwd read from the one before",
        `bunx --cwd=${CLI_DIR.slice(0, -"/scripts/src/playground".length)} --cwd=scripts/src/playground bun cli.ts ext add login list x y`,
      ],
      [
        "ext add by bunx bun in its --cwd",
        `bunx --cwd=${CLI_DIR} bun cli.ts ext add login list x y`,
      ],
    ],
  },
  // a bun that a package runner starts reads its own --cwd from the folder the runner starts it in
  {
    folders: ["home", "checkout", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => {
      const PKG = CLI_DIR.slice(0, -"/scripts/src/playground".length)
      return [
        [
          "ext put by a bun that bunx starts, its --cwd read from the runner's",
          `bunx --cwd=${PKG} bun --cwd=scripts/src/playground cli.ts ext put login list x /tmp/l.json --reason y`,
        ],
        [
          "ext add by a bun that bun x starts, its --cwd read from bun's own",
          `bun --cwd=${PKG} x bun --cwd=scripts/src/playground cli.ts ext add login list x y`,
        ],
        [
          "ext add by a bun x that bunx starts, its --cwd read from the runner's",
          `bunx --cwd=${PKG} bun x --cwd=scripts/src/playground bun cli.ts ext add login list x y`,
        ],
        [
          "ext add by a bunx that bunx starts, its --cwd read from the runner's",
          `bunx --cwd=${PKG} bunx --cwd=scripts/src/playground bun cli.ts ext add login list x y`,
        ],
        [
          "ext add by a bun run that bunx starts, its --cwd read from the runner's",
          `bunx --cwd=${PKG} bun run --cwd=scripts/src/playground cli.ts ext add login list x y`,
        ],
        [
          "ext put by a bun that bunx starts in its own --cwd",
          `bunx bun --cwd=${CLI_DIR} cli.ts ext put login list x /tmp/l.json --reason y`,
        ],
        [
          "ext add by a bun that bunx starts in its own --cwd past the runner's",
          `bunx --cwd=/tmp bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
        ],
        [
          "ext add by a bun that bun x starts in its own --cwd",
          `bun x bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
        ],
        [
          "ext add by a bun that npx starts in its own --cwd",
          `npx bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
        ],
        [
          "ext add by a bun that bun run starts in its own --cwd",
          `bun run bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
        ],
      ]
    },
  },
  // each package runner that starts another, which then starts a bun reading its own --cwd
  {
    folders: ["home", "checkout"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) =>
      RUNNERS.flatMap((outer) =>
        RUNNERS.map(
          (inner) =>
            [
              `ext add by a bun in its own --cwd that ${inner} starts under ${outer}`,
              `${outer} ${inner} bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
            ] as const,
        ),
      ),
  },
]

const RUNNERS = ["bunx", "bun x", "npx", "bun run"]
