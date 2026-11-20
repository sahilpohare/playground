import { type Group, NEVER_MADE } from "./_shared"

// #2127: a command held in a shell variable, which bash, and zsh under sh_word_split, splits into the words it runs; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-kill-by-name"],
    rows: () => [
      ["a kill by pattern held in a variable run as the command", 'C="pkill -f watcher"; $C'],
      ["a kill by name held in a variable run as the program", "P=pkill; $P -f watcher"],
      [
        "a kill by pattern after run-slot's session name and separator held in a variable",
        'W="w --"; ~/.playground/ops/run-slot.sh $W pkill -f watcher',
      ],
      [
        "a kill by pattern whose program run-slot's session name variable holds",
        'W="w -- pkill"; ~/.playground/ops/run-slot.sh $W -- -f watcher',
      ],
      [
        "a kill by pattern held with run-slot's separator in a variable",
        'A="-- pkill -f watcher"; ~/.playground/ops/run-slot.sh w $A',
      ],
      [
        "a kill by pattern held with run-slot's option and separator in a variable",
        'A="--after 5 -- pkill -f watcher"; ~/.playground/ops/run-slot.sh w $A',
      ],
      [
        "a kill by pattern held in run-slot's session name variable",
        'W="w -- pkill -f watcher"; ~/.playground/ops/run-slot.sh $W -- true',
      ],
      [
        "a kill by pattern held in run-slot's session name variable set by export",
        'export W="w -- pkill -f watcher"; ~/.playground/ops/run-slot.sh $W -- true',
      ],
      [
        "a kill by pattern held in a variable the word shares with an empty quote",
        'C="pkill -f watcher"; $C""',
      ],
      [
        "a kill by pattern held in a variable read with zsh's split flag",
        'C="pkill -f watcher"; ${=C}',
      ],
      ["a kill by pattern held in a copy of a variable", 'A="pkill -f watcher"; C=$A; $C'],
      ["a kill by name held in a copy of a variable", "A=pkill; C=$A; $C -f watcher"],
      ["a kill by pattern whose literal text a partly unread value holds", 'C="pkill -f $X"; $C'],
      [
        "a kill whose search a partly unread value's substitution holds",
        'C="kill -9 $(pgrep -f watcher)"; $C',
      ],
      [
        "a kill by pattern held in a variable set with a literal IFS",
        'IFS=:; C="pkill:-f:watcher"; $C',
      ],
      [
        "a kill by pattern held in a variable read with zsh's bare split flag",
        'C="pkill -f watcher"; $=C',
      ],
      [
        "a kill by pattern held in a copy whose source is set again after it",
        'A="pkill -f watcher"; C=$A; A=ls; $C',
      ],
      ["a kill by pattern a program word appends literal text to", 'C="pkill -f wat"; $C/x'],
      [
        "a kill by pattern a program word prefixes a literal path to",
        'C="pkill -f watcher"; /usr/bin/$C',
      ],
      ["a kill by pattern held in TMPDIR", 'TMPDIR="pkill -f watcher"; $TMPDIR'],
      [
        "a kill by pattern whose program name two back-to-back variables hold",
        'P=pk; Q="ill -f watcher"; $P$Q',
      ],
    ],
  },
  {
    folders: ["checkout", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      [
        "a recursive delete held with run-slot's separator in a variable",
        `A="-- rm -rf ${NEVER_MADE}"; ~/.playground/ops/run-slot.sh w $A`,
      ],
      [
        "a recursive delete held with run-slot's option and separator in a variable",
        `A="--after 5 -- rm -rf ${NEVER_MADE}"; ~/.playground/ops/run-slot.sh w $A`,
      ],
      [
        "a recursive delete held in run-slot's session name variable",
        `W="w -- rm -rf ${NEVER_MADE}"; ~/.playground/ops/run-slot.sh $W -- true`,
      ],
      [
        "a recursive delete held in run-slot's session name variable set by export",
        `export W="w -- rm -rf ${NEVER_MADE}"; ~/.playground/ops/run-slot.sh $W -- true`,
      ],
      [
        "a recursive delete held in a variable the word shares with an empty quote",
        `c="rm -rf ${NEVER_MADE}"; $c""`,
      ],
      [
        "a recursive delete held in a variable read with zsh's split flag",
        `c="rm -rf ${NEVER_MADE}"; \${=c}`,
      ],
      ["a recursive delete held in a copy of a variable", `A="rm -rf ${NEVER_MADE}"; c=$A; $c`],
      ["a recursive delete whose literal text a partly unread value holds", 'c="rm -rf $X"; $c'],
      [
        "a recursive delete held in a variable set with a literal IFS",
        `IFS=:; c="rm:-rf:${NEVER_MADE}"; $c`,
      ],
      [
        "a recursive delete held in a variable read with zsh's bare split flag",
        `c="rm -rf ${NEVER_MADE}"; $=c`,
      ],
      [
        "a recursive delete held in a copy whose source is set again after it",
        `A="rm -rf ${NEVER_MADE}"; c=$A; A=ls; $c`,
      ],
      [
        "a recursive delete a program word appends literal text to",
        `c="rm -rf ${NEVER_MADE}"; $c-zz`,
      ],
      ["a recursive delete held in TMPDIR", `TMPDIR="rm -rf ${NEVER_MADE}"; $TMPDIR`],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-unslotted-run"],
    rows: () => [
      ["a suite held in a variable the word shares with an empty quote", 'C="bun run test"; $C""'],
      ["a suite held in a variable read with zsh's split flag", 'C="bun run test"; ${=C}'],
      ["a suite held in a variable read with zsh's bare split flag", 'C="bun run test"; $=C'],
      ["a suite held in a copy of a variable", 'A="bun run test"; C=$A; $C'],
    ],
  },
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: () => [
      [
        "a commit held in a variable the word shares with an empty quote",
        'C="git commit -m x"; $C""',
      ],
      ["a commit held in a copy of a variable", 'A="git commit -m x"; C=$A; $C'],
      ["a commit held in a variable read with zsh's bare split flag", 'C="git commit -m x"; $=C'],
    ],
  },
]
