import { type Group } from "./_shared"

// #2161: a builtin later on the line may change a held variable's value or leave it with no word, so the program after it runs where the reader read the old value; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-kill-by-name"],
    rows: () => [
      [
        "a kill by pattern behind a variable unset after it is set",
        "X=a; unset X; $X pkill -f watcher",
      ],
      ["a kill by pattern behind a variable set to a blank", 'X=" "; $X pkill -f watcher'],
      [
        "a kill by pattern behind a variable set to blanks the line's IFS splits at",
        'IFS=" "; X="  "; $X pkill -f watcher',
      ],
      ["a kill by pattern behind a variable unset with -v", "X=a; unset -v X; $X pkill -f watcher"],
      [
        "a kill by pattern behind a variable zsh unsets by a pattern",
        "X=a; unset -m 'X*'; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable unset behind an &&",
        "X=a; true && unset X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable read sets at the end of its input",
        "X=a; read X < /dev/null; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable read sets with no value before it",
        "read X < /dev/null; $X pkill -f watcher",
      ],
      ["a kill by pattern behind a variable read binds", "read s; $s pkill -f watch"],
      [
        "a kill by pattern behind a variable read binds after its options",
        "read -r -p prompt s; $s pkill -f watch",
      ],
      ["a kill by pattern behind an array read binds", "read -a s; $s pkill -f watch"],
      [
        "a kill by pattern behind a variable a while read loop leaves",
        "X=a; while read X; do :; done < /dev/null; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable printf -v sets",
        "X=a; printf -v X ''; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable declare makes a reference",
        "X=a; declare -n X=Y; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable typeset gives an attribute",
        "X=a; typeset -u X; $X pkill -f watcher",
      ],
      ["a kill by pattern behind a variable local declares", "X=a; local X; $X pkill -f watcher"],
      [
        "a kill by pattern behind a variable zsh's private declares",
        "X=a; private X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's float declares",
        "X=a; float X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's integer declares",
        "X=a; integer X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable export gives an option",
        "X=a; export -n X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable readonly gives an option",
        "X=a; readonly -a X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's set -A sets",
        "X=a; set -A X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable an unread eval may change",
        'X=a; eval "$Y"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable a sourced file may change",
        "X=a; source ./env.sh; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a dot-sourced file may change",
        "X=a; . ./env.sh; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable an unread program with an unread argument may change",
        'X=a; $P "$Q"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable a program the reader cannot read may change",
        "U=unset; X=a; $U X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's print -v sets",
        "X=a; print -v X ''; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's zparseopts sets",
        "X=a; zparseopts x=X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's zformat sets",
        "X=a; zformat -f X '' a:b; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable zsh's zstyle sets",
        "X=a; zstyle -s :x y X; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable mapfile sets",
        "X=a; mapfile -t X < /dev/null; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable read sets as its default name",
        "REPLY=a; read < /dev/null; $REPLY pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a trap's text may change",
        "X=a; trap 'unset X' DEBUG; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable unset names by a substitution",
        "X=a; unset $(printf X); $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable unset names by a variable the reader cannot read",
        'N=$(printf X); X=a; unset "$N"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable read names by a substitution",
        "X=a; read $(printf X) < /dev/null; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a for loop's body unsets for its next pass",
        "X=a; for i in 1 2; do $X pkill -f watcher; unset X; done",
      ],
      [
        "a kill by pattern behind a variable a while loop's body unsets for its next pass",
        "X=a; while :; do $X pkill -f watcher; unset X; done",
      ],
      [
        "a kill by pattern behind a variable an until loop's body unsets for its next pass",
        "X=a; until false; do $X pkill -f watcher; unset X; done",
      ],
      [
        "a kill by pattern a zsh repeat loop's body runs first",
        "repeat 2 do pkill -f watcher; done",
      ],
      [
        "a kill by pattern behind a variable a zsh repeat loop's body unsets for its next pass",
        "X=a; repeat 2 do $X pkill -f watcher; unset X; done",
      ],
      [
        "a kill by pattern a zsh repeat loop's braced body runs first",
        "repeat 2 { pkill -f watcher; }",
      ],
      [
        "a kill by pattern behind a variable a zsh repeat loop's braced body unsets for its next pass",
        "X=a; repeat 2 { $X pkill -f watcher; unset X; }",
      ],
      [
        "a kill by pattern behind a variable an array run whole unsets",
        'A=(unset X); X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole reads",
        'A=(read X); X=a; "${A[@]}" < /dev/null; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole evaluates text on",
        `A=(eval 'unset X'); X=a; "\${A[@]}"; $X pkill -f watcher`,
      ],
      [
        "a kill by pattern behind a variable an array the reader cannot read whole may change",
        'A=($(printf unset) X); X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after bash sets an element",
        'A=(echo X); A[0]=unset; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after zsh sets an element",
        'A=(echo X); A[1]=unset; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after an element's unset",
        'A=(echo unset X); unset "A[0]"; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after zsh empties an element",
        'A=(echo unset X); A[1]=(); X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after an append",
        'A=(); A+=(unset X); X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after read sets an element",
        'A=(echo X); read "A[0]" <<< unset; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after print -v sets an element",
        'A=(echo X); print -v "A[1]" unset; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after export sets an element",
        'A=(echo X); export "A[1]=unset"; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole the line names elsewhere",
        'A=(echo X); : ${A[1]}; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after printf sets an element by its joined -v",
        'A=(echo X); printf -vA[0] unset; X=a; "${A[@]}"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array run whole changes after eval's text sets an element",
        `A=(echo X); eval 'echo hi; A[0]=unset'; X=a; "\${A[@]}"; $X pkill -f watcher`,
      ],
      [
        "a kill by pattern behind a variable zsh's nameref makes a reference",
        "X=a; nameref X=Y; $X pkill -f watcher",
      ],
      [
        "a kill by pattern behind a variable a loop's body assigns for its next pass",
        "X=a; for i in 1 2; do $X pkill -f watcher; X=; done",
      ],
      [
        "a kill by pattern behind a variable an array that holds eval may change",
        'X=a; A=(eval); "${A[@]}" "$Q"; $X pkill -f watcher',
      ],
      [
        "a kill by pattern behind a variable an array that holds source may change",
        'X=a; A=(source); "${A[@]}" ./env.sh; $X pkill -f watcher',
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-main-checkout"],
    rows: () => [
      [
        "a commit after a relative cd a zsh repeat loop's body holds",
        "repeat 3 do cd ..; done; git commit -m x",
      ],
    ],
  },
  {
    folders: ["home"],
    guards: ["no-extensions-write"],
    rows: ({ ROOT }) => [
      [
        "a copy into the root by a literal held past a cd's && chain",
        `cd /tmp && f=${ROOT}/x; cp /tmp/a "$f"`,
      ],
      [
        "a copy by a relative literal held past a cd into the root",
        `cd ${ROOT} && f=x; cp /tmp/a "$f"`,
      ],
      [
        "a copy by a literal held past a cd's && chain whose name the line set before",
        `f=${ROOT}/x; cd /tmp && f=/tmp/y; cp /tmp/a "$f"`,
      ],
      [
        "a copy by a relative literal held past a cd's && chain, which the starting folder may hold",
        `cd /tmp && f=out.txt; cp /tmp/a "$f"`,
      ],
      [
        "a copy through a held variable after an unread program with an unread argument",
        `S=/tmp/x; $P "$Q"; cp /tmp/a "$S"`,
      ],
      [
        "a copy by a value held past a cd's && chain that is not a literal",
        `cd /tmp && f=$(pwd)/x; cp /tmp/a "$f"`,
      ],
      [
        "a copy by an unquoted literal held past a cd's && chain, whose empty value makes the folder before it the copy's",
        "cd /tmp && f=/tmp/out.txt; cp /tmp/a .playground/extensions/hooks $f",
      ],
    ],
  },
  {
    folders: ["extensions root"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "a copy by a relative literal held past a cd out of the root, which a failed cd leaves in it",
        `cd /tmp && f=x; cp /tmp/a "$f"`,
      ],
      [
        "a copy by a literal held past a cd's && chain and joined to a relative name, which an empty value leaves in the root",
        `cd /tmp && S=/tmp/; cp /tmp/a "\${S}x"`,
      ],
      [
        "a copy by an unquoted literal held past a cd's && chain, whose empty value makes the name before it the copy's",
        "cd /tmp && f=/tmp/out.txt; cp /tmp/a sub $f",
      ],
      [
        "a move by an unquoted literal held past a cd's && chain, whose empty value makes the name before it the move's",
        "cd /tmp && f=/tmp/out.txt; mv /tmp/a sub $f",
      ],
      [
        "a link by an unquoted literal held past a cd's && chain, whose empty value makes the name before it the link",
        "cd /tmp && f=/tmp/out.txt; ln -s /tmp/a sub $f",
      ],
      [
        "a copy by an unquoted braced literal held past a cd's && chain, whose empty value makes the name before it the copy's",
        "cd /tmp && f=/tmp/out.txt; cp /tmp/a sub ${f}",
      ],
    ],
  },
]
