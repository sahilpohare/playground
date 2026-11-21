import type { Group, Row } from "./_shared"

// #2248: the data folder written into a git hook by an in-place perl's print text, by a perl or GNU sed replacement that spells the slash by a hex, octal or decimal escape, or by a printer's or a read-only sed's or perl's output that a redirect or a tee writes into the hook, each judged the same from every working folder; rows are data, as refused-forms.ts says.
const held = (): Row[] => [
  [
    "an in-place perl -pi whose print writes a glob of the data folder into a git hook",
    `perl -pi -e 'print "touch ~/.play*/extensions/x\\n"' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl -ni whose print writes a glob of the data folder into a git hook",
    `perl -ni -e 'print "touch ~/.play*/extensions/x"' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose print writes a glob of the data folder after a match variable",
    `perl -pi -e 'print "$1 ~/.play*/extensions/x" if /(a)/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a hex escape",
    String.raw`perl -pi -e 's/a/touch ~\x2f.playground\x2fextensions\x2fx/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a braced hex escape",
    String.raw`perl -pi -e 's/a/touch ~\x{2f}.playground\x{2f}extensions\x{2f}x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by an octal escape",
    String.raw`perl -pi -e 's/a/touch ~\057.playground\057extensions\057x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a braced octal escape",
    String.raw`perl -pi -e 's/a/touch ~\o{57}.playground\o{57}extensions\o{57}x/' .git/hooks/pre-commit`,
  ],
  [
    "a read-only perl whose s/// spells the slash by a hex escape, redirected into a git hook",
    String.raw`perl -pe 's/a/touch ~\x2f.playground\x2fextensions\x2fx/' run.sh > .git/hooks/pre-commit`,
  ],
  [
    "a read-only GNU sed whose s/// spells the slash by a hex escape, redirected into a git hook",
    String.raw`gsed 's/a/touch ~\x2f.playground\x2fextensions\x2fx/' run.sh > .git/hooks/pre-commit`,
  ],
  [
    "an in-place GNU sed whose s/// spells the slash by an octal escape",
    String.raw`gsed -i 's/a/touch ~\o57.playground\o57extensions\o57x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place GNU sed whose s/// spells the slash by a decimal escape",
    String.raw`gsed -i 's/a/touch ~\d47.playground\d47extensions\d47x/' .git/hooks/pre-commit`,
  ],
  [
    "a read-only sed -n whose output holds a glob of the data folder, piped into a git hook by tee",
    `sed -n 's#a#touch ~/.play*/extensions/x#p' run.sh | tee .git/hooks/pre-commit`,
  ],
  [
    "a read-only perl whose print holds a glob of the data folder, redirected into a git hook",
    `perl -ne 'print "touch ~/.play*/extensions/x\\n"' run.sh > .git/hooks/pre-commit`,
  ],
  [
    "an echo of the quoted data folder redirected into a git hook",
    `echo 'touch ~/.playground/extensions/x' > .git/hooks/pre-commit`,
  ],
  [
    "an echo of a quoted glob of the data folder appended to a git hook",
    `echo 'touch ~/.play*/extensions/x' >> .git/hooks/pre-commit`,
  ],
  [
    "an echo of the quoted data folder piped into a git hook by tee",
    `echo 'touch ~/.playground/extensions/x' | tee -a .git/hooks/pre-commit`,
  ],
  [
    "a printf of a quoted glob of the data folder redirected into a git hook",
    String.raw`printf 'touch ~/.play*/extensions/x\n' > .git/hooks/pre-commit`,
  ],
  [
    "an echo of a glob of the data folder in a brace group redirected into a git hook",
    `{ echo 'touch ~/.play*/extensions/x'; } > .git/hooks/pre-commit`,
  ],
  [
    "an echo of the data folder in a subshell appended to a git hook",
    `(echo 'touch ~/.playground/extensions/x') >> .git/hooks/pre-commit`,
  ],
  [
    "an echo of the data folder in a subshell piped into a git hook by tee",
    `(echo set -e; echo 'touch ~/.play*/extensions/x') | tee .git/hooks/pre-commit`,
  ],
  [
    "an echo whose stdout is duplicated to a descriptor its own command opens on a git hook",
    `echo 'touch ~/.play*/extensions/x' 3> .git/hooks/pre-commit >&3`,
  ],
  [
    "an echo whose stdout is duplicated to a descriptor its brace group opens on a git hook",
    `{ echo 'touch ~/.play*/extensions/x' >&3; } 3> .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by its Unicode name",
    String.raw`perl -pi -e 's/a/touch ~\N{SOLIDUS}.playground\N{SOLIDUS}extensions\N{SOLIDUS}x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose print joins two strings into the data folder",
    `perl -pi -e 'print "touch ~/.play", "ground/extensions/x"' .git/hooks/pre-commit`,
  ],
  [
    "a read-only perl whose print joins two strings into the data folder, redirected into a git hook",
    `perl -ne 'print "touch ~/.play", "ground/extensions/x"' f > .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose print spells the data folder around the line it reads",
    `perl -lpi -e 'print "touch ~/.pl", $_, "/extensions/x"' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by an octal escape with no leading 0",
    String.raw`perl -pi -e 's/a/touch ~\57.playground\57extensions\57x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose print spells the slash by an octal escape with no leading 0",
    String.raw`perl -pi -e 'print "touch ~\57.playground\57extensions\57x"' .git/hooks/pre-commit`,
  ],
  [
    "a read-only perl whose s/// spells the slash by an octal escape with no leading 0, redirected into a git hook",
    String.raw`perl -pe 's/a/touch ~\57.playground\57extensions\57x/' f > .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a braced hex escape holding an underscore",
    String.raw`perl -pi -e 's/a/touch ~\x{2_f}.playground\x{2_f}extensions\x{2_f}x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a braced hex escape holding blanks",
    String.raw`perl -pi -e 's/a/touch ~\x{ 2f }.playground\x{ 2f }extensions\x{ 2f }x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a braced octal escape holding an underscore",
    String.raw`perl -pi -e 's/a/touch ~\o{5_7}.playground\o{5_7}extensions\o{5_7}x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a braced octal escape holding blanks",
    String.raw`perl -pi -e 's/a/touch ~\o{ 57 }.playground\o{ 57 }extensions\o{ 57 }x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a code point holding an underscore",
    String.raw`perl -pi -e 's/a/touch ~\N{U+2_F}.playground\N{U+2_F}extensions\N{U+2_F}x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the slash by a code point holding blanks",
    String.raw`perl -pi -e 's/a/touch ~\N{ U+2F }.playground\N{ U+2F }extensions\N{ U+2F }x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the data folder's letters by their Unicode names",
    String.raw`perl -pi -e 's/a/touch ~\/.play\N{LATIN SMALL LETTER G}round\N{SOLIDUS}extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "two echoes in a brace group appended to a git hook",
    `{ echo hi; echo 'touch ~/.playground/extensions/x'; } >> .git/hooks/pre-commit`,
  ],
  [
    "an echo in an if compound redirected into a git hook",
    `if true; then echo 'touch ~/.playground/extensions/x'; fi > .git/hooks/pre-commit`,
  ],
  [
    "an echo in a for loop redirected into a git hook",
    `for i in 1; do echo 'touch ~/.playground/extensions/x'; done > .git/hooks/pre-commit`,
  ],
  [
    "an echo in a while loop piped into a git hook by tee",
    `while true; do echo 'touch ~/.playground/extensions/x'; break; done | tee .git/hooks/pre-commit`,
  ],
  [
    "a read-only sed -n in a brace group redirected into a git hook",
    String.raw`{ sed -n 's/.*/touch ~\/.play*\/extensions\/x/p' f; } > .git/hooks/pre-commit`,
  ],
  [
    "an echo in a brace group piped into a git hook by tee",
    `{ echo 'touch ~/.playground/extensions/x'; } | tee .git/hooks/pre-commit`,
  ],
  [
    "an echo whose stdout is duplicated to a descriptor its own command opens later on a git hook",
    `echo 'touch ~/.playground/extensions/x' >&3 3> .git/hooks/pre-commit`,
  ],
  [
    "an echo whose stdout is duplicated to stdin, which a bare <> opens on a git hook",
    `echo 'touch ~/.playground/extensions/x' <> .git/hooks/pre-commit >&0`,
  ],
  [
    "an echo whose stdout is duplicated to a descriptor an earlier exec opened on a git hook",
    `exec 3> .git/hooks/pre-commit; echo 'touch ~/.playground/extensions/x' >&3`,
  ],
  [
    "an echo after an exec sent stdout into a git hook",
    `exec > .git/hooks/pre-commit; echo 'touch ~/.playground/extensions/x'`,
  ],
  [
    "an echo of the data folder piped into a git hook by gtee",
    `echo 'touch ~/.playground/extensions/x' | gtee .git/hooks/pre-commit`,
  ],
]
// controls that keep canary's verdict: text with no path, a path outside the data folder, and the data folder written into a file no shell runs as a hook
const controls = (): Row[] => [
  [
    "an in-place perl whose print writes a header line with no path",
    String.raw`perl -pi -e 'print "// header\n" if /^import/' src/a.ts`,
  ],
  [
    "an in-place perl whose print writes a plain word into a git hook",
    `perl -pi -e 'print "set -e\\n" if /^#!/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// writes plain escaped slashes",
    String.raw`perl -pi -e 's/\/usr\/local/\/opt/' Makefile`,
  ],
  [
    "an in-place perl whose s/// writes a folder outside the home by a hex escape into a git hook",
    String.raw`perl -pi -e 's/a/cd \x2fopt\x2fx/' .git/hooks/pre-commit`,
  ],
  [
    "a read-only GNU sed whose s/// writes /tmp by a hex escape",
    String.raw`gsed 's/a/\x2ftmp/' a.txt`,
  ],
  [
    "a read-only sed whose s/// writes /var/tmp by escaped slashes",
    String.raw`sed 's/\/tmp\//\/var\/tmp\//g' a.txt`,
  ],
  [
    "a read-only sed -n that prints each path's last part",
    String.raw`sed -n 's/^.*\/\(.*\)$/\1/p' paths.txt`,
  ],
  [
    "a read-only sed -n whose output names another folder of the home, piped into a git hook by tee",
    `sed -n 's#a#touch ~/.config/x#p' run.sh | tee .git/hooks/pre-commit`,
  ],
  [
    "an echo of another folder of the home redirected into a git hook",
    `echo 'touch ~/.config/x' > .git/hooks/pre-commit`,
  ],
  [
    "an echo of a plain command redirected into a git hook",
    `echo 'bun test' > .git/hooks/pre-commit`,
  ],
  [
    "an echo of the quoted data folder redirected into a note",
    `echo 'touch ~/.playground/extensions/x' > notes.md`,
  ],
  [
    "an echo of the data folder into a note inside a brace group redirected into a git hook",
    `{ echo 'touch ~/.playground/extensions/x' > notes.md; echo ok; } > .git/hooks/pre-commit`,
  ],
  ["an in-place perl whose print joins two plain strings", `perl -pi -e 'print "a", "b"' src/a.ts`],
  [
    "an echo of another folder of the home in an if compound redirected into a git hook",
    `if true; then echo 'touch ~/.config/x'; fi > .git/hooks/pre-commit`,
  ],
  [
    "an echo of the data folder through a descriptor an earlier exec opened on a log",
    `exec 3> out.log; echo 'touch ~/.playground/extensions/x' >&3`,
  ],
  [
    "an echo of the data folder with a descriptor opened on a git hook and its stdout left alone",
    `echo 'touch ~/.playground/extensions/x' 3> .git/hooks/pre-commit`,
  ],
]
// a Unicode name read as any character makes a *, which from the data folder canary already reads as a glob of the root, so this control runs from every other folder
const away = (): Row[] => [
  [
    "an in-place perl whose s/// writes a character by its Unicode name",
    String.raw`perl -pi -e 's/a/\N{BULLET} done/' src/a.ts`,
  ],
]

const rows = () => [...held(), ...controls()]

export const groups: Group[] = [
  { folders: ["data folder", "home", "process worktree"], guards: ["no-extensions-write"], rows },
  { folders: ["home", "process worktree"], guards: ["no-extensions-write"], rows: away },
]

export const allowed: string[] = [...controls(), ...away()].map(([what]) => what)
