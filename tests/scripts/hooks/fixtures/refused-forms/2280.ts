import { type Group, NEVER_MADE, type Row } from "./_shared"

// #2280: a program word spelled by a brace sequence, a brace list fused with a zsh group, a one-word zsh group after a cd into a folder the reader cannot read, or a brace list or zsh group past the spelling cap; rows are data, as refused-forms.ts says. Each path row names a program both macOS and Linux keep at that path.

// a zsh group of more alternatives than a guard's first look spells, its last the program's own letters
const overCap = (last: string) =>
  `(${Array.from({ length: 65 }, (_, k) => `z${k}`).join("|")}|${last})`

// a zsh group of n alternatives, its last the given letters
const group = (n: number, last: string) =>
  `(${Array.from({ length: n - 1 }, (_, k) => `z${k}`).join("|")}|${last})`

const killControls = (): Row[] => [
  ["an echo of a kill path a brace sequence spells", "echo /usr/bin/pk{i..i}ll -f watcher"],
  ["an echo of a kill name a one-word zsh group spells, after a cd", `cd "$Q" && echo pk(i)ll`],
  ["an echo of a brace list past the cap", "echo pk{i,x}{a,}{b,}{c,}{d,}{e,}{f,}ll -f watcher"],
  ["an echo of a zsh group past the cap", `echo /usr/bin/pk${overCap("i")}ll -f watcher`],
  ["a kill by name past the cap in a comment", "# pk{i,x}{a,}{b,}{c,}{d,}{e,}{f,}ll -f watcher"],
  ["a plain program word beside a kill's words", "echo -f watcher"],
  // round 2: a number sequence as an argument, beside a program word the reader cannot read
  ["a loop over a number sequence running a variable", "for i in {1..3}; do $X status; done"],
  ["a list of a number sequence beside a variable's program", "ls /tmp/{1..3}; $EDITOR notes"],
  // round 1: a brace list fused with a zsh group, and a one-word group after a cd, in a comment
  [
    "a kill by name a brace list fused with a zsh group spells, in a comment",
    "# /usr/bin/pk{(i|x),y}ll -f watcher",
  ],
  [
    "a kill by name a one-word zsh group spells after a cd, in a comment",
    `# cd "$Q" && pk(i)ll -f watcher`,
  ],
  // round 1: every letter of the name inside a list or group past the cap, as an argument and in a comment
  [
    "an echo of a kill path every letter of which a brace list past the cap holds",
    "echo /usr/bin/{p,x}{k,y}{i,z}{l,w}{l,v}{,a}{,b} -f watcher",
  ],
  [
    "a kill by name every letter of which a brace list past the cap holds, in a comment",
    "# /usr/bin/{p,x}{k,y}{i,z}{l,w}{l,v}{,a}{,b} -f watcher",
  ],
]

const deleteControls = (): Row[] => [
  ["an echo of a delete path a brace sequence spells", `echo /bin/r{m..m} ${NEVER_MADE}`],
  ["a brace sequence as a list's argument", "ls {a..c}"],
  // round 2: a number sequence as an argument, beside a program word the reader cannot read
  [
    "a loop over a number sequence running an array whole",
    `for i in {1..3}; do "\${A[@]}" ${NEVER_MADE}; done`,
  ],
  ["a delete a brace sequence spells in a comment", `# /bin/r{m..m} ${NEVER_MADE}`],
  ["an echo of a delete path a zsh group past the cap matches", `echo /bin/r${overCap("m")}`],
  // round 1: every letter of the name inside a list or group past the cap, and a sequence to a bracket-negation character, as an argument and in a comment
  [
    "an echo of a delete path every letter of which a brace list past the cap holds",
    `echo /bin/{r,x}{m,y}{,a}{,b}{,c}{,d}{,e} ${NEVER_MADE}`,
  ],
  [
    "a delete every letter of which a brace list past the cap holds, in a comment",
    `# /bin/{r,x}{m,y}{,a}{,b}{,c}{,d}{,e} ${NEVER_MADE}`,
  ],
  ["a delete a brace sequence to a caret spells, in a comment", `# /bin/r{m..^} ${NEVER_MADE}`],
  ["an echo of a delete path a brace sequence to a caret spells", `echo /bin/r{m..^}`],
]

const stashControls = (): Row[] => [
  [
    "an echo of a git path a zsh group past the cap matches",
    `echo /usr/bin/g${overCap("i")}t stash pop`,
  ],
  [
    "an echo of a git path every letter of which two zsh groups hold, one past the cap",
    `echo /usr/bin/${overCap("g")}(it|x) stash pop`,
  ],
]

export const groups: Group[] = [
  {
    folders: ["process data folder", "process home", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      ["a plain rm by a path a brace sequence spells", `/bin/r{m..m} ${NEVER_MADE}`],
      [
        "a plain rm by a path a brace sequence spells, after a header line",
        `#!/bin/sh\n/bin/r{m..m} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path a brace sequence spells across a backslash-newline",
        `/bin/r{m..\\\nm} ${NEVER_MADE}`,
      ],
      ["a plain rm by a path two brace sequences spell", `/bin/{r..r}{m..m} ${NEVER_MADE}`],
      [
        "a plain rm by a path a brace list past the cap spells",
        `/bin/r{m,x}{,a}{,b}{,c}{,d}{,e}{,f} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path a zsh group past the cap matches",
        `/bin/r${overCap("m")} ${NEVER_MADE}`,
      ],
      // round 1: every letter of the name inside a list or group past the cap, so no literal letter is left to spell
      [
        "a plain rm by a path every letter of which a brace list past the cap holds",
        `/bin/{r,x}{m,y}{,a}{,b}{,c}{,d}{,e} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a bare name every letter of which a brace list past the cap holds",
        `{r,x}{m,y}{,a}{,b}{,c}{,d}{,e} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path every letter of which a brace list past the cap holds, after a header line",
        `#!/bin/sh\n/bin/{r,x}{m,y}{,a}{,b}{,c}{,d}{,e} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path every letter of which a brace list past the cap holds across a backslash-newline",
        `/bin/{r,x}{m,y}{,a}{,b}{,c}{,d}{,\\\ne} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path every letter of which two zsh groups past the cap hold",
        `/bin/${group(9, "r")}${group(8, "m")} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path every letter of which a zsh group past the cap and a group hold",
        `/bin/${overCap("r")}(m|x) ${NEVER_MADE}`,
      ],
      // round 1: a brace sequence whose far end is a bracket-negation character, which zsh expands through the program's letter
      ["a plain rm by a path a brace sequence to a caret spells", `/bin/r{m..^} ${NEVER_MADE}`],
      ["a plain rm by a path a brace sequence to a bang spells", `/bin/r{m..!} ${NEVER_MADE}`],
      [
        "a plain rm by a path two brace sequences to a caret spell",
        `/bin/{r..^}{m..^} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path a brace sequence to a caret spells, after a header line",
        `#!/bin/sh\n/bin/r{m..^} ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path a brace sequence to a caret spells across a backslash-newline",
        `/bin/r{m..\\\n^} ${NEVER_MADE}`,
      ],
      ...deleteControls(),
    ],
  },
  {
    folders: ["checkout", "home"],
    guards: ["no-kill-by-name"],
    rows: () => [
      [
        "a kill by name a brace list fused with a zsh group spells",
        "/usr/bin/pk{(i|x),y}ll -f watcher",
      ],
      [
        "a kill by name a brace list fused with a zsh group spells, after a header line",
        "#!/bin/sh\n/usr/bin/pk{(i|x),y}ll -f watcher",
      ],
      [
        "a kill by name a brace list fused with a zsh group spells across a backslash-newline",
        "/usr/bin/pk{(i|x),\\\ny}ll -f watcher",
      ],
      [
        "a kill by name a one-word zsh group spells, after a cd into a folder it cannot read",
        `cd "$Q" && pk(i)ll -f watcher`,
      ],
      [
        "a kill by name a one-word zsh group spells after a header line and a cd into a folder it cannot read",
        `#!/bin/sh\ncd "$Q" && pk(i)ll -f watcher`,
      ],
      [
        "a kill by name a one-word zsh group spells across a backslash-newline, after a cd into a folder it cannot read",
        `cd "$Q" && pk(\\\ni)ll -f watcher`,
      ],
      [
        "a kill by name a brace list past the cap spells",
        "pk{i,x}{a,}{b,}{c,}{d,}{e,}{f,}ll -f watcher",
      ],
      [
        "a kill by name at a path a zsh group past the cap matches",
        `/usr/bin/pk${overCap("i")}ll -f watcher`,
      ],
      // round 1: every letter of the name inside a list or group past the cap
      [
        "a kill by name at a path every letter of which a brace list past the cap holds",
        "/usr/bin/{p,x}{k,y}{i,z}{l,w}{l,v}{,a}{,b} -f watcher",
      ],
      [
        "a kill by name at a path every letter of which a brace list past the cap holds, after a header line",
        "#!/bin/sh\n/usr/bin/{p,x}{k,y}{i,z}{l,w}{l,v}{,a}{,b} -f watcher",
      ],
      [
        "a kill by name at a path every letter of which a brace list past the cap holds across a backslash-newline",
        "/usr/bin/{p,x}{k,y}{i,z}{l,w}{l,v}{,a}{,\\\nb} -f watcher",
      ],
      [
        "a kill by name at a path every letter of which three zsh groups hold, one past the cap",
        `/usr/bin/${overCap("pk")}(il|x)(l|y) -f watcher`,
      ],
      [
        "a kill by name at a path every letter of which two zsh groups hold, one past the cap",
        `/usr/bin/${overCap("pki")}(ll|x) -f watcher`,
      ],
      ...killControls(),
    ],
  },
  {
    folders: ["checkout", "data folder", "home"],
    guards: ["no-stash"],
    rows: () => [
      [
        "a stash pop by a git path a zsh group past the cap matches",
        `/usr/bin/g${overCap("i")}t stash pop`,
      ],
      [
        "a stash pop by a git path a brace list past the cap spells",
        "/usr/bin/g{i,x}{,a}{,b}{,c}{,d}{,e}{,f}t stash pop",
      ],
      // round 1: every letter of the name inside a group, one past the cap
      [
        "a stash pop by a git path every letter of which two zsh groups hold, one past the cap",
        `/usr/bin/${overCap("g")}(it|x) stash pop`,
      ],
      [
        "a stash pop by a git path every letter of which two zsh groups hold, one past the cap, after a header line",
        `#!/bin/sh\n/usr/bin/${overCap("g")}(it|x) stash pop`,
      ],
      ...stashControls(),
    ],
  },
]

export const allowed: string[] = [...killControls(), ...deleteControls(), ...stashControls()].map(
  ([what]) => what,
)
