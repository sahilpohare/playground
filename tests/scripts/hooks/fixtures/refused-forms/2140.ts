import type { Group } from "./_shared"

// #2140: grep under xargs reads as a reader only when xargs runs grep itself, with grep's environment as typed: a replace string in grep's own word puts stdin in place of the program, and --process-slot-var sets a variable such as PATH in grep's environment; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "cp in place of grep through xargs -J",
        "echo cp | xargs -J grep grep /tmp/a $HOME/.playground/extensions/b",
      ],
      [
        "touch in place of grep through xargs -J",
        "echo touch | xargs -J grep grep $HOME/.playground/extensions/b",
      ],
      [
        "tee in place of grep through xargs -J",
        "echo tee | xargs -J grep grep $HOME/.playground/extensions/b",
      ],
      [
        "cp in place of grep by a system path through xargs -J",
        "echo cp | xargs -J /usr/bin/grep /usr/bin/grep /tmp/a $HOME/.playground/extensions/b",
      ],
      [
        "cp in place of grep through xargs -I",
        "echo cp | xargs -I grep grep /tmp/a $HOME/.playground/extensions/b",
      ],
      [
        "cp in place of grep through an attached xargs -I",
        "echo cp | xargs -Igrep grep /tmp/a $HOME/.playground/extensions/b",
      ],
      [
        "cp in place of grep through xargs --replace=",
        "echo cp | xargs --replace=grep grep /tmp/a $HOME/.playground/extensions/b",
      ],
      [
        "grep under xargs --process-slot-var= setting PATH",
        'ls /tmp | xargs --process-slot-var=PATH grep -h "x in $HOME/.playground"',
      ],
      [
        "grep under xargs --process-slot-var setting PATH",
        'ls /tmp | xargs --process-slot-var PATH grep -h "x in $HOME/.playground"',
      ],
      [
        "grep under gxargs --process-slot-var= setting PATH",
        'ls /tmp | gxargs --process-slot-var=PATH grep -h "x in $HOME/.playground"',
      ],
    ],
  },
]
