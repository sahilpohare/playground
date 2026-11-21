import { type Group, NEVER_MADE } from "./_shared"

// #1421: after a cd the hook cannot read, xargs hands a remover or a writer its stdin words where shell.ts misread xargs' or printf's flags (a line-count flag that takes no value, a later wrapper's -i, printf's leading --), or read an xargs-run program's output as known words; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "rm under xargs --max-lines, which takes no value, after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs --max-lines rm -r`,
      ],
      [
        "rm under xargs --max-lines fed a relative name, then an absolute one",
        `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-lines rm -r`,
      ],
      [
        "rm under env -i under xargs after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs env -i rm -r`,
      ],
      [
        "rm under xargs fed by printf -- after a cd to a variable",
        `cd "$X" && printf -- '.no-such-folder' | xargs rm -rf`,
      ],
      [
        "rm under xargs fed by an xargs-run echo after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs echo | xargs rm -r`,
      ],
      [
        "rm under xargs fed by an xargs -n1 echo after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs -n1 echo | xargs rm -r`,
      ],
      [
        "touch under xargs fed by an xargs-run echo after a cd to a variable",
        `cd "$X" && echo .no-such-file | xargs echo | xargs touch`,
      ],
    ],
  },
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "rm under xargs fed the root's path by printf --",
        "printf -- '%s\\n' ~/.playground/extensions/.no-such-folder | xargs rm -rf",
      ],
    ],
  },
  {
    folders: ["process home", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      [
        "a recursive delete under xargs --max-lines, which takes no value",
        `echo a | xargs --max-lines rm -rf ${NEVER_MADE}`,
      ],
      [
        "a recursive delete under xargs --max-lines=2",
        `echo a | xargs --max-lines=2 rm -rf ${NEVER_MADE}`,
      ],
      ["a recursive delete under xargs -L1", `echo a | xargs -L1 rm -rf ${NEVER_MADE}`],
    ],
  },
]
