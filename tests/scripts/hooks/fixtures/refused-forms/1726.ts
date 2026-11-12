import { type Group, NEVER_MADE } from "./_shared"

export const groups: Group[] = [
  {
    folders: ["home", "data folder", "checkout", "tmp"],
    guards: ["no-extensions-write"],
    rows: () => [
      ["a shell -c of a variable", `sh -c "$x"`],
      ["a shell -c of an unquoted variable", "sh -c $x"],
      ["a shell -c of a substitution", `sh -c "$(cat f)"`],
      ["a shell -c of a backtick substitution", 'sh -c "`cat f`"'],
      ["a script a jq read wrote, then run", `jq -r '"rm -rf ${NEVER_MADE}"' f > s.sh; sh s.sh`],
      ["a removal in a glob qualifier", `cat f(e:"rm -rf ${NEVER_MADE}":)`],
      [
        "a removal in a glob qualifier after a read",
        `sed -n '/{/p' f; cat f(e:"rm -rf ${NEVER_MADE}":)`,
      ],
      ["a removal in an e flag", `cat \${(e):-"\\$(rm -rf ${NEVER_MADE})"}`],
      ["a removal in a glob qualifier under zsh -c", `zsh -c 'cat f(e:"rm -rf ${NEVER_MADE}":)'`],
      ["a removal in a zsh file substitution under zsh -c", `zsh -c 'cat =(rm -rf ${NEVER_MADE})'`],
      [
        "a removal through a prompt expansion under bash -c",
        `bash -c 'cat f "\\$(rm -rf ~/.p*/extensions/.no-such-folder)"; cat \${_@P}'`,
      ],
    ],
  },
]
