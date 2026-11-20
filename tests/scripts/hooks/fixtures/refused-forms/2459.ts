import { type Group, NEVER_MADE, type Paths, type Row } from "./_shared"

// #2459 items 1 and 2: ssh's remote line read from the login's home, the stdin ssh hands a remote shell read as its script, and the -o values ssh runs here, each passing form beside its nearest refused twin; rows are data, as refused-forms.ts says.

// no-extensions-write: remote lines that write outside the root from the home, stdin a remote command reads as data or never gets, and a ProxyCommand that writes nothing
const extensionsControls = ({ DATA, HOME }: Paths): Row[] => [
  [
    "Ops' peer-folder check: a listing of the data folder fed to a remote bash from a file",
    `ssh spark-9dfb bash -s < ${HOME}/peer-check.sh`,
  ],
  [
    "Ops' peer-folder check: a listing of the data folder fed to a remote bash as a here-string",
    `ssh spark-9dfb bash -s <<< 'ls ${DATA}'`,
  ],
  ["a touch in the remote home's notes folder over ssh", "ssh localhost 'touch notes/x'"],
  [
    "a listing of the remote home's data folder after a remote cd",
    "ssh localhost 'cd .playground && ls'",
  ],
  ["a copy into the remote home's notes folder over ssh", "ssh localhost cp a notes/x"],
  ["a text piped to a remote cat", "echo hi | ssh box cat > out.txt"],
  ["a remote listing reading /dev/null", "ssh box ls < /dev/null"],
  ["a script piped to a remote bash -n", "echo 'df -h' | ssh box bash -n"],
  ["a script piped to a remote bash that writes nothing", "echo 'df -h' | ssh box bash"],
  [
    "a write's text piped to ssh -n, whose remote side reads /dev/null",
    "echo 'touch .playground/extensions/x' | ssh -n host bash",
  ],
  [
    "a write's text piped to a remote cat that saves it as data",
    "echo 'touch .playground/extensions/x' | ssh box 'cat > notes.txt'",
  ],
  ["a ProxyCommand that connects by nc", "ssh -o ProxyCommand='nc %h %p' host ls"],
  ["a remote uptime after -o options that run nothing", "ssh -o Port=2222 -o User=me box uptime"],
  [
    "docker's format templates in a remote line, braces with no list read from the home",
    `ssh spark-9dfb 'docker ps --format "{{.Names}}"; docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}"'`,
  ],
  [
    "a python print in a remote line, its parentheses read from the home",
    `ssh spark-9dfb 'python3 -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"'`,
  ],
  [
    "a bracket pattern in a remote pgrep, read from the home",
    "ssh spark-9dfb 'pgrep -af [c]laude'",
  ],
  [
    "a zsh group of one plain name in a remote line, read from the home",
    `ssh spark-9dfb "printf '%s\\n' 'profile x flags=(unconfined) {'"`,
  ],
  [
    "a star glob in the remote home, which no dot-led name matches",
    "ssh spark-9dfb 'ls */extensions'",
  ],
  [
    "a runner-host survey sourcing os-release in a heredoc fed to a remote bash",
    "ssh spark-9dfb bash -s <<'EOF'\nif [ -r /etc/os-release ]; then . /etc/os-release && echo \"${PRETTY_NAME:-unknown}\"; fi\nEOF",
  ],
  ["a source of os-release by . from the home", ". /etc/os-release && echo ok", "home"],
  [
    "a source of os-release by source in a heredoc fed to a remote bash",
    "ssh spark-9dfb bash -s <<'EOF'\nsource /etc/os-release && echo ok\nEOF",
  ],
  ["a source of os-release by source from the home", "source /etc/os-release && echo ok", "home"],
  ["a source of os-release by . in a remote line", "ssh box '. /etc/os-release && echo ok'"],
  [
    "a source of os-release by source in a remote line",
    "ssh box 'source /etc/os-release && echo ok'",
  ],
  [
    "Ops' peer-folder check fed from a file, its output piped to head",
    `ssh spark-9dfb bash -s < ${HOME}/peer-check.sh | head -80`,
  ],
  ["a remote listing under $HOME with no glob in the home", "ssh box 'ls $HOME/notes'"],
  ["a RemoteCommand that writes nothing", "ssh -o RemoteCommand=uptime box"],
  ["a remote uptime after a port option past the host", "ssh box -p 22 uptime"],
]

const extensionsRefused = ({ HOME, ROOT }: Paths): Row[] => [
  [
    "a write under the root fed to a remote bash from a file",
    `ssh spark-9dfb bash -s < ${HOME}/peer-write.sh`,
  ],
  [
    "a write under the root fed to a remote bash as a here-string",
    `ssh spark-9dfb bash -s <<< 'touch ${ROOT}/x'`,
  ],
  [
    "a source by . of a file in the root in a heredoc fed to a remote bash",
    "ssh spark-9dfb bash -s <<'EOF'\n. .playground/extensions/x\nEOF",
  ],
  ["a source by . of a file in the root from the home", ". .playground/extensions/x", "home"],
  [
    "a source by source of a file in the root in a heredoc fed to a remote bash",
    "ssh spark-9dfb bash -s <<'EOF'\nsource .playground/extensions/x\nEOF",
  ],
  [
    "a source by source of a file in the root from the home",
    "source .playground/extensions/x",
    "home",
  ],
  ["a source by . of a file in the root in a remote line", "ssh box '. .playground/extensions/x'"],
  [
    "a source by source of a file in the root in a remote line",
    "ssh box 'source .playground/extensions/x'",
  ],
  [
    "a write under the root fed to a remote bash from a file, its output piped to head",
    `ssh spark-9dfb bash -s < ${HOME}/peer-write.sh | head -80`,
  ],
  [
    "a reader piped to a remote bash inside a here-string, which roots the line",
    "ssh spark-9dfb bash -s <<< 'cat .playground/extensions/x | bash'",
  ],
  ["a remote touch into the root from the home", "ssh localhost 'touch .playground/extensions/x'"],
  [
    "a remote touch into the root after a remote cd from the home",
    "ssh localhost 'cd .playground && touch extensions/x'",
  ],
  ["a remote copy into the root from the home", "ssh localhost cp a .playground/extensions/x"],
  [
    "a remote commit after a remote cd into the root",
    "ssh localhost 'cd .playground/extensions; git commit -am x'",
  ],
  [
    "a remote touch into the root after -p and -i",
    "ssh -p 22 -i key localhost 'touch .playground/extensions/x'",
  ],
  ["a remote touch into the root after --", "ssh localhost -- 'touch .playground/extensions/x'"],
  [
    "a remote touch into the root after an option past the host",
    "ssh localhost -p 22 'touch .playground/extensions/x'",
  ],
  [
    "a RemoteCommand touching the root",
    "ssh -o RemoteCommand='touch .playground/extensions/x' localhost",
  ],
  ["a write piped to a remote bash", "echo 'touch .playground/extensions/x' | ssh localhost bash"],
  [
    "a write piped to ssh with no remote command, which the login shell reads",
    "echo 'cd .playground && touch extensions/x' | ssh localhost",
  ],
  [
    "a write in a here-string to a remote bash",
    "ssh localhost bash <<< 'touch .playground/extensions/x'",
  ],
  [
    "a write in a heredoc to a remote bash",
    "ssh localhost bash <<'EOF'\ntouch .playground/extensions/x\nEOF",
  ],
  [
    "a write piped to a remote command the hook cannot read",
    `echo 'touch .playground/extensions/x' | ssh localhost "$REMOTE"`,
  ],
  [
    "a write piped to a remote bash after -o BatchMode",
    "echo 'touch .playground/extensions/x' | ssh -o BatchMode=yes localhost bash",
  ],
  [
    "a write piped to a remote sudo bash",
    "echo 'touch .playground/extensions/x' | ssh localhost sudo bash",
  ],
  [
    "a remote touch into the root on another host, read from the home",
    "ssh spark-9dfb 'touch .playground/extensions/x'",
  ],
  ["a remote touch through a dot-led glob in the home", "ssh spark-9dfb 'touch .p*/extensions/x'"],
  [
    "a remote chmod of a ? glob spelling the data folder",
    "ssh spark-9dfb 'chmod -R 777 .pl?yground'",
  ],
  [
    "a remote touch through a brace list spelling the data folder",
    "ssh spark-9dfb 'touch {.playground,x}/extensions/y'",
  ],
  [
    "a remote touch through a star glob after dotglob",
    "ssh spark-9dfb 'shopt -s dotglob; touch */extensions/x'",
  ],
  ["a remote touch through zsh's dot qualifier", "ssh spark-9dfb 'touch *(D)/extensions/x'"],
  [
    "a remote touch through a zsh group spelling the data folder",
    "ssh spark-9dfb 'touch (.playground|x)/extensions/y'",
  ],
  ["a ProxyCommand touching the root", `ssh -o ProxyCommand='touch ${ROOT}/x' host true`],
  [
    "an attached -oProxyCommand touching the root",
    `ssh -oProxyCommand='touch ${ROOT}/x' host true`,
  ],
  [
    "a LocalCommand touching the root",
    `ssh -o PermitLocalCommand=yes -o LocalCommand='touch ${ROOT}/x' host true`,
  ],
  [
    "a KnownHostsCommand touching the root, its value after a blank",
    `ssh -o 'KnownHostsCommand touch ${ROOT}/x' host true`,
  ],
  ["a ProxyCommand the hook cannot read", `ssh -o ProxyCommand="$CMD" host true`],
  ["a -o the hook cannot read", `ssh -o "$OPT" host true`],
  ["a log file in the root by -E past the host", `ssh box -E ${ROOT}/x ls`],
  [
    "a known-hosts file in the root by -o past the host",
    `ssh box -o UserKnownHostsFile=${ROOT}/kh ls`,
  ],
  ["a control socket in the root by -S past the host", `ssh box -S ${ROOT}/sock -M ls`],
  ["a forwarded socket in the root by -L past the host", `ssh box -L ${ROOT}/sock:localhost:80 -N`],
  [
    "a remote touch through a ? glob after GLOBIGNORE",
    "ssh box 'GLOBIGNORE=x; touch ?playground/extensions/y'",
  ],
  [
    "a remote chmod of a ? glob after GLOBIGNORE",
    "ssh box 'GLOBIGNORE=x; chmod -R 777 ?playground'",
  ],
  [
    "a remote touch through a ? glob after GLOB_DOTS spelled with underscores",
    "ssh box 'setopt g_l_o_b_d_o_t_s; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a quoted dotglob",
    `ssh box "shopt -s dot''glob; touch ?playground/extensions/y"`,
  ],
  [
    "a remote touch through a ? glob in zsh -4",
    `ssh box "zsh -4 -c 'touch ?playground/extensions/y'"`,
  ],
  [
    "a touch through a ? glob in zsh -4 from the home",
    "zsh -4 -c 'touch ?playground/extensions/y'",
    "home",
  ],
  [
    "a remote touch through a ? glob after exporting a name the hook cannot read",
    "ssh box 'export GLOB$(echo IGNORE)=x; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a shopt of a substitution",
    "ssh box 'shopt -s $(echo dot)glob; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a setopt of a substitution",
    "ssh box 'setopt $(echo glob)dots; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after declaring a name built from a variable",
    "ssh box 'o=GLOBIGN; declare ${o}ORE=x; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a zsh options key built from a variable",
    "ssh box 'options[glob${x}dots]=on; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a shopt of a positional parameter",
    "ssh box 'shopt -s $1; touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after a shopt of every positional parameter",
    `ssh box 'shopt -s "$@"; touch ?playground/extensions/y'`,
  ],
  [
    "a remote touch through a ? glob in bash -O of a name built from a variable",
    `ssh box 'x=dot; bash -O \${x}glob -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in zsh -o of a name built from a variable",
    `ssh box 'y=glob; zsh -o \${y}dots -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob under BASHOPTS set by a substitution",
    `ssh box 'BASHOPTS=$(echo dot)glob bash -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob in bash -O of a positional parameter",
    `ssh box 'bash -O $1 -c "touch ?playground/extensions/y"'`,
  ],
  [
    "a remote touch through a ? glob under env BASHOPTS=dotglob",
    `ssh box "env BASHOPTS=dotglob bash -c 'touch ?playground/extensions/y'"`,
  ],
  [
    "a remote touch through a ? glob after an eval",
    `ssh box 'eval "$(cat opts)"; touch ?playground/extensions/y'`,
  ],
  [
    "a touch through a ? glob fed to a remote bash -O of a positional parameter",
    "ssh box 'bash -O $1 -s' <<< 'touch ?playground/extensions/y'",
  ],
  [
    "a remote touch through a ? glob after GLOBIGNORE split by a line continuation",
    "ssh box 'GLOBIGNOR\\\nE=x; touch ?playground/extensions/y'",
  ],
  [
    "a touch through a ? glob after GLOBIGNORE split by a line continuation in a heredoc",
    "ssh box bash -s <<'EOF'\nGLOBIGNOR\\\nE=x\ntouch ?playground/extensions/y\nEOF",
  ],
  [
    "a printf-built dotglob piped into a quoted bash in a remote line",
    `ssh box "printf 'shopt -s dot%sglob\\ntouch ?playground/extensions/y\\n' '' | b''ash"`,
  ],
  [
    "a printf-built dotglob piped into a backslashed bash in a remote line",
    `ssh box "printf 'shopt -s dot%sglob\\ntouch ?playground/extensions/y\\n' '' | \\\\bash"`,
  ],
  [
    "a printf-built dotglob piped into a quoted bash by its path in a remote line",
    `ssh box "printf 'shopt -s dot%sglob\\ntouch ?playground/extensions/y\\n' '' | /bin/b''ash"`,
  ],
  [
    "a printf-built dotglob piped to a remote bash",
    `printf 'shopt -s dot%sglob\\ntouch ?playground/extensions/y\\n' '' | ssh box bash`,
  ],
  [
    "a printf-built dotglob piped to ssh with no remote command",
    `printf 'shopt -s dot%sglob\\ntouch ?playground/extensions/y\\n' '' | ssh box`,
  ],
  [
    "a printf-built dotglob in a here-string fed to a remote bash",
    `ssh box bash -s <<< "$(printf 'shopt -s dot%sglob\\ntouch ?playground/extensions/y\\n' '')"`,
  ],
  [
    "a printf-built write in a here-string fed to a remote bash",
    `ssh box bash -s <<< "$(printf 'touch .playground/extensions/y')"`,
  ],
  [
    "a fed file the line rewrites from the root before ssh reads it",
    `cat ${ROOT}/policy.json > ${HOME}/peer-check.sh; ssh h bash -s < ${HOME}/peer-check.sh`,
  ],
  [
    "a python write piped to a remote python3, read from the home",
    `echo 'open(".playground/extensions/x","w")' | ssh box python3`,
  ],
]

export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-extensions-write"],
    rows: (paths) => [...extensionsControls(paths), ...extensionsRefused(paths)],
  },
  {
    folders: ["checkout", "process worktree"],
    guards: ["no-raw-delete"],
    rows: () => [
      ["a recursive rm piped to a remote sh", `echo 'rm -rf ${NEVER_MADE}' | ssh localhost sh`],
    ],
  },
]

export const allowed: string[] = extensionsControls(new Proxy({} as Paths, { get: () => "" })).map(
  ([what]) => what,
)
