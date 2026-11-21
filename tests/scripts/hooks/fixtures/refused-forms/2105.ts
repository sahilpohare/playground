import type { Group } from "./_shared"

// #2105: after a cd the hook cannot read, perl's script and sed's w command wrote a relative file, since both were judged by their in-place edit alone; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "perl opening a file for writing after a cd to a variable",
        `cd "$X" && perl -e 'open F, ">x"'`,
      ],
      ["sed's w command after a cd to a variable", `cd "$X" && sed -n 'w out' f`],
      [
        "sed's w command on an absolute input after a cd to a variable",
        `cd "$X" && sed 'w out' /tmp/f`,
      ],
    ],
  },
]
