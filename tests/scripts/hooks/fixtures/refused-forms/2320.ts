import { type Group, NEVER_MADE, type Row } from "./_shared"

// #2320, #2322, #2324 and #2257's second case: read-only calls a guard refused on a Linux machine, each passing beside its nearest refused twin; rows are data, as refused-forms.ts says.

// no-extensions-write: a disk check, ssh's remote command, an awk > that compares, bash -n, command -v, and regex or comment text read as a glob in /
const extensionsControls = (): Row[] => [
  ["a disk check of the home", "df -h ~"],
  ["a disk check of the folder that holds the homes", "df -h /home"],
  ["a disk check of another machine's homes over ssh", "ssh box df -h /home"],
  ["a quoted disk check of another machine's home over ssh", "ssh box 'df -h ~'"],
  ["a listing of another machine's data folder over ssh", "ssh box ls ~/.playground"],
  [
    "a disk check over ssh after its own options",
    "ssh -i ~/.ssh/k -o IdentitiesOnly=yes -o BatchMode=yes u@10.0.0.2 'df -h /home; ls ~'",
  ],
  [
    "an awk pattern comparing with > beside a bracketed regex",
    "awk '/^[a-z]+:/ && $2 > 100 { print $1 }' /proc/meminfo",
  ],
  [
    "an awk pattern comparing with > in parentheses",
    "awk '/^.*error/ && (NR > 10) {print}' log.txt",
  ],
  [
    "an awk if comparing with > beside a regex after ~",
    "awk '{ if ($1 > 0 && $2 ~ /^\\/home\\/.*/) print $2 }' x",
  ],
  [
    "a function's text cut by awk and checked by bash -n",
    "awk '/^check_proxy\\(\\) \\{/,/^\\}$/' install.sh | bash -n",
  ],
  ["a lookup of pkexec by command -v", "command -v pkexec"],
  ["a lookup of pkexec, sudo and doas by command -V", "command -V pkexec sudo doas"],
  [
    "an inline bun program joining text beside a regex of a literal +@",
    'bun -e \'const E = /[a-z\\d._%+-]+@[a-z\\d-]+(?:\\.[a-z\\d-]+)*\\.[a-z]{2,}/gi; console.log(["a", "b"].join(" "), E.test("q@example.com"))\'',
  ],
  [
    "an in-place sed whose regex holds __[A-Z]+__ in a chain",
    "sed -i 's|/__\\[A-Z\\]+__/.test(out)|/__(SPEC\\|PR)__/.test(out)|' fill.ts && bun fill.ts",
  ],
  [
    "an inline bun edit whose string holds a // comment with a paren",
    'bun -e \'const p = "jobs.ts"; const s = await Bun.file(p).text(); await Bun.write(p, s.replace("// On macOS the folder launchd loads (HOME\\x27s LaunchAgents) and systemctl --user. A test fakes either.", ""))\'',
  ],
]

// no-raw-delete: a single-dash option holding an r that is no rm option, a brace member led by a dash, a case pattern, and agent-browser's eval after its own options
const deleteControls = (): Row[] => [
  [
    "an openssl fingerprint of a file named by a variable",
    "openssl x509 -in $f -noout -fingerprint -sha256",
  ],
  [
    "an openssl connect to a port with a default, given -servername",
    "echo | openssl s_client -connect 127.0.0.1:${PORT:-443} -servername x 2>/dev/null | openssl x509 -noout -subject",
  ],
  ["a listing of a brace list holding a dash-led member", "ls dir{,-before}"],
  ["a listing of a data folder brace path", "ls -l ~/.playground/scratchpad/me/start-{a,b}.sh"],
  ["a cat of a data folder brace path", "cat ~/.playground/scratchpad/me/start-{a,b}.sh"],
  ["a listing of a temp folder brace path", "ls -l /tmp/start-{a,b}.sh"],
  [
    "a retry loop whose case pattern holds a blank",
    'for i in 1 2 3; do out=$(playground roster --reports-to x 2>&1); case "$out" in *"herdr pane"*) exit 0;; esac; done',
  ],
  [
    "agent-browser's eval with braces after --args, --session and --ignore-https-errors",
    'agent-browser --args "--no-sandbox,--mute-audio" --session t --ignore-https-errors eval \'(()=>{const out=[];for(const g of document.querySelectorAll("nav")){out.push(g.innerText)}return out.join("\\n")})()\'',
  ],
  [
    "agent-browser's eval with ?? after --session and --json",
    "agent-browser --session t --json eval \"document.querySelector('#x')?.textContent ?? document.body.innerText.slice(0,2000)\"",
  ],
]

// no-playground-leak: a CA file given to curl by --cacert, so its value is no URL
const leakControls = (): Row[] => [
  [
    "a health curl given a CA file from a variable by --cacert",
    'curl -sS --cacert "$PDIR/ca.pem" https://x.api.playground.localhost:1355/api/health',
  ],
]

export const groups: Group[] = [
  {
    folders: ["process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      ...extensionsControls(),
      ["a disk check writing into the root", `df -h > ${NEVER_MADE}/x`],
      ["an ssh call whose local redirect writes into the root", `ssh box cat x > ${NEVER_MADE}/x`],
      ["an ssh call logging into the root by -E", `ssh -E ${NEVER_MADE}/log box ls`],
      ["an ssh call whose remote command copies into the root", `ssh box cp a ${NEVER_MADE}/x`],
      [
        "an ssh call to this machine removing the root's folder",
        `ssh localhost 'rm -rf ${NEVER_MADE}'`,
      ],
      [
        "an ssh call whose ProxyCommand removes the root's folder",
        `ssh -o 'ProxyCommand=rm -rf ${NEVER_MADE}' box ls`,
      ],
      [
        "an awk print redirected into the root beside a > comparison",
        `awk '/^[a-z]+:/ && $2 > 1 { print $1 > "${NEVER_MADE}/x" }' f`,
      ],
      [
        "a function's text cut by awk and run by bash",
        "awk '/^check_proxy\\(\\) \\{/,/^\\}$/' install.sh | bash",
      ],
      [
        "a function's text cut by awk and run by bash with -n undone",
        "awk '/^check_proxy\\(\\) \\{/,/^\\}$/' install.sh | bash -n +n",
      ],
      [
        "a removal piped into bash with noexec undone by name",
        `echo 'rm -rf ${NEVER_MADE}' | bash -n +o noexec`,
      ],
      [
        "a write piped into bash with noexec undone in a +xo cluster",
        `echo 'touch ${NEVER_MADE}/x' | bash -n +xo noexec`,
      ],
      [
        "a write piped into bash with noexec undone in a +eo cluster",
        `echo 'touch ${NEVER_MADE}/x' | bash -n +eo noexec`,
      ],
      [
        "a write piped into sh with noexec undone in a +vo cluster",
        `echo 'touch ${NEVER_MADE}/x' | sh -n +vo noexec`,
      ],
      [
        "a write piped into zsh with noexec undone by a long option",
        `echo 'touch ${NEVER_MADE}/x' | zsh -n --no-noexec`,
      ],
      ["a bare pkexec, a root shell reading stdin", "pkexec"],
      ["a pkexec run by command, a root shell reading stdin", "command pkexec"],
      [
        "an inline bun program joining text beside a regex that may match a name in /",
        "bun -e 'const r = /[a-z]*/; console.log([r].join(\" \"))'",
      ],
    ],
  },
  {
    folders: ["process data folder", "process home", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      ...deleteControls(),
      ["a variable's program given a bare -r", "openssl x509 -in $f -r"],
      ["a variable's program given -Rf", `x $f -Rf ${NEVER_MADE}`],
      ["a variable's program given --rec", `x $f --rec ${NEVER_MADE}`],
      ["a variable's program given rm's macOS -P with -r", `$RM -rP ${NEVER_MADE}`],
      ["a variable's program given rm's macOS -W with -R", `$RM -WR ${NEVER_MADE}`],
      ["a brace list spelling -r for rm", `rm -{r,f} ${NEVER_MADE}`],
      [
        "a recursive rm of a brace path",
        `rm -r ${NEVER_MADE.replace("/extensions/", "/{extensions,extensions}/")}`,
      ],
      [
        "a case pattern's substitution running a recursive rm",
        `case x in $(rm -rf ${NEVER_MADE})) ;; esac`,
      ],
      [
        "a recursive rm piped into bash with noexec undone in a +xo cluster",
        `echo 'rm -rf ${NEVER_MADE}' | bash -n +xo noexec`,
      ],
      ["an ssh call to this machine with a recursive rm", `ssh localhost 'rm -rf ${NEVER_MADE}'`],
      [
        "agent-browser's eval after --args holding a blank, before a recursive rm",
        `agent-browser --args "--renderer-cmd-prefix=rm -rf ${NEVER_MADE}" eval 'a?.b ?? 1'`,
      ],
    ],
  },
  {
    folders: ["home"],
    guards: ["no-playground-leak"],
    rows: () => [
      ...leakControls(),
      [
        "a health curl handed a CA file from a variable as its URL",
        'curl -sS "$PDIR/ca.pem" https://x.api.playground.localhost:1355/api/health',
      ],
    ],
  },
]

export const allowed: string[] = [
  ...extensionsControls(),
  ...deleteControls(),
  ...leakControls(),
].map(([what]) => what)
