import type { Group } from "./_shared"

// 22 runners each started by the one before, each past three unlisted options' values, so the readings pass their cap at every level
const DEEP = Array.from({ length: 22 }, (_, i) => `npx --a${i} a --b${i} b --c${i} c`).join(" ")
// the same runners each started through env, a wrapper the reader parses, so each is read again, past the depth no-extensions-write reads runners to
const WRAPPED = Array.from({ length: 22 }, (_, i) => `npx --a${i} a --b${i} b --c${i} c env`).join(
  " ",
)

// #2103: a value-taking option the shared runner reader does not list had its value read as the program, so a later --cwd went unread; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "ext add by runners nested past the readings' cap",
        `${DEEP} bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add after runners nested past the readings' cap",
        `${DEEP} cowsay hi; bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by runners each started through env, past the depth the hook reads",
        `${WRAPPED} bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by bun run past an unlisted option's value",
        `bun run --env-file /tmp/e bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by bun run past its shell option's value",
        `bun run --shell bun bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by npx past a cache option's value",
        `npx --cache /tmp/c bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by npx past a workspace option's value",
        `npx -w pkg bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      // a control, refused before this source's fix
      [
        "ext add by bunx past an env file option's value",
        `bunx --env-file /tmp/e bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by bun x past bun's own env file option",
        `bun --env-file /tmp/e x bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
      [
        "ext add by bun past its own env file option",
        `bun --env-file /tmp/e --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
    ],
  },
  {
    folders: ["checkout", "home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ CLI_DIR }) => [
      [
        "ext add by npx past a user config option's value",
        `npx --userconfig /tmp/u bun --cwd ${CLI_DIR} cli.ts ext add login list x y`,
      ],
    ],
  },
  {
    folders: ["checkout", "home", "main checkout"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      [
        "turbo's build in the main checkout by npx past a user config option's value",
        `npx --userconfig /tmp/u turbo run build --cwd ${MAIN}`,
      ],
      [
        "turbo's build in the main checkout by npx started by npx",
        `npx npx turbo run build --cwd ${MAIN}`,
      ],
      [
        "turbo's build in the main checkout by npx started by npx past a user config option's value",
        `npx --userconfig /tmp/u npx turbo run build --cwd ${MAIN}`,
      ],
      [
        "turbo's build in the main checkout by npx started by npx, both past an unlisted option's value",
        `npx --userconfig /tmp/u npx --cache /tmp/c turbo run build --cwd ${MAIN}`,
      ],
    ],
  },
  {
    folders: ["checkout", "main checkout"],
    guards: ["no-unslotted-run"],
    rows: ({ MAIN }) => [
      [
        "turbo's build by npx past a user config option's value",
        `npx --userconfig /tmp/u turbo run build --cwd ${MAIN}/.claude/worktrees/a`,
      ],
      [
        "turbo's build by npx started by npx",
        `npx npx turbo run build --cwd ${MAIN}/.claude/worktrees/a`,
      ],
      [
        "turbo's build by npx started by npx, both past an unlisted option's value",
        `npx --userconfig /tmp/u npx --cache /tmp/c turbo run build --cwd ${MAIN}/.claude/worktrees/a`,
      ],
    ],
  },
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: () => [
      ["turbo's build by runners nested past the readings' cap", `${DEEP} turbo run build`],
      [
        "bun's build past more unlisted options than the readings hold",
        "bun run --oa build --o0 v0 --o1 v1 --o2 v2 --o3 v3 --o4 v4 --o5 v5 --o6 v6 --o7 v7 --o8 v8 --o9 v9 --o10 v10 --o11 v11 --o12 v12 --o13 v13 --o14 v14",
      ],
      [
        "turbo's build by npx past more unlisted options than the readings hold",
        "npx --oa turbo --o0 v0 --o1 v1 --o2 v2 --o3 v3 --o4 v4 --o5 v5 --o6 v6 --o7 v7 --o8 v8 --o9 v9 --o10 v10 --o11 v11 --o12 v12 --o13 v13 --o14 v14 run build",
      ],
      // a control, refused before this source's fix
      [
        "bun's build past as many unlisted options as the readings hold",
        "bun run --oa build --o0 v0 --o1 v1 --o2 v2 --o3 v3 --o4 v4 --o5 v5 --o6 v6 --o7 v7 --o8 v8 --o9 v9 --o10 v10 --o11 v11 --o12 v12 --o13 v13",
      ],
    ],
  },
  {
    folders: ["checkout", "main checkout"],
    guards: ["no-unslotted-run"],
    rows: ({ MAIN }) => [
      [
        "turbo's build by runners nested past the readings' cap",
        `${DEEP} turbo run build --cwd ${MAIN}/.claude/worktrees/a`,
      ],
      [
        "bun's build past more unlisted options than the readings hold",
        `cd ${MAIN}/.claude/worktrees/a && bun run --oa build --o0 v0 --o1 v1 --o2 v2 --o3 v3 --o4 v4 --o5 v5 --o6 v6 --o7 v7 --o8 v8 --o9 v9 --o10 v10 --o11 v11 --o12 v12 --o13 v13 --o14 v14`,
      ],
      // a control, refused before this source's fix
      [
        "bun's build past as many unlisted options as the readings hold",
        `cd ${MAIN}/.claude/worktrees/a && bun run --oa build --o0 v0 --o1 v1 --o2 v2 --o3 v3 --o4 v4 --o5 v5 --o6 v6 --o7 v7 --o8 v8 --o9 v9 --o10 v10 --o11 v11 --o12 v12 --o13 v13`,
      ],
    ],
  },
]
