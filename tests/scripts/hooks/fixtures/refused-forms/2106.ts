import type { Group } from "./_shared"

// #2106: a relative cd after a cd the hook cannot read was read as sure, so a write after it ran; beside it, a cd the line redefines, a cd after && that may fail, a zsh modifier on an unbraced name, env with more than one -C and an abbreviated git --output each read a folder the hook could not; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ DATA }) => [
      ["cp after a relative cd after a cd to a variable", `cd "$X" && cd sub && cp a b`],
      ["ex after a relative cd after a cd to a variable", `cd "$X" && cd sub && ex -sc wq f`],
      [
        "patch after a relative cd after a cd to a variable",
        `cd "$X" && cd sub && patch -p1 < /tmp/d`,
      ],
      ["git mv after a relative cd after a cd to a variable", `cd "$X" && cd sub && git mv a b`],
      [
        "git checkout after a relative cd after a cd to a variable",
        `cd "$X" && cd sub && git checkout -- f`,
      ],
      // a control, refused before this source's fix
      ["a relative held cd after a cd to a variable", `W=sub; cd "$X" && cd "$W" && ex -sc wq f`],
      [
        "cp after a cd the line defines as a function",
        `cd() { builtin cd "$X"; }; cd /tmp && cp a b`,
      ],
      [
        "cp after a cd the line defines by function",
        `function cd { builtin cd "$X"; }; cd /tmp && cp a b`,
      ],
      [
        "cp after a cd under a chpwd hook the line sets",
        `chpwd() { builtin cd "$X"; }; cd /tmp && cp a b`,
      ],
      [
        "cp after a cd under a chpwd hook the line adds to zsh's hook array",
        `f() { builtin cd "$X"; }; chpwd_functions=(f); cd /tmp && cp a b`,
      ],
      [
        "cp after a cd under a chpwd hook array named with an empty double quote inside",
        `f() { builtin cd "$X"; }; set -A chp""wd_functions f; cd /tmp && cp a b`,
      ],
      [
        "cp after a cd under a chpwd hook array named with a quoted part",
        `f() { builtin cd "$X"; }; set -A "chp"wd_functions f; cd /tmp && cp a b`,
      ],
      [
        "cp after a cd under a chpwd hook array named with a backslash inside",
        `f() { builtin cd "$X"; }; set -A chp\\wd_functions f; cd /tmp && cp a b`,
      ],
      [
        "cp after a cd under a chpwd hook array typeset with an empty single quote inside",
        `f() { builtin cd "$X"; }; typeset -ga chp''wd_functions=(f); cd /tmp && cp a b`,
      ],
      [
        "cp after a held cd the line defines as a function",
        `W=/tmp; cd() { builtin cd "$X"; }; cd "$W" && cp a b`,
      ],
      [
        "a write after a cd that runs only if one before it may fail",
        `cd "$X" && false && cd /tmp; echo x > f`,
      ],
      [
        "a write after a cd that may fail, chained after a cd to a variable",
        `cd "$X" && cd /nonexistent-zz; echo x > f`,
      ],
      ["a write after a cd to the tail of a known variable", `cd "$X" && cd $HOME:t && echo x > f`],
      [
        "a write under env with two -C options, the second relative",
        `env -C ${DATA}/other -C ../extensions touch f`,
      ],
      [
        "a write under env with two -C options through a held variable",
        `W=${DATA}/other; env -C "$W" -C ../extensions touch f`,
      ],
      ["git diff's abbreviated output after a cd to a variable", `cd "$X" && git diff --out=f`],
      [
        "git log's spaced abbreviated output after a cd to a variable",
        `cd "$X" && git log --out f`,
      ],
      [
        "git diff's longer abbreviated output after a cd to a variable",
        `cd "$X" && git diff --outp=f`,
      ],
      [
        "git show's longest abbreviated output after a cd to a variable",
        `cd "$X" && git show --outpu=f`,
      ],
      [
        "git grep's abbreviated pager option after a cd to a variable",
        `cd "$X" && git grep --open=vi x`,
      ],
      [
        "git diff's abbreviated external diff after a cd to a variable",
        `cd "$X" && git diff --ext`,
      ],
      [
        "git log's abbreviated text conversion after a cd to a variable",
        `cd "$X" && git log --textc -p`,
      ],
      // a control, refused before this source's fix
      [
        "git grep's pager option after a cd to a variable",
        `cd "$X" && git grep --open-files-in-pager=vi x`,
      ],
      // a control, refused before this source's fix
      ["git diff's external diff after a cd to a variable", `cd "$X" && git diff --ext-diff`],
      // a control, refused before this source's fix
      ["git log's text conversion after a cd to a variable", `cd "$X" && git log --textconv -p`],
    ],
  },
]
