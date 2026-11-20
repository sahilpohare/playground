import { type Group, NEVER_MADE } from "./_shared"

const KILL = "pkill -f watcher"
const DELETE = `rm -rf ${NEVER_MADE}`

// A command the shell builds from an expansion: an array run whole, a held script an eval or a shell's -c runs, a loop variable over a literal list, each as the command it holds
const built = (command: string, program: string, rest: string) => [
  ["an array run whole", `A=(${command}); "\${A[@]}"`],
  ["an array run whole unquoted", `A=(${command}); \${A[@]}`],
  ["an array's joined elements run unquoted", `A=(${command}); \${A[*]}`],
  ["an array declare -a sets, run whole", `declare -a A=(${command}); "\${A[@]}"`],
  ["an array typeset -a sets, run whole", `typeset -a A=(${command}); "\${A[@]}"`],
  ["an array zsh's set -A sets, run whole", `set -A A ${command}; "\${A[@]}"`],
  ["a held script an eval runs", `S='${command}'; eval "$S"`],
  ["a held script a shell's -c runs", `S='${command}'; sh -c "$S"`],
  ["a held script bash -c runs", `S='${command}'; bash -c "$S"`],
  [
    "a loop variable over a literal list as the program",
    `for c in ${program}; do $c ${rest}; done`,
  ],
  ["a loop variable over a literal list as the command", `for c in '${command}'; do $c; done`],
]

// An array whose elements hold a blank or are empty, run whole unquoted, which bash splits again and drops an empty word of
const split = (elements: string[]) =>
  elements.map(
    (list) => [`an array of (${list}) run whole unquoted`, `A=(${list}); \${A[@]}`] as const,
  )

// The forms the review of this file's source found refused; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-kill-by-name"],
    rows: () => [
      ...built(KILL, "pkill", "-f watcher").map(
        ([what, call]) => [`a kill by name in ${what}`, call] as const,
      ),
      ["a killall in an array run whole", `A=(killall watcher); "\${A[@]}"`],
      ["a kill beside a search in an array run whole", `A=(kill $(pgrep -f watcher)); "\${A[@]}"`],
      ["a kill by name an ANSI-C string's escaped blank holds", `C=$'pkill\\x20-f'; $C watcher`],
      // an unquoted run splits each element again at blanks, as bash does
      ...split([
        "'pkill -f' watcher",
        '"pkill -f" watcher',
        "pkill\\ -f watcher",
        "'pkill -f watcher'",
      ]).map(([what, call]) => [`a kill by name in ${what}`, call] as const),
      [
        "a kill by name in an element holding a blank, its joined run unquoted",
        "A=('pkill -f' watcher); ${A[*]}",
      ],
      ["a kill by name an eval runs past its --, quoted", "eval -- 'pkill -f watcher'"],
      ["a kill by name an eval runs past its --", "eval -- pkill -f watcher"],
      ["a held kill by name an eval runs past its --, quoted", `S='${KILL}'; eval -- "$S"`],
      ["a held kill by name an eval runs past its --", `S='${KILL}'; eval -- $S`],
      // the reader cannot resolve these, so each is an unread command in a call that names a kill
      [
        "a loop variable over a list it cannot read",
        "for c in $(cat list); do $c -f watcher; done # pkill",
      ],
      ["a held script a read sets, run by an eval", `read S < list; eval "$S" # ${KILL}`],
      ["a held script a read sets, run by a shell's -c", `read S < list; sh -c "$S" # ${KILL}`],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-raw-delete"],
    rows: () => [
      // canary already refuses set -A's array, both loop forms and the ANSI-C string here, through its rule for a program word it cannot read given -r
      ...built(DELETE, "rm", `-rf ${NEVER_MADE}`)
        .filter(([what]) => !/set -A|loop/.test(what))
        .map(([what, call]) => [`a recursive delete in ${what}`, call] as const),
      ["a recursive delete by -R in an array run whole", `A=(rm -R ${NEVER_MADE}); "\${A[@]}"`],
      ...split([`'rm -rf' ${NEVER_MADE}`]).map(
        ([what, call]) => [`a recursive delete in ${what}`, call] as const,
      ),
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-stash"],
    rows: () => [
      [
        "a stash pop in a loop variable over a literal list as the command",
        "for c in 'git stash pop'; do $c; done",
      ],
      ["a stash pop in an array run whole", `A=(git stash pop); "\${A[@]}"`],
      ["a stash pop in a held script an eval runs", `S='git stash pop'; eval "$S"`],
      ...split(["'git stash' pop", "'git stash pop'", "'' git stash pop"]).map(
        ([what, call]) => [`a stash pop in ${what}`, call] as const,
      ),
      [
        "a stash pop in an element holding a blank, its joined run unquoted",
        "A=('git stash' pop); ${A[*]}",
      ],
    ],
  },
]
