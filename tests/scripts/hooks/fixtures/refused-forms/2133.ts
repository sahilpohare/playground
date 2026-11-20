import { type Group, NEVER_MADE } from "./_shared"

// #2133: an unquoted variable the line never sets expands to no word, so the word after it runs as the program; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-kill-by-name"],
    rows: () => [
      ["a kill by pattern behind an unset variable", "$X pkill -f watcher"],
      [
        "a kill by pattern behind an unset variable through run-slot",
        "~/.playground/ops/run-slot.sh w -- $X pkill -f watcher",
      ],
      ["a kill by name behind a braced unset variable", "${X} killall node"],
      ["a kill by pattern behind two unset variables", "$X $Y pkill -f watcher"],
      ["a kill by pattern behind a word of two unset variables", "$X$Y pkill -f watcher"],
      ["a kill by pattern behind nice and an unset variable", "nice $X pkill -f watcher"],
      ["a kill by pattern behind a quoted list of no arguments", '"$@" pkill -f watcher'],
      ["a kill by pattern behind a list of no arguments", "$@ pkill -f watcher"],
      ["a kill by pattern behind a joined list of no arguments", "$* pkill -f watcher"],
      [
        "a kill by pattern behind an unset variable with an empty default",
        "${X:-} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable with an empty default for unset alone",
        "${X-} pkill -f watcher",
      ],
      ["a kill by pattern behind an unset variable's alternate value", "${X:+y} pkill -f watcher"],
      [
        "a kill by pattern behind an unset variable's alternate value for unset alone",
        "${X+y} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable assigned an empty default",
        "${X:=} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable assigned an empty default for unset alone",
        "${X=} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable with a prefix removed",
        "${X#a} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable with a suffix removed",
        "${X%a} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable with its longest prefix removed",
        "${X##*} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable with a replacement",
        "${X/a/b} pkill -f watcher",
      ],
      ["a kill by pattern behind an unset variable's substring", "${X:0} pkill -f watcher"],
      ["a kill by pattern behind an unset array's elements", "${X[@]} pkill -f watcher"],
      ["a kill by pattern behind an unset array's joined elements", "${X[*]} pkill -f watcher"],
      ["a kill by pattern behind an unset array's quoted elements", '"${X[@]}" pkill -f watcher'],
      ["a kill by pattern behind an indirect read of an unset variable", "${!X} pkill -f watcher"],
      [
        "a kill by pattern behind an unset variable joined to a quoted list of no arguments",
        '$X"$@" pkill -f watcher',
      ],
      [
        "a kill by pattern behind a quoted list of no arguments joined to an unset variable",
        '"$@"$X pkill -f watcher',
      ],
      [
        "a kill by pattern behind two quoted lists of no arguments joined",
        '"$@""$@" pkill -f watcher',
      ],
      [
        "a kill by pattern behind an unset variable read with zsh's split flag",
        "$=X pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable read with zsh's braced split flag",
        "${=X} pkill -f watcher",
      ],
      [
        "a kill by pattern behind an unset variable read with zsh's glob flag",
        "$~X pkill -f watcher",
      ],
      ["a kill by pattern behind an unset variable in an eval's words", "eval $X pkill -f watcher"],
      [
        "a kill by pattern behind an unset variable in an eval's quoted script",
        'eval "$X pkill -f watcher"',
      ],
      [
        "a kill by pattern behind an unset variable in a shell's script",
        'bash -c "$X pkill -f watcher"',
      ],
      [
        "a kill by pattern behind a variable the line names only as an argument",
        "echo s; $s pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable the line names only as read's prompt",
        "read -p s t; $s pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a declaration names with no value",
        "declare X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a declaration sets to nothing",
        "declare X=; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable local names with no value",
        "local X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable typeset names with no value",
        "typeset X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable export names with no value",
        "export X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable readonly names with no value",
        "readonly X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable read binds only after it",
        "$X pkill -f watcher; read X",
      ],
      [
        "a kill by pattern behind a variable read binds only after a failure",
        "false && read X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable read binds only in a subshell",
        "( read X ); $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a function's local names, never called",
        "f() { local X; }; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a function's read binds, never called",
        "f() { read X; }; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable export sets to nothing",
        "export X= ; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a loop binds only after it",
        "$X pkill -f watcher; for X in a; do :; done",
      ],
      [
        "a kill by pattern behind a variable read binds only in a pipeline",
        "echo | read X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a loop's variable after its loop",
        "for s in a b; do :; done; $s pkill -f watcher",
      ],
      [
        "a kill by pattern behind an inner loop's variable after the inner loop",
        "for s in a; do for t in b; do :; done; $t pkill -f watcher; done",
      ],
    ],
  },
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      ["a commit behind an unset variable", "$X git commit -m x"],
      [
        "a commit behind an unset variable through run-slot",
        "~/.playground/ops/run-slot.sh w -- $X git commit -m x",
      ],
      [
        "a commit after a cd behind an unset variable, from a worktree",
        `$X cd ${MAIN} && git commit -m x`,
        "checkout",
      ],
      [
        "a commit after a cd behind an unset variable's alternate value, from a worktree",
        `\${X:+y} cd ${MAIN} && git commit -m x`,
        "checkout",
      ],
      [
        "a commit after a cd behind an unset variable joined to a quoted list of no arguments, from a worktree",
        `$X"$@" cd ${MAIN} && git commit -m x`,
        "checkout",
      ],
      [
        "a commit after a pushd behind an unset variable, from a worktree",
        `$X pushd ${MAIN} && git commit -m x`,
        "checkout",
      ],
    ],
  },
  {
    folders: ["checkout", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [["a recursive delete behind an unset variable", `$X rm -rf ${NEVER_MADE}`]],
  },
]
