import { type Group, NEVER_MADE } from "./_shared"

// #2244: a program path written as a glob that matches a guarded program, an array run the reader cannot read in a call that names a guarded program, and a loop variable read after its loop; rows are data, as refused-forms.ts says. Each glob row names a program both macOS and Linux keep at that path.
const DELETE = `rm -rf ${NEVER_MADE}`

export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-kill-by-name"],
    rows: () => [
      ["a kill by name at a path a ? glob matches", "/usr/bin/pk?ll -f watcher"],
      ["a kill by name at a path a * glob matches", "/usr/bin/pk*ll -f watcher"],
      ["a kill by name at a path a bracket glob matches", "/usr/bin/pk[i]ll -f watcher"],
      ["a kill by name in a loop over a glob", "for c in pk?ll; do $c -f watcher; done"],
      [
        "a kill by name in a loop variable read after a one-word literal loop",
        "c=echo; for c in pkill; do :; done; $c -f watcher",
      ],
      [
        "a kill by name in a loop variable set before a one-word literal loop, read in its body",
        "c=echo; for c in pkill; do $c -f watcher; done",
      ],
      [
        "a kill by name in a loop variable its body set, read after the loop",
        "c=echo; for c in x; do c=pkill; done; $c -f watcher",
      ],
      [
        "a kill by name in a loop variable read after a loop over a list it cannot read",
        "c=echo; for c in $(cat list); do :; done; $c -f watcher # pkill",
      ],
      [
        "a kill by name in a loop variable set before a one-word literal loop, read after it",
        "c=pkill; for c in echo; do :; done; $c -f watcher",
      ],
      ["a kill by name at a path of bracket globs alone", "/usr/bin/[p][k][i][l][l] -f watcher"],
      ["a kill by name at a path of bracket and ? globs alone", "/usr/bin/[p]?[i]?[l] -f watcher"],
      [
        "a kill by name at a path a POSIX class glob matches",
        "/usr/bin/pk[[:alpha:]]ll -f watcher",
      ],
      ["a kill by name at a held folder and a glob", "X=/usr/bin; $X/pk?ll -f watcher"],
      ["a kill by name at a held glob", "X=/usr/bin/pk?ll; $X -f watcher"],
      ["a kill by name at a path a lone colon bracket matches", "/usr/bin/p[:k:]ill -f watcher"],
      ["a kill by name at a quoted held folder and a glob", 'X=/usr/bin; "$X"/pk?ll -f watcher'],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-stash"],
    rows: () => [
      ["a stash pop by a git path a ? glob matches", "/usr/bin/g?t stash pop"],
      ["a stash pop in an array an append changed", `A=(git stash); A+=(pop); "\${A[@]}"`],
      [
        "a stash pop in an array an element's assignment changed",
        `A=(echo stash pop); A[0]=git; "\${A[@]}"`,
      ],
      [
        "a stash pop in an array a shell's -c sets and runs",
        `bash -c 'A=(git stash pop); "\${A[@]}"'`,
      ],
      [
        "a stash pop in an array a shell's -c sets and runs unquoted",
        "bash -c 'A=(git stash pop); ${A[@]}'",
      ],
      ["a stash pop in an array an eval sets and runs", `eval 'A=(git stash pop); "\${A[@]}"'`],
      [
        "a stash pop in an array of a spaced element a shell's -c sets and runs unquoted",
        `bash -c 'A=("git stash" pop); \${A[@]}'`,
      ],
      [
        "a stash pop in a loop variable its body set, read after the loop",
        "c=echo; for c in x; do c='git stash'; done; $c pop",
      ],
      [
        "a stash pop in an unset loop variable its body set, read after the loop",
        "for c in x; do c='git stash'; done; $c pop",
      ],
      [
        "a stash pop in a loop variable read after a one-word literal loop",
        "c=echo; for c in 'git stash'; do :; done; $c pop",
      ],
      [
        "a stash pop in an unset loop variable read after a one-word literal loop",
        "for c in 'git stash'; do :; done; $c pop",
      ],
      [
        "a stash pop in a loop variable set before a one-word literal loop, read after it",
        "c='git stash'; for c in echo; do :; done; $c pop",
      ],
      ["a stash pop by a git path a POSIX class glob matches", "/usr/bin/g[[:alpha:]]t stash pop"],
      ["a stash pop by a git path a lone colon bracket matches", "/usr/bin/g[:i:]t stash pop"],
      [
        "a stash pop in an array an append changed, git in an ANSI-C string",
        `A=($'\\x67it' stash); A+=(pop); "\${A[@]}"`,
      ],
      [
        "a stash pop in an array an append changed, stash in an ANSI-C string",
        `A=(git $'st\\x61sh'); A+=(pop); "\${A[@]}"`,
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-raw-delete"],
    rows: () => [
      ["a plain rm outside the worktree by a path a ? glob matches", `/bin/r? ${NEVER_MADE}`],
      [
        "a recursive delete in an array an element's assignment changed",
        `A=(echo -rf ${NEVER_MADE}); A[0]=rm; "\${A[@]}"`,
      ],
      [
        "a recursive delete in an array set twice",
        `A=(echo hi); declare -a A=(${DELETE}); "\${A[@]}"`,
      ],
      [
        "a recursive delete in an array a shell's -c sets and runs",
        `bash -c 'A=(${DELETE}); "\${A[@]}"'`,
      ],
      [
        "a plain rm in a loop variable its body set, read after the loop",
        `c=echo; for c in x; do c=rm; done; $c ${NEVER_MADE}`,
      ],
      [
        "a plain rm in an unset loop variable its body set, read after the loop",
        `for c in x; do c=rm; done; $c ${NEVER_MADE}`,
      ],
      [
        "a plain rm and its path in a loop variable its body set, read after the loop",
        `for c in x; do c='rm ${NEVER_MADE}'; done; $c`,
      ],
      [
        "a recursive delete in a loop variable its body set, read after the loop",
        `c=echo; for c in x; do c='${DELETE}'; done; $c`,
      ],
      [
        "a plain rm in a loop variable read after a one-word literal loop",
        `c=echo; for c in rm; do :; done; $c ${NEVER_MADE}`,
      ],
      [
        "a plain rm in an unset loop variable read after a one-word literal loop",
        `for c in rm; do :; done; $c ${NEVER_MADE}`,
      ],
      [
        "a plain rm in a loop variable set before a one-word literal loop, read after it",
        `c=rm; for c in echo; do :; done; $c ${NEVER_MADE}`,
      ],
      ["a plain rm by a path a POSIX class glob matches", `/bin/r[[:alpha:]] ${NEVER_MADE}`],
      ["a plain rm at a held folder and a glob", `X=/bin; $X/r? ${NEVER_MADE}`],
      ["a plain rm at a held glob", `X=/bin/r?; $X ${NEVER_MADE}`],
      ["a plain rm by a path a lone colon bracket matches", `/bin/r[:m:] ${NEVER_MADE}`],
      ["a plain rm at a quoted held folder and a glob", `X=/bin; "$X"/r? ${NEVER_MADE}`],
      [
        "a plain rm in an array an element's assignment set from an ANSI-C string",
        `A=(echo ${NEVER_MADE}); A[0]=$'\\x72m'; "\${A[@]}"`,
      ],
    ],
  },
]
