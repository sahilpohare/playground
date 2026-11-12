import { join } from "node:path"

import { type Group } from "./_shared"

// #1663: git changes into each -C as the kernel does, following a link before a `..`; the worktrees folder and a plain folder in it sit in no worktree, so git, turbo and bun walk up to the main checkout from there; a command after a cd's `||` runs only where the cd failed; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-main-checkout"],
    rows: ({ TREE_LINK }) => [
      [
        "a commit by a -C read from a link into the main checkout",
        "git -C into-main -C .. commit -m x",
      ],
      [
        "a commit by a -C read from a link named by its absolute path",
        `git -C ${TREE_LINK} -C .. commit -m x`,
      ],
      ["a commit by one -C that climbs out of a link", `git -C ${TREE_LINK}/.. commit -m x`],
      [
        "a reset by a --work-tree read from a link into the main checkout",
        "git -C into-main --work-tree=.. reset --hard",
      ],
      ["a commit after a cd that climbs to the worktrees folder", "cd .. && git commit -m x"],
    ],
  },
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      ["a commit by -C in the worktrees folder", "git -C .claude/worktrees commit -m x"],
      [
        "a commit by -C in a plain folder of the worktrees folder",
        "git -C .claude/worktrees/plain commit -m x",
      ],
      ["turbo by its --cwd in the worktrees folder", "turbo run build --cwd=.claude/worktrees"],
      [
        "turbo by its --cwd in a plain folder of the worktrees folder",
        "turbo run build --cwd=.claude/worktrees/plain",
      ],
      ["a build after a cd into the worktrees folder", "cd .claude/worktrees && bun run build"],
      [
        "a commit that runs only when the cd before its || failed",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || git commit -m x`,
      ],
      [
        "turbo by bunx --cwd that runs only when the cd before its || failed",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || bunx --cwd=api turbo run build`,
      ],
      // round 1: what the || runs, reached through a subshell, a substitution or an eval, and an exit that ends only a subshell
      [
        "a commit in a subshell the cd's || runs",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || (git commit -m x)`,
      ],
      [
        "a commit in a substitution the cd's || runs",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || echo $(git commit -m x)`,
      ],
      [
        "a commit in a substitution of the exit the cd's || runs",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || exit $(git commit -m x)`,
      ],
      [
        "a commit in an eval the || after the cd's run runs",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} && true || eval 'git commit -m x'`,
      ],
      [
        "a commit after an exit in a subshell the cd's || runs",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || (exit); git commit -m x`,
      ],
      [
        "a commit after a return the cd's || runs, which bash -c carries on past",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || return; git commit -m x`,
      ],
      // round 2: a script's own sure cd, and a brace group's exit as a pipeline stage
      [
        "a commit the || after an eval's cd runs",
        `eval 'cd ${join(MAIN, ".claude", "worktrees", "a")}' || git commit -m x`,
      ],
      [
        "a commit after an exit in a brace group piped on from the cd's ||",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || { exit; } | cat; git commit -m x`,
      ],
      [
        "a commit after an exit in a pipeline the cd's || runs",
        `cd ${join(MAIN, ".claude", "worktrees", "a")} || exit | cat; git commit -m x`,
      ],
    ],
  },
  // round 1: a physical cd follows a link before a `..`, as git's -C does
  {
    folders: ["checkout"],
    guards: ["no-main-checkout"],
    rows: () => [
      [
        "a commit after a physical cd that climbs out of a link",
        "cd -P into-main/.. && git commit -m x",
      ],
      [
        "a commit after a physical cd into a link, then a climb",
        "cd -P into-main && cd .. && git commit -m x",
      ],
      // round 2: any -P among the options lands physical, whatever else is there
      [
        "a commit after zsh's quiet physical cd that climbs out of a link",
        "cd -qP into-main/.. && git commit -m x",
      ],
      [
        "a commit after a quiet physical pushd that climbs out of a link",
        "pushd -qP into-main/.. && git commit -m x",
      ],
      ["a commit after a cd whose -P comes before -L", "cd -PL into-main/.. && git commit -m x"],
    ],
  },
]
