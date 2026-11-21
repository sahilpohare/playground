import type { Group } from "./_shared"

// #2104: after a cd the hook cannot read, a program off every list the hook judges (an editor in script mode, a patch applier, a git subcommand that moves, restores or stages files, a build tool) was let run, though it may write the shell's folder; a cd through a variable the line sets to anything but a literal absolute path stays unread; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: ({ DATA, HOME, ROOT }) => [
      ["ex in script mode after a cd to a variable", `cd "$X" && ex -sc 'wq' f`],
      ["vim running a write after a cd to a variable", `cd "$X" && vim -c wq f`],
      ["patch from an absolute diff after a cd to a variable", `cd "$X" && patch -p1 < /tmp/d`],
      ["git mv after a cd to a variable", `cd "$X" && git mv a b`],
      ["git checkout of a path after a cd to a variable", `cd "$X" && git checkout -- f`],
      ["git restore after a cd to a variable", `cd "$X" && git restore f`],
      ["git apply after a cd to a variable", `cd "$X" && git apply /tmp/d`],
      ["git reset --hard after a cd to a variable", `cd "$X" && git reset --hard`],
      ["git add after a cd to a variable", `cd "$X" && git add f`],
      ["git add under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs git add`],
      ["git -C a relative folder after a cd to a variable", `cd "$X" && git -C sub checkout -- f`],
      [
        "git checkout under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs git checkout --`,
      ],
      [
        "git with a git folder alone after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/r/.git checkout -- f`,
      ],
      [
        "git with a spaced git folder alone after a cd to a variable",
        `cd "$X" && git --git-dir /tmp/r/.git checkout -- f`,
      ],
      [
        "git apply with a git folder alone after a cd to a variable",
        `cd "$X"; git --git-dir=/tmp/x/.git apply p.diff`,
      ],
      [
        "git with a work tree alone after a cd to a variable",
        `cd "$X" && git --work-tree=/tmp/r checkout -- f`,
      ],
      [
        "git rm with a git folder alone after a cd to a variable",
        `cd "$X"; git --git-dir=/tmp/x/.git rm f`,
      ],
      [
        "a recursive git rm with a git folder alone after a cd to a variable",
        `cd "$X"; git --git-dir=/tmp/x/.git rm -r .`,
      ],
      [
        "git rm with a work tree alone after a cd to a variable",
        `cd "$X"; git --work-tree=/tmp/x rm f`,
      ],
      [
        "a recursive git rm with a work tree alone after a cd to a variable",
        `cd "$X"; git --work-tree=/tmp/x rm -r .`,
      ],
      [
        "git with a git folder and a work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/r/.git --work-tree=/tmp/r checkout -- f`,
      ],
      [
        "a recursive git rm with a git folder and a work tree after a cd to a variable",
        `cd "$X"; git --git-dir=/tmp/x/.git --work-tree=/tmp/x rm -r .`,
      ],
      [
        "git with a git folder and the filesystem root as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=/ checkout -- f`,
      ],
      [
        "git with a git folder and the root spelt with a dot as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=/. checkout -- f`,
      ],
      [
        "git with a git folder and the root spelt with two slashes as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=// checkout -- f`,
      ],
      [
        "git with a git folder and the root spelt by a climb as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=/tmp/.. checkout -- f`,
      ],
      [
        "git rm with a git folder and the filesystem root as its work tree after a cd to a variable",
        `cd "$X"; git --git-dir=/tmp/x/.git --work-tree=/ rm f`,
      ],
      ["unzip after a cd to a variable", `cd "$X" && unzip /tmp/a.zip`],
      ["bun run after a cd to a variable", `cd "$X" && bun run build`],
      [
        "patch behind nice after a cd to a substitution",
        `cd "$(cat p)" && nice patch -p1 < /tmp/d`,
      ],
      ["a shell running a script file after a cd to a variable", `cd "$X" && bash /tmp/s.sh`],
      [
        "a shell reading a script file as stdin after a cd to a variable",
        `cd "$X" && sh < /tmp/s.sh`,
      ],
      ["a shell piped a file's text after a cd to a variable", `cd "$X" && cat /tmp/s.sh | bash`],
      ["a source of a script after a cd to a variable", `cd "$X" && source ./x.sh`],
      ["a script run by its path after a cd to a variable", `cd "$X" && ./build.sh`],
      ["make after a cd to a variable", `cd "$X" && make`],
      [
        "a program after a cd to the checkout's top",
        `cd "$(git rev-parse --show-toplevel)" && bun test`,
      ],
      [
        "patch after a cd to a variable the line sets to a relative path",
        `W=sub; cd "$W" && patch -p1 < /tmp/d`,
      ],
      [
        "patch after a cd to a variable the line sets by a substitution",
        `W=$(pwd); cd "$W" && patch -p1 < /tmp/d`,
      ],
      ["patch after a cd to a variable read from stdin", `read W; cd "$W" && patch -p1 < /tmp/d`],
      [
        "patch after a cd to a variable the line sets to a glob",
        `W=/tmp/*; cd $W && patch -p1 < /tmp/d`,
      ],
      [
        "patch after a cd to a variable the line sets twice, the second time unread",
        `W=/tmp; W=$X; cd "$W" && patch -p1 < /tmp/d`,
      ],
      [
        "patch after a cd to a held path joined to an unread part",
        `W=/tmp; cd "$W/$X" && patch -p1 < /tmp/d`,
      ],
      [
        "patch under env -C of a variable the line sets by a substitution",
        `W=$(pwd); env -C "$W" patch -p1 < /tmp/d`,
      ],
      [
        "patch after a cd to a variable the line sets to the root",
        `W=${ROOT}; cd "$W" && patch -p1 < /tmp/d`,
      ],
      [
        "a build under run-slot's env -C of a variable the line sets by a substitution",
        `W=$(pwd); ~/.playground/ops/run-slot.sh a -- /usr/bin/env -C $W bun run test`,
      ],
      [
        "a write after a cd to the tail of a variable the line sets to the root",
        `W=${ROOT}; cd "$X" && cd $W:t && echo x > f`,
      ],
      [
        "a write after a quoted cd to the tail of a variable the line sets to the root",
        `W=${ROOT}; cd "$X" && cd "$W:t" && echo x > f`,
      ],
      [
        "a write after a pushd to the tail of a variable the line sets to the root",
        `W=${ROOT}; cd "$X" && pushd $W:t && echo x > f`,
      ],
      [
        "a write after a cd to a substitution modifier of a variable the line sets",
        `W=/tmp; cd "$X" && cd $W:s/tmp/x/ && echo x > f`,
      ],
      [
        "a write after a cd to a variable set from the head of another",
        `W=${ROOT}/hooks; T=$W:h; cd "$X" && cd $T && echo x > f`,
      ],
      [
        "git with a git folder by its variable after a cd to a variable",
        `cd "$X" && GIT_DIR=/tmp/r/.git git checkout -- f`,
      ],
      [
        "git with a git folder and an unread work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/r/.git --work-tree="$Y" checkout -- f`,
      ],
      [
        "git mv with a git folder alone after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git mv a b`,
      ],
      [
        "git clean with a git folder alone after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git clean -f`,
      ],
      [
        "git stash with a git folder alone after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git stash`,
      ],
      [
        "git with a git folder and the root as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/r/.git --work-tree=${ROOT} checkout -- f`,
      ],
      [
        "git with a git folder and home as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=${HOME} checkout -- f`,
      ],
      [
        "git with a git folder and the folder above home as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=${HOME}/.. checkout -- f`,
      ],
      [
        "git with a git folder and /var as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=/var checkout -- f`,
      ],
      [
        "git with a git folder and /private as its work tree after a cd to a variable",
        `cd "$X" && git --git-dir=/tmp/x/.git --work-tree=/private checkout -- f`,
      ],
      [
        "a write after a cd to a variable with an escaped modifier",
        `W=/tmp; cd "$X" && cd $W\\:t && echo x > f`,
      ],
      [
        "a write after a cd to a variable with a quoted-empty modifier",
        `W=/tmp; cd "$X" && cd $W'':t && echo x > f`,
      ],
      [
        "a write after a cd to a braced variable followed by a colon",
        `W=/tmp; cd "$X" && cd \${W}:t && echo x > f`,
      ],
      [
        "a write after a cd to a variable followed by a colon path",
        `W=/tmp; cd "$X" && cd $W:/x && echo x > f`,
      ],
      [
        "a write after a split cd to a variable holding a blank",
        `W='/other /extensions'; cd ${DATA}/other && setopt sh_word_split && cd $W && echo x > f`,
      ],
      [
        "a write after a split cd to a variable holding a blank, the option set first",
        `W='/other /extensions'; setopt sh_word_split; cd ${DATA}/other && cd $W && echo x > f`,
      ],
      [
        "a write after a split cd to a variable holding a blank, the option unspaced",
        `W='/other /extensions'; cd ${DATA}/other && setopt shwordsplit; cd $W; echo x > f`,
      ],
      [
        "a write after a split cd to a variable holding a blank, the option by set -o",
        `W='/other /extensions'; cd ${DATA}/other && set -o shwordsplit && cd $W && echo x > f`,
      ],
      [
        "a write after a split pushd to a variable holding a blank",
        `W='/other /extensions'; cd ${DATA}/other && setopt SH_WORD_SPLIT && pushd $W && echo x > f`,
      ],
      [
        "a write after a split cd to a variable holding a tab",
        `W=$'/other\\t/extensions'; cd ${DATA}/other && setopt sh_word_split && cd $W && echo x > f`,
      ],
      [
        "patch after a split cd to a variable holding a blank",
        `W='/other /extensions'; cd ${DATA}/other && setopt sh_word_split && cd $W && patch -p1 < /tmp/d`,
      ],
      [
        "a write after a typed two-operand cd",
        `cd ${DATA}/other && cd /other /extensions && echo x > f`,
      ],
      [
        "a write after a cd to a split of a variable holding a blank",
        `W='/other /extensions'; cd ${DATA}/other && cd \${=W} && echo x > f`,
      ],
      [
        "a write after a cd to a short split of a variable holding a blank",
        `W='/other /extensions'; cd ${DATA}/other && cd $=W && echo x > f`,
      ],
      [
        "a write after a split cd to a variable split at an IFS the line sets",
        `W=/otherX/extensions; cd ${DATA}/other && IFS=X && setopt sh_word_split && cd $W && echo x > f`,
      ],
      [
        "a write after a split cd to a variable split at an IFS the line sets first",
        `W=/otherX/extensions; IFS=X; cd ${DATA}/other && setopt sh_word_split && cd $W && echo x > f`,
      ],
      [
        "a write after a cd to a variable holding a blank in an sh emulation",
        `W='/other /extensions'; cd ${DATA}/other && emulate sh -c 'cd $W && echo x > f'`,
      ],
      [
        "a write under a split env -C of a variable holding a blank",
        `W='/other /extensions'; cd ${DATA}/other && setopt sh_word_split && env -C $W touch f`,
      ],
    ],
  },
]
