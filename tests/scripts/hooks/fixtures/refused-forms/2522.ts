import { type Group, type Paths, type Row } from "./_shared"

// #2522: a glob-option switch on a line ssh runs remotely or feeds a remote shell is refused rather than read, so a spelling the per-name reading never listed is refused too; #2487's spellings are 2459.ts's rows; rows are data, as refused-forms.ts says.

// no-extensions-write: a switch on the local side of the line, and a remote line or fed script with none
const controls = (): Row[] => [
  ["a dotglob on the local side before a remote uptime", "shopt -s dotglob; ssh box uptime"],
  ["a remote star glob with no switch on the line", "ssh box 'ls */notes'"],
  ["a script with no switch piped to a remote bash", "echo 'df -h' | ssh box bash"],
  ["a strict-mode header on a remote line", "ssh box 'set -euo pipefail; ls */notes'"],
  [
    "a strict-mode header in a heredoc fed to a remote bash",
    "ssh box bash -s <<'EOF'\nset -euo pipefail\nls */notes\nEOF",
  ],
  [
    "a script's own -o after its name, past a shell's options",
    "ssh box 'bash deploy.sh --verbose -o x'",
  ],
  [
    "a tar -xOf inside a remote bash -c, past the shell's own options",
    `ssh box 'bash -c "tar -xOf a.tar f | wc -l"'`,
  ],
  [
    "a shell's name inside a longer word on a remote line, which starts no shell",
    "ssh box 'cat /etc/bash-completion.d/git; ls ~/zsh-config'",
  ],
  [
    "a strict-mode cluster after a redirect on a remote bash",
    "ssh box 'bash 2>&1 -euo pipefail -c uptime'",
  ],
  [
    "a strict-mode cluster after a remote bash's -c, read on to the command string",
    `ssh box 'bash -c -e "ls */notes"'`,
  ],
  [
    "awk's *100/(…) in a heredoc fed to a remote bash, which a * before a digit keeps from reading as a qualifier",
    "ssh box bash -s <<'EOF'\nawk '{ print (a[2]-a[1])*100/(b[2]-b[1]) }' f\nEOF",
  ],
]

const refused = (): Row[] => [
  [
    "a remote touch through a ? glob after ksh93's FIGNORE, a name the per-name reading never listed",
    "ssh box 'FIGNORE=x; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a setopt naming no dot option",
    "ssh box 'setopt EXTENDED_GLOB; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a shopt naming no dot option",
    "ssh box 'shopt -s nocaseglob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a set -o",
    "ssh box 'set -o KSH_GLOB; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after an unsetopt",
    "ssh box 'unsetopt BARE_GLOB_QUAL; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after an emulate",
    "ssh box 'emulate ksh; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob in a zsh started with -o",
    `ssh box "zsh -o KSH_GLOB -c 'touch ?playground/extensions/y'"`,
  ],
  [
    "a remote touch through a ? glob after a zsh options key",
    "ssh box 'options[nomatch]=off; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob with a zsh (#q) qualifier",
    "ssh box 'touch ?playground(#qN)/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after FIGNORE in a heredoc fed to a remote bash",
    "ssh box bash -s <<'EOF'\nFIGNORE=x\ntouch ?playground/extensions/y\nEOF",
  ],
  [
    "a remote touch through a ? glob after FIGNORE piped to a remote bash",
    "echo 'FIGNORE=x; touch ?playground/extensions/y' | ssh box bash",
  ],
  [
    "a remote touch through a ? glob after a set naming zsh's option inside its -o cluster",
    "ssh box 'set -oextendedglob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob in a zsh started with its option inside its -o cluster",
    `ssh box "zsh -oextendedglob -c 'touch ?playground/extensions/y'"`,
  ],
  [
    "a remote touch through a ? glob in a zsh started with its option as a long one",
    `ssh box "zsh --extended-glob -c 'touch ?playground/extensions/y'"`,
  ],
  [
    "a remote touch through a ? glob after a set whose -o is mid-cluster, bash's name the next word",
    "ssh box 'set -oe extendedglob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob in a bash whose -O comes after its -c, as bash reads it",
    `ssh box 'bash -c -O extglob "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a zsh whose -o comes after its -c",
    `ssh box 'zsh -c -o extendedglob "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a restricted bash started with -O",
    `ssh box 'rbash -O extglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a restricted zsh started with -o",
    `ssh box 'rzsh -o extendedglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a versioned bash started with -O",
    `ssh box 'bash-5.2 -O extglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob after a set whose cluster the hook cannot read",
    "ssh box 'set -$o extendedglob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a set with zsh's long option",
    "ssh box 'set --extendedglob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a set with yash's long dot option",
    "ssh box 'set --dot-glob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a set -o naming yash's dot option",
    "ssh box 'set -o dot-glob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after tcsh's set globdot, a reasoned row with no tcsh here to measure",
    "ssh box 'set globdot; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob in a bash whose -O comes after a redirect, as bash reads it",
    `ssh box 'bash >/dev/null -O extglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a zsh whose -o comes after a 2>&1",
    `ssh box 'zsh 2>&1 -o extendedglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob after a set whose -o comes after a redirect and its own target word",
    "ssh box 'set > x -o extendedglob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob in a bash whose -O comes after a named-descriptor redirect",
    `ssh box 'bash {fd}>/dev/null -O extglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a zsh whose -o comes after a >! and its own target word",
    `ssh box 'zsh >! log -o extendedglob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a zsh whose -4 comes after a named-descriptor redirect, which canary's dot reading refused",
    `ssh box 'zsh {fd}>/dev/null -4 -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in a zsh whose -4 comes after a >! and its own target word, which canary's dot reading refused",
    `ssh box 'zsh >! log -4 -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a zsh qualifier holding a space, refused by the glob reading rather than as a switch",
    `ssh box "touch *(D e:'true':)/notes/x"`,
  ],
  [
    "a remote touch through a * glob with BASHOPTS set by ssh's SetEnv",
    "ssh -o SetEnv=BASHOPTS=dotglob box 'touch */extensions/x'",
  ],
  [
    "a remote touch through a ? glob with GLOBIGNORE set by an attached SetEnv",
    "ssh -oSetEnv=GLOBIGNORE=x box 'touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a * glob with BASHOPTS sent by ssh's SendEnv",
    "ssh -o SendEnv=BASHOPTS box 'touch */extensions/x'",
  ],
  [
    "a remote touch through a * glob with a SendEnv pattern",
    "ssh -o 'SendEnv=BASH*' box 'touch */extensions/x'",
  ],
  [
    "a heredoc fed to a remote bash with BASHOPTS set by SetEnv",
    "ssh -o SetEnv=BASHOPTS=dotglob box bash -s <<'EOF'\ntouch */extensions/x\nEOF",
  ],
]

export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-extensions-write"],
    rows: (_paths: Paths) => [...controls(), ...refused()],
  },
]

export const allowed: string[] = controls().map(([what]) => what)
