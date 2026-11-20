import { type Group, NEVER_MADE, type Row } from "./_shared"

// #2288: a program word glued to a subshell's or a substitution's opening paren, or to a -c script's opening quote, spelled by a brace sequence, a zsh group or a group past the spelling cap; rows are data, as refused-forms.ts says. Each path row names a program both macOS and Linux keep at that path.

// a zsh group of more alternatives than a guard's first look spells, its last the program's own letters
const overCap = (last: string) =>
  `(${Array.from({ length: 65 }, (_, k) => `z${k}`).join("|")}|${last})`

// calls that run no guarded program: guarded names in quoted text or a search pattern, a subshell that changes folder and lints, a glob qualifier, and a date read into an assignment
const controls = (): Row[] => [
  ["a commit message that opens with a delete", `git commit -m "rm stale files"`],
  ["a reason that opens with a kill by name", `x --reason "pkill the watcher"`],
  ["an echo of text that opens with a stash pop", `echo "git stash pop"`],
  ["a subshell that changes folder and lints", "(cd x && bun run lint)"],
  ["a glob qualifier in an argument", "ls *(.)"],
  // a quoted alternation of guarded names, and a substitution inside an assignment before a read-only command
  ["a search for an alternation of guarded names", `grep -E "rm|pkill|stash" notes.txt`],
  [
    "a search for a grouped alternation of guarded names",
    `grep -E "(rm|pkill)|(git stash)" notes.txt`,
  ],
  ["a date read into an assignment before a status", "d=$(date) git status"],
  ["a date read into an assignment, then listed", `x=$(date); ls "$x"`],
]

const deleteControls = (): Row[] => [
  [
    "a delete a brace sequence spells, glued to a subshell's paren, in a comment",
    `# (/bin/r{m..m} ${NEVER_MADE})`,
  ],
  // a comment twin for each class
  [
    "a delete a brace sequence spells, glued to a substitution's paren, in a comment",
    `# echo $(/bin/r{m..m} ${NEVER_MADE})`,
  ],
  [
    "a delete a brace sequence spells, glued to a -c script's quote, in a comment",
    `# bash -c '/bin/r{m..m} ${NEVER_MADE}'`,
  ],
  [
    "a delete a brace sequence spells, glued to a substitution's paren after an =, in a comment",
    `# x=$(/bin/r{m..m} ${NEVER_MADE})`,
  ],
  [
    "a delete a brace sequence spells, glued to a subshell's paren after a pipe, in a comment",
    `# true|(/bin/r{m..m} ${NEVER_MADE})`,
  ],
]

const killControls = (): Row[] => [
  [
    "a kill by name a zsh alternation spells, glued to a -c script's quote, in a comment",
    `# zsh -c 'pk(i|x)ll -f watcher'`,
  ],
  // a comment twin for each class
  [
    "a kill by name a one-word zsh group spells after a cd, glued to a subshell's paren, in a comment",
    `# cd "$Q" && (pk(i)ll -f watcher)`,
  ],
  [
    "a kill by name a zsh alternation spells, glued to a substitution's paren, in a comment",
    "# echo $(pk(i|x)ll -f watcher)",
  ],
  [
    "a kill by name a zsh alternation spells, glued to a substitution's paren after an =, in a comment",
    "# x=$(pk(i|x)ll -f watcher)",
  ],
  [
    "a kill by name a zsh alternation spells, glued to a subshell's paren after a pipe, in a comment",
    "# true|(/usr/bin/pk(i|x)ll -f watcher)",
  ],
]

export const groups: Group[] = [
  {
    folders: ["process data folder", "process home", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      [
        "a plain rm by a path a brace sequence spells, glued to a subshell's paren",
        `(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a subshell's paren, after a header line",
        `#!/bin/sh\n(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells across a backslash-newline, glued to a subshell's paren",
        `(/bin/r{m..\\\nm} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a substitution's paren",
        `echo $(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a substitution's paren, after a header line",
        `#!/bin/sh\necho $(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a zsh group past the cap matches, glued to a subshell's paren",
        `(/bin/r${overCap("m")} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a zsh alternation matches, glued to a subshell's paren",
        `(/bin/r(m|x) ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a zsh alternation matches, glued to a subshell's paren, after a header line",
        `#!/bin/sh\n(/bin/r(m|x) ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a -c script's quote",
        `bash -c '/bin/r{m..m} ${NEVER_MADE}'`,
      ],
      // the twins each class lacked
      [
        "a plain rm by a path a brace sequence spells across a backslash-newline, glued to a substitution's paren",
        `echo $(/bin/r{m..\\\nm} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a -c script's quote, after a header line",
        `#!/bin/sh\nbash -c '/bin/r{m..m} ${NEVER_MADE}'`,
      ],
      [
        "a plain rm by a path a brace sequence spells across a backslash-newline, glued to a -c script's quote",
        `bash -c '/bin/r{m..\\\nm} ${NEVER_MADE}'`,
      ],
      // a substitution's paren glued after an = or other word text, and a subshell's paren glued after a pipe
      [
        "a plain rm by a path a brace sequence spells, glued to a substitution's paren after an =",
        `x=$(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a substitution's paren after an =, after a header line",
        `#!/bin/sh\nx=$(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells across a backslash-newline, glued to a substitution's paren after an =",
        `x=$(/bin/r{m..\\\nm} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a substitution's paren after word text",
        `echo a$(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a subshell's paren after a pipe",
        `true|(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a subshell's paren after a ||",
        `true||(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, glued to a subshell's paren after a pipe, after a header line",
        `#!/bin/sh\ntrue|(/bin/r{m..m} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells across a backslash-newline, glued to a subshell's paren after a pipe",
        `true|(/bin/r{m..\\\nm} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, spaced from a substitution's paren after an =",
        `x=$( /bin/r{m..m} ${NEVER_MADE} )`,
      ],
      [
        "a plain rm by a path a brace sequence spells, spaced from a subshell's paren after a pipe",
        `true|( /bin/r{m..m} ${NEVER_MADE} )`,
      ],
      // the zsh alternation and over-cap classes glued to a -c script's quote or a substitution's paren
      [
        "a plain rm by a path a zsh alternation matches, glued to a -c script's quote",
        `zsh -c '/bin/r(m|x) ${NEVER_MADE}'`,
      ],
      [
        "a plain rm by a path a zsh alternation matches, glued to a -c script's double quote",
        `zsh -c "/bin/r(m|x) ${NEVER_MADE}"`,
      ],
      [
        "a plain rm by a path a zsh group past the cap matches, glued to a -c script's quote",
        `zsh -c '/bin/r${overCap("m")} ${NEVER_MADE}'`,
      ],
      [
        "a plain rm by a path a zsh group past the cap matches, glued to a substitution's paren",
        `echo $(/bin/r${overCap("m")} ${NEVER_MADE})`,
      ],
      [
        "a plain rm by a path a brace sequence spells, spaced from a substitution's paren",
        `echo $( /bin/r{m..m} ${NEVER_MADE} )`,
      ],
      [
        "a plain rm by a path a brace sequence spells, spaced from a subshell's paren after a ||",
        `true||( /bin/r{m..m} ${NEVER_MADE} )`,
      ],
      // the spaced twins, refused at canary
      [
        "a plain rm by a path a brace sequence spells, spaced from a subshell's paren",
        `( /bin/r{m..m} ${NEVER_MADE} )`,
      ],
      [
        "a plain rm by a path a brace sequence spells, in a brace group",
        `{ /bin/r{m..m} ${NEVER_MADE}; }`,
      ],
      ...controls(),
      ...deleteControls(),
    ],
  },
  {
    folders: ["checkout", "home"],
    guards: ["no-kill-by-name"],
    rows: () => [
      [
        "a kill by name a one-word zsh group spells after a cd into a folder it cannot read, glued to a subshell's paren",
        `cd "$Q" && (pk(i)ll -f watcher)`,
      ],
      [
        "a kill by name a one-word zsh group spells across a backslash-newline after a cd, glued to a subshell's paren",
        `cd "$Q" && (pk(\\\ni)ll -f watcher)`,
      ],
      [
        "a kill by name at a path a zsh group past the cap matches, glued to a subshell's paren",
        `(/usr/bin/pk${overCap("i")}ll -f watcher)`,
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren",
        "echo $(pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren, after a header line",
        "#!/bin/sh\necho $(pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells across a backslash-newline, glued to a substitution's paren",
        "echo $(pk(i|\\\nx)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches, glued to a -c script's quote",
        `zsh -c '/usr/bin/pk(i|x)ll -f watcher'`,
      ],
      [
        "a kill by name a zsh alternation spells, glued to a -c script's quote",
        `zsh -c 'pk(i|x)ll -f watcher'`,
      ],
      [
        "a kill by name a zsh alternation spells, glued to a -c script's double quote",
        `zsh -c "pk(i|x)ll -f watcher"`,
      ],
      [
        "a kill by name at a path a brace list fused with a zsh group spells, glued to a -c script's quote",
        `zsh -c '/usr/bin/pk{(i|x),y}ll -f watcher'`,
      ],
      [
        "a kill by name a zsh alternation spells, glued to a -c script's quote, after a header line",
        `#!/bin/sh\nzsh -c 'pk(i|x)ll -f watcher'`,
      ],
      [
        "a kill by name a zsh alternation spells across a backslash-newline, glued to a -c script's quote",
        `zsh -c 'pk(i|\\\nx)ll -f watcher'`,
      ],
      // the twins each class lacked
      [
        "a kill by name a one-word zsh group spells after a header line and a cd, glued to a subshell's paren",
        `#!/bin/sh\ncd "$Q" && (pk(i)ll -f watcher)`,
      ],
      // a substitution's paren glued after an = or other word text, and a subshell's paren glued after a pipe
      [
        "a kill by name at a path a zsh alternation matches, glued to a substitution's paren after an =",
        "x=$(/usr/bin/pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches, glued to a quoted substitution's paren after an =",
        `x="$(/usr/bin/pk(i|x)ll -f watcher)"`,
      ],
      [
        "a kill by name at a path a zsh alternation matches, glued to a substitution's paren after word text",
        "echo a$(/usr/bin/pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren after an =",
        "x=$(pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren after an option's =",
        "echo --x=$(pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren inside a quote",
        `echo "x$(pk(i|x)ll -f watcher)"`,
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren inside a zsh expansion flag",
        `echo \${(f)"$(pk(i|x)ll -f watcher)"}`,
      ],
      [
        "a kill by name a zsh alternation spells, glued to a substitution's paren after an =, after a header line",
        "#!/bin/sh\nx=$(pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells across a backslash-newline, glued to a substitution's paren after an =",
        "x=$(pk(i|\\\nx)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches, glued to a subshell's paren after a pipe",
        "true|(/usr/bin/pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches, glued to a subshell's paren after a ||",
        "true||(/usr/bin/pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches, glued to a subshell's paren after a pipe, after a header line",
        "#!/bin/sh\ntrue|(/usr/bin/pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches across a backslash-newline, glued to a subshell's paren after a pipe",
        "true|(/usr/bin/pk(i|\\\nx)ll -f watcher)",
      ],
      [
        "a kill by name at a path a zsh alternation matches, spaced from a subshell's paren after a pipe",
        "true | (/usr/bin/pk(i|x)ll -f watcher)",
      ],
      [
        "a kill by name a zsh alternation spells, spaced from a substitution's paren after an =",
        "x=$( pk(i|x)ll -f watcher )",
      ],
      // the over-cap class glued to a substitution's paren or a -c script's quote
      [
        "a kill by name at a path a zsh group past the cap matches, glued to a substitution's paren",
        `echo $(/usr/bin/pk${overCap("i")}ll -f watcher)`,
      ],
      [
        "a kill by name at a path a zsh group past the cap matches, glued to a -c script's quote",
        `zsh -c '/usr/bin/pk${overCap("i")}ll -f watcher'`,
      ],
      [
        "a kill by name a zsh alternation spells, spaced from a subshell's paren",
        "( pk(i|x)ll -f watcher )",
      ],
      [
        "a kill by name a zsh alternation spells, spaced from a -c script's quote",
        `zsh -c ' pk(i|x)ll -f watcher'`,
      ],
      // the spaced twin, refused at canary
      [
        "a kill by name a zsh alternation spells, spaced from a substitution's paren",
        "echo $( pk(i|x)ll -f watcher )",
      ],
      ...controls(),
      ...killControls(),
    ],
  },
  {
    folders: ["checkout", "data folder", "home"],
    guards: ["no-stash"],
    rows: () => controls(),
  },
]

export const allowed: string[] = [...controls(), ...deleteControls(), ...killControls()].map(
  ([what]) => what,
)
