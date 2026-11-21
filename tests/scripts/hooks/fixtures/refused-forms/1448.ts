import { type Group } from "./_shared"

// A GLM session's read of a guarded org's checkout (the made-up acme-blue's) by a path the hook cannot read (#1448), by a recursive read of a folder above it (#1449), and its database client given a connection inside its own input (#1450).
export const groups: Group[] = [
  {
    folders: ["glm repo"],
    guards: ["no-glm-heavy-path"],
    rows: () => [
      // #1448: a path held in a variable the line never sets, xargs's -I word, and zsh's ~-
      ["cat of a path held in a variable the hook cannot read", "cat $ORG_DIR/README.md"],
      ["cat of the word xargs fills by -I", "ls .. | xargs -I{} cat ../{}/README.md"],
      ["cat of a path under ~-, the folder the shell last left", "cat ~-/README.md"],
      // #1449: rg on the folder that holds an org's checkout, a search whose pattern names a file or folder in its own folder (which holds a link into the org's checkout), a Grep of that folder, and a ** glob reaching below one level
      ["rg on the folder that holds an org's checkout", "rg token .."],
      ["rg whose pattern names a folder in its own folder", "rg web"],
      ["rg whose pattern names a file in its own folder", "rg package.json"],
      ["grep -r whose pattern names a folder in its own folder", "grep -r web"],
      [
        "a Grep of the folder that holds an org's checkout",
        { input: { path: "..", pattern: "token" }, tool: "Grep" },
      ],
      ["a ** glob reaching an org's checkout two levels down", "cat ../glm-nest/**/README.md"],
      // #1450: psql's connect meta-command naming a remote URL in a heredoc, and a remote conninfo in a script file it runs
      [
        "psql given a heredoc that connects to a remote host",
        "psql <<'EOF'\n\\connect postgres://app@db.example.com/app\nEOF",
      ],
      ["psql running a script file that connects to a remote host", "psql -f connect.sql"],
    ],
  },
]
