import { type Group, NEVER_MADE, type Row } from "./_shared"

// After a cd the hook cannot read, xargs hands a remover or a writer its stdin words: appended, split over several calls, split at a NUL or GNU's -d, or put in place of its -I or -J string; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "rm under xargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs rm -r`,
      ],
      [
        "find -delete under xargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs find -delete`,
      ],
      [
        "find under xargs fed its folder and -delete after a cd to a variable",
        `cd "$X" && printf '%s\\n' .no-such-folder -delete | xargs find`,
      ],
      [
        "rm under xargs -n1 fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs -n1 rm -r`,
      ],
      [
        "touch under xargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-file | xargs touch`,
      ],
      [
        "tee under xargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-file | xargs tee`,
      ],
      [
        "cp under xargs fed a relative target after a cd to a variable",
        `cd "$X" && echo .no-such-file | xargs cp /tmp/a`,
      ],
      ["touch under xargs fed by ls after a cd to a variable", `cd "$X" && ls | xargs touch`],
      // xargs splits its words over several calls, so a relative word ends a call of its own
      [
        "ln -s under xargs -n1 fed a relative name, then an absolute one",
        `cd "$X" && echo .no-such-file /tmp/l | xargs -n1 ln -s /tmp/a`,
      ],
      [
        "cp under xargs -n1 fed a relative name, then an absolute one",
        `cd "$X" && echo .no-such-file /tmp/d | xargs -n1 cp /tmp/a`,
      ],
      [
        "cp under xargs -L1 fed a relative line, then an absolute one",
        `cd "$X" && printf '%s\\n' .no-such-file /tmp/d | xargs -L1 cp /tmp/a`,
      ],
      [
        "install under xargs -n1 fed a relative name, then an absolute one",
        `cd "$X" && echo .no-such-file /tmp/d | xargs -n1 install /tmp/a`,
      ],
      [
        "cp under xargs -s 20 fed a relative name, then an absolute one",
        `cd "$X" && echo .no-such-file /tmp/d | xargs -s 20 cp /tmp/a`,
      ],
      // xargs -0 splits at a NUL the hook reads as a part it cannot read
      [
        "ln -s under xargs -0 -n1 fed a NUL-split relative name",
        `cd "$X" && printf '/tmp/l\\0.no-such-file' | xargs -0 -n1 ln -s /tmp/a`,
      ],
      [
        "touch under xargs -0 fed a NUL-split relative name",
        `cd "$X" && printf '/tmp/x\\0.no-such-file' | xargs -0 touch`,
      ],
      // xargs puts a relative stdin word in place of an absolute-looking -I or -J string
      [
        "touch under xargs -I with an absolute-looking string",
        `cd "$X" && echo .no-such-file | xargs -I /tmp/q touch /tmp/q`,
      ],
      [
        "touch under xargs -I with an attached absolute-looking string",
        `cd "$X" && echo .no-such-file | xargs -I/tmp/q touch /tmp/q`,
      ],
      [
        "ln -s under xargs -J with an absolute-looking string",
        `cd "$X" && echo .no-such-file | xargs -J /tmp/q ln -s /tmp/a /tmp/q`,
      ],
      [
        "cp under xargs -J with an absolute-looking string",
        `cd "$X" && echo .no-such-file | xargs -J /tmp/q cp /tmp/a /tmp/q`,
      ],
      // the g names read as find and xargs (#1193)
      [
        "gfind -delete under xargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | xargs gfind -delete`,
      ],
      [
        "find -delete under gxargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | gxargs find -delete`,
      ],
      [
        "gfind -delete under gxargs fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | gxargs gfind -delete`,
      ],
      [
        "rm under gxargs -n1 fed a relative name after a cd to a variable",
        `cd "$X" && echo .no-such-folder | gxargs -n1 rm -r`,
      ],
      [
        "gfind -fprint under xargs fed a relative file after a cd to a variable",
        `cd "$X" && echo .no-such-file | xargs -I{} gfind /tmp -fprint {}`,
      ],
      // GNU xargs' -d splits stdin on a character of its own
      [
        "rm under gxargs -d fed a relative part after a cd to a variable",
        `cd "$X" && printf /.no-such-folder | gxargs -d / rm -r`,
      ],
      [
        "rm under GNU xargs -d by its gnubin path",
        `cd "$X" && printf /.no-such-folder | /opt/homebrew/opt/findutils/libexec/gnubin/xargs -d / rm -r`,
      ],
      [
        "rm under GNU xargs --delimiter by its gnubin path",
        `cd "$X" && printf /.no-such-folder | /opt/homebrew/opt/findutils/libexec/gnubin/xargs --delimiter=/ rm -r`,
      ],
      [
        "rm under gxargs with -d in a flag cluster, which splits stdin where the hook cannot see",
        `cd "$X" && printf /.no-such-folder | gxargs -rd / rm -r`,
      ],
      [
        "rm under gxargs --delimiter with its value as the next word",
        `cd "$X" && printf /.no-such-folder | gxargs --delimiter / rm -r`,
      ],
      // an option value spelled like the program (-E's end-of-file string) ends none of xargs' own words
      [
        "rm under gxargs -d after an -E value spelled like the program",
        `cd "$X" && printf /tmp/a/.no-such-folder | gxargs -E rm -d / rm -r`,
      ],
      [
        "rm under gxargs -a after an -E value spelled like the program",
        `cd "$X" && printf /tmp/a/.no-such-folder | gxargs -E rm -a /tmp/list rm -r`,
      ],
      // find with no path before its expression searches the shell's own folder
      [
        "find under xargs -I fed its acting word with no path after a cd to a variable",
        `cd "$X" && echo -delete | xargs -I{} find {}`,
      ],
      [
        "gfind under xargs -I fed its acting word with no path after a cd to a variable",
        `cd "$X" && echo -delete | xargs -I{} gfind {}`,
      ],
      [
        "find under xargs fed its acting word with no path after a cd to a variable",
        `cd "$X" && echo -delete | xargs find`,
      ],
      [
        "gfind under xargs fed its acting word with no path after a cd to a variable",
        `cd "$X" && echo -delete | xargs gfind`,
      ],
      ["find -delete with no path after a cd to a variable", `cd "$X"; find -delete`],
      ["gfind -delete with no path after a cd to a variable", `cd "$X"; gfind -delete`],
      ["gfind -L -delete with no path after a cd to a variable", `cd "$X"; gfind -L -delete`],
      // printf's leading -- ends its options, so the text after it is what xargs reads
      [
        "find under xargs fed -delete by printf -- after a cd to a variable",
        `cd "$X" && printf -- '-delete' | xargs find sub`,
      ],
      [
        "find under xargs fed a -delete line by printf -- after a cd to a variable",
        `cd "$X" && printf -- '-delete\\n' | xargs find sub`,
      ],
      [
        "find under xargs -0 fed a NUL-ended -delete by printf -- after a cd to a variable",
        `cd "$X" && printf -- '-delete\\0' | xargs -0 find sub -name x`,
      ],
      [
        "find under xargs fed -delete by printf -- with a format after a cd to a variable",
        `cd "$X" && printf -- '%s\\n' -delete | xargs find sub`,
      ],
      [
        "find under xargs fed -exec by printf -- after a cd to a variable",
        `cd "$X" && printf -- '-exec rm {} ;' | xargs find sub`,
      ],
      // xargs drops a pair of quotes and keeps the character after a backslash, so a quoted or escaped stdin word may become a find's action
      [
        "find under xargs fed a single-quoted -delete after a cd to a variable",
        `cd "$X" && echo "'-delete'" | xargs find sub`,
      ],
      [
        "find under xargs fed a double-quoted -delete after a cd to a variable",
        `cd "$X" && echo '"-delete"' | xargs find sub`,
      ],
      [
        "find under xargs fed a -delete quoted in part after a cd to a variable",
        `cd "$X" && echo "'-del'ete" | xargs find sub`,
      ],
      [
        "find under xargs fed a quoted -delete by printf after a cd to a variable",
        `cd "$X" && printf '%s\\n' "'-delete'" | xargs find sub`,
      ],
      [
        "find under xargs with a quoted -delete here-string after a cd to a variable",
        `cd "$X" && xargs find sub <<< "'-delete'"`,
      ],
      [
        "find under xargs with a quoted -delete heredoc after a cd to a variable",
        `cd "$X" && xargs find sub <<END\n'-delete'\nEND`,
      ],
      [
        "find under xargs fed a backslash-led -delete after a cd to a variable",
        `cd "$X" && echo '\\-delete' | xargs find sub`,
      ],
      [
        "find under xargs with a backslash-led -delete here-string after a cd to a variable",
        `cd "$X" && xargs find sub <<< '\\-delete'`,
      ],
      [
        "find under xargs with a -delete here-string holding a backslash after a cd to a variable",
        `cd "$X" && xargs find sub <<< '-dele\\te'`,
      ],
      [
        "find under xargs fed a -delete holding a backslash by echo -E after a cd to a variable",
        `cd "$X" && echo -E '-dele\\te' | xargs find sub`,
      ],
      [
        "find under xargs fed a -delete holding a backslash escape by echo -E after a cd to a variable",
        `cd "$X" && echo -E '-del\\ete' | xargs find sub`,
      ],
      [
        "find under xargs fed a -delete holding a backslash by printf after a cd to a variable",
        `cd "$X" && printf '%s\\n' '-dele\\te' | xargs find sub`,
      ],
      [
        "find under xargs fed a -delete holding a backslash by echo after a cd to a variable",
        `cd "$X" && echo '-dele\\te' | xargs find sub`,
      ],
      [
        "find under xargs with a backslash-led -delete heredoc after a cd to a variable",
        `cd "$X" && xargs find sub <<END\n\\-delete\nEND`,
      ],
      [
        "find under xargs with a backslash-led -delete in a quoted heredoc after a cd to a variable",
        `cd "$X" && xargs find sub <<'END'\n\\-delete\nEND`,
      ],
      [
        "find under xargs fed a -delete holding a backslash escape in bash -c after a cd to a variable",
        `bash -c 'cd "$X" && echo "-del\\ete" | xargs find sub'`,
      ],
      [
        "find under xargs fed a -delete holding a backslash in bash -c after a cd to a variable",
        `bash -c 'cd "$X" && echo "-dele\\te" | xargs find sub'`,
      ],
      [
        "find under xargs fed a -delete holding a backslash in sh -c after a cd to a variable",
        `sh -c 'cd "$X" && echo "-dele\\te" | xargs find sub'`,
      ],
      // printf's output for any directive but a bare %s is text the hook cannot read
      [
        "find under xargs fed by printf's %b after a cd to a variable",
        `cd "$X" && printf '%b\\n' '-dele\\te' | xargs find sub`,
      ],
      [
        "find under xargs fed by printf with a precision after a cd to a variable",
        `cd "$X" && printf '%.7s\\n' -deletexyz | xargs find sub`,
      ],
      [
        "find under xargs fed by printf with a width from an argument after a cd to a variable",
        `cd "$X" && printf '%*s\\n' 7 -delete | xargs find sub`,
      ],
      // GNU xargs' -a reads its words from a file in place of stdin, so an absolute stdin says nothing of them
      [
        "rm under xargs -a fed an absolute path after a cd to a variable",
        `cd "$X" && printf '/tmp/x\\n' | xargs -a .no-such-list rm -r`,
      ],
      [
        "rm under xargs -a with an absolute here-string after a cd to a variable",
        `cd "$X" && xargs -a .no-such-list rm -r <<< /tmp/x`,
      ],
      [
        "touch under xargs --arg-file= fed an absolute path after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs --arg-file=.no-such-list touch`,
      ],
      [
        "rm under xargs --arg-file with its value as the next word after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs --arg-file .no-such-list rm`,
      ],
      [
        "rm under xargs -a with an attached value after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs -a.no-such-list rm`,
      ],
      [
        "rm under xargs -r -a after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs -r -a .no-such-list rm`,
      ],
      [
        "rm under xargs -ra in a flag cluster after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs -ra .no-such-list rm`,
      ],
      [
        "rm under gxargs -a after a cd to a variable",
        `cd "$X" && echo /tmp/x | gxargs -a .no-such-list rm`,
      ],
      [
        "rm under xargs --arg, a prefix of --arg-file, after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs --arg .no-such-list rm`,
      ],
      [
        "rm under xargs --a=, a prefix GNU reads as --arg-file so its words come from the file, after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs --a=.no-such-list rm`,
      ],
      [
        "rm under xargs -a run by another xargs after a cd to a variable",
        `cd "$X" && echo /tmp/x | xargs xargs -a .no-such-list rm`,
      ],
      [
        "rm under xargs -a with an absolute here-string and no cd, since its words come from a file the hook cannot read",
        `xargs -a .no-such-list rm -r <<< /tmp/x`,
      ],
      // a replace string in a flag cluster or a --replace prefix that xargs glues into a find word, which makes it an action
      ...[
        "xargs -rI{} find sub -{}",
        "xargs -tI{} find sub -{}",
        "xargs -ri{} find sub -{}",
        "xargs -rJ{} find sub -{}",
        "xargs -0I{} find sub -{}",
        "xargs -xI{} find sub -{}",
        "xargs -prI{} find sub -{}",
        "xargs -n1 -rI{} find sub -{}",
        "xargs -tri find sub -{}",
        "xargs --r find sub -{}",
        "xargs --re find sub -{}",
        "xargs --rep find sub -{}",
        "xargs --repl={} find sub -{}",
        "xargs --repla={} find sub -{}",
        "xargs --replac find sub -{}",
        "gxargs -rI{} find sub -{}",
        "xargs -rI{} gfind sub -{}",
        "xargs -rIQ find sub -Q",
      ].map((call): Row => [
        `${call} fed delete, a glued replace string, after a cd to a variable`,
        `cd "$X" && echo delete | ${call}`,
      ]),
      [
        "find under xargs -rI{} with a glued replace string fed exec after a cd to a variable",
        `cd "$X" && echo exec | xargs -rI{} find sub -{} rm Z ;`,
      ],
      [
        "find under xargs -rIQ with the replace string inside a word after a cd to a variable",
        `cd "$X" && echo de | xargs -rIQ find sub -Qlete`,
      ],
    ],
  },
  // a path to the root xargs reads once it drops a pair of quotes or a backslash, with no cd
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: ({ HOME }) => [
      [
        "rm under xargs fed the root's absolute path quoted in part",
        `echo "${HOME}/.play'ground'/extensions/.no-such-file" | xargs rm`,
      ],
      [
        "rm under xargs fed the root's absolute path holding a backslash",
        `echo "${HOME}/.play\\ground/extensions/.no-such-file" | xargs rm`,
      ],
      [
        "rm under xargs with a here-string of the root's absolute path quoted in part",
        `xargs rm <<< "${HOME}/.play'ground'/extensions/.no-such-file"`,
      ],
    ],
  },
  {
    folders: ["home"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "rm under xargs fed the root's relative path single-quoted in part",
        `echo ".play'ground'/extensions/.no-such-file" | xargs rm`,
      ],
      [
        "rm under xargs fed the root's relative path double-quoted in part",
        `echo '.play"ground"/extensions/.no-such-file' | xargs rm`,
      ],
      [
        "rm under xargs fed the root's relative path holding a backslash",
        `echo '.play\\ground/extensions/.no-such-file' | xargs rm`,
      ],
      [
        "rm under xargs -n1 fed the root's relative path quoted in part",
        `echo ".play'ground'/extensions/.no-such-folder" | xargs -n1 rm -r`,
      ],
      [
        "rm under xargs fed the root's relative path quoted in part by printf",
        `printf '%s\\n' ".play'ground'/extensions/.no-such-file" | xargs rm`,
      ],
      [
        "touch under xargs fed the root's relative path quoted in part",
        `echo ".play'ground'/extensions/.no-such-file" | xargs touch`,
      ],
      [
        "touch under xargs fed the root's relative path after an -E value spelled like -a",
        `echo .playground/extensions/.no-such-file | xargs -E -a touch`,
      ],
    ],
  },
  // a word read as xargs' -a, another option's value included, leaves xargs' stdin judged for the root as typed, and after a cd the hook cannot read its file's words are words it cannot read
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: ({ HOME }) => [
      ...[
        "-E -a touch",
        "-E -a tee",
        "-I -a touch -a",
        "-I -a cp /tmp/a -a",
        "-E --arg touch",
        "-E --a touch",
        "-E -ta touch",
        "-J -a cp -a /tmp/a",
        "-L 1 -E -a touch",
        "-E -a ln -s /tmp/a",
        "-E -a mkdir",
        "-E -a sed -i s/a/b/",
        "-E -a cp /tmp/a",
        "-E -a -n1 touch",
        "-s 99 -E -a touch",
        "-E -a wc -l",
      ].map((call): Row => [
        `xargs ${call} fed the root's path`,
        `echo ~/.playground/extensions/.no-such-file | xargs ${call}`,
      ]),
      [
        "gxargs -E -a touch fed the root's path",
        `echo ~/.playground/extensions/.no-such-file | gxargs -E -a touch`,
      ],
      [
        "xargs -E -a touch fed the root's absolute path",
        `echo ${HOME}/.playground/extensions/.no-such-file | xargs -E -a touch`,
      ],
      [
        "touch under a real xargs -a, its stdin naming the root",
        `echo ~/.playground/extensions/.no-such-file | xargs -a /dev/null touch`,
      ],
      [
        "touch under xargs -a after a cd to a variable, whose words the hook cannot read",
        `cd "$X"; xargs -a /tmp/list touch`,
      ],
    ],
  },
  // printf's %b, a width or a precision piped into a shell, which the hooks judging a piped script read through printf's own rendering
  {
    folders: ["checkout"],
    guards: ["no-stash"],
    rows: () => [
      ["a stash by printf %b piped to sh", "printf '%b' 'git stash' | sh"],
      ["a stash by printf %b with a newline piped to bash", "printf '%b\\n' 'git stash' | bash"],
      ["a stash by printf with a width piped to sh", "printf '%5s' 'git stash' | sh"],
      ["a stash by printf with a precision piped to sh", "printf '%.3s' 'git stash' | sh"],
      [
        "a stash by printf %b to sh -c under xargs",
        "printf '%b' 'git stash' | xargs -I{} sh -c {}",
      ],
      ["a stash by printf %b sourced from stdin", "printf '%b' 'git stash' | source /dev/stdin"],
      ["a stash by printf %b piped to eval", "printf '%b' 'git stash' | eval"],
    ],
  },
  {
    folders: ["checkout", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      ["a recursive delete by printf %b piped to sh", `printf '%b' 'rm -rf ${NEVER_MADE}' | sh`],
      [
        "a recursive delete by printf %b with a newline piped to bash",
        `printf '%b\\n' 'rm -rf ${NEVER_MADE}' | bash`,
      ],
      [
        "a recursive delete by printf with a width piped to sh",
        `printf '%5s' 'rm -rf ${NEVER_MADE}' | sh`,
      ],
      [
        "a recursive delete by printf with a precision piped to sh",
        `printf '%.80s' 'rm -rf ${NEVER_MADE}' | sh`,
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-kill-by-name"],
    rows: () => [["a kill by name by printf %b piped to sh", "printf '%b' 'pkill node' | sh"]],
  },
  // every option of GNU and BSD xargs, and every find primary that names a path or acts, each feeding a remover or a writer after a cd the hook cannot read
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: () => EVERY_OPTION.map((call): Row => [`every option: ${call}`, call]),
  },
]

const EVERY_OPTION = [
  `cd "$X" && echo .no-such-folder | xargs -0 rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --null rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --nu rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -o rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --open-tty rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -p rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --interactive rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -r rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --no-run-if-empty rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --no rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -t rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --verbose rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -x -n1 rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --exit -n1 rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -E END rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -EEND rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -e rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -eEND rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --eof rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --eof=END rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -I Q rm -r Q`,
  `cd "$X" && echo .no-such-folder | xargs -IQ rm -r Q`,
  `cd "$X" && echo .no-such-folder | xargs -rI Q rm -r Q`,
  `cd "$X" && echo .no-such-folder | xargs -rI /tmp/q rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder | xargs -i rm -r {}`,
  `cd "$X" && echo .no-such-folder | xargs -iQ rm -r Q`,
  `cd "$X" && echo .no-such-folder | xargs -ri rm -r {}`,
  `cd "$X" && echo .no-such-folder | xargs --replace rm -r {}`,
  `cd "$X" && echo .no-such-folder | xargs --replace=/tmp/q rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder | xargs --rep=/tmp/q rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder | xargs -I /tmp/q -R 1 rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder | xargs -I /tmp/q -S 255 rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder | xargs -J /tmp/q rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder | xargs -J/tmp/q rm -r /tmp/q`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -L 1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -L1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -l rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -l1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-lines=1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -n 1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-args=1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-args 1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-a 1 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -s 20 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-chars=20 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs -P 2 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-procs=2 rm -r`,
  `cd "$X" && echo .no-such-folder /tmp/d | xargs --max-procs 2 rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --process-slot-var=S rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --process-slot-var S rm -r`,
  `cd "$X" && echo .no-such-folder | xargs --show-limits rm -r`,
  `cd "$X" && printf /.no-such-folder | xargs -d / rm -r`,
  `cd "$X" && printf /.no-such-folder | xargs --delimiter=/ rm -r`,
  `cd "$X" && printf /.no-such-folder | xargs --del / rm -r`,
  `cd "$X" && echo /tmp/x | xargs -a .no-such-list rm -r`,
  `cd "$X" && echo /tmp/x | xargs --arg-file=.no-such-list rm -r`,
  `cd "$X" && echo .no-such-folder | xargs -- rm -r`,
  `cd "$X" && echo .no-such-file | xargs -n1 -P4 -t touch`,
  `cd "$X"; find -delete`,
  `cd "$X"; find -exec rm {} +`,
  `cd "$X"; find -execdir rm {} ;`,
  `cd "$X"; find -ok rm {} ;`,
  `cd "$X"; find -okdir rm {} ;`,
  `cd "$X"; find -fprint .no-such-file`,
  `cd "$X"; find /tmp/a -fprint .no-such-file`,
  `cd "$X"; find /tmp/a -fprint0 .no-such-file`,
  `cd "$X"; find /tmp/a -fprintf .no-such-file %p`,
  `cd "$X"; find /tmp/a -fls .no-such-file`,
  `cd "$X"; find -f .no-such-folder -delete`,
  `cd "$X"; find -files0-from /tmp/list -delete`,
  `cd "$X" && echo -delete | xargs find -files0-from /tmp/list`,
  `cd "$X" && echo .no-such-folder | xargs find -delete`,
  `cd "$X" && echo .no-such-folder | xargs find -exec rm {} +`,
  `cd "$X" && echo .no-such-file | xargs find /tmp/a -fprint`,
  `cd "$X" && echo .no-such-file | xargs find /tmp/a -fls`,
  `cd "$X" && echo .no-such-file | xargs find /tmp/a -fprintf`,
]
