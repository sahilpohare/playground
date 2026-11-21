import { type Group, NEVER_MADE, type Row } from "./_shared"

// #2259: a program word spelled by a brace list the shell expands, or by a zsh group the Bash tool's zsh globs (`(a|b)`, and the glob qualifiers that close a word), on the command line and in text written into a git hook; rows are data, as refused-forms.ts says. Each path row names a program both macOS and Linux keep at that path.
const hook = (what: string, content: string): Row => [
  what,
  { input: { content, file_path: ".git/hooks/pre-commit" }, tool: "Write" },
]

const held = (): Row[] => [
  hook(
    "a Write of a program a brace list spells into a git hook",
    "#!/bin/sh\n/bin/r{m,} old.log\n",
  ),
  hook(
    "a Write of a program a zsh alternation names into a git hook",
    "#!/bin/sh\n/bin/r(m|x) old.log\n",
  ),
  hook(
    "a Write of a program a brace list spells across a backslash-newline into a git hook",
    "#!/bin/sh\n/bin/r{m,\\\n} old.log\n",
  ),
  hook(
    "a Write of a program a brace list spells after a comment that ends at a backslash into a git hook",
    "#!/bin/sh\n# x \\\n/bin/r{m,} old.log\n",
  ),
]

const controls = (): Row[] => [
  hook(
    "a Write of a brace list used only as an argument into a git hook",
    "#!/bin/sh\necho {a,b}\nbun run lint\n",
  ),
  hook(
    "a Write of a brace-list program in a comment into a git hook",
    "#!/bin/sh\n# /bin/r{m,} old.log\nbun run lint\n",
  ),
  hook(
    "a Write of a function and a subshell into a git hook",
    "#!/bin/sh\nf() { echo hi; }\nf\n(cd x && bun run lint)\n",
  ),
]

export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-kill-by-name"],
    rows: () => [
      ["a kill by name at a path a brace list spells", "/usr/bin/pk{i,x}ll -f watcher"],
      ["a kill by name at a path a zsh alternation matches", "/usr/bin/pk(i|x)ll -f watcher"],
      ["a kill by name a bare brace list spells", "pk{i,x}ll -f watcher"],
      ["a kill by name as a brace list's first word", "{pkill,true} -f watcher"],
      ["a kill by name at a path a one-word zsh group matches", "/usr/bin/pk(i)ll -f watcher"],
      ["a kill by name at a path a nested zsh group matches", "/usr/bin/pk((i)|x)ll -f watcher"],
      [
        "a kill by name at a path a brace list spells across a backslash-newline",
        "/usr/bin/pk\\\n{i,x}ll -f watcher",
      ],
      [
        "a kill by name at a path a brace list spells beside a quote",
        "/usr/bin/p'k'{i,x}ll -f watcher",
      ],
      ["a kill by name at a path with zsh glob qualifiers", "/usr/bin/pkill(x) -f watcher"],
      [
        "a kill by name at a path a zsh alternation matches, with glob qualifiers",
        "/usr/bin/pk(i|x)ll(x) -f watcher",
      ],
      [
        "a kill by name at a relative path a zsh alternation matches",
        "cd /usr/bin && ./pk(i|x)ll -f watcher",
      ],
      ["a kill by name at a path a brace sequence spells", "/usr/bin/pk{i..i}ll -f watcher"],
      // round 1: a quoted paren is a plain character, so a glob beside one stays a glob, and a quoted paren inside a group or its qualifiers is text
      [
        "a kill by name at a relative glob beside a quoted paren, after a cd into a folder it cannot read",
        `cd "$Q" && ./pk?ll'(' -f watcher`,
      ],
      [
        "a kill by name at a relative glob behind a quoted paren, after a cd into a folder it cannot read",
        `cd "$Q" && '('pk?ll -f watcher`,
      ],
      [
        "a kill by name at a path a zsh alternation holding a quoted paren matches",
        `/usr/bin/p(kill|x')') -f watcher`,
      ],
      [
        "a kill by name at a path a glob matches, with glob qualifiers holding a quoted paren",
        `/usr/bin/pk?ll(e:'(true)':) -f watcher`,
      ],
      // round 2: a backslash-newline right after the qualifiers joins the word, so they still close it
      [
        "a kill by name at a path with glob qualifiers before a backslash-newline",
        "/usr/bin/pkill(x)\\\n -f watcher",
      ],
      [
        "a kill by name at a path a glob matches, with glob qualifiers before a backslash-newline",
        "/usr/bin/pk?ll(x)\\\n -f watcher",
      ],
      [
        "a kill by name at a path a zsh alternation matches, with glob qualifiers before a backslash-newline",
        "/usr/bin/pk(i|x)ll(x)\\\n -f watcher",
      ],
      [
        "a kill by name at a path with glob qualifiers split by a backslash-newline",
        "/usr/bin/pkill(\\\nx) -f watcher",
      ],
      [
        "a kill by name at a path split by a backslash-newline, with glob qualifiers",
        "/usr/bin/pk\\\nill(x) -f watcher",
      ],
      // round 2: a group the reader cannot read, an extended glob character inside it or more alternatives than READINGS, reads as unread
      [
        "a kill by name at a path a zsh group holding a caret matches",
        "/usr/bin/pk(i|^x)ll -f watcher",
      ],
      [
        "a kill by name at a path a zsh group holding a hash matches",
        "/usr/bin/pk(i|#x)ll -f watcher",
      ],
      [
        "a kill by name at a path a zsh group holding a tilde matches",
        "/usr/bin/pk(i|x~y)ll -f watcher",
      ],
      [
        "a kill by name at a path a glob and a zsh group holding a caret match",
        "/usr/bin/pk?(i|^x)l -f watcher",
      ],
      [
        "a kill by name at a relative path a zsh group holding a caret matches",
        "cd /usr/bin && ./pk(i|^x)ll -f watcher",
      ],
      [
        "a kill by name at a path a zsh group of more alternatives than the reader reads matches",
        "/usr/bin/pk(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)ll -f watcher",
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-stash"],
    rows: () => [
      ["a stash pop by a git path a zsh alternation matches", "/usr/bin/g(i|x)t stash pop"],
      [
        "a stash pop by a git path a zsh alternation matches, with glob qualifiers",
        "/usr/bin/g(i|x)t(x) stash pop",
      ],
      ["a stash pop by a git path a brace list spells", "/usr/bin/g{i,x}t stash pop"],
      [
        "a stash pop by a relative git glob beside a quoted paren, after a cd into a folder it cannot read",
        `cd "$Q" && ./g?t'(' stash pop`,
      ],
      [
        "a stash pop by a git path a zsh alternation holding a quoted paren matches",
        `/usr/bin/g(it|x')') stash pop`,
      ],
      [
        "a stash pop by a git path with glob qualifiers before a backslash-newline",
        "/usr/bin/git(x)\\\n stash pop",
      ],
      [
        "a stash pop by a git path a glob matches, with glob qualifiers before a backslash-newline",
        "/usr/bin/g?t(x)\\\n stash pop",
      ],
      [
        "a stash pop by a git path a zsh group holding a caret matches",
        "/usr/bin/g(i|^x)t stash pop",
      ],
      [
        "a stash pop by a git path a zsh group holding a hash matches",
        "/usr/bin/g(i|#x)t stash pop",
      ],
      [
        "a stash pop by a git path a glob and a zsh group holding a caret match",
        "/usr/bin/g?(i|^x) stash pop",
      ],
      [
        "a stash pop by a git path a zsh group of more alternatives than the reader reads matches",
        "/usr/bin/g(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)t stash pop",
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-raw-delete"],
    rows: () => [
      ["a plain rm by a path a zsh alternation matches", `/bin/r(m|x) ${NEVER_MADE}`],
      [
        "a plain rm by a path a zsh alternation matches, with glob qualifiers",
        `/bin/r(m|x)(x) ${NEVER_MADE}`,
      ],
      ["a plain rm by a path a brace list spells", `/bin/r{m,x} ${NEVER_MADE}`],
      [
        "a plain rm by a path with glob qualifiers before a backslash-newline",
        `/bin/rm(x)\\\n ${NEVER_MADE}`,
      ],
      [
        "a plain rm by a path a zsh alternation matches, with glob qualifiers before a backslash-newline",
        `/bin/r(m|x)(x)\\\n ${NEVER_MADE}`,
      ],
      ["a plain rm by a path a zsh group holding a caret matches", `/bin/r(m|^x) ${NEVER_MADE}`],
      [
        "a plain rm by a path a zsh group of more alternatives than the reader reads matches",
        `/bin/r(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q) ${NEVER_MADE}`,
      ],
    ],
  },
  {
    folders: ["data folder", "home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [...held(), ...controls()],
  },
]

export const allowed: string[] = controls().map(([what]) => what)
