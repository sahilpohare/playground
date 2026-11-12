// What every source file in this folder shares: the shapes of a group and its rows, and NEVER_MADE; refused-forms.ts, beside the folder, reads every source file and skips this one.
// A row that deletes from HOME recursively names NEVER_MADE, a path under the root that never exists, and one that names a folder itself (the root, the data folder) deletes it by a plain rm, which removes no folder, so a row run by mistake deletes nothing; refused-forms.test.ts holds every row to it.
export const NEVER_MADE = "~/.playground/extensions/.no-such-folder"

export type Guard =
  | "no-desktop-owner-app"
  | "no-env-dump"
  | "no-extension-repo-write"
  | "no-extensions-write"
  | "no-glm-heavy-path"
  | "no-headless-login"
  | "no-kill-by-name"
  | "no-linear-ticket"
  | "no-main-checkout"
  | "no-outside-pr-code"
  | "no-playground-leak"
  | "no-public-leak"
  | "no-raw-delete"
  | "no-raw-spawn"
  | "no-release-comment"
  | "no-stash"
  | "no-unslotted-run"

// "process …" folders sit in the home `~` expands to (the process's own), the rest in the test's scratch machine.
export type Folder =
  | "bare home"
  | "checkout"
  | "cli folder"
  | "data folder"
  | "extensions root"
  | "glm org repo"
  | "glm repo"
  | "home"
  | "main checkout"
  | "main checkout subfolder"
  | "outside clone"
  | "outside clone subfolder"
  | "outside clone subfolder with bunfig"
  | "outside clone under a bunfig"
  | "outside clone with an env file"
  | "plain clone"
  | "process data folder"
  | "process home"
  | "process tmp"
  | "process worktree"
  | "scratch folder"
  | "tmp"
  | "unknown folder"
  | "worktree"

export type Paths = {
  BARE: string
  CLI_DIR: string
  DATA: string
  // worktrees another repository lists: one outside the main checkout, one placed under its .claude/worktrees
  FOREIGN_TREE: string
  FOREIGN_TREE_IN_MAIN: string
  HOME: string
  LINK: string
  LIST: string
  MAIN: string
  ROOT: string
  SCOPE: string
  // a link inside the main checkout's worktree that names a folder of the main checkout
  TREE_LINK: string
  WORDS: string
  WORK: string
}

export type Call = string | { input: Record<string, unknown>; tool: string }

// A row's own folder, its third value, takes the place of its group's folders.
export type Row = readonly [what: string, call: Call, folder?: Folder]

// A group's source is its file's name: <n>.ts holds the rows of source #<n>.
export type Group = {
  folders: Folder[]
  guards: Guard[]
  rows: (paths: Paths) => readonly Row[]
}
