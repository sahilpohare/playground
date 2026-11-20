import type { Group } from "./_shared"

// #2097: a bun's --cwd behind a wrapper the reader does not parse (find -exec, arch, watch), a shell's -c script a package runner starts, and env a runner starts were read from the wrong folder or none, so the CLI's write ran; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "ext add by a bun --cwd behind find -exec",
        `find /tmp -maxdepth 0 -exec bun --cwd=${CLI_DIR} cli.ts ext add login list x y \\;`,
      ],
      // a control, refused before this source's fix
      [
        "ext add by a bun --cwd behind xargs",
        `echo | xargs bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by a bun --cwd behind arch",
        `arch -arm64 bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by a relative bun --cwd behind arch under bunx's --cwd",
        `bunx --cwd=${CLI_DIR}/../../.. arch -arm64 bun --cwd=scripts/src/playground cli.ts ext add login list x y`,
      ],
      [
        "ext add by a bun --cwd behind watch",
        `watch bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
      ],
      // a control, refused before this source's fix
      [
        "ext add by a bun --cwd behind nice",
        `nice bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
      ],
      // a control, refused before this source's fix
      [
        "ext add by a bun --cwd behind timeout",
        `timeout 5 bun --cwd=${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by bun under env that bunx starts in a --cwd above the CLI's",
        `bunx --cwd=${CLI_DIR.slice(0, -"/scripts/src/playground".length)} env bun --cwd=scripts/src/playground cli.ts ext add login list x y`,
      ],
    ],
  },
  // a shell's -c script that a package runner starts runs in the runner's folder
  {
    folders: ["checkout", "home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "ext put by sh -c that bunx starts in the CLI's folder",
        `bunx --cwd=${CLI_DIR} sh -c 'bun cli.ts ext put login list x /tmp/l.json --reason y'`,
      ],
      [
        "ext put by bash -c that bunx starts in the CLI's folder",
        `bunx --cwd=${CLI_DIR} bash -c 'bun cli.ts ext put login list x /tmp/l.json --reason y'`,
      ],
      [
        "ext put by sh -c that bun x starts in the CLI's folder",
        `bun x --cwd=${CLI_DIR} sh -c 'bun cli.ts ext put login list x /tmp/l.json --reason y'`,
      ],
      [
        "ext put by sh -c that bun --cwd x starts in the CLI's folder",
        `bun --cwd=${CLI_DIR} x sh -c 'bun cli.ts ext put login list x /tmp/l.json --reason y'`,
      ],
    ],
  },
]
