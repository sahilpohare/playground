// @bun
const __CHECKOUT = import.meta.dir.slice(0, import.meta.dir.lastIndexOf("/scripts/hooks/bundled"));

// scripts/hooks/no-raw-wa.ts
import { realpathSync as realpathSync2 } from "fs";
import { homedir as homedir4 } from "os";
import { resolve as resolve4 } from "path";

// packages/env/src/aliases.ts
var DESK_ENV = new Set([
  "APPROVALS_ENABLED",
  "ATTACHMENTS_DIR",
  "BARE_NAMES",
  "CHANGELOG_DIR",
  "DATA_DIR",
  "DEBUG_",
  "DEBUG_PASTE_DIR",
  "DISPATCHER",
  "DISPATCHER_SECONDARY",
  "FIXTURE",
  "FIXTURE_DIR",
  "FIXTURE_LAUNCHED",
  "HERDR_",
  "HERDR_ALONE",
  "HERDR_DIR",
  "HERDR_SESSION",
  "HERDR_SESSIONS",
  "LIVE_READS",
  "MERGED_PULLS",
  "OWNER_NAME",
  "PREVIEWS_DIR",
  "SDK_PERMISSION_MODE",
  "SDK_PROBE_DIR"
]);
var renamedEnv = (name) => {
  if (!name.startsWith("DESK_"))
    return;
  const rest = name.slice("DESK_".length);
  if (DESK_ENV.has(rest) || [...DESK_ENV].some((p) => p.endsWith("_") && rest.startsWith(p)))
    return `PLAYGROUND_${rest}`;
};
var applyEnvAliases = (env = process.env) => {
  for (const [name, value] of Object.entries(env)) {
    const renamed = renamedEnv(name);
    if (renamed && !env[renamed])
      env[renamed] = value;
  }
};
applyEnvAliases();

// packages/env/src/data-dir.ts
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
var dataDirOf = (env, home = env.HOME || homedir()) => {
  const named = env.PLAYGROUND_DATA_DIR;
  if (!named)
    return join(home, ".playground");
  if (!isAbsolute(named))
    throw new Error(`PLAYGROUND_DATA_DIR is relative (${named}), so each process would read it from its own folder: set it to an absolute path`);
  return resolve(named);
};

// scripts/hooks/codex.ts
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "path";
var HEADERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "];
var SHELL_PATCH = /(?:^|[\n;&|(`]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:\S*\/)?(?:apply_patch|applypatch)(?=$|[\s;&|)<>'"`])/;
var patchPaths = (text) => text.split(`
`).flatMap((line) => {
  const trimmed = line.trim();
  const header = HEADERS.find((h) => trimmed.startsWith(h));
  return header && trimmed.length > header.length ? [trimmed.slice(header.length)] : [];
});
var writeOf = (input, path, patch) => {
  const cwd = typeof input.cwd === "string" ? input.cwd : "/";
  return JSON.stringify({
    ...input,
    tool_input: { content: patch, file_path: isAbsolute2(path) ? path : resolve2(cwd, path) },
    tool_name: "Write"
  });
};
function guardInputs(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (typeof input !== "object" || input === null || typeof input.turn_id !== "string")
    return [raw];
  const tool = input.tool_name;
  const command = input.tool_input?.command;
  const text = typeof command === "string" ? command : "";
  const shell = tool === "Bash" && SHELL_PATCH.test(text);
  if (tool !== "apply_patch" && !shell)
    return [raw];
  const paths = patchPaths(text);
  if (paths.length === 0)
    return null;
  return [...shell ? [raw] : [], ...paths.map((path) => writeOf(input, path, text))];
}
async function eachInput(raw, guard, judge) {
  const inputs = guardInputs(raw);
  if (!inputs)
    return `${guard} hook refuses an apply_patch whose patch names no file it can read: give the patch whole in the call itself, with each file on its own *** Add File, *** Update File or *** Delete File line.`;
  for (const input of inputs) {
    const reason = await judge(input);
    if (reason)
      return reason;
  }
}

// scripts/hooks/input.ts
var DEADLINE = 13000;
async function input(name, kind, deadline = DEADLINE) {
  let timer;
  const raw = await Promise.race([
    Bun.stdin.text(),
    new Promise((done) => {
      timer = setTimeout(() => done(undefined), deadline - performance.now());
    })
  ]).finally(() => clearTimeout(timer));
  if (raw !== undefined)
    return raw;
  if (kind === "recorder")
    process.exit(0);
  console.error(`${name} hook: the call's input did not arrive by its deadline, about ${deadline / 1000} s, inside the runner's 15 s timeout, so the call is refused; report it to your lead.`);
  process.exit(2);
}

// scripts/hooks/role.ts
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";

// packages/config/src/kinds.ts
var ROSTER_KINDS = [
  "assistant",
  "builder",
  "dispatcher",
  "ops",
  "optimizer",
  "orchestrator",
  "planner",
  "probe",
  "researcher",
  "reviewer",
  "runner",
  "tester",
  "worker"
];
var isRosterKind = (value) => ROSTER_KINDS.includes(value);
var FACTORY_ROLE_OF_KIND = {
  assistant: "lead",
  builder: "lead",
  dispatcher: "dispatcher",
  ops: "lead",
  optimizer: "lead",
  orchestrator: "lead",
  planner: "lead",
  probe: "probe",
  researcher: "worker",
  reviewer: "reviewer",
  runner: "runner",
  tester: "tester",
  worker: "worker"
};
var ID_ALPHABET = "23456789bcdfghjkmnpqrstvwxyz";
var ID_NAME_SOURCE = `[${ID_ALPHABET}]{6}-(?:${ROSTER_KINDS.join("|")})`;
var PREFIXED = /^(probe|reviewer|runner|tester|worker)-./;
var ID_NAME = new RegExp(`^[${ID_ALPHABET}]{6}-(${ROSTER_KINDS.join("|")})$`);
var kindOfName = (name) => (ID_NAME.exec(name) ?? PREFIXED.exec(name))?.[1] ?? null;
var DEFAULT_SESSION_NAMES = {
  aliases: {},
  names: { builder: "builder", dispatcher: "dispatcher", ops: "ops", planner: "planner" }
};
var NAMES = Symbol.for("playground.sessionNames");
var held = globalThis;
var setSessionNames = (next) => {
  held[NAMES] = next;
};
var getSessionNames = () => held[NAMES] ?? DEFAULT_SESSION_NAMES;
var namedKinds = () => {
  const { aliases, names } = getSessionNames();
  return new Map([
    ...Object.entries(names).map(([kind, name]) => [name, kind]),
    [`${names.dispatcher}-2`, "dispatcher"],
    ...Object.entries(aliases),
    ["optimizer", "optimizer"]
  ]);
};
var placedKindOfName = (name) => kindOfName(name) ?? namedKinds().get(name) ?? null;
function roleOfName(name) {
  const kind = placedKindOfName(name);
  return kind ? FACTORY_ROLE_OF_KIND[kind] : "";
}
var SEATLESS = new Set(["ended", "parked"]);

// scripts/hooks/role.ts
var MANAGER_ROLES = new Set(["dispatcher", "lead", "manager"]);
var names;
function loadNames(environment = process.env) {
  names ??= (async () => {
    try {
      const setting = join2(__CHECKOUT + "/scripts/hooks", "../../packages/scripts/src/playground/setting.ts");
      const read = Bun.spawn(["bun", setting, "sessions.names", "sessions.aliases"], {
        env: { ...process.env, ...environment },
        stderr: "ignore",
        stdout: "pipe"
      });
      const [names, aliases] = (await new Response(read.stdout).text()).trim().split(`
`);
      if (await read.exited === 0)
        setSessionNames({ aliases: JSON.parse(aliases), names: JSON.parse(names) });
    } catch {}
  })();
  return names;
}
async function registryName(sessionId, environment = process.env) {
  const dir = join2(environment.CLAUDE_CONFIG_DIR || join2(homedir2(), ".claude"), "sessions");
  for await (const file of new Bun.Glob("*.json").scan(dir)) {
    try {
      const entry = await Bun.file(join2(dir, file)).json();
      if (entry.sessionId === sessionId && typeof entry.name === "string")
        return entry.name;
    } catch {}
  }
}
async function codexName(sessionId, environment = process.env) {
  if (!environment.CODEX_HOME)
    return;
  let name;
  try {
    const index = await Bun.file(join2(environment.CODEX_HOME, "session_index.jsonl")).text();
    for (const line of index.split(`
`)) {
      try {
        const entry = JSON.parse(line);
        if (entry.id === sessionId && typeof entry.thread_name === "string")
          name = entry.thread_name;
      } catch {}
    }
  } catch {}
  return name;
}
async function rosterKind(name, environment = process.env) {
  const path = join2(dataDirOf(environment), "roster.json");
  try {
    const roster = await Bun.file(path).json();
    const kind = roster.agents?.find((agent) => agent?.name === name)?.kind;
    return isRosterKind(kind) ? kind : undefined;
  } catch {
    return;
  }
}
async function rosterRole(name, environment = process.env) {
  const kind = await rosterKind(name, environment);
  return kind ? FACTORY_ROLE_OF_KIND[kind] : "";
}
async function sessionRole(environment, sessionId) {
  if (environment.PLAYGROUND_ROLE)
    return environment.PLAYGROUND_ROLE;
  if (typeof sessionId !== "string")
    return "";
  try {
    const name = await registryName(sessionId, environment) ?? await codexName(sessionId, environment) ?? "";
    const role = name && await rosterRole(name, environment);
    if (role)
      return role;
    await loadNames(environment);
    return roleOfName(name);
  } catch {
    return "";
  }
}
async function fromFactory(raw, environment = process.env) {
  return await sessionRole(environment, sessionOf(raw)) !== "";
}
function sessionOf(raw) {
  try {
    return JSON.parse(raw).session_id;
  } catch {
    return;
  }
}

// scripts/hooks/shell.ts
import { AsyncLocalStorage } from "async_hooks";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir as homedir3 } from "os";
import { basename, dirname, isAbsolute as isAbsolute3, resolve as resolve3 } from "path";
var UNKNOWN = "\x00";
var READ = "\x01";
var MAX_BYTES = 1048576;
var MAX_SCRIPT = 131072;
var LARGE = "a text too large to read";
var deadlines = new AsyncLocalStorage;
function pastDeadline() {
  const deadline = deadlines.getStore();
  if (deadline !== undefined && performance.now() > deadline)
    throw new RangeError("past the hook's time");
}
var steps = 0;
function tick() {
  if (++steps % 1024 === 0)
    pastDeadline();
}
function lexScript(value, env) {
  if (deadlines.getStore() !== undefined && value.length > MAX_SCRIPT)
    throw new RangeError("a script too large to read");
  return lex(value, env.known);
}
function filled(script, mark, value) {
  const count = script.split(mark).length - 1;
  if (deadlines.getStore() !== undefined && script.length + count * value.length > MAX_SCRIPT)
    throw new RangeError("a script too large to read");
  return script.replaceAll(mark, value);
}
var held2 = (text) => text.value.length > MAX_BYTES ? unknown(LARGE) : text;
var BREAK = new Set([" ", "\t", `
`, ";", "&", "|", "<", ">", "(", ")"]);
var REDIRECT_OP = "(<<<|<<-|<<|<>|<&|>&!?|>>[!|]?|>[!|]|<|>)";
var REDIRECT = new RegExp(`^(\\d*|&)${REDIRECT_OP}`);
var RESERVED = new Set([
  "!",
  "{",
  "}",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "if",
  "then",
  "until",
  "while"
]);
var OPENS = new Set(["case", "coproc", "for", "if", "select", "until", "while", "{"]);
var CLOSES = new Set(["done", "esac", "fi", "}"]);
var HELD = new Set(["coproc", "function", "{"]);
var FREES = new Set([`
`, ";", ";;", "&", "||"]);
var tokens = 0;
var freshToken = () => ++tokens;
var BODIES = new Set(["do", "elif", "else", "then"]);
var REPEAT_BODY = new Set(["do", "{"]);
var MARKERS = new Set([...RESERVED, ...OPENS, ...CLOSES, ...BODIES]);
function markers(words) {
  const out = [];
  for (let k = 0;k < words.length; ) {
    const w = words[k];
    if (w.quoted)
      break;
    if (w.value === "function") {
      out.push("function");
      k += 2;
    } else if (MARKERS.has(w.value)) {
      out.push(w.value);
      k++;
    } else if (w.value === "repeat" && REPEAT_BODY.has(words[k + 2]?.value ?? "") && !words[k + 2].quoted) {
      k += 2;
    } else if (ASSIGN.test(w.value))
      k++;
    else
      break;
  }
  return out;
}
var ownFirst = (cmd, first) => !!first && first === cmd.words.find((w) => w.quoted || !RESERVED.has(w.value));
var onlyReserved = (cmd) => cmd.words.length > 0 && cmd.words.every((w) => !w.quoted && RESERVED.has(w.value));
var GROUPING = new Set(["}", "done", "esac", "fi"]);
var ASSIGN = /^[A-Za-z_]\w*=/;
var WRAPPERS = new Map(Object.entries({
  "-": ["", ""],
  builtin: ["", ""],
  busybox: ["", ""],
  caffeinate: ["-d -i -m -s -u", "-t -w"],
  chrt: [
    "-a -b -d -e -f -i -m -o -p -R -r -v --all-tasks --batch --deadline --ext --fifo --idle --max --other --pid --reset-on-fork --rr --verbose",
    "-D -P -T --sched-deadline --sched-period --sched-runtime"
  ],
  command: ["-p -V -v", ""],
  doas: ["-L -n -s", "-a -C -u"],
  env: ["-0 -i -v --debug --ignore-environment --null", "-P -S -u --unset"],
  exec: ["-c -l", "-a"],
  flock: [
    "-F -n -o -s -u -x --close --exclusive --fcntl --nb --no-fork --nonblocking --shared --unlock --verbose",
    "-E -w --conflict-exit-code --length --start --timeout --wait"
  ],
  ionice: ["-t --ignore", "-c -n -P -p -u --class --classdata --pgid --pid --uid"],
  nice: ["", "-n --adjustment"],
  nocorrect: ["", ""],
  noglob: ["", ""],
  nohup: ["", ""],
  pkexec: ["--disable-internal-agent --help --keep-cwd --version", "--user"],
  repeat: ["", ""],
  setsid: ["-c -f -w --ctty --fork --wait", ""],
  stdbuf: ["", "-e -i -o --error --input --output"],
  sudo: [
    "-A -B -b -E -e -H -i -K -k -l -N -n -P -S -s -V -v --askpass --background --bell --edit --help --list --login --non-interactive --preserve-env --preserve-groups --remove-timestamp --reset-timestamp --set-home --shell --stdin --validate --version",
    "-C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user"
  ],
  taskset: ["-a -c -p --all-tasks --cpu-list --pid", ""],
  time: [
    "-a -h -l -p -q -V -v --append --portability --quiet --verbose",
    "-f -o --format --output"
  ],
  timeout: ["-f -p -v --foreground --preserve-status --verbose", "-k -s --kill-after --signal"],
  xargs: [
    "-0 -o -p -r -t -x --exit --interactive --max-lines --no-run-if-empty --null --open-tty --show-limits --verbose",
    "-a -d -E -L -n -P -R -S -s --arg-file --delimiter --max-args --max-chars --max-procs --process-slot-var"
  ]
}).map(([name, [flags, values]]) => [
  name,
  { flags: new Set(flags.split(" ")), values: new Set(values.split(" ")) }
]));
var runner = (flags, values, more = {}) => ({
  flags: new Set(flags.split(" ")),
  folder: new Set(more.folder?.split(" ")),
  joined: more.always ?? new Set(more.joined?.split(" ")),
  script: new Set(more.script?.split(" ")),
  spec: !!more.spec,
  tools: !!more.tools,
  values: new Set(values.split(" "))
});
var NPM = runner("-y --dangerously-allow-all-scripts --include-workspace-root --no --strict-allow-scripts --workspaces --yes", "-c -w --allow-scripts --call --package --workspace", { script: "-c --call", spec: true });
var BUNX = runner("--bun --ignore-scripts --no-install --silent --trust --verbose", "-p --ca --cafile --cwd --env-file --minimum-release-age --package --registry", { folder: "--cwd", spec: true });
var PNPM_FLAGS = "-c -r -w -y --aggregate-output --color --fail-if-no-match --ignore-workspace --include-workspace-root --no-fail-if-no-match --no-include-workspace-root --no-progress --no-sort --parallel --recursive --reverse --shell-mode --sort --stream --use-stderr --workspace-root --yes";
var PNPM_VALUES = "-C -F --changed-files-ignore-pattern --dir --env-file --filter --filter-prod --http-proxy --https-proxy --loglevel --no-proxy --npmrc-auth-file --registry --reporter --state-dir --store-dir --test-pattern --userconfig --workspace-concurrency --workspace-packages";
var PNPM_DLX = runner(`${PNPM_FLAGS} -v --version`, `${PNPM_VALUES} --allow-build --cpu --libc --os --package`, { folder: "-C --dir", joined: "-c --shell-mode", spec: true });
var MISE = runner("--deny-all --deny-env --deny-net --deny-read --deny-unix --deny-write --fresh-env --no-deps --raw --secrets-all", "-c -j --allow-env --allow-net --allow-read --allow-unix --allow-write --command --jobs --secrets", { script: "-c --command", tools: true });
var BUN_FLAGS = "-b -i --bun --check --hot --if-present --no-clear-screen --no-exit-on-error --no-install --no-orphans --parallel --sequential --silent --smol --watch --workspaces";
var BUN_VALUES = "-e -F -p -r --cwd --elide-lines --env-file --eval --filter --import --preload --print --require --shell";
var DENO = runner("-A -q -r --allow-all --allow-env --allow-ffi --allow-import --allow-net --allow-read --allow-run --allow-scripts --allow-sys --allow-write --cached-only --check --coverage --deny-env --deny-ffi --deny-import --deny-net --deny-read --deny-run --deny-sys --deny-write --env-file --frozen --hmr --inspect --inspect-brk --inspect-wait --lock --no-check --no-clear-screen --no-code-cache --no-config --no-lock --no-npm --no-remote --node-modules-dir --quiet --reload --unsafely-ignore-certificate-errors --unstable --use-env-proxy --v8-flags --vendor --watch", "-c --cert --conditions --config --ext --import-map --location --min-dep-age --node-modules-linker --preload --require --seed --watch-exclude", { spec: true });
var RUNNERS = new Map([
  ["bun exec", runner(BUN_FLAGS, BUN_VALUES, { always: true, folder: "--cwd" })],
  ["bun run", runner(BUN_FLAGS, BUN_VALUES, { folder: "--cwd" })],
  ["bun x", BUNX],
  ["bunx", BUNX],
  ["corepack", runner("", "", { spec: true })],
  ["deno run", DENO],
  ["deno x", DENO],
  ["mise exec", MISE],
  ["mise x", MISE],
  ["npm exec", NPM],
  ["npm x", NPM],
  ["npx", NPM],
  ["pnpm dlx", PNPM_DLX],
  ["pnpm exec", runner(PNPM_FLAGS, PNPM_VALUES, { folder: "-C --dir", joined: "-c --shell-mode" })],
  ["pnpx", PNPM_DLX],
  ["volta run", runner("--bundled-npm --no-yarn --quiet --verbose", "--env --node --npm --yarn")],
  ["yarn dlx", runner("-q --quiet", "-p --package", { spec: true })],
  ["yarn exec", runner("", "", { always: true })]
]);
var MANAGERS = new Map([
  ["bun", "bun run"],
  ["deno", "deno run"],
  ["mise", "mise exec"],
  ["npm", "npm exec"],
  ["pnpm", "pnpm exec"],
  ["volta", "volta run"],
  ["yarn", "yarn dlx"]
]);
var SCOPES = new Map([
  ["yarn workspace", { names: 1, options: { flags: new Set, values: new Set } }],
  [
    "yarn workspaces foreach",
    {
      names: 0,
      options: {
        flags: new Set("-A -i -n -p -R -t -v -W --all --dry-run --interlaced --no-private --parallel --recursive --topological --topological-dev --verbose --worktree".split(" ")),
        values: new Set("-j --exclude --from --include --jobs".split(" "))
      }
    }
  ]
]);
var PNPM_COMMANDS = new Set("access add adduser approve approve-builds audit bin bugs c cache cat-file cat-index change ci clean clean-install completion config create dedupe deploy deprecate dislink dist-tag dist-tags dlx docs doctor edit env exec fetch find find-hash fund get help home i ic ignored-builds import info init install install-clean install-test issues it la lane licences licenses link list ll ln login logout ls m multi outdated owner owners pack pack-app patch patch-commit patch-remove peers permissions ping pipeline pkg prefix profile prune publish purge rb rebuild recursive remove repo restart rm root rt run run-script runtime s sbom se search self-update set set-script setup shim show ss stage star stars start stop store t tasks team test token tst un undeprecate uni uninstall unlink unpublish unstar up update upgrade v version view whoami why with xmas".split(" "));
function caseOpener(cmd) {
  const at = cmd.words.findIndex((w) => w.value === "case" && !w.quoted);
  const before = cmd.words.slice(0, Math.max(at, 0));
  const word = cmd.words[at + 2];
  return at !== -1 && (before.length === 0 || onlyReserved({ ...cmd, words: before })) && word?.value === "in" && !word.quoted;
}
function casePatterns(all, scoped = false) {
  const out = new Set;
  for (let k = 0;k < all.length; k++) {
    if (!caseOpener(all[k]) && all[k].follows !== ";;")
      continue;
    const commands = scoped ? all.slice(k).filter((c) => c.scope === all[k].scope) : all.slice(k);
    let end = 0;
    while (commands[end + 1]?.follows === "|")
      end++;
    const body = commands[end + 1];
    const run = commands.slice(0, end + 1);
    if (body?.follows !== ")" || run.some((c) => c.redirects.length > 0 || c.scope !== body.scope))
      continue;
    for (const c of run)
      out.add(c);
  }
  return out;
}
function optionValue(word, { flags, values }) {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    const name = eq === -1 ? word : word.slice(0, eq);
    if (values.has(name))
      return eq === -1 ? "next" : "own";
    return flags.has(name) ? "own" : undefined;
  }
  for (let k = 1;k < word.length; k++) {
    const option = `-${word[k]}`;
    if (values.has(option))
      return k === word.length - 1 ? "next" : "own";
    if (!flags.has(option))
      return;
  }
  return "own";
}
var ROOT_SHELLS = new Map([
  ["doas", new Set(["-s"])],
  ["pkexec", new Set],
  ["sudo", new Set(["--login", "--shell", "-i", "-s"])]
]);
var BARE_ROOT = new Set(["pkexec"]);
function stdinShell(cmd) {
  cmd = spreadSplit(cmd);
  const parsed = parse(cmd);
  const kinds = readings(parsed).map((reading) => stdinShellOf(cmd, reading));
  if (parsed.capped) {
    const names = cmd.words.map((w) => program(w.value));
    if (names.some((n) => ROOT_SHELLS.has(n) || n === "su"))
      kinds.push("root");
    else if (names.some((n) => SHELLS.has(n)))
      kinds.push("shell");
  }
  return kinds.includes("root") ? "root" : kinds.includes("shell") ? "shell" : kinds.find(Boolean);
}
function spreadSplit(cmd) {
  if (!cmd.words.some((w) => program(w.value) === "env"))
    return cmd;
  const options = WRAPPERS.get("env");
  const out = [];
  const rest = [...cmd.words].reverse();
  let inEnvOptions = false;
  let spreadOne = false;
  for (let w = rest.pop();w; w = rest.pop()) {
    const v = w.value;
    const long = inEnvOptions ? envLong(v) : undefined;
    const split = long?.name === "split-string" ? long.value ?? "" : long || !inEnvOptions ? undefined : SPLIT.exec(v)?.[1];
    if (split !== undefined) {
      const text = (split || rest.pop()?.value || "").replace(/\$\{[^}]*\}/g, UNKNOWN).replace(/\\[_fnrtv]/g, " ").replace(/['"\\]/g, "");
      const words = text.split(/\s+/).filter(Boolean);
      for (let j = words.length - 1;j >= 0; j--)
        rest.push({ quoted: false, value: words[j] });
      spreadOne = true;
      continue;
    }
    if (inEnvOptions && v === "-") {
      out.push({ ...w, value: "-i" });
      continue;
    }
    out.push(w);
    if (program(v) === "env")
      inEnvOptions = true;
    else if (!inEnvOptions || ASSIGN.test(v))
      continue;
    else if (!v.startsWith("-") || v === "--")
      inEnvOptions = false;
    else if (long ? ENV_LONG_VALUES.has(long.name) && long.value === undefined : ENV_SHORT_VALUE.test(v) || optionValue(v, options) === "next") {
      const value = rest.pop();
      if (value)
        out.push(value);
    }
  }
  return spreadOne ? { ...cmd, words: out } : cmd;
}
var ENV_LONG = [
  "argv0",
  "block-signal",
  "chdir",
  "debug",
  "default-signal",
  "help",
  "ignore-environment",
  "ignore-signal",
  "list-signal-handling",
  "null",
  "split-string",
  "unset",
  "version"
];
var ENV_LONG_VALUES = new Set(["argv0", "chdir", "split-string", "unset"]);
var ENV_SHORT_VALUE = /^-[0iv]*[aCu]$/;
function envLong(v) {
  const m = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(v);
  if (!m)
    return;
  const hits = ENV_LONG.filter((o) => o.startsWith(m[1]));
  const name = hits.includes(m[1]) ? m[1] : hits.length === 1 ? hits[0] : undefined;
  return name ? { name, value: m[2] } : undefined;
}
var SSH_FLAGS = "46AaCfGgKkMNnqsTtVvXxYy";
var SSH_VALUES = "BbcDEeFIiJLlmOoPpQRSWw";
var SSH_LOCAL = new Set(["knownhostscommand", "localcommand", "proxycommand"]);
function sshCall({ args, first }) {
  if (program(first?.value ?? "") !== "ssh")
    return;
  const call = { env: [], local: [], noStdin: false, remote: [], unread: false };
  let remoteCommand;
  const option = (word) => {
    const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)([\s\S]*)$/.exec(word.value);
    const key = m?.[1]?.toLowerCase() ?? "";
    if (marked(word.value.split(/[=\s]/)[0] ?? ""))
      call.local.push(word);
    else if (SSH_LOCAL.has(key))
      call.local.push({ ...word, value: m?.[2] ?? "" });
    else if (key === "remotecommand")
      remoteCommand = { ...word, value: m?.[2] ?? "" };
    else if (key === "sendenv" || key === "setenv")
      call.env.push({ ...word, value: m?.[2] ?? "" });
  };
  for (let k = 0;k < args.length; k++) {
    const { value } = args[k];
    if (value === "--" || !value.startsWith("-") || value === "-") {
      const at = value === "--" ? k + 1 : k;
      if (call.host || value === "--") {
        call.host ??= args[at];
        call.remote = args.slice(call.host === args[at] ? at + 1 : at);
        break;
      }
      call.host = args[k];
      call.unread ||= marked(value);
      continue;
    }
    for (let c = 1;c < value.length; c++) {
      if (value[c] === "n")
        call.noStdin = true;
      if (SSH_VALUES.includes(value[c])) {
        const attached = value.slice(c + 1);
        const given = attached ? { ...args[k], value: attached } : args[++k];
        if (value[c] === "o" && given)
          option(given);
        break;
      }
      if (!SSH_FLAGS.includes(value[c]))
        return { ...call, unread: true };
    }
  }
  if (call.remote.length === 0 && remoteCommand)
    call.remote = [remoteCommand];
  return call;
}
function sshStdin(cmd, call) {
  if (call.noStdin)
    return;
  if (call.unread || call.remote.length === 0)
    return "shell";
  const kinds = lex(call.remote.map((w) => w.value).join(" ")).commands.map((c) => stdinShell({ ...c, stdin: c.stdin ?? cmd }));
  return kinds.includes("root") ? "root" : kinds.includes("shell") ? "shell" : kinds.find(Boolean);
}
var DYNAMIC = /^(?:\.|bash|bun|busybox|dash|deno|env|eval|exec|expect|fish|g?awk|ksh|lua|mawk|mksh|node|perl|php|python[\d.]*|ruby|script|sh|source|su|sudo|tclsh|watch|zsh)$/;
function staticLine(line) {
  const joined = line.replace(/\\\n/g, "");
  if (marked(joined) || /[$`]/.test(joined))
    return false;
  const words = (cmds) => cmds.flatMap((c) => [...c.words, ...c.inner ? words(c.inner()) : []]);
  return !words(lex(joined).commands).some((w) => marked(w.value) || DYNAMIC.test(basename(w.value).toLowerCase()));
}
var GLOB_SWITCHES = [
  /\b(?:emulate|setopt|shopt|unsetopt)\b|\boptions\[/i,
  /bashopts|dotglob|fignore|globdot|globignore/i,
  /(?:[?[]|\*(?!\d))[^\s;&|()]*\([^()\s|]*\)/
];
var DIGIT_QUALIFIER = /\*\d[^\s;&|()]*\([^()\s|]*\)/;
var bareText = (text) => text.replace(/\\\n/g, "").replace(/['"\\_]/g, "");
var NO_GLOB = new Set([
  "errexit",
  "errtrace",
  "functrace",
  "login",
  "noclobber",
  "noprofile",
  "norc",
  "nounset",
  "pipefail",
  "verbose",
  "xtrace"
]);
var OPTION_REDIRECT = `(?:\\d*|&|\\{[A-Za-z_]\\w*\\})${REDIRECT_OP}`;
var SHELL_HEAD = new RegExp(`(?<=^|[\\s;&|(/])(r?(?:bash|ksh|zsh)|dash|ksh93|mksh|set|sh|yash)(?:-?[\\d.]*\\d)?(?=[\\s<>;&|)]|$)(?=((?:${OPTION_REDIRECT}|[^;&|\\n])*))`, "gi");
var LEADING_REDIRECT = new RegExp(`^${OPTION_REDIRECT}`);
function optionSwitch(bare) {
  for (const [, head, rest] of bare.matchAll(SHELL_HEAD)) {
    const words = rest.split(/\s+/).filter(Boolean);
    for (let i = 0;i < words.length; i++) {
      const word = words[i];
      const redirect = LEADING_REDIRECT.exec(word);
      if (redirect) {
        if (redirect[0] === word)
          i++;
        continue;
      }
      if (word === "--" || !/^[-+]/.test(word))
        break;
      const long = /^--([a-zA-Z][a-zA-Z0-9-]*)$/.exec(word);
      if (long) {
        if (!NO_GLOB.has(long[1].replace(/-/g, "").toLowerCase()))
          return `${head} ${word}`;
        continue;
      }
      if (!/^[-+][a-zA-Z0-9]+$/.test(word) || /[O4]/.test(word))
        return `${head} ${word}`;
      const o = word.indexOf("o");
      if (o >= 0) {
        const names = [word.slice(o + 1), words[i + 1] ?? ""].filter(Boolean);
        if (names.length === 0 || names.some((name) => !NO_GLOB.has(name.toLowerCase())))
          return `${head} ${word}${words[i + 1] ? ` ${words[i + 1]}` : ""}`;
        i++;
      }
    }
  }
}
function globSwitch(text) {
  const bare = bareText(text);
  for (const pattern of GLOB_SWITCHES) {
    const found = pattern.exec(bare);
    if (found)
      return found[0].trim();
  }
  return optionSwitch(bare);
}
function remoteEnv(env, line, fed = false, text = line) {
  const home = env.process.HOME || undefined;
  const { PWD: _pwd, ...known } = env.known;
  return {
    ...env,
    cwd: home,
    cwdAnywhere: undefined,
    cwdBack: [],
    cwdChain: undefined,
    cwdChainToken: undefined,
    cwdChainUnread: undefined,
    cwdHeld: [],
    cwdMaybe: [],
    cwdOr: undefined,
    cwdSure: home,
    cwdUnread: home === undefined,
    known: home && !/\b(?:cd|popd|pushd)\b/.test(line) ? { ...known, PWD: home } : known,
    old: { dir: home },
    oldFrom: undefined,
    remote: true,
    remoteDots: fed || !staticLine(line) || DIGIT_QUALIFIER.test(bareText(text)),
    remoteSwitch: env.remoteSwitch ?? globSwitch(text),
    vars: new Map
  };
}
function stdinShellOf(cmd, { args, first, name, xargs }) {
  const fed = !!cmd.stdin || !!xargs;
  if (first && !marked(first.value)) {
    if (name === "ssh") {
      const call = sshCall({ args, first });
      return call && (fed || stdinFed(cmd)) ? sshStdin(cmd, call) : undefined;
    }
    if (name === "." || name === "source" || name === "eval")
      return fed || name !== "eval" && STDIN_PATHS.has(args[0]?.value ?? "") ? "shell" : undefined;
    const family = familyOf(name);
    if (family)
      return fed && interpreted(family, args, xargs) ? "code" : undefined;
    if (name === "su")
      return suCommand(args) ? undefined : "root";
    if (!SHELLS.has(name) || noExec(args, name))
      return;
    if (fed)
      return "shell";
    const { inline, operand } = shellOperand(args, name);
    return inline || operand && !STDIN_PATHS.has(operand.value) ? undefined : "shell";
  }
  let at = 0;
  for (let w = cmd.words[at];w && !w.quoted; w = cmd.words[at]) {
    if (w.value === "function")
      at += 2;
    else if (RESERVED.has(w.value) || ASSIGN.test(w.value))
      at++;
    else
      break;
  }
  const end = first ? cmd.words.indexOf(first) : -1;
  const before = cmd.words.slice(at, end === -1 ? undefined : end);
  if (before.some((w, k) => !w.quoted && program(w.value) === "command" && /^-p?[vV]/.test(before[k + 1]?.value ?? "")))
    return;
  const firstWrapper = before.find((w) => !w.quoted && ROOT_SHELLS.has(program(w.value)));
  const wrappers = [];
  for (const w of before) {
    if (wrappers.some((wrapper) => startsRootShell(wrapper, w.value)))
      return "root";
    if (w === firstWrapper || ROOT_SHELLS.has(w.value.toLowerCase()))
      wrappers.push(program(w.value));
  }
  if (first && wrappers.length)
    return "root";
  if (!first && wrappers.some((wrapper) => BARE_ROOT.has(wrapper)))
    return "root";
  return fed && first ? "shell" : undefined;
}
var SU_PLAIN = new Set(["-", "-f", "-l", "-m"]);
var suCommand = (args) => {
  for (const [at, word] of args.entries()) {
    const { value } = word;
    if (word.unknown !== undefined || word.glob || marked(value))
      return false;
    if (value === "-c" || value === "--command")
      return at + 1 < args.length;
    if (value.startsWith("--command="))
      return true;
    if (value.startsWith("-") && !SU_PLAIN.has(value))
      return false;
  }
  return false;
};
function startsRootShell(wrapper, value) {
  if (marked(value))
    return true;
  const shells = ROOT_SHELLS.get(wrapper);
  const { flags, values } = WRAPPERS.get(wrapper);
  if (value.startsWith("--")) {
    const named = [...flags, ...values].filter((o) => o.startsWith(value));
    return shells.has(named.length === 1 ? named[0] : value);
  }
  if (!/^-[A-Za-z]/.test(value))
    return false;
  let shell = false;
  for (const c of value.slice(1)) {
    if (values.has(`-${c}`))
      return shell;
    if (!flags.has(`-${c}`))
      return false;
    shell ||= shells.has(`-${c}`);
  }
  return shell;
}
var FAMILIES = {
  bun: { takes: ["--cwd", "--env-file", "--preload", "--tsconfig-override"], values: "r" },
  deno: { takes: ["--config", "--import-map"], values: "c" },
  lua: { takes: [], values: "l" },
  node: {
    takes: [
      "--conditions",
      "--env-file",
      "--experimental-loader",
      "--import",
      "--input-type",
      "--inspect-port",
      "--loader",
      "--max-old-space-size",
      "--require",
      "--stack-size",
      "--title"
    ],
    values: "Cr"
  },
  osascript: { takes: [], values: "ls" },
  perl: { takes: [], values: "I" },
  php: { own: "f", takes: [], values: "cdf" },
  python: { own: "m", takes: ["--check-hash-based-pycs"], values: "WXm" },
  ruby: { takes: [], values: "CEIr" }
};
var FAMILY = /^(bun|deno|lua|luajit|node|nodejs|osascript|perl|php|python|ruby)[\d.]*$/;
var familyOf = (name) => {
  const base = FAMILY.exec(name)?.[1];
  return base ? FAMILIES[base === "nodejs" ? "node" : base === "luajit" ? "lua" : base] : undefined;
};
function interpreted(family, args, xargs) {
  const filled = (word) => marked(word.value) || !!xargs?.replace && word.value.includes(xargs.replace);
  const own = (word) => !!word && !filled(word) && !STDIN_PATHS.has(word.value);
  const runner = family === FAMILIES.bun || family === FAMILIES.deno;
  const script = (word) => own(word) && (!runner || /\.[cm]?[jt]sx?$/.test(word?.value ?? ""));
  let sub = false;
  for (let k = 0;k < args.length; k++) {
    const { value } = args[k];
    if (value === "--")
      return !script(args[k + 1]);
    if (value.startsWith("--")) {
      if (!family.takes.includes(value.split("=")[0]))
        return true;
      if (!value.includes("="))
        k++;
      continue;
    }
    if (value.startsWith("-") && value !== "-") {
      const [letter, attached] = [value[1], value.slice(2)];
      if (!family.values.includes(letter))
        return true;
      if (letter === family.own)
        return !own(attached ? { ...args[k], value: attached } : args[k + 1]);
      if (!attached)
        k++;
      continue;
    }
    if (runner && !sub && value === "run") {
      sub = true;
      continue;
    }
    return !script(args[k]);
  }
  return true;
}
function codeFed(commands) {
  const fed = new Map;
  const add = (cmd, kind) => {
    if (!kind || !cmd.stdin)
      return;
    const known = fed.get(cmd.stdin);
    if (known?.kind !== "code")
      fed.set(cmd.stdin, { consumer: cmd, kind });
  };
  for (const [k, cmd] of commands.entries()) {
    if (!cmd.stdin)
      continue;
    add(cmd, stdinShell(cmd));
    let depth = 0;
    for (let j = k;j < commands.length; j++) {
      const body = commands[j];
      for (const m of markers(body.words))
        depth += OPENS.has(m) ? 1 : CLOSES.has(m) ? -1 : 0;
      if (j > k)
        add(cmd, stdinShell({ ...body, stdin: cmd.stdin }));
      if (depth <= 0)
        break;
    }
  }
  return fed;
}
function feedBodies(commands) {
  for (let k = commands.length - 1;k >= 0; k--) {
    const close = commands[k];
    const inputs = close.redirects.filter((r) => r.op.startsWith("<") || dupOnto0(r));
    if (inputs.length === 0)
      continue;
    const region = CLOSES.has(markers(close.words)[0] ?? "") ? bodyOf(commands, k) : undefined;
    const body = close.inner ? close.inner() : region ?? [];
    const ownPipe = (cmd) => !!cmd.stdin && (region ? region.includes(cmd.stdin) : cmd.stdin.scope > close.scope);
    const fed = inputs.map((r) => ({ ...r, bodyFed: r.bodyFed ?? r }));
    const origins = new Set(fed.map((r) => r.bodyFed));
    for (const cmd of body) {
      if (cmd === close)
        continue;
      const own = cmd.redirects.filter((r) => !r.bodyFed || !origins.has(r.bodyFed));
      cmd.redirects.splice(0, cmd.redirects.length, ...ownPipe(cmd) ? fed.filter((r) => fdOf(r) !== "0") : fed, ...own);
    }
  }
}
function bodyOf(commands, k) {
  let depth = 0;
  for (let j = k;j >= 0; j--) {
    for (const m of markers(commands[j].words))
      depth += CLOSES.has(m) ? 1 : OPENS.has(m) ? -1 : 0;
    if (depth <= 0)
      return commands.slice(j, k + 1);
  }
  return [];
}
var COUNTED = new Set(["flock", "repeat", "taskset", "timeout"]);
var REPEATS = new Set(["repeat", "timeout"]);
var SHELLS = new Set(["bash", "csh", "dash", "fish", "ksh", "sh", "tcsh", "zsh"]);
var QUOTED_ONE_WORD = /^(?:\$(?:[A-Za-z_]\w*|\d|\{(?:[A-Za-z_]\w*|\d+)(?::?[-+=?][^}@]*|(?:[#%]{1,2}|\/{1,2})[^}]*)?\}|\([\s\S]*\))|`[\s\S]*`)$/;
var STDIN_PATHS = new Set(["-", "/dev/fd/0", "/dev/stdin", "/proc/self/fd/0"]);
var EXPORTS = new Set(["declare", "export", "local", "readonly", "typeset"]);
var PRINTERS = new Set(["echo", "printf"]);
var GIT_TAKES = new Set([
  "-C",
  "-c",
  "--attr-source",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree"
]);
var API_FIELDS = new Set(["-F", "--field", "-f", "--raw-field"]);
var API_TAKES = new Set([
  ...API_FIELDS,
  "--cache",
  "-H",
  "--header",
  "--hostname",
  "--input",
  "-p",
  "--preview",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-X",
  "--method"
]);
var CURL_DATA = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-F",
  "--form",
  "--form-string",
  "--json",
  "-T",
  "--upload-file"
]);
var CURL_TAKES = new Set([
  ...CURL_DATA,
  "-A",
  "--user-agent",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "--cacert",
  "-D",
  "--dump-header",
  "-e",
  "--referer",
  "-H",
  "--header",
  "-K",
  "--config",
  "-m",
  "--max-time",
  "-o",
  "--output",
  "-u",
  "--user",
  "--url",
  "-w",
  "--write-out",
  "-X",
  "--request",
  "-x",
  "--proxy"
]);
var ESCAPES = {
  '"': '"',
  "'": "'",
  "?": "?",
  "\\": "\\",
  a: "\x07",
  b: "\b",
  E: "\x1B",
  e: "\x1B",
  f: "\f",
  n: `
`,
  r: "\r",
  t: "\t",
  v: "\v"
};
var unknown = (why) => ({ unknown: why, value: UNKNOWN });
var setLog = new WeakMap;
var setVar = (vars, key, value) => {
  vars.set(key, value);
  const log = setLog.get(vars);
  if (log)
    log.push(key);
  else
    setLog.set(vars, [key]);
};
var merge = (out, part) => {
  out.value += part.value;
  if (part.splits)
    out.splits = true;
  if (part.unknown)
    out.unknown ??= part.unknown;
  if (part.variable)
    out.variable ??= part.variable;
  if (part.reads?.length)
    (out.reads ??= []).push(...part.reads);
};
var join3 = (parts, separator = "") => {
  const out = { value: "" };
  parts.forEach((part, k) => {
    if (k > 0)
      out.value += separator;
    merge(out, part);
  });
  return out;
};
var slice = (word, from) => {
  const dropped = word.value.slice(0, from).split(READ).length - 1;
  return { ...word, reads: word.reads?.slice(dropped), value: word.value.slice(from) };
};
var visible = (value) => value.replaceAll(UNKNOWN, " ").replaceAll(READ, " ");
var marked = (value) => value.includes(UNKNOWN) || value.includes(READ);
var PLAIN = /^[\w./=,:@%-]$/;
var unreadWord = (word) => {
  if (word.unknown !== undefined || marked(word.value))
    return true;
  const src = word.source;
  if (src === undefined)
    return ![...word.value].every((c) => PLAIN.test(c));
  for (let i = 0;i < src.length; i++) {
    const c = src[i];
    if (c === "\\")
      i++;
    else if (c === "'") {
      i = src.indexOf("'", i + 1);
      if (i === -1)
        return true;
    } else if (c === '"') {
      for (i++;i < src.length && src[i] !== '"'; i++)
        if (src[i] === "\\")
          i++;
        else if (src[i] === "$" && src[i + 1] === "(")
          i = balanced(src, i + 1, "(", ")") - 1;
        else if (src[i] === "`")
          i = src.indexOf("`", i + 1);
      if (i === -1 || i >= src.length)
        return true;
    } else if (!PLAIN.test(c))
      return true;
  }
  return false;
};
var SHELL_OWN = new Set([
  ".",
  "alias",
  "cd",
  "declare",
  "eval",
  "export",
  "hash",
  "let",
  "local",
  "popd",
  "pushd",
  "read",
  "readonly",
  "set",
  "shift",
  "source",
  "trap",
  "type",
  "typeset",
  "unalias",
  "unset"
]);
var G_WRAPPERS = new Map([
  ["genv", "env"],
  ["gnice", "nice"],
  ["gnohup", "nohup"],
  ["gstdbuf", "stdbuf"],
  ["gtimeout", "timeout"]
]);
var program = (value) => {
  const base = basename(value.replace(/^=/, ""));
  const lower = base.toLowerCase();
  if (SHELL_OWN.has(lower) && value !== lower)
    return value;
  return G_WRAPPERS.get(lower) ?? lower;
};
var UV_TAKES = new Set([
  "--cache-dir",
  "--config-file",
  "--directory",
  "--env-file",
  "--extra",
  "--extra-index-url",
  "--from",
  "--group",
  "--index",
  "--index-url",
  "--package",
  "--project",
  "-p",
  "--python",
  "--with",
  "--with-editable",
  "--with-requirements"
]);
function decode(raw) {
  return raw.replace(/\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|0?([0-7]{1,3})|([\s\S]))/g, (whole, hex, u4, u8, octal, other) => {
    tick();
    const point = hex || u4 || u8 ? Number.parseInt(hex ?? u4 ?? u8 ?? "", 16) : Number.parseInt(octal ?? "", 8);
    if (!Number.isNaN(point))
      return point <= 1114111 ? String.fromCodePoint(point) : whole;
    return ESCAPES[other ?? ""] ?? whole;
  });
}
function lex(src, known = {}) {
  const lx = { commands: [], i: 0, known, scope: 0, scopes: [-1], src, token: freshToken() };
  list(lx, 0, false);
  calledAgain(lx.commands, src);
  if (lx.commands.some((c) => c.words.some((w) => /^chpwd/.test(w.value))))
    for (const c of lx.commands)
      c.cdRedefined = true;
  braced(lx.commands);
  for (const c of casePatterns(lx.commands, true))
    c.casePattern = true;
  return { commands: lx.commands, scopes: lx.scopes };
}
var BRACED = new Set([
  "elif",
  "else",
  "for",
  "foreach",
  "if",
  "repeat",
  "select",
  "until",
  "while"
]);
function braced(commands) {
  for (const [k, c] of commands.entries()) {
    const head = c.words[0];
    if (!head || head.quoted || !BRACED.has(head.value))
      continue;
    const at = c.words.findIndex((w, i) => i > 0 && !w.quoted && w.value === "{");
    if (at < 0 || markers(c.words).length > at)
      continue;
    if (commands.slice(k + 1).some((d) => d.words.some((w) => !w.quoted && w.value === "}")))
      c.opaque = true;
  }
}
function calledAgain(commands, src) {
  for (const [k, open] of commands.entries()) {
    const [first, second] = open.words;
    if (!open.held || !first || first.quoted)
      continue;
    const before = commands[k - 1]?.words;
    const word = first.value === "function" ? second : open.group && before?.length === 1 ? before[0] : undefined;
    if (!word)
      continue;
    let end = k;
    for (let balance = 0;end < commands.length; end++) {
      const reserved = markers(commands[end].words);
      balance += reserved.filter((w) => OPENS.has(w)).length - reserved.filter((w) => CLOSES.has(w)).length;
      if (balance <= 0)
        break;
    }
    const body = commands.slice(k, end + 1);
    const name = word.value.replace(/\(\)$/, "");
    if (name === "cd" || name === "chpwd")
      for (const c of commands)
        c.cdRedefined = true;
    if (word.quoted || !/^[\w.:-]+$/.test(name)) {
      for (const c of body)
        c.repeated = true;
      continue;
    }
    const outside = commands.filter((_, at) => at < k - 1 || at > end).map(callee);
    const calls = outside.filter((w) => w?.value === name);
    const others = outside.some((w) => w !== undefined && (w.unknown !== undefined || !w.quoted && (w.value === "eval" || w.value === "source" || w.value === ".")));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const files = commands.flatMap((c) => c.redirects).filter((r) => r.target?.value === name).length;
    const mentions = (src.match(new RegExp(`(?<![\\w.:-])${escaped}(?![\\w.:-])`, "g"))?.length ?? 0) - files;
    const call = commands.find((c, at) => (at < k - 1 || at > end) && callee(c)?.value === name);
    const once = mentions === 2 && calls.length === 1 && !others && !call?.repeated && !call?.kept;
    if (!once)
      for (const c of body)
        c.repeated = true;
  }
}
function callee(cmd) {
  return cmd.words.find((w) => w.quoted || !(ASSIGN.test(w.value) || MARKERS.has(w.value) || BUILTIN.has(w.value) || w.value.startsWith("-")));
}
function nest(lx, inherit) {
  list(lx, lx.scopes.push(lx.scope) - 1, true, inherit);
}
function list(lx, scope, nested, inherit) {
  const outer = lx.scope;
  lx.scope = scope;
  try {
    walk(lx, scope, nested, inherit);
  } finally {
    lx.scope = outer;
  }
}
function walk(lx, scope, nested, inherit) {
  const { src } = lx;
  const pending = [];
  const fedOpens = [];
  const fresh = () => {
    const braceFed = fedOpens.at(-1);
    return { ...braceFed && { braceFed }, redirects: [], scope, stdin: inherit, words: [] };
  };
  let cmd = fresh();
  const twins = new Map;
  const past = (from) => {
    const twin = twins.get(cmd);
    return twin && from >= twin.from ? twin : undefined;
  };
  const opens = [];
  let depth = 0;
  let loops = 0;
  const counted = [];
  let after = "";
  const bodies = [];
  const heads = [];
  const end = (op) => {
    const done = cmd;
    const twin = twins.get(done);
    const pipe = op === "|" || op === "|&";
    const brace = (c, value) => c.words[0]?.value === value && !c.words[0].quoted;
    if (brace(done, "}")) {
      const open = opens.pop();
      fedOpens.pop();
      if (open !== undefined) {
        const { commands } = lx;
        const close = commands.length;
        done.inner = () => topLevel(commands.slice(open, close), scope);
      }
    }
    if (pipe || op === "&")
      done.detached = true;
    if (done.words.length > 0 || done.redirects.length > 0 || done.group) {
      const reserved = markers(done.words);
      const opened = reserved.filter((w) => OPENS.has(w)).length;
      const closed = reserved.filter((w) => CLOSES.has(w)).length;
      const body = reserved.some((w) => HELD.has(w) || BODIES.has(w));
      const loop = reserved.includes("do");
      if (after === "||" || depth > 0 || body)
        done.unsure = true;
      if (after === "&&")
        done.chained = true;
      done.chain = lx.token;
      if (lx.orRun)
        done.orRun = true;
      const last = lx.commands[lx.commands.length - 1]?.words;
      const compound = !!done.group && last?.length === 1 && OPENS.has(reserved[0] ?? "") && !HELD.has(reserved[0] ?? "");
      if (reserved.some((w) => HELD.has(w)) || compound)
        done.held = true;
      if (done.held || bodies.includes(true))
        done.kept = true;
      for (const [at, w] of reserved.entries()) {
        if (OPENS.has(w))
          bodies.push(HELD.has(w) || compound && at === 0);
        else if (CLOSES.has(w))
          bodies.pop();
      }
      const each = done.words[0]?.quoted ? undefined : done.words[0]?.value;
      const outer = heads.length === 0 && loops === 0;
      let head = heads.length > 0;
      for (const w of reserved) {
        if (w === "while" || w === "until" || w === "for" || w === "select")
          heads.push(w === "while" || w === "until");
        else if (w === "do")
          heads.pop();
        head ||= heads.length > 0;
      }
      if (each === "foreach")
        heads.push(false);
      else if (each === "end" && heads.length > 0 && !loop)
        heads.pop();
      const counting = each === "repeat" && reserved.includes("{");
      if (loops > 0 || loop || head || each === "foreach" || counting)
        done.repeated = true;
      if (outer && !loop && reserved.some((w) => w === "while" || w === "until"))
        done.atLeastOnce = true;
      depth = Math.max(0, depth + opened - closed);
      loops = Math.max(0, loops + (loop ? 1 : 0) - (reserved.includes("done") ? 1 : 0));
      if (counting) {
        counted.push(depth);
        loops++;
      }
      while (counted.length > 0 && depth < counted[counted.length - 1]) {
        counted.pop();
        loops = Math.max(0, loops - 1);
      }
      if (depth === 0 && FREES.has(op)) {
        lx.token = freshToken();
        lx.orRun = op === "||";
      }
      after = op;
      if (counting) {
        opens.push(lx.commands.length);
        fedOpens.push(fedOpens.at(-1));
      }
      for (const w of done.words) {
        if (w.value !== "{" || w.quoted)
          break;
        opens.push(lx.commands.length);
        fedOpens.push(done.stdin ?? done.braceFed);
      }
      const called = done.words.find((w) => w.value !== "{" || w.quoted);
      if (fedOpens.length > 0 && called?.value === "exec" && !called.quoted && done.redirects.length > 0)
        fedOpens[fedOpens.length - 1] = undefined;
      lx.commands.push(done);
      if (twin && lx.i >= twin.from) {
        const { of, redirects, words } = twin;
        of.glob = { detached: of.detached || done.detached, redirects, words };
      }
    }
    cmd = fresh();
    if (twin && lx.i < twin.from)
      twins.set(cmd, twin);
    cmd.follows = op;
    if (pipe) {
      cmd.stdin = done;
      cmd.detached = true;
    }
  };
  while (lx.i < src.length) {
    tick();
    const c = src[lx.i];
    const redirect = REDIRECT.exec(src.slice(lx.i, lx.i + 8));
    if (c === " " || c === "\t")
      lx.i++;
    else if (c === "\\" && src[lx.i + 1] === `
`)
      lx.i += 2;
    else if (c === `
`) {
      lx.i++;
      heredocs(lx, pending, nested);
      end(";");
    } else if (c === "#") {
      while (lx.i < src.length && src[lx.i] !== `
`)
        lx.i++;
    } else if (c === ")") {
      lx.i++;
      end(")");
      if (nested)
        return;
    } else if (c === "(") {
      const twin = globOpens(cmd, src, lx.i) ? globTwin(lx, cmd) : undefined;
      lx.i++;
      const piped = cmd.words.length === 0 && cmd.redirects.length === 0 ? cmd.stdin : undefined;
      end(";");
      const from = lx.commands.length;
      const scope = lx.scopes.length;
      nest(lx, piped);
      cmd.group = true;
      const members = topLevel(lx.commands.slice(from), scope);
      cmd.inner = () => members;
      if (twin)
        twins.set(cmd, twin);
    } else if ((c === "<" || c === ">" || c === "=") && src[lx.i + 1] === "(") {
      const from = lx.i;
      cmd.words.push(procSub(lx));
      past(from)?.words.push(cmd.words[cmd.words.length - 1]);
    } else if (redirect) {
      const from = lx.i;
      lx.i += redirect[0].length;
      while (src[lx.i] === " " || src[lx.i] === "\t")
        lx.i++;
      const [, fd] = redirect;
      const op = redirect[2].replace(/!$/, "|").replace(/^(>[>&])\|$/, "$1");
      const target = src.startsWith("<(", lx.i) || src.startsWith("=(", lx.i) ? procSub(lx) : word(lx);
      const entry = { fd, op, target };
      if (op === "<<" || op === "<<-") {
        pending.push({
          delim: target.value,
          quoted: target.quoted,
          redirect: entry,
          strip: op === "<<-"
        });
      } else if (op === "<<<")
        entry.body = { ...target, value: `${target.value}
` };
      cmd.redirects.push(entry);
      past(from)?.redirects.push(entry);
    } else if (c === ";" || c === "&" || c === "|") {
      const two = src.slice(lx.i, lx.i + 2);
      const op = ["&&", ";;", "|&", "||"].includes(two) ? two : c;
      lx.i += op.length;
      end(op);
    } else {
      const from = lx.i;
      cmd.words.push(word(lx));
      if (lx.i === from)
        lx.i++;
      else
        past(from)?.words.push(cmd.words[cmd.words.length - 1]);
    }
  }
  heredocs(lx, pending, nested);
  end(";");
}
function topLevel(cmds, scope) {
  const fed = new Set(cmds.map((c) => c.stdin));
  return cmds.filter((c) => !fed.has(c) && c.scope === scope);
}
function procSub(lx) {
  lx.i += 2;
  const from = lx.commands.length;
  const scope = lx.scopes.length;
  nest(lx);
  return {
    procs: topLevel(lx.commands.slice(from), scope),
    quoted: false,
    ...unknown("a process substitution")
  };
}
function heredocs(lx, pending, nested) {
  for (const doc of pending.splice(0)) {
    const lines = [];
    while (lx.i < lx.src.length) {
      tick();
      const start = lx.i;
      const newline = lx.src.indexOf(`
`, start);
      const stop = newline === -1 ? lx.src.length : newline;
      const raw = lx.src.slice(start, stop);
      const line = doc.strip ? raw.replace(/^\t+/, "") : raw;
      lx.i = stop + 1;
      if (line === doc.delim)
        break;
      if (nested && line.startsWith(`${doc.delim})`)) {
        lx.i = start + raw.length - line.length + doc.delim.length;
        break;
      }
      lines.push(line);
    }
    const body = lines.map((line) => `${line}
`).join("");
    doc.redirect.body = doc.quoted ? { value: body } : expandHeredoc(body);
    if (!doc.quoted)
      textCommands(lx, body);
  }
}
function textCommands(lx, text) {
  const sub = { ...lx, i: 0, src: text };
  while (sub.i < text.length) {
    tick();
    const c = text[sub.i];
    if (c === "\\")
      sub.i += 2;
    else if (c === "$")
      dollar(sub, true);
    else if (c === "`")
      backtick(sub);
    else
      sub.i++;
  }
}
function expandHeredoc(body) {
  const joined = body.replaceAll("\\\n", "");
  const value = joined.replace(/\\([\\$`])/g, "$1");
  return /\$[\w{(@*#?!$-]|`/.test(joined.replace(/\\[\\$`]/g, "")) ? { unknown: "an expansion in an unquoted heredoc", value } : { value };
}
function globOpens(cmd, src, at) {
  const program = cmd.words.findIndex((w) => w.quoted || !MARKERS.has(w.value));
  if (program < 0)
    return false;
  const lead = cmd.words.slice(program);
  const next = { quoted: false, value: "(" };
  let words = [...cmd.words, next];
  let { first } = parse({ ...cmd, words });
  while (first && first !== next && words.includes(first) && maySkip(first)) {
    const dropped = first;
    words = words.filter((w) => w !== dropped);
    ({ first } = parse({ ...cmd, words }));
  }
  const close = balanced(src, at, "(", ")", false, true);
  const group = src.slice(at, close);
  return first === next && src[at + 1] !== ")" && !group.includes("/") && plainAlternative(group, close < src.length && !/[\s;&|<>)]/.test(src[close])) && !subshellPrefix(lead) && !HEADERS2.has(cmd.words[0]?.value ?? "");
}
function plainAlternative(group, glued) {
  let depth = 0;
  let plain = true;
  let empty = true;
  for (let i = 1;i < group.length - 1; i++) {
    const c = group[i];
    if (c === "|" && depth === 0) {
      if (plain && (glued || !empty))
        return true;
      plain = true;
      empty = true;
      continue;
    }
    empty = false;
    if (c === "\\")
      i++;
    else if (c === "'") {
      const end = group.indexOf("'", i + 1);
      i = end === -1 ? group.length : end;
    } else if (c === '"') {
      i++;
      while (i < group.length && group[i] !== '"')
        i += group[i] === "\\" ? 2 : 1;
    } else if (c === "(")
      depth++;
    else if (c === ")")
      depth--;
    else if (/[\s;&]/.test(c))
      plain = false;
  }
  return plain && (glued || !empty);
}
function subshellPrefix(lead) {
  let at = 0;
  while (at < lead.length && !lead[at].quoted)
    if (lead[at].value === "time" && lead[at - 1]?.value === "time")
      break;
    else if (lead[at].value === "time" || lead[at].value === "nocorrect")
      at++;
    else if (lead[at].value === "repeat" && at + 1 < lead.length)
      at += 2;
    else
      break;
  return at > 0 && at === lead.length;
}
var maySkip = (w) => !!w.source && /^\u0000+$/.test(w.value) && (/^\u0000+$/.test(w.source) || vanishingParts(w.source));
var HEADERS2 = new Set(["case", "for", "foreach", "function", "select"]);
function globTwin(lx, of) {
  const copy = { ...lx, commands: [], scopes: [...lx.scopes] };
  const glob = word(copy, true);
  const program = of.words.findIndex((w) => w.quoted || !MARKERS.has(w.value));
  return {
    from: copy.i,
    of,
    redirects: [...of.redirects],
    words: [...of.words.slice(program), glob]
  };
}
function word(lx, opening = false) {
  const { src } = lx;
  const start = lx.i;
  const out = { quoted: false, value: "" };
  let bare = "";
  while (lx.i < src.length && (!BREAK.has(src[lx.i]) || src[lx.i] === "(" && (lx.i > start || opening) && src[lx.i + 1] !== ")")) {
    tick();
    const c = src[lx.i];
    const next = src[lx.i + 1] ?? "";
    if (c === "(" && /^(?:[A-Za-z_]\w*(?:\[[^\]]*\])?|\[[^\]]*\])\+?==$/.test(src.slice(start, lx.i))) {
      out.value = out.value.slice(0, -1);
      bare = bare.slice(0, -1);
      lx.i--;
      merge(out, procSub(lx));
    } else if (c === "(") {
      const end = balanced(src, lx.i, "(", ")", false, opening);
      out.value += src.slice(lx.i, end);
      bare += src.slice(lx.i, end);
      inner(lx, src.slice(lx.i + 1, end - 1));
      lx.i = end;
    } else if (c === "\\") {
      out.quoted = true;
      if (next !== `
`)
        out.value += next;
      lx.i += 2;
    } else if (c === "'") {
      out.quoted = true;
      const close = src.indexOf("'", lx.i + 1);
      const stop = close === -1 ? src.length : close;
      out.value += src.slice(lx.i + 1, stop);
      lx.i = stop + 1;
    } else if (c === '"') {
      out.quoted = true;
      lx.i++;
      merge(out, double(lx));
    } else if (c === "$" && next === "'") {
      out.quoted = true;
      merge(out, ansi(lx));
    } else if (c === "$" && next === '"')
      lx.i++;
    else if (c === "$" || c === "`") {
      const text = c === "$" ? dollar(lx) : backtick(lx);
      merge(out, text);
      if (GLOB_CHARS.test(text.value))
        out.glob = true;
      if (marked(text.value))
        out.splits = true;
    } else if (c === "~" && lx.i === start && ends(next)) {
      out.value += homedir3();
      lx.i++;
    } else {
      if (c === UNKNOWN || c === READ)
        out.splits = true;
      out.value += c;
      bare += c;
      lx.i++;
    }
  }
  if (BRACE_LIST.test(bare))
    out.unknown ??= BRACE;
  if (GLOB_CHARS.test(bare))
    out.glob = true;
  out.source = src.slice(start, lx.i);
  if (marked(out.value))
    out.raw = out.source;
  if (src[start] === "~" && TILDE.test(out.value))
    out.tilde = true;
  return out;
}
var GLOB_CHARS = /[*?[{(]/;
var BRACE_LIST = /\{(?=[^{}]*\})[^{}]*(?:,|\.\.)/;
var BRACE = "a brace expansion";
var TILDE = /^~[-+](?=\/|$|\u0000)/;
var ends = (c = "") => c === "" || c === "/" || BREAK.has(c);
function double(lx) {
  const { src } = lx;
  const out = { value: "" };
  while (lx.i < src.length && src[lx.i] !== '"') {
    const c = src[lx.i];
    const next = src[lx.i + 1] ?? "";
    if (c === "\\") {
      if (next !== `
`)
        out.value += '$`"\\'.includes(next) ? next : c + next;
      lx.i += 2;
    } else if (c === "$" || c === "`") {
      const from = lx.i;
      const text = c === "$" ? dollar(lx, true) : backtick(lx);
      merge(out, text);
      if (marked(text.value) && !QUOTED_ONE_WORD.test(src.slice(from, lx.i)))
        out.splits = true;
    } else {
      out.value += c;
      lx.i++;
    }
  }
  lx.i++;
  return out;
}
function ansi(lx) {
  const { src } = lx;
  let i = lx.i + 2;
  while (i < src.length && src[i] !== "'")
    i += src[i] === "\\" ? 2 : 1;
  const raw = src.slice(lx.i + 2, Math.min(i, src.length));
  lx.i = i + 1;
  return { value: decode(raw) };
}
function dollar(lx, plain = false) {
  tick();
  const { src } = lx;
  const readText = plain ? textCommands : inner;
  const next = src[lx.i + 1] ?? "";
  const variable = (name) => name !== undefined && lx.known[name] !== undefined ? { value: lx.known[name], variable: name } : { ...unknown("a shell variable"), variable: name };
  if (src.startsWith("$((", lx.i)) {
    const end = balanced(src, lx.i + 1, "(", ")", plain);
    readText(lx, src.slice(lx.i + 3, end - 2));
    lx.i = end;
    return unknown("an arithmetic expansion");
  }
  if (next === "(") {
    lx.i += 2;
    const from = lx.commands.length;
    nest(lx);
    return substituted(lx.commands.slice(from), lx.known);
  }
  if (next === "{") {
    const end = balanced(src, lx.i + 1, "{", "}", plain);
    const name = /^\$\{([A-Za-z_]\w*)(?::?\?[^}]*)?\}$/.exec(src.slice(lx.i, end))?.[1];
    readText(lx, src.slice(lx.i + 2, end - 1));
    lx.i = end;
    return variable(name);
  }
  const flagged = /[=~^]/.test(next) && /[A-Za-z_]/.test(src[lx.i + 2] ?? "");
  if (flagged || /[A-Za-z_]/.test(next)) {
    lx.i += flagged ? 2 : 1;
    const from = lx.i;
    while (/\w/.test(src[lx.i] ?? ""))
      lx.i++;
    if (/^:[A-Za-z&]/.test(src.slice(lx.i, lx.i + 2)))
      return unknown("a zsh modifier");
    return variable(src.slice(from, lx.i));
  }
  if (next === "$") {
    lx.i += 2;
    return { value: "99999" };
  }
  if (/[\d@*#?$!-]/.test(next)) {
    lx.i += 2;
    return unknown("a shell variable");
  }
  lx.i++;
  return { value: "$" };
}
function inner(lx, src) {
  const sub = { ...lx, i: 0, src };
  while (sub.i < src.length) {
    tick();
    const from = sub.i;
    if ((src[sub.i] === "<" || src[sub.i] === ">" || src[sub.i] === "=") && src[sub.i + 1] === "(")
      procSub(sub);
    else
      word(sub);
    if (sub.i === from)
      sub.i++;
  }
}
function balanced(src, from, open, close, plain = false, doubles = false) {
  let depth = 0;
  for (let i = from;i < src.length; i++) {
    tick();
    const c = src[i];
    if (c === "\\")
      i++;
    else if (c === "'" && !plain) {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end;
    } else if (c === '"' && doubles) {
      i++;
      while (i < src.length && src[i] !== '"')
        i += src[i] === "\\" ? 2 : 1;
    } else if (c === open)
      depth++;
    else if (c === close && --depth === 0)
      return i + 1;
  }
  return src.length;
}
function backtick(lx) {
  const { src } = lx;
  let i = lx.i + 1;
  let inner = "";
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\" && i + 1 < src.length) {
      inner += "$`\\".includes(src[i + 1]) ? src[i + 1] : src[i] + src[i + 1];
      i += 2;
    } else
      inner += src[i++];
  }
  lx.i = i + 1;
  list({ ...lx, i: 0, src: inner }, lx.scopes.push(lx.scope) - 1, false);
  return unknown("a command substitution");
}
var echoes = false;
function substituted(inner, known) {
  const [only] = inner;
  if (inner.length !== 1 || only.stdin || only.group)
    return unknown("a command substitution");
  const made = mktempPath(only, known);
  if (made)
    return { value: made };
  const [first, ...args] = only.words;
  const plainCat = first?.value === "cat" && !first.unknown && !first.reads?.length;
  const input = only.redirects[0];
  if (only.redirects.length === 1 && input.body && plainCat && args.length === 0) {
    return input.body.unknown ? input.body : { ...input.body, value: input.body.value.replace(/\n+$/, "") };
  }
  if (only.redirects.length === 0 && plainCat && args.length === 1 && !args[0].value.startsWith("-")) {
    return { reads: [args[0]], value: READ };
  }
  if (only.words.length === 0 && only.redirects.length === 1 && input.op === "<" && input.target) {
    return { reads: [input.target], value: READ };
  }
  const printed = args.map((w) => w.value.replaceAll("\\n", `
`));
  const words = args.every((w) => !w.unknown && !w.glob && !marked(w.value)) && printed.every((v) => !v.includes("\\"));
  if (echoes && first?.value === "echo" && !first.quoted && only.redirects.length === 0 && words && !args[0]?.value.startsWith("-"))
    return { value: printed.join(" ") };
  return unknown("a command substitution");
}
var MKTEMP_FLAGS = new Set(["d", "q"]);
var MKTEMP_LONG = new Set(["--directory", "--quiet"]);
function mktempPath(cmd, known) {
  const [first, ...args] = cmd.words;
  if (!first || first.quoted || first.value !== "mktemp" || cmd.redirects.length > 0)
    return;
  if (!known.TMPDIR)
    return;
  const flag = ({ quoted, value }) => !quoted && (MKTEMP_LONG.has(value) || /^-[a-z]+$/.test(value) && value.slice(1).split("").every((c) => MKTEMP_FLAGS.has(c)));
  const templates = args.filter((word) => !flag(word));
  const [template] = templates;
  if (templates.length > 1 || template?.value.startsWith("-") || marked(template?.value ?? ""))
    return;
  return template ? template.value : `${known.TMPDIR.replace(/\/$/, "")}/tmp.mktemp`;
}
var SPLIT = /^(?:-[0iv]*S|--split-string(?:=|$))(.*)$/;
var XARGS_LONG = [
  "arg-file",
  "delimiter",
  "eof",
  "exit",
  "help",
  "interactive",
  "max-args",
  "max-chars",
  "max-lines",
  "max-procs",
  "no-run-if-empty",
  "null",
  "open-tty",
  "process-slot-var",
  "replace",
  "show-limits",
  "verbose",
  "version"
];
var XARGS_FLAGS = "0oprtx";
function delimiterOf(word) {
  if (!word || word.unknown)
    return;
  if (word.value.length === 1)
    return word.value;
  const [, hex, octal, letter] = /^\\(?:x([\da-f]+)|([0-7]+)|(.))$/i.exec(word.value) ?? [];
  const code = hex ? parseInt(hex, 16) : octal ? parseInt(octal, 8) : undefined;
  if (code !== undefined)
    return code < 256 ? String.fromCharCode(code) : undefined;
  return letter ? ESCAPES[letter] : undefined;
}
var XARGS_REPLACE = /^(?:-[IiJ]|--replace)/;
function xargsOption(xargs, w, next, state) {
  const split = (delimiter) => {
    xargs.delimiters = [...xargs.delimiters ?? [], delimiter];
  };
  if (XARGS_REPLACE.test(w.value))
    return;
  const long = /^--([^=]+)(=?)/.exec(w.value);
  let name;
  let value;
  if (long) {
    const names = XARGS_LONG.filter((n) => n.startsWith(long[1]));
    name = names.includes(long[1]) ? long[1] : names.length === 1 ? names[0] : undefined;
    if (long[2])
      value = slice(w, long[0].length);
  } else if (w.value.startsWith("-")) {
    let k = 1;
    while (XARGS_FLAGS.includes(w.value[k] ?? "-"))
      k++;
    if (w.value.slice(1, k).includes("0"))
      split("\x00");
    name = w.value[k];
    if (k + 1 < w.value.length)
      value = slice(w, k + 1);
  }
  if (name === "i" || name === "replace")
    xargs.replace = value?.value || "{}";
  else if (name === "null")
    split("\x00");
  else if (name === "I" || name === "J")
    xargs.replace = (value ?? next)?.value;
  else if (name === "a" || name === "arg-file")
    xargs.files = [
      ...xargs.files ?? [],
      ...[value ?? next].filter((file) => file !== undefined).map((file) => ({ chdir: state.chdir, file, moved: state.moved }))
    ];
  else if (name === "d" || name === "delimiter")
    split(delimiterOf(value ?? next));
}
var splitFrom = new WeakMap;
var chdirOf = (state, word) => state.chdir && word ? { ...word, ...unknown("a second env -C") } : word;
var READINGS = 16;
function parse(cmd) {
  const state = { local: new Map, rest: cmd.words.toReversed(), xargs: undefined };
  const { rest } = state;
  for (let w = rest.at(-1);w && !w.quoted; w = rest.at(-1)) {
    if (RESERVED.has(w.value))
      rest.pop();
    else if (w.value === "function")
      rest.length = Math.max(0, rest.length - 2);
    else
      break;
  }
  while (ASSIGN.test(rest.at(-1)?.value ?? ""))
    assign(state.local, rest.pop());
  const budget = { left: READINGS };
  const parsed = unwrap(state, undefined, budget);
  return budget.capped ? { ...parsed, capped: true } : parsed;
}
var readings = (parsed) => [parsed, ...parsed.also.flatMap(readings)];
var assign = (local, w) => {
  const eq = w.value.indexOf("=");
  local.set(w.value.slice(0, eq), slice(w, eq + 1));
};
function unwrap(state, inside, budget) {
  const { local, rest } = state;
  const peek = () => rest[rest.length - 1];
  const next = () => rest[rest.length - 2];
  const take = () => rest.pop();
  const also = [];
  const fork = (wrapper, drop) => {
    tick();
    if (budget.left-- <= 0) {
      budget.capped = true;
      return;
    }
    also.push(unwrap({
      chdir: state.chdir,
      local: new Map(local),
      moved: state.moved,
      rest: rest.slice(0, Math.max(0, rest.length - drop)),
      xargs: state.xargs && { ...state.xargs }
    }, wrapper, budget));
  };
  let spec = false;
  for (let wrapper = inside;; wrapper = undefined) {
    if (!wrapper) {
      const word = peek();
      const held = [state.xargs?.replace ?? "", ...state.xargs?.outer ?? []];
      for (const replace of held.filter((r) => r && word?.value.includes(r)))
        if (word) {
          const typed = splitFrom.get(word) ?? word;
          state.xargs = {
            ...state.xargs,
            filled: [...state.xargs?.filled ?? [], [typed, replace]]
          };
        }
      wrapper = program(word?.value ?? "");
      if (!WRAPPERS.has(wrapper))
        break;
      if (ROOT_SHELLS.has(wrapper))
        state.moved = true;
      if (wrapper === "xargs" && state.xargs?.replace)
        state.xargs = { ...state.xargs, outer: [...state.xargs.outer ?? [], state.xargs.replace] };
      if (wrapper === "xargs")
        state.xargs ??= {};
      take();
    }
    const runs = RUNNERS.get(wrapper);
    const options = WRAPPERS.get(wrapper) ?? runs;
    spec = !!runs?.spec;
    let joined = runs?.joined === true;
    for (let w = peek();w; w = peek()) {
      const v = w.value;
      const script = runs && namedOption(v, runs, runs.script);
      const folder = runs && namedOption(v, runs, runs.folder);
      if (wrapper === "xargs")
        xargsOption(state.xargs ??= {}, w, next(), state);
      if (runs && runs.joined !== true && joinsWords(v, runs.joined))
        joined = true;
      if (ASSIGN.test(v))
        assign(local, take());
      else if (wrapper === "env" && SPLIT.test(v)) {
        const attached = SPLIT.exec(v)?.[1] ?? "";
        take();
        const from = attached ? w : take();
        const split = (attached || from?.value || "").split(/\s+/).filter(Boolean);
        for (let j = split.length - 1;j >= 0; j--) {
          const word = { quoted: false, value: split[j] };
          if (from)
            splitFrom.set(word, splitFrom.get(from) ?? from);
          rest.push(word);
        }
      } else if (wrapper === "env" && (v === "-C" || v === "--chdir")) {
        take();
        state.chdir = chdirOf(state, take());
      } else if (wrapper === "env" && /^(?:-C|--chdir=)./.test(v)) {
        state.chdir = chdirOf(state, slice(w, v.startsWith("-C") ? 2 : "--chdir=".length));
        take();
      } else if (wrapper === "xargs" && XARGS_REPLACE.test(v)) {
        const attached = /^(?:-[IiJ]|--replace=?)(.*)$/.exec(v)?.[1] ?? "";
        take();
        state.xargs ??= {};
        state.xargs.replace = v === "-I" || v === "-J" ? take()?.value : attached || "{}";
      } else if (wrapper === "env" && v === "-") {
        take();
      } else if (folder !== undefined) {
        take();
        state.chdir = chdirOf(state, folder === -1 ? take() : slice(w, folder));
      } else if (script !== undefined) {
        take();
        const text = script === -1 ? take() : slice(w, script);
        if (text)
          rest.push(text, ...SH_C);
        break;
      } else if (v === "--") {
        take();
        while (ASSIGN.test(peek()?.value ?? ""))
          assign(local, take());
        break;
      } else if (v.startsWith("-") && v !== "-") {
        const end = wrapper === "nice" && /^-\d+$/.test(v) ? "own" : marked(v) ? undefined : optionValue(v, options);
        if (!end)
          fork(wrapper, 2);
        else if (end === "next" && marked(next()?.value ?? "")) {
          fork(wrapper, 1);
          fork(wrapper, 3);
        }
        rest.length = Math.max(0, rest.length - (end === "next" ? 2 : 1));
      } else if (runs?.tools && rest.some((r) => !r.quoted && r.value === "--"))
        take();
      else
        break;
    }
    if (joined && rest.length > 0) {
      const text = rest.toReversed().map((r) => r.value).join(" ");
      rest.length = 0;
      rest.push({ quoted: true, value: text }, ...SH_C);
    }
    if (COUNTED.has(wrapper))
      take();
    if (wrapper === "chrt" && /^\d+$/.test(peek()?.value ?? ""))
      take();
    if (wrapper === "flock" && !peek()?.quoted && FLOCK_SCRIPT.has(peek()?.value ?? "")) {
      take();
      const text = take();
      if (text)
        rest.push(text, ...SH_C);
    }
    if (wrapper === "repeat" && REPEAT_BODY.has(peek()?.value ?? "") && !peek()?.quoted)
      take();
  }
  const typed = take();
  const first = spec && typed ? packageName(typed) : typed;
  const parsed = {
    also,
    args: rest.reverse(),
    chdir: state.chdir,
    first,
    local,
    name: first ? program(first.value) : "",
    xargs: state.xargs
  };
  const via = viaRunner(parsed, state, budget);
  if (via)
    also.push(via);
  return parsed;
}
var SH_C = [
  { quoted: false, value: "-c" },
  { quoted: false, value: "sh" }
];
var FLOCK_SCRIPT = new Set(["-c", "--command"]);
function namedOption(v, { values }, names) {
  if (!v.startsWith("-") || v === "-" || v === "--")
    return;
  if (v.startsWith("--")) {
    const eq = v.indexOf("=");
    if (!names.has(eq === -1 ? v : v.slice(0, eq)))
      return;
    return eq === -1 ? -1 : eq + 1;
  }
  for (let k = 1;k < v.length; k++) {
    const option = `-${v[k]}`;
    if (values.has(option))
      return names.has(option) ? k === v.length - 1 ? -1 : k + 1 : undefined;
  }
}
function joinsWords(v, joined) {
  if (v.startsWith("--"))
    return joined.has(v.split("=")[0]);
  return v.startsWith("-") && [...v.slice(1)].some((letter) => joined.has(`-${letter}`));
}
function packageName(word) {
  const from = word.value.startsWith("npm:") ? 4 : 0;
  const name = word.value.slice(from).replace(/(?<=.)@[^@/]*$/, "");
  if (from === 0 && name === word.value)
    return word;
  const cut = slice(word, from);
  return { ...cut, source: word.source === word.value ? name : word.source, value: name };
}
function subcommandAt(manager, args, options) {
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (!v.startsWith("-") || v === "-" || v === "--")
      return k;
    const end = optionValue(v, options);
    if (end === "next")
      k++;
    else if (end === undefined && !RUNNERS.has(`${manager} ${args[k + 1]?.value}`) && RUNNERS.has(`${manager} ${args[k + 2]?.value}`))
      k++;
  }
  return args.length;
}
function viaRunner(parsed, state, budget) {
  const { args, name } = parsed;
  let key = RUNNERS.has(name) ? name : undefined;
  let words = args;
  let implicit = false;
  const manager = MANAGERS.get(name);
  if (!key && manager) {
    let at = subcommandAt(name, args, RUNNERS.get(manager));
    const from = at;
    for (let scope = scopeAt(name, args, at);scope; scope = scopeAt(name, args, at)) {
      const after = at + scope.words + scope.names;
      at = after + subcommandAt(name, args.slice(after), scope.options);
    }
    const sub = args[at]?.value;
    if (sub === undefined)
      return;
    if (RUNNERS.has(`${name} ${sub}`)) {
      key = `${name} ${sub}`;
      words = args.toSpliced(from, at + 1 - from);
    } else if (name === "pnpm" && !PNPM_COMMANDS.has(sub) || name === "deno" && sub.startsWith("npm:")) {
      key = manager;
      implicit = true;
    }
  }
  if (!key)
    return;
  tick();
  if (budget.left-- <= 0) {
    budget.capped = true;
    return;
  }
  const reading = unwrap({
    chdir: parsed.chdir,
    local: new Map(parsed.local),
    moved: state.moved,
    rest: words.toReversed(),
    xargs: parsed.xargs && { ...parsed.xargs }
  }, key, budget);
  if (!reading.first)
    return;
  const file = reading.first.value;
  if (key === "bun run" && (file.includes("/") || SCRIPT_FILE.test(file)))
    return;
  if (key === "deno run" && words.includes(reading.first))
    return;
  return { ...reading, via: implicit ? name : key };
}
var SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
function scopeAt(name, args, at) {
  const two = `${name} ${args[at]?.value} ${args[at + 1]?.value}`;
  const one = `${name} ${args[at]?.value}`;
  const scope = SCOPES.get(two) ?? SCOPES.get(one);
  return scope && { ...scope, words: SCOPES.has(two) ? 2 : 1 };
}
function runsScript({ first, via }, env) {
  if (via !== "bun run" && via !== "pnpm")
    return false;
  const name = first?.value;
  const unsure = env.cwdUnread || env.cwdAnywhere || (env.cwdMaybe?.length ?? 0) > 0;
  const start = env.cwdSure ?? (unsure ? undefined : env.cwd);
  if (!name || marked(name) || !start)
    return false;
  for (let dir = start;; dir = dirname(dir)) {
    const scripts = packageScripts(`${dir}/package.json`);
    if (scripts)
      return Object.hasOwn(scripts, name);
    if (dirname(dir) === dir)
      return false;
  }
}
function packageScripts(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  try {
    const scripts = JSON.parse(text).scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return {};
  }
}
function shellSlot(args, shell) {
  const { inline, operand } = shellOperand(args, shell);
  if (inline || !operand || program(operand.value) !== "run-slot.sh")
    return;
  return args.slice(args.indexOf(operand));
}
async function run(lexed, env, visit, builtins = false) {
  if (running >= MAX_RUNS)
    throw new RangeError("scripts nested too deep");
  running++;
  try {
    return await runAll(lexed, env, visit, builtins);
  } finally {
    running--;
  }
}
var running = 0;
var MAX_RUNS = 256;
async function runAll(lexed, env, visit, builtins) {
  const envs = new Map([[0, env]]);
  const envOf = (scope) => {
    const found = envs.get(scope);
    if (found)
      return found;
    const parent = envOf(lexed.scopes[scope]);
    const child = { ...parent, vars: new Map(parent.vars) };
    envs.set(scope, child);
    return child;
  };
  feedBodies(lexed.commands);
  for (const [producer, { consumer, kind }] of codeFed(lexed.commands)) {
    producer.feedsShell = true;
    consumer.runsStdin = kind !== "code";
  }
  env.namings ??= namings(lexed.commands);
  const unbind = new Map;
  for (const [k, cmd] of lexed.commands.entries()) {
    const at = envOf(cmd.scope);
    if (cmd.repeated && !lexed.commands[k - 1]?.repeated)
      repass(lexed.commands.slice(k), envs);
    const verdict = await examine(cmd, at, visit, builtins) ?? (cmd.glob && await examine({ ...cmd, ...cmd.glob, glob: undefined }, at, visit, builtins));
    if (verdict)
      return verdict;
    unbind.get(cmd)?.();
    bind(lexed.commands, k, at, unbind);
    change(cmd, at);
  }
}
var NAME_SETTERS = new Set([
  "compgen",
  "declare",
  "export",
  "float",
  "getln",
  "getopts",
  "integer",
  "let",
  "local",
  "mapfile",
  "nameref",
  "pcre_match",
  "print",
  "printf",
  "private",
  "read",
  "readarray",
  "readonly",
  "set",
  "shift",
  "stat",
  "strftime",
  "syserror",
  "sysopen",
  "sysread",
  "syswrite",
  "typeset",
  "unset",
  "vared",
  "wait",
  "zcurses",
  "zformat",
  "zgdbmpath",
  "zgetattr",
  "zlistattr",
  "zmodload",
  "zparseopts",
  "zpty",
  "zregexparse",
  "zselect",
  "zsocket",
  "zstat",
  "zstyle",
  "zsystem",
  "ztcp",
  "ztie",
  "zuntie"
]);
var PRINTS = new Set(["print", "printf"]);
var RUNS_TEXT = new Set([
  ".",
  "alias",
  "autoload",
  "emulate",
  "enable",
  "eval",
  "fc",
  "mapfile",
  "r",
  "readarray",
  "sched",
  "source",
  "trap",
  "zmodload",
  "zregexparse",
  "zstyle"
]);
var CHANGED = { ...unknown("a value a builtin may change"), vanishes: true };
var DECLARES = new Set([...EXPORTS, "float", "integer", "private"]);
function change(cmd, env) {
  const { args, first, name } = parse(cmd);
  const words = args.map((a) => a.value);
  if (marked(name)) {
    const array = arrayRun(cmd, first, env);
    if (array === null || array && RUNS_TEXT.has(parse(array).name)) {
      for (const key of env.vars.keys())
        setVar(env.vars, key, CHANGED);
      return;
    }
    const variants = array ? [array] : [...splitHeld(cmd, name, env), ...splitHeld(cmd, name, env, true)].filter((variant) => !marked(parse(variant).name));
    for (const variant of variants)
      change(variant, env);
    if (variants.length > 0)
      return;
    const known = heldKnown(env);
    const unread = args.some((a) => {
      const value = marked(a.value) && a.raw ? relexedValue(a.raw, known) : a.value;
      return value === undefined || marked(value);
    });
    const names = unread ? [...env.vars.keys()] : words.filter((w) => NAME.test(w));
    for (const key of names)
      if (env.vars.has(key))
        setVar(env.vars, key, CHANGED);
    return;
  }
  const element = (first?.source ?? first?.value ?? "").match(SUBSCRIPTED)?.[1];
  if (element) {
    if (env.vars.has(element))
      setVar(env.vars, element, CHANGED);
    return;
  }
  const options = words.filter((w) => /^[-+]./.test(w) && w !== "--");
  const prints = PRINTS.has(name);
  const vNames = prints ? words.flatMap((w, k) => /^-[^-\s]*v/.test(w) ? [w.slice(w.indexOf("v") + 1), words[k + 1] ?? ""] : []) : [];
  const nameWords = prints ? vNames : words.map((w) => w.split("=")[0]);
  const all = RUNS_TEXT.has(name) && (name !== "eval" || args.some(unreadWord)) || NAME_SETTERS.has(name) && nameWords.some(marked) || name === "unset" && options.some((w) => w.includes("m"));
  const read = name === "read" ? binds(cmd) : [];
  const names = all ? [...env.vars.keys()] : name === "unset" ? options.some((w) => w.includes("f")) ? [] : words : name === "read" ? read.length > 0 ? read : ["REPLY"] : prints ? printsText(words) ? [] : vNames : DECLARES.has(name) ? words.filter((w) => options.some((o) => o !== "-a") || !ASSIGN.test(w) && (options.length > 0 || name !== "export" && name !== "readonly")) : name === "set" ? words.flatMap((w, k) => /^[-+]\w*A$/.test(w) && words[k + 1] ? [words[k + 1]] : []) : NAME_SETTERS.has(name) && name !== "getopts" ? words.flatMap((w) => w.match(/[A-Za-z_]\w*/g) ?? []) : [];
  for (const key of names.map((w) => w.split("=")[0].replace(/\[[\s\S]*$/, ""))) {
    if (!NAME.test(key))
      continue;
    if (env.vars.has(key) || name === "read" || prints)
      setVar(env.vars, key, CHANGED);
  }
}
function namings(commands) {
  const counts = new Map;
  const add = (name) => void counts.set(name, (counts.get(name) ?? 0) + 1);
  const count = (source, value) => {
    for (const [, name] of (source ?? "").matchAll(/\$\{?[#!+^=~]?([A-Za-z_]\w*)/g))
      add(name);
    const text = value ?? "";
    for (const [, name] of text.matchAll(/(?<=^|=)([A-Za-z_]\w*)(?=\[|\+?=|$)/g))
      add(name);
    const cluster = text.match(/^-(\w+)/)?.[1] ?? "";
    for (let k = 1;k < cluster.length; k++) {
      const name = cluster.slice(k).match(/^[A-Za-z_]\w*/)?.[0];
      if (name && /^(?:\[|\+?=|$)/.test(text.slice(k + 1 + name.length)))
        add(name);
    }
  };
  for (const cmd of commands) {
    const { args, first, name } = parse(cmd);
    if (name === "eval")
      for (const a of args)
        for (const [key] of a.value.matchAll(/[A-Za-z_]\w*/g))
          add(key);
    for (const w of cmd.words)
      if (w !== first || !WHOLE_RUN.test(w.raw ?? w.source ?? ""))
        count(w.source ?? w.raw, w.value);
    for (const r of cmd.redirects) {
      count(r.target?.source, r.target?.value);
      count(r.body?.value, undefined);
    }
  }
  return counts;
}
function arrayRun(cmd, first, env) {
  const run = (first?.raw ?? first?.source)?.match(WHOLE_RUN);
  const key = run?.[1] ?? run?.[2];
  const set = key ? env.vars.get(key) : undefined;
  if (!key || !set)
    return;
  if ((env.namings?.get(key) ?? 0) > 1)
    return null;
  if (set.unknown !== undefined || set.vanishes)
    return null;
  const inner = set.source?.match(/^[A-Za-z_]\w*=\(([\s\S]*)\)$/)?.[1];
  if (inner === undefined)
    return;
  const { commands } = lex(inner);
  const elements = commands.length === 1 ? commands[0].words : [];
  const asWritten = (w) => !unreadWord({ ...w, source: w.source?.replace(/^~(?=\/|$)/, "") });
  if (elements.length === 0 || commands[0].redirects.length > 0 || !elements.every(asWritten))
    return null;
  const seps = ifsSplit(env);
  const words = run?.[2] ? elements.flatMap((w) => splitValue(w.value, seps)) : elements;
  if (words.length === 0)
    return null;
  return { ...cmd, words: cmd.words.flatMap((w) => w === first ? words : [w]) };
}
function globRun(cmd, first, env, glob = !!first?.glob) {
  const pattern = first?.value ?? "";
  if (!first || !glob || marked(pattern) || SUBSCRIPTED.test(first.source ?? ""))
    return;
  const seen = (first.source ?? "").replace(/\\\n/g, "").replace(QUOTED, maskQuoted);
  const grouped = seen.includes("(");
  const qualifiers = grouped ? /\(([^()|]*)\)$/.exec(seen) : null;
  const joined = pattern.replace(/\\\n/g, "");
  const groups = grouped ? groupWords(qualifiers ? joined.slice(0, joined.length - qualifiers[0].length) : joined) : [pattern];
  if (groups === null || qualifiers?.[1].includes("N"))
    return null;
  const patterns = groups ?? [pattern];
  if ((!grouped || !groups) && !GLOB_PATTERN.test(pattern))
    return;
  const [only, ...more] = patterns;
  const unsure = !env.cwd || env.cwdUnread || env.cwdAnywhere;
  if (more.length === 0 && !GLOB_PATTERN.test(only) && !isAbsolute3(only) && unsure)
    return [
      { ...cmd, words: cmd.words.map((w) => w === first ? { quoted: true, value: only } : w) }
    ];
  const found = [];
  for (const each of patterns) {
    const matched = globMatches(each, env);
    if (matched === null)
      return null;
    found.push(...matched);
  }
  if (found.length > READINGS || qualifiers && found.length > 0)
    return null;
  if (found.length === 0)
    return;
  return found.map((value) => ({
    ...cmd,
    words: cmd.words.map((w) => w === first ? { quoted: true, value } : w)
  }));
}
function globMatches(pattern, env) {
  const absolute = isAbsolute3(pattern);
  if (!absolute && (!env.cwd || env.cwdUnread || env.cwdAnywhere))
    return null;
  const base = absolute ? "/" : env.cwd;
  let paths = [""];
  for (const [k, part] of pattern.split("/").entries()) {
    const join = (path, name) => k === 0 ? name : `${path}/${name}`;
    if (!GLOB_PATTERN.test(part)) {
      paths = paths.map((path) => join(path, part));
      continue;
    }
    const glob = shellGlob(part);
    const next = [];
    for (const path of paths) {
      let names;
      try {
        names = readdirSync(resolve3(base, path || "."));
      } catch (error) {
        if (/^(?:ENOENT|ENOTDIR)$/.test(error.code ?? ""))
          continue;
        return null;
      }
      for (const name of names)
        if ((part.startsWith(".") || !name.startsWith(".")) && glob.match(name))
          next.push(join(path, name));
    }
    if (next.length > READINGS)
      return null;
    paths = next;
  }
  const found = [];
  for (const path of paths) {
    try {
      lstatSync(resolve3(base, path));
      found.push(path);
    } catch (error) {
      if (!/^(?:ENOENT|ENOTDIR)$/.test(error.code ?? ""))
        return null;
    }
  }
  return found;
}
function groupWords(pattern, spelling = false) {
  const seen = pattern.replace(QUOTED, maskQuoted);
  const open = seen.indexOf("(");
  if (open < 0)
    return seen.includes(")") ? undefined : [pattern.replace(QUOTED, unquote)];
  const cuts = [open];
  let close = -1;
  for (let k = open, depth = 0;k < seen.length && close < 0; k++) {
    if (seen[k] === "(")
      depth++;
    else if (seen[k] === "|" && depth === 1)
      cuts.push(k);
    else if (seen[k] === ")" && --depth === 0)
      close = k;
  }
  if (close < 0 || pattern.slice(open, close).includes("/"))
    return;
  if (!spelling && /[#^~]/.test(seen.slice(open, close)))
    return null;
  const out = [];
  for (const [n, from] of cuts.entries()) {
    const alternative = pattern.slice(from + 1, cuts[n + 1] ?? close);
    const extended = spelling && /[#^~]/.test(seen.slice(from + 1, cuts[n + 1] ?? close));
    for (const each of extended ? [alternative, "*"] : [alternative]) {
      const words = groupWords(pattern.slice(0, open) + each + pattern.slice(close + 1), spelling);
      if (!words || out.push(...words) > (spelling ? BRACE_WORDS : READINGS))
        return words === undefined ? undefined : null;
    }
  }
  return out;
}
var unquote = (part) => part.startsWith("\\") ? part.slice(1) : part.slice(1, part.endsWith(part[0]) && part.length > 1 ? -1 : undefined);
function braceRun(cmd, first) {
  if (first?.unknown !== BRACE)
    return;
  const source = (first.source ?? "").replace(/\\\n/g, "");
  if (/[$`]/.test(source))
    return null;
  const masked = source.replace(QUOTED, (part) => part.replace(/[{,}()]/g, hide));
  const grouped = masked.includes("(");
  const expanded = braceWords(masked);
  if (!expanded || expanded.some((w) => BRACE_LIST.test(w)))
    return null;
  const words = [];
  for (const each of expanded) {
    const { commands } = lex(unhide(each));
    if (commands.length > 1 || commands[0]?.redirects.length)
      return grouped ? undefined : null;
    words.push(...commands[0]?.words ?? []);
  }
  if (words.length === 0)
    return null;
  return { ...cmd, words: cmd.words.flatMap((w) => w === first ? words : [w]) };
}
var QUOTED = /'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|\\[\s\S]/g;
var HIDDEN = "{,}()";
var maskQuoted = (part) => "\uE005".repeat(part.length);
var hide = (c) => String.fromCharCode(57344 + HIDDEN.indexOf(c));
var HIDDEN_CHARS = new RegExp(`[${[...HIDDEN].map(hide).join("")}]`, "g");
var unhide = (text) => text.replace(HIDDEN_CHARS, (c) => HIDDEN[c.charCodeAt(0) - 57344]);
function heldGlob(cmd, first, env) {
  if (!first?.glob || !first.raw || !marked(first.value))
    return;
  const value = relexedValue(first.raw, heldKnown(env));
  if (value === undefined || marked(value))
    return;
  const word = { ...first, value };
  return globRun({ ...cmd, words: cmd.words.map((w) => w === first ? word : w) }, word, env, true);
}
var GLOB_PATTERN = /[*?]|\[[^\]]*\]/;
var shellGlob = (part) => new Bun.Glob(part.replace(/^!/, "\\!").replace(BRACKET, (bracket) => bracket.slice(1, -1).replace(/\[:([a-z]+):\]/g, (_, name) => POSIX_CLASSES[name] ?? " -~").replace(/\[([=.])(.)\1\]/g, "$2").replace(/^/, "[").concat("]")));
var BRACKET = /\[[!^]?\]?(?:\[:[a-z]+:\]|\[([=.]).\1\]|[^\]])*\]/g;
var POSIX_CLASSES = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  blank: " \t",
  digit: "0-9",
  lower: "a-z",
  space: ` 	
\r\f\v`,
  upper: "A-Z",
  xdigit: "0-9A-Fa-f"
};
function repass(commands, envs) {
  for (const cmd of commands) {
    if (!cmd.repeated)
      return;
    const env = envs.get(cmd.scope);
    if (!env)
      continue;
    change(cmd, env);
    const { local, name } = parse(cmd);
    if (name !== "")
      continue;
    for (const key of local.keys())
      if (env.vars.has(key))
        setVar(env.vars, key, CHANGED);
  }
}
function printsText(words) {
  const v = words.findIndex((w) => w === "-v" || /^-v\w/.test(w));
  const format = words[v + (words[v] === "-v" ? 2 : 1)];
  return v >= 0 && format !== undefined && !marked(format) && /^[^%\\]*\S[^%\\]*$/.test(format);
}
function bind(commands, k, env, unbind) {
  const cmd = commands[k];
  const names = binds(cmd);
  if (names.length === 0 || cmd.detached)
    return;
  const close = loopHeader(cmd) ? loopClose(commands, k) : undefined;
  if (!close && (loopHeader(cmd) || cmd.unsure || cmd.chained || cmd.kept))
    return;
  const value = close ? loopWord(cmd) : undefined;
  const held = close ? heldKnown(env) : {};
  const prior = names.flatMap((name) => (name in held) ? [[name, held[name]]] : []);
  for (const name of names)
    setVar(env.vars, name, value ?? unknown("a value a builtin gives"));
  if (!close)
    return;
  for (const name of names)
    capture(env, name, value);
  unbind.set(close, () => {
    for (const name of names)
      setVar(env.vars, name, CHANGED);
    if (prior.length === 0)
      return;
    let record = loopBefore.get(env.vars);
    if (!record)
      loopBefore.set(env.vars, record = {});
    for (const [name, was] of prior)
      record[name] = was;
  });
}
function capture(env, key, value) {
  if (value)
    recordHeld(env, key, value);
  else
    delete heldResolved.get(env.vars)?.[key];
}
function loopWord({ words }) {
  const at = words.findIndex((w) => w.value === "in" && !w.quoted);
  const list = at < 0 ? [] : words.slice(at + 1);
  return list.length === 1 && !unreadWord(list[0]) ? list[0] : undefined;
}
function heads({ words }) {
  const out = [];
  for (const w of words) {
    if (w.quoted || !(RESERVED.has(w.value) || OPENS.has(w.value) || CLOSES.has(w.value)))
      break;
    out.push(w.value);
  }
  return out;
}
var loopHeader = (cmd) => {
  const last = heads(cmd).at(-1);
  return last === "for" || last === "select";
};
function loopClose(commands, k) {
  let depth = 1;
  for (const cmd of commands.slice(k + 1))
    for (const word of heads(cmd)) {
      if (CLOSES.has(word) && --depth === 0)
        return cmd;
      if (OPENS.has(word))
        depth++;
    }
}
var subshell = (env) => ({ ...env, vars: new Map(env.vars) });
var PLAIN_PREFIXES = new Set(["HOME", "PLAYGROUND_REPO"]);
async function examine(cmd, env, visit, builtins) {
  tick();
  orElse(cmd, env);
  unchain(cmd, env);
  if (cmd.opaque) {
    env.cwdAnywhere = true;
    env.cwdSure = undefined;
    env.cwdUnread = true;
  }
  const [primary, ...others] = readings(parse(cmd));
  const vanished = emptyProgram(cmd, env);
  const array = arrayRun(cmd, primary.first, env);
  const prior = splitHeld(cmd, primary.name, env, true);
  const split = splitHeld(cmd, primary.name, env);
  const brace = braceRun(cmd, primary.first);
  const globs = [
    brace === null ? null : undefined,
    globRun(cmd, primary.first, env),
    heldGlob(cmd, primary.first, env),
    ...[...split, ...prior].map((v) => globRun(v, parse(v).first, env, true)),
    ...brace ? [globRun(brace, parse(brace).first, env)] : [],
    ...vanished.map((v) => globRun(v, parse(v).first, env))
  ];
  const resolving = [
    ...split,
    ...array ? [array] : [],
    ...brace ? [brace] : [],
    ...heldScripts(cmd, primary, env),
    ...globs.flatMap((globbed) => globbed ?? [])
  ];
  if (globs.includes(null) || unreadCommand(cmd, primary, resolving))
    for (const parsed of [primary, ...others])
      parsed.unread = true;
  const expanded = [
    ...expandTilde(cmd, primary.name, env),
    ...resolving,
    ...prior,
    ...vanished,
    ...await xargsFilled(cmd, [primary, ...others], env)
  ];
  const before = others.length > 0 || expanded.length > 0 ? apart(env) : env;
  const verdict = await examineReading(cmd, primary, env, visit, builtins);
  if (verdict)
    return verdict;
  for (const parsed of others) {
    if (runsScript(parsed, readingEnv(cmd, parsed, before)))
      continue;
    const verdict = await examineReading(cmd, parsed, apart(before), visit, builtins);
    if (verdict)
      return verdict;
  }
  for (const variant of expanded) {
    const verdict = await examineExpanded(cmd, variant, before, visit, builtins);
    if (verdict)
      return verdict;
  }
  for (const variant of vanished) {
    const parsed = parse(variant);
    if (MOVES.has(parsed.name))
      await chdirTo(parsed.name, { ...variant, unsure: true }, parsed, env);
  }
  const remote = primary.name === "ssh" && ["root", "shell"].includes(stdinShellOf(cmd, primary) ?? "");
  if (!remote && (!cmd.runsStdin || stdinScript(primary)))
    return;
  for (const script of await scriptStdin(cmd, env)) {
    const at = remote ? remoteEnv(env, known(script), true) : subshell(env);
    const verdict = await nested(cmd, env, () => run(lexScript(known(script), at), at, visit, builtins));
    if (verdict)
      return verdict;
  }
}
function heldScripts(cmd, parsed, env) {
  const scripts = scriptWords(parsed).filter((w) => w.raw && marked(w.value));
  if (scripts.length === 0)
    return [];
  const known = heldKnown(env);
  let resolved = false;
  const words = cmd.words.map((w) => {
    if (!scripts.includes(w) || !w.raw)
      return w;
    const value = relexedValue(w.raw, known);
    if (value === undefined || value === w.value)
      return w;
    resolved = true;
    return { quoted: true, value };
  });
  return resolved ? [{ ...cmd, words }] : [];
}
function scriptWords({ args, name }) {
  if (name === "eval")
    return args[0]?.value === "--" ? args.slice(1) : args;
  if (!SHELLS.has(name))
    return [];
  const { inline, operand } = shellOperand(args, name);
  return inline && operand ? [operand] : [];
}
function unreadCommand(cmd, parsed, resolving) {
  const others = resolving.map(parse);
  if (marked(parsed.name))
    return /[$`]/.test(parsed.first?.source ?? "") && others.every((p) => marked(p.name));
  if (!scriptWords(parsed).some((w) => marked(w.value)))
    return false;
  return others.every((p) => scriptWords(p).some((w) => marked(w.value)));
}
function stdinScript({ args, name }) {
  if (name === "." || name === "source")
    return STDIN_PATHS.has(args[0]?.value ?? "");
  if (!SHELLS.has(name))
    return false;
  const { inline, operand } = shellOperand(args, name);
  return !operand || !inline && STDIN_PATHS.has(operand.value);
}
async function argFile({ chdir, file, moved }, cmd, env) {
  if (file.procs)
    return held2(await outputs(file.procs, env));
  if (moved)
    return unknown(`${file.value}, which a privilege wrapper before xargs may read from another folder or root`);
  const cwd = chdir && pathOf(landsHeld(chdir, cmd, env) ?? chdir, env);
  return held2(await readPath(file, chdir && !isAbsolute3(file.value) ? { ...env, cwd } : env));
}
var itemsOf = (fed, split) => {
  if (fed.unknown || split === undefined)
    return;
  if (split === null)
    return [fed.value, ...fed.value.split(`
`), ...fed.value.split(/\s+/)];
  return [fed.value, ...fed.value.split(split)];
};
async function xargsFilled(cmd, parsed, env) {
  const filled = new Map;
  for (const [word, replace] of parsed.flatMap((p) => p.xargs?.filled ?? []))
    filled.set(word, [...new Set([...filled.get(word) ?? [], replace])]);
  if (filled.size === 0)
    return [];
  const xargs = parsed.map((p) => p.xargs);
  const files = xargs.flatMap((x) => x?.files ?? []).filter((f) => !STDIN_PATHS.has(f.file.value));
  const splits = [null, ...new Set(xargs.flatMap((x) => x?.delimiters ?? []))];
  const inputs = [
    await stdinOf(cmd, env),
    ...await Promise.all(files.map((f) => argFile(f, cmd, env)))
  ];
  const texts = new Set;
  for (const raw of inputs.flatMap((fed) => splits.map((split) => itemsOf(fed, split)))) {
    const items = [...new Set(raw?.map((text) => text.replace(/["'\\]/g, "").trim()))].filter(Boolean);
    if (!raw || items.length > READINGS)
      texts.add(undefined);
    else
      for (const text of items)
        texts.add(text);
    if (raw?.some((text) => /["'\\]/.test(text)))
      texts.add(undefined);
  }
  const fill = (text) => ({
    ...cmd,
    words: cmd.words.flatMap((w) => {
      const held = filled.get(w);
      if (!held)
        return [w];
      if (text === undefined)
        return [{ ...w, ...unknown(`the program xargs puts in place of ${held.join(" or ")}`) }];
      return held.reduce((value, replace) => value.replaceAll(replace, text), w.value).split(/\s+/).filter(Boolean).map((value) => ({ quoted: false, value }));
    })
  });
  return [...texts].map(fill);
}
var BLIND = "zsh's ~-, the folder the shell last left, which the hook cannot name on this line";
function expandTilde(cmd, name, env) {
  if (!env.old)
    return [];
  const opens = (w) => !!w?.tilde && TILDE.test(w.value);
  const moves = name === "cd" || name === "popd" || name === "pushd";
  const words = moves ? [] : cmd.words.filter(opens);
  const targets = cmd.redirects.filter((r) => opens(r.target));
  if (words.length === 0 && targets.length === 0)
    return [];
  const left = leftFolder(env);
  const lefts = cmd.kept ? [...left === undefined ? [] : [left], undefined] : [left];
  return lefts.map((dir) => {
    const expand = (w) => {
      if (!opens(w))
        return w;
      const rest = w.value.slice(2);
      if (w.value[1] === "+")
        return { ...w, tilde: undefined, value: `.${rest}` };
      return dir === undefined ? { ...w, tilde: undefined, unknown: BLIND, value: UNKNOWN + rest } : { ...w, tilde: undefined, value: dir + rest };
    };
    return {
      ...cmd,
      redirects: cmd.redirects.map((r) => opens(r.target) ? { ...r, target: expand(r.target) } : r),
      words: moves ? cmd.words : cmd.words.map(expand)
    };
  });
}
var holdsCommand = (w) => !!w.source && /^(?:\$\{\w+\}|\$\w+)+$/.test(w.source.replace(/["']/g, "").replace(/\$\{[=~^]+/g, "${").replace(/\$[=~^](?=\w)/g, "$"));
function splitHeld(cmd, name, env, prior = false) {
  if (name === "cd" || name === "popd" || name === "pushd")
    return [];
  const first = cmd.words.some((w) => w.splits && w.raw && !holdsCommand(w)) ? parse(cmd).first : undefined;
  const holds = (w) => !!w.splits && !!w.raw && (holdsCommand(w) || w === first);
  if (!cmd.words.some(holds))
    return [];
  const known = heldKnown(env);
  const seps = ifsSplit(env);
  const splitWith = (known) => {
    let split = false;
    const words = cmd.words.flatMap((w) => {
      if (!holds(w) || !w.raw)
        return [w];
      const value = relexedValue(w.raw, known);
      if (value === undefined)
        return [w];
      const parts = splitValue(value, seps);
      if (!parts.some((part) => !part.unknown))
        return [w];
      split = true;
      return parts;
    });
    return split ? [{ ...cmd, words }] : [];
  };
  if (!prior)
    return splitWith(known);
  const before = loopBefore.get(env.vars);
  return before && Object.keys(before).length > 0 ? splitWith({ ...known, ...before }) : [];
}
function relexedValue(raw, known) {
  const words = lex(raw.replace(/\$\{[=~^]+/g, "${"), known).commands.at(-1)?.words;
  return words?.length === 1 ? words[0].value : undefined;
}
var tildeHome = (value, quoted = false) => quoted || marked(value) ? value : value.replace(/^~(?=\/|$)/, homedir3());
function heldKnown(env) {
  const known = { ...env.known };
  for (const [key, text] of env.vars) {
    if (!text.unknown && !marked(text.value))
      known[key] = tildeHome(text.value, "quoted" in text && text.quoted === true);
    else if ("raw" in text && typeof text.raw === "string") {
      const value = relexedValue(text.raw, known);
      const eq = value?.indexOf("=") ?? -1;
      if (value !== undefined && eq >= 0)
        known[key] = tildeHome(value.slice(eq + 1));
    }
  }
  return Object.assign(known, heldResolved.get(env.vars));
}
var loopBefore = new WeakMap;
var heldResolved = new WeakMap;
function recordHeld(env, key, value) {
  delete loopBefore.get(env.vars)?.[key];
  let record = heldResolved.get(env.vars);
  if (!record)
    heldResolved.set(env.vars, record = {});
  if (!value.unknown && !marked(value.value))
    record[key] = tildeHome(value.value, "quoted" in value && value.quoted === true);
  else if ("raw" in value && typeof value.raw === "string") {
    const built = relexedValue(value.raw, { ...env.known, ...record });
    const eq = built?.indexOf("=") ?? -1;
    if (built !== undefined && eq >= 0)
      record[key] = tildeHome(built.slice(eq + 1));
  }
}
function ifsSplit(env) {
  const ifs = env.vars.get("IFS");
  if (!ifs || ifs.unknown || marked(ifs.value) || !ifs.value)
    return /\s+/;
  return new RegExp(`[\\s${ifs.value.replace(/[\]\\^-]/g, "\\$&")}]+`);
}
function splitValue(value, seps) {
  return value.split(seps).filter(Boolean).map((part) => marked(part) ? { quoted: false, unknown: "a shell variable", value: part } : { quoted: false, value: tildeHome(part) });
}
var VANISHING_PART = /\$[=~^]*(?:\w+|[@*])|\$\{[=~^]*!?(?:\w+|[@*])(?:\[[@*]\])?(?::?[-=]|:?\+[^{}]*|(?:#|%|\/|:(?![-=?+]))[^{}]*)?\}|"\$(?:@|\{@\}|\{\w+\[@\]\})"/y;
var MOVES = new Set(["cd", "popd", "pushd"]);
var vanishingParts = (source) => {
  VANISHING_PART.lastIndex = 0;
  while (VANISHING_PART.lastIndex < source.length)
    if (!VANISHING_PART.exec(source))
      return false;
  return true;
};
var READ_VALUES = new Set(["d", "i", "n", "N", "p", "t", "u"]);
var NAME = /^[A-Za-z_]\w*$/;
var SUBSCRIPTED = /^([A-Za-z_]\w*)(?:\[[^\]]*\]\+?|\+)=/;
var WHOLE_RUN = /^(?:"\$\{([A-Za-z_]\w*)\[@\]\}"|\$\{([A-Za-z_]\w*)\[[@*]\]\})$/;
function binds({ words }) {
  let at = 0;
  while (at < words.length && (!words[at].quoted && RESERVED.has(words[at].value) || ASSIGN.test(words[at].value)))
    at++;
  const [head, ...rest] = words.slice(at).map((w) => w.value);
  if (head === "for" || head === "select")
    return rest[0] && NAME.test(rest[0]) ? [rest[0]] : [];
  if (head === "getopts")
    return rest[1] && NAME.test(rest[1]) ? [rest[1]] : [];
  if (head === "printf") {
    const v = rest.findIndex((w) => w === "-v" || /^-v\w/.test(w));
    const name = v < 0 ? undefined : rest[v] === "-v" ? rest[v + 1] : rest[v].slice(2);
    return name && NAME.test(name) ? [name] : [];
  }
  if (head !== "read")
    return [];
  const names = [];
  for (let i = 0;i < rest.length; i++) {
    const w = rest[i];
    if (w === "--" || !w.startsWith("-") || w.length < 2) {
      names.push(...rest.slice(w === "--" ? i + 1 : i));
      break;
    }
    const letters = w.slice(1);
    const taker = [...letters].findIndex((c) => c === "a" || READ_VALUES.has(c));
    if (taker < 0)
      continue;
    const value = letters.slice(taker + 1) || rest[++i];
    if (letters[taker] === "a" && value)
      names.push(value);
  }
  return names.filter((w) => NAME.test(w));
}
var mayVanish = (w, env) => maySkip(w) && [...(w.source ?? "").matchAll(/\$\{?[=~^]*!?(\w+)/g)].every(([, name]) => {
  const set = env.vars.get(name);
  return !set || !!set.vanishes || !set.unknown && /^[ \t\n]*$/.test(set.value);
});
function emptyProgram(cmd, env) {
  if (!cmd.words.some((w) => mayVanish(w, env)))
    return [];
  let words = cmd.words;
  for (let { first } = parse(cmd);first && words.includes(first) && mayVanish(first, env); ) {
    const dropped = first;
    words = words.filter((w) => w !== dropped);
    ({ first } = parse({ ...cmd, words }));
  }
  return words === cmd.words ? [] : [{ ...cmd, words }];
}
async function examineExpanded(cmd, expanded, before, visit, builtins) {
  const { redirects, words } = cmd;
  cmd.redirects = expanded.redirects;
  cmd.words = expanded.words;
  try {
    for (const parsed of readings(parse(cmd))) {
      const verdict = await examineReading(cmd, parsed, apart(before), visit, builtins);
      if (verdict)
        return verdict;
    }
  } finally {
    cmd.redirects = redirects;
    cmd.words = words;
  }
}
function leftFolder(env) {
  const left = env.oldFrom ?? (env.old?.dir === undefined ? [] : [env.old.dir]);
  return left.length === 1 ? left[0] : undefined;
}
var apart = (env) => ({
  ...env,
  files: new Map(env.files),
  known: { ...env.known },
  process: { ...env.process },
  vars: new Map(env.vars)
});
function readingEnv(cmd, { chdir, via }, env) {
  const into = chdir && pathOf(landsHeld(chdir, cmd, env) ?? chdir, env);
  if (!chdir || via && into === undefined)
    return env;
  return {
    ...env,
    cwd: into,
    cwdHeld: [],
    cwdMaybe: [],
    cwdSure: into,
    cwdUnread: into === undefined
  };
}
async function examineReading(cmd, parsed, env, visit, builtins) {
  const { args, local, name } = parsed;
  const here = readingEnv(cmd, parsed, env);
  let verdict;
  const followed = SHELLS.has(name) || [".", "cd", "eval", "popd", "pushd", "source"].includes(name);
  if (followed && builtins && cmd.redirects.length > 0) {
    const bare = { ...cmd, bareOf: cmd, words: [] };
    verdict = await visit(bare, parse(bare), here);
    if (verdict)
      return verdict;
  }
  if (name === "") {
    for (const [key, value] of local) {
      setVar(env.vars, key, value);
      recordHeld(env, key, value);
    }
    if (builtins || cmd.feedsShell || rootFed(cmd))
      verdict = await visit(cmd, parsed, here);
  } else if (name === "cd" || name === "popd" || name === "pushd") {
    if (name !== "popd" && args.some((a) => GLOB_CHARS.test(a.value)))
      verdict = await visit(cmd, parsed, here);
    await chdirTo(name, cmd, parsed, env);
  } else if (EXPORTS.has(name)) {
    for (const w of args.filter((a) => ASSIGN.test(a.value))) {
      const eq = w.value.indexOf("=");
      const value = slice(w, eq + 1);
      setVar(env.vars, w.value.slice(0, eq), value);
      recordHeld(env, w.value.slice(0, eq), value);
    }
    if (builtins)
      verdict = await visit(cmd, parsed, here);
  } else if (SHELLS.has(name))
    verdict = (here.visitShells ? await visit(cmd, parsed, here) : undefined) ?? await nested(cmd, env, () => shell(name, args, cmd, here, visit, builtins, parsed.xargs));
  else if ((name === "source" || name === ".") && (args[0]?.procs || STDIN_PATHS.has(args[0]?.value ?? ""))) {
    const scripts = await scriptOf(args[0], cmd, here);
    verdict = scripts[0].unknown ? await visit(cmd, parsed, here) : undefined;
    for (const script of verdict ? [] : scripts) {
      verdict = await nested(cmd, env, () => run(again(lexScript(known(script), env), cmd, parsed), here, visit, builtins));
      if (verdict)
        break;
    }
  } else if (name === "eval") {
    verdict = (args.some(unreadWord) ? await visit(cmd, parsed, here) : undefined) ?? await nested(cmd, env, () => run(again(lexScript(evalText(args), env), cmd, parsed), here, visit, builtins));
  } else
    verdict = await visit(cmd, parsed, here);
  await record(cmd, name, args, here);
  return verdict;
}
var evalText = (args) => (args[0]?.value === "--" ? args.slice(1) : args).map((a) => a.value).join(" ");
function again(lexed, cmd, parsed) {
  if (!manyTimes(cmd, parsed))
    return lexed;
  const more = onceOrMore(cmd, parsed);
  for (const c of lexed.commands) {
    if (more && !c.repeated)
      c.atLeastOnce = true;
    c.repeated = true;
  }
  return lexed;
}
async function nested(cmd, env, body) {
  const chain = env.cwdChain;
  const token = env.cwdChainToken;
  const lineOr = env.cwdOr;
  env.cwdChain = [];
  env.cwdChainToken = undefined;
  env.cwdOr = undefined;
  try {
    return await body();
  } finally {
    const scriptOr = env.cwdOr;
    env.cwdOr = scriptOr && scriptOr.orChain === undefined ? { ...scriptOr, cdChain: cmd.chain, scope: cmd.scope } : lineOr;
    const left = [...new Set([...chain ?? [], ...env.cwdChain ?? []])];
    env.cwdChain = keep(left, env);
    env.cwdChainToken = left.length > 0 ? chain?.length ? token : cmd.chain : undefined;
  }
}
var BUILTIN = new Set(["builtin", "command"]);
var sureToRun = (cmd, parsed) => !cmd.detached && !cmd.unsure && !cmd.repeated && (ownFirst(cmd, parsed.first) || throughBuiltin(cmd, parsed));
var onceOrMore = (cmd, parsed) => !!cmd.atLeastOnce && !cmd.chained && !cmd.detached && !cmd.kept && !cmd.unsure && (ownFirst(cmd, parsed.first) || throughBuiltin(cmd, parsed));
var throughBuiltin = (cmd, { first }) => {
  if (!first)
    return false;
  const before = cmd.words.slice(0, cmd.words.indexOf(first));
  return before.some((w) => !w.quoted && BUILTIN.has(w.value)) && before.every((w) => !w.quoted && (BUILTIN.has(w.value) || w.value.startsWith("-") || MARKERS.has(w.value) || ASSIGN.test(w.value)));
};
var manyTimes = (cmd, { first }) => !!cmd.repeated || cmd.words.slice(0, first ? cmd.words.indexOf(first) : 0).some((w) => !w.quoted && REPEATS.has(program(w.value)));
var startFolders = (env) => [
  ...env.cwdSure === undefined ? [] : [env.cwdSure],
  ...env.cwdMaybe ?? []
];
function places(env, fallback) {
  const folders = [
    ...startFolders(env),
    ...env.cwdHeld ?? [],
    ...env.cwdUnread && fallback !== undefined ? [fallback] : []
  ];
  const out = [];
  const seen = new Set;
  for (const cwd of folders) {
    tick();
    if (seen.has(cwd))
      continue;
    seen.add(cwd);
    out.push({ ...env, cwd, cwdSure: cwd });
  }
  return out.length > 0 ? out : [{ ...env, cwd: undefined, cwdSure: undefined }];
}
function ancestors(path) {
  const out = [];
  for (let dir = dirname(path);; dir = dirname(dir)) {
    tick();
    out.push(dir);
    if (dir === dirname(dir))
      return out;
  }
}
var tildeSign = (name, dir, env) => (name === "cd" || name === "pushd") && env.old && dir?.tilde && !dir.unknown && !dir.reads?.length ? dir.value[1] : undefined;
async function cdTarget(name, cmd, args, env) {
  const typedDir = args.find((a) => !(a.value.startsWith("-") && a.value.length > 1));
  if (!typedDir)
    return homedir3();
  const dir = landsHeld(typedDir, cmd, env) ?? typedDir;
  const lexical = dir.value === "-" ? undefined : pathOf(dir, env);
  const typed = await folder(lexical && physicalCd(args) ? kernelPath(dir, env.cwd, lexical) : lexical);
  const sign = typed ? undefined : tildeSign(name, dir, env);
  const base = sign && (sign === "-" ? env.old?.dir : env.cwd);
  return base ? await folder(base + dir.value.slice(2)) : typed;
}
async function folder(path) {
  if (!path)
    return;
  return isFolder(path) ? path : undefined;
}
var landsHeld = (word, cmd, env) => {
  const held = env.hold?.(word, cmd, env);
  return held && isAbsolute3(held.value) && !held.glob && !/[:\s]/.test(held.value) ? held : undefined;
};
function cdTargets(name, cmd, parsed, env, from) {
  const dirs = parsed.args.filter((a) => !(a.value.startsWith("-") && a.value.length > 1));
  const [dir] = dirs;
  if (!dir) {
    return name === "cd" ? { paths: [homedir3()], unread: false } : { back: true, paths: [homedir3()], unread: true };
  }
  if (dir.value === "-")
    return { back: true, paths: [], unread: true };
  const paths = new Set;
  const many = manyTimes(cmd, parsed);
  const physical = physicalCd(parsed.args);
  let unread = dirs.length > 1;
  for (const typed of dirs.length > 1 ? dirs : [dir]) {
    const word = env.hold?.(typed, cmd, env) ?? typed;
    if (word !== typed && !landsHeld(typed, cmd, env))
      unread = true;
    if (env.cwdUnread && pathOf(word, { ...env, cwd: undefined }) === undefined)
      unread = true;
    for (const base of from.length > 0 ? from : [undefined]) {
      tick();
      const path = pathOf(word, { ...env, cwd: base });
      if (path === undefined) {
        unread = true;
        continue;
      }
      const landed = physical ? kernelPath(word, base, path) : path;
      paths.add(landed);
      if (many && word.value.split("/").includes("..")) {
        for (const up of ancestors(landed))
          paths.add(up);
      }
    }
  }
  return { back: dirs.length > 1, paths: [...paths], unread };
}
var physicalCd = (args) => args.some((a) => /^-[^-]/.test(a.value) && a.value.includes("P"));
function kernelPath(word, base, lexical) {
  try {
    return realpathSync.native(isAbsolute3(word.value) ? word.value : `${base}/${word.value}`);
  } catch {
    return lexical;
  }
}
function tildeMove(move, name, parsed, env, from, back) {
  const dir = parsed.args.find((a) => !(a.value.startsWith("-") && a.value.length > 1));
  const sign = tildeSign(name, dir, env);
  if (!sign || !dir)
    return move;
  const bases = sign === "-" ? back : from;
  const paths = [
    ...move.paths,
    ...bases.map((base) => base + dir.value.slice(2)),
    ...env.cwd === undefined ? [] : [env.cwd]
  ];
  return {
    back: move.back || sign === "-",
    paths: [...new Set(paths)],
    unread: move.unread || bases.length === 0
  };
}
async function chdirTo(name, cmd, parsed, env) {
  const left = env.cwd;
  env.cwd = name === "popd" || cmd.detached ? undefined : await cdTarget(name, cmd, parsed.args, env);
  if (env.old)
    env.old = name === "popd" ? {} : { dir: env.cwd === undefined ? undefined : left };
  if (env.old)
    env.oldFrom = [];
  const from = startFolders(env);
  const back = [...new Set([...env.cwdBack ?? [], ...from])];
  const bases = [...new Set([...from, ...env.cwdHeld ?? []])];
  const move = name === "popd" ? { back: true, paths: [], unread: true } : tildeMove(cdTargets(name, cmd, parsed, env, bases), name, parsed, env, from, back);
  const { paths } = move;
  const unread = move.unread || !!cmd.cdRedefined;
  const named = [left, env.cwd].filter((dir) => dir !== undefined);
  env.cwdBack = keep([...new Set([...back, ...paths, ...named])], env);
  if (cmd.held) {
    env.cwdHeld = keep([...new Set([...env.cwdHeld ?? [], ...paths])], env);
    env.cwdUnread ||= unread;
    return;
  }
  const chained = cmd.chained && !negated(cmd);
  if (sureToRun(cmd, parsed) && !unread && paths.length === 1 && (chained || isFolder(paths[0]))) {
    env.cwdSure = paths[0];
    env.cwdMaybe = [];
    if (chained)
      env.cwdChainUnread ||= env.cwdUnread;
    env.cwdUnread = false;
    env.cwdOr = chained ? undefined : { before: from, cdChain: cmd.chain, scope: cmd.scope };
    if (env.old)
      env.oldFrom = bases;
    if (chained) {
      env.cwdChain = keep([...new Set([...env.cwdChain ?? [], ...from])], env);
      env.cwdChainToken = cmd.chain;
    }
    return;
  }
  env.cwdSure = undefined;
  env.cwdOr = undefined;
  const behind = onceOrMore(cmd, parsed) && !unread && !move.back && paths.length > 0 && (chained || paths.every(isFolder));
  env.cwdMaybe = keep([...new Set([...move.back ? back : behind ? [] : from, ...paths])], env);
  env.cwdUnread = env.cwdUnread || unread || from.length === 0 && paths.length === 0;
}
var negated = (cmd) => markers(cmd.words).filter((word) => word === "!").length % 2 === 1;
var EXITS = new Set(["exit"]);
function orElse(cmd, env) {
  const or = env.cwdOr;
  if (!or)
    return;
  if (cmd.chain === or.orChain) {
    if (or.exits && cmd.detached)
      env.cwdOr = { ...or, exits: false };
    return;
  }
  if (cmd.chain === or.cdChain) {
    if (!or.joined)
      env.cwdOr = { ...or, joined: true };
    return;
  }
  if (or.orChain === undefined && cmd.orRun) {
    env.cwdOr = {
      ...or,
      exits: EXITS.has(parse(cmd).name) && !cmd.detached && cmd.scope === or.scope,
      landed: { maybe: env.cwdMaybe ?? [], sure: env.cwdSure },
      orChain: cmd.chain
    };
    env.cwdMaybe = keep([...new Set([...startFolders(env), ...or.before])], env);
    env.cwdSure = undefined;
    return;
  }
  if ((or.joined || or.exits) && or.landed) {
    env.cwdMaybe = or.landed.maybe;
    env.cwdSure = or.landed.sure;
  }
  env.cwdOr = undefined;
}
function unchain(cmd, env) {
  if (!env.cwdChain?.length && !env.cwdChainUnread || cmd.chain === env.cwdChainToken)
    return;
  if (env.cwdChainUnread)
    env.cwdUnread = true;
  env.cwdChainUnread = undefined;
  env.cwdMaybe = keep([
    ...new Set([
      ...env.cwdMaybe ?? [],
      ...env.cwdSure ? [env.cwdSure] : [],
      ...env.cwdChain ?? []
    ])
  ], env);
  env.cwdSure = undefined;
  if (env.old)
    env.oldFrom = [];
  env.cwdChain = [];
  env.cwdChainToken = undefined;
}
var MAX_FOLDERS = 32;
function keep(folders, env) {
  if (folders.length <= MAX_FOLDERS)
    return folders;
  env.cwdAnywhere = true;
  env.cwdSure = undefined;
  env.cwdUnread = true;
  return folders.slice(0, MAX_FOLDERS);
}
function isFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
var SHELL_TAKES = new Set(["-o", "+o", "--init-file", "--rcfile"]);
var BASH_TAKES = new Set([...SHELL_TAKES, "-O", "+O"]);
function noExec(args, shell) {
  const takes = shell === "bash" || shell === "sh" ? BASH_TAKES : SHELL_TAKES;
  let set = false;
  for (const { value } of args) {
    if (/^[-+][A-Za-z]*[oO]/.test(value) || value.startsWith("--") && value !== "--")
      return false;
    if (takes.has(value) || !/^[-+][A-Za-z]+$/.test(value))
      break;
    if (value.includes("n"))
      set = value.startsWith("-");
  }
  return set;
}
function shellOperand(args, shell) {
  const takes = shell === "bash" || shell === "sh" ? BASH_TAKES : SHELL_TAKES;
  let inline = false;
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (takes.has(v))
      k++;
    else if (/^[-+][A-Za-z0-9]+$/.test(v))
      inline ||= v.startsWith("-") && v.includes("c");
    else if (!v.startsWith("--"))
      return { inline, operand: args[k] };
  }
  return { inline };
}
async function shell(name, args, cmd, env, visit, builtins, xargs) {
  const slot = shellSlot(args, name);
  if (slot)
    return examine({ ...cmd, words: slot }, env, visit, builtins);
  if (noExec(args, name))
    return;
  const { inline, operand } = shellOperand(args, name);
  if (operand && inline) {
    let script = operand.value;
    if (xargs?.replace && script.includes(xargs.replace)) {
      const fed = await stdinOf(cmd, env);
      script = filled(script, xargs.replace, fed.unknown ? UNKNOWN : fed.value.trim());
    }
    return run(lexScript(script, env), subshell(env), visit, builtins);
  }
  for (const script of await scriptOf(operand, cmd, env)) {
    const text = known(script);
    const verdict = await run(lexScript(text, env), subshell(env), visit, builtins);
    if (verdict)
      return verdict;
  }
}
var known = (script) => script.value.replaceAll(UNKNOWN, `
`);
async function scriptOf(operand, cmd, env) {
  const scripts = !operand || STDIN_PATHS.has(operand.value) ? await scriptStdin(cmd, env) : [operand.procs ? await outputs(operand.procs, env) : unknown("a script file")];
  if (deadlines.getStore() !== undefined && scripts.some((s) => s.unknown === LARGE))
    throw new RangeError(LARGE);
  return scripts;
}
async function outputs(cmds, env) {
  return join3(await Promise.all(cmds.map((c) => outputOf(c, env))));
}
async function record(cmd, name, args, env) {
  for (const r of cmd.redirects) {
    if (r.op !== ">" && r.op !== ">>" && r.op !== ">|")
      continue;
    const path = r.target && pathOf(r.target, env);
    if (!path)
      continue;
    const stdout = r.fd === "" || r.fd === "1" || r.fd === "&";
    const out = stdout ? await outputOf(cmd, env) : unknown(`what ${name || "a command"} writes to stderr`);
    env.files.set(path, held2(r.op === ">>" ? join3([await existing(path, env), out]) : out));
  }
  if (name !== "tee")
    return;
  const input = await stdinOf(cmd, env);
  const append = args.some((a) => a.value === "-a" || a.value === "--append");
  for (const a of args) {
    const path = a.value.startsWith("-") ? undefined : pathOf(a, env);
    if (path)
      env.files.set(path, held2(append ? join3([await existing(path, env), input]) : input));
  }
}
async function existing(path, env) {
  return env.files.get(path) ?? await readFile(path) ?? { value: "" };
}
async function outputOf(cmd, env) {
  tick();
  const { args, name, xargs } = parse(cmd);
  if (xargs)
    return unknown(`the output of ${name || "echo"} under xargs`);
  if (name === "") {
    if (cmd.inner)
      return outputs(cmd.inner(), env);
    return cmd.group || cmd.words.some((w) => GROUPING.has(w.value) && !w.quoted) ? unknown("the output of a command group") : { value: "" };
  }
  if (name === "cat") {
    const sources = args.filter((a) => a.value === "-" || !a.value.startsWith("-"));
    if (sources.length === 0)
      return stdinOf(cmd, env);
    const first = sources.findIndex((s) => s.value === "-");
    const parts = [];
    let size = 0;
    for (const [k, s] of sources.entries()) {
      tick();
      const part = s.value !== "-" ? await readPath(s, env) : k === first ? await stdinOf(cmd, env) : { value: "" };
      size += part.value.length;
      if (size > MAX_BYTES)
        return unknown(LARGE);
      parts.push(part);
    }
    return join3(parts);
  }
  if (name === "tee")
    return stdinOf(cmd, env);
  if (!PRINTERS.has(name))
    return unknown(`the output of ${name}`);
  const values = await Promise.all(args.map((a) => resolveText(a, env)));
  const hidden = values.find((v) => v.unknown);
  if (hidden)
    return hidden;
  if (name === "printf")
    return { value: printf(values.slice(values[0]?.value === "--" ? 1 : 0).map((v) => v.value)) };
  let k = 0;
  while (k < values.length && /^-[neE]+$/.test(values[k].value))
    k++;
  return {
    value: `${values.slice(k).map((v) => decode(v.value)).join(" ")}
`
  };
}
function printf([format = "", ...args]) {
  const conversion = /%(?:%|[-+ #0']*(?:[1-9]\d*)?(?:\.\d+)?([a-zA-Z]))/g;
  const pattern = decode(format);
  let out = "";
  let k = 0;
  for (;; ) {
    tick();
    const before = k;
    out += pattern.replace(conversion, (_, kind) => {
      if (!kind)
        return "%";
      const value = args[k++] ?? "";
      return kind === "b" ? decode(value) : value;
    });
    if (k === before || k >= args.length)
      return out;
  }
}
async function stdinOf(cmd, env) {
  tick();
  const input = cmd.redirects.findLast((r) => !r.bodyFed && ownFeed(r));
  if (!input)
    return held2(cmd.stdin ? await outputOf(cmd.stdin, env) : unknown("stdin the hook cannot see"));
  return held2(await redirectText(input, env, false));
}
async function scriptStdin(cmd, env) {
  const own = await stdinOf(cmd, env);
  tick();
  const fed = held2(await stdinText(cmd, env));
  return fed.value === own.value && fed.unknown === own.unknown ? [own] : [own, fed];
}
var ownFeed = ({ fd, op }) => (fd === "" || fd === "0") && op.startsWith("<") && op !== "<&";
function stdinRedirect(cmd) {
  const fed = new Map;
  for (const r of cmd.redirects) {
    const dup = r.op === "<&" || dupOnto0(r);
    if (!r.op.startsWith("<") && !dup)
      continue;
    const from = (r.target?.value ?? "").replace(/^(\d+)-$/, "$1");
    fed.set(fdOf(r), dup ? /^\d+$/.test(from) ? fed.get(from) : undefined : r);
  }
  return fed.get("0");
}
var fdOf = (r) => r.fd === "" ? r.op.startsWith(">") ? "1" : "0" : r.fd;
var dupOnto0 = (r) => r.op === ">&" && r.fd === "0";
var stdinFed = (cmd) => stdinRedirect(cmd) !== undefined || cmd.redirects.some(ownFeed);
var rootFed = (cmd) => stdinFed(cmd) && stdinShell(cmd) === "root";
async function stdinText(cmd, env) {
  const input = stdinRedirect(cmd);
  if (!input)
    return cmd.stdin ? outputOf(cmd.stdin, env) : unknown("stdin the hook cannot see");
  return redirectText(input, env, true);
}
async function redirectText(input, env, shells) {
  if (input.target?.procs)
    return outputs(input.target.procs, env);
  if (input.op === "<" || input.op === "<>")
    return input.target ? readPath(input.target, env) : unknown("an input redirect");
  if (!input.body)
    return unknown("a heredoc the hook could not read");
  const set = shells && input.body.variable ? env.vars.get(input.body.variable) : undefined;
  if (input.body.unknown && input.body.value === `${UNKNOWN}
` && set && !set.unknown)
    return resolveText({ ...set, value: `${set.value}
` }, env);
  return resolveText(shells && hereStringEchoed(input, env) || input.body, env);
}
function hereStringEchoed(input, env) {
  const source = input.target?.source;
  if (input.op !== "<<<" || !input.body?.unknown || !source?.includes("$("))
    return;
  echoes = true;
  try {
    const outer = lex(`: <<< ${source}`, env.known).commands.at(-1);
    return outer?.redirects.find((r) => r.op === "<<<")?.body;
  } finally {
    echoes = false;
  }
}
async function resolveText(text, env) {
  if (text.unknown || !text.reads?.length)
    return text;
  const pieces = text.value.split(READ);
  let value = pieces[0];
  for (const [k, path] of text.reads.entries()) {
    tick();
    const file = await readPath(path, env);
    if (file.unknown)
      return file;
    if (k + 1 < pieces.length)
      value += file.value + pieces[k + 1];
    if (value.length > MAX_BYTES)
      return unknown(LARGE);
  }
  for (const piece of pieces.slice(text.reads.length + 1))
    value += READ + piece;
  return { value };
}
function pathOf(text, env) {
  if (text.unknown || text.reads?.length || text.value === "")
    return;
  if (isAbsolute3(text.value))
    return text.value;
  return env.cwd ? resolve3(env.cwd, text.value) : undefined;
}
async function readFile(path) {
  const file = Bun.file(path);
  try {
    const stats = await file.stat();
    if (!stats.isFile())
      return unknown(`${path}, which is not a regular file`);
    if (stats.size > MAX_BYTES)
      return unknown(`${path}, which is too large to read`);
    return { value: await file.text() };
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    return unknown(`${path}, which the hook cannot read`);
  }
}
async function readPath(path, env) {
  const resolved = pathOf(path, env);
  if (!resolved && path.unknown)
    return unknown(`a file path built from ${path.unknown}, which the hook cannot expand: name the file by its literal absolute path`);
  if (!resolved)
    return unknown("a file path the hook cannot resolve");
  return env.files.get(resolved) ?? await readFile(resolved) ?? unknown(`${resolved}, which does not exist yet`);
}
function knownVariables(command, environment, cwd) {
  const values = {
    HOME: environment.HOME,
    PWD: /\b(?:cd|popd|pushd)\b/.test(command) ? undefined : cwd,
    TMPDIR: environment.TMPDIR
  };
  const known = {};
  for (const [name, value] of Object.entries(values)) {
    if (value && !command.includes(`${name}=`))
      known[name] = value;
  }
  return known;
}
var BRACE_WORDS = 64;
function braceWords(word) {
  const done = [];
  const todo = [word];
  while (todo.length > 0) {
    if (done.length + todo.length > BRACE_WORDS)
      return;
    const next = todo.pop();
    let split;
    for (let open = next.indexOf("{");open >= 0 && !split; open = next.indexOf("{", open + 1)) {
      const cuts = [open];
      let depth = 0;
      for (let k = open;k < next.length; k++) {
        if (next[k] === "{")
          depth++;
        else if (next[k] === "," && depth === 1)
          cuts.push(k);
        else if (next[k] === "}" && --depth === 0) {
          if (cuts.length > 1)
            split = [...cuts, k].slice(1).map((end, n) => next.slice(0, open) + next.slice(cuts[n] + 1, end) + next.slice(k + 1));
          break;
        }
      }
    }
    if (split)
      todo.push(...split.reverse());
    else
      done.push(next);
  }
  return done;
}

// scripts/hooks/no-raw-wa.ts
var refuse = (what) => `no-raw-wa hook refuses ${what}: the data folder's whatsapp/ holds ops-wa's linked device, its auth state, its socket and the owner's messages, which no session reads or writes. To write to the owner on WhatsApp, run playground wa send <absolute file>; to see ops-wa's state, read its row on the System page.`;
var refuseJob = (what) => `no-raw-wa hook refuses ${what}: the relay tags each line with its queue's job, and a line tagged [ops-wa] or [ops-dm-watch] reads as the owner's own words, so only ops-wa and ops-dm-watch queue under those jobs. Queue your line under your own job, notify.sh <your job> <text>, or tell your manager with SendMessage.`;
var OWNER_JOBS = new Set(["dm-watch", "wa"]);
var RECURSIVE = new Set(["ack", "ag", "ditto", "find", "rg", "rsync", "tar"]);
var RECURSIVE_WITH = {
  cp: /^-[A-Za-z]*[rRa]|^--(?:recursive|archive)$/,
  egrep: /^-[A-Za-z]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$/,
  fgrep: /^-[A-Za-z]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$/,
  grep: /^-[A-Za-z]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$/,
  scp: /^-[A-Za-z]*r/,
  zip: /^-[A-Za-z]*r/
};
var targetsOf = (environment) => {
  const typed = resolve4(dataDirOf(environment), "whatsapp");
  let real = typed;
  try {
    real = resolve4(realpathSync2(dataDirOf(environment)), "whatsapp");
  } catch {}
  return [...new Set([typed, real].map((p) => p.toLowerCase()))];
};
var queuesOf = (environment) => {
  const data = dataDirOf(environment);
  let real = data;
  try {
    real = realpathSync2(data);
  } catch {}
  return [
    ...new Set([data, real].flatMap((d) => [...OWNER_JOBS].map((job) => resolve4(d, "ops", "outbox", `ops-${job}.jsonl`).toLowerCase())))
  ];
};
var segments = (path) => resolve4(path).toLowerCase().split("/").filter(Boolean);
function reach(path, target, glob = false) {
  const p = segments(path);
  const t = segments(target);
  for (let i = 0;i < Math.min(p.length, t.length); i++) {
    if (glob && p[i].includes("**"))
      return "inside";
    if (!(glob ? new Bun.Glob(p[i]).match(t[i]) : p[i] === t[i]))
      return;
  }
  return p.length >= t.length ? "inside" : "above";
}
var worst = (path, targets, glob = false) => {
  const found = targets.map((t) => reach(path, t, glob));
  return found.includes("inside") ? "inside" : found.includes("above") ? "above" : undefined;
};
var namesTarget = (command, targets) => {
  const text = command.replace(/["'\\]/g, "").toLowerCase();
  return targets.some((t) => text.includes(t)) || /(?:\.playground|playground_data_dir\}?)\/+whatsapp(?![\w.-])/.test(text);
};
var namesOwnerJob = (command) => {
  const text = command.replace(/["'\\]/g, "").toLowerCase();
  return /notify\.sh\s+(?:dm-watch|wa)(?![\w.-])/.test(text) || /outbox\/+ops-(?:dm-watch|wa)\.jsonl/.test(text);
};
var readOf = (word, at) => {
  if (!marked(word.value))
    return word;
  if (!word.raw)
    return;
  const known = { ...at.known };
  for (const [key, text] of at.vars)
    if (!marked(text.value))
      known[key] = text.value;
  const again = lex(word.raw, known).commands[0]?.words[0];
  return again && !marked(again.value) ? again : undefined;
};
var recursive = (name, args) => RECURSIVE.has(name) || args.some((a) => RECURSIVE_WITH[name]?.test(a.value));
var ownerJob = (name, args, at) => {
  let rest = args;
  if (SHELLS.has(name)) {
    const { inline, operand } = shellOperand(args, name);
    if (inline || !operand || program(operand.value) !== "notify.sh")
      return;
    rest = args.slice(args.indexOf(operand) + 1);
  } else if (program(name) !== "notify.sh")
    return;
  if (!rest[0])
    return;
  const job = readOf(rest[0], at);
  if (!job)
    return refuseJob("a notify.sh call whose job it cannot read");
  if (OWNER_JOBS.has(job.value))
    return refuseJob(`a notify.sh call as ops-${job.value}`);
};
async function judgeBash(command, cwd, environment) {
  const targets = targetsOf(environment);
  if (namesTarget(command, targets))
    return refuse("a command naming whatsapp/ in the data folder");
  if (namesOwnerJob(command))
    return refuseJob("a command naming an owner-word job's queue");
  const queues = queuesOf(environment);
  const env = {
    cwd,
    files: new Map,
    known: knownVariables(command, environment, cwd),
    process: environment,
    vars: new Map,
    visitShells: true
  };
  const visit = async (cmd, { args, first, name }, at) => {
    const job = ownerJob(name, args, at);
    if (job || SHELLS.has(name))
      return job;
    const words = [
      ...first ? [first] : [],
      ...args,
      ...cmd.redirects.flatMap((r) => r.target ? [r.target] : [])
    ];
    for (const place of places(at)) {
      if (place.cwd && worst(place.cwd, targets) === "inside")
        return refuse(`a command run inside whatsapp/ in the data folder`);
      for (const typed of words) {
        const word = readOf(typed, at);
        if (!word?.value)
          continue;
        for (const raw of [word.value, word.value.slice(word.value.indexOf("=") + 1)]) {
          const value = /^~(?:\/|$)/.test(raw) ? `${homedir4()}${raw.slice(1)}` : raw;
          const path = value.startsWith("/") ? value : place.cwd && resolve4(place.cwd, value);
          if (!path)
            continue;
          const stands = worst(path, targets, !!word.glob);
          if (stands === "inside")
            return refuse(`${visible(word.value)}, which reaches whatsapp/ in the data folder`);
          if (worst(path, queues, !!word.glob) === "inside")
            return refuseJob(`${visible(word.value)}, an owner-word job's queue`);
          if (stands === "above" && recursive(program(name), args))
            return refuse(`${name} through ${visible(word.value)}, which reads whatsapp/ in the data folder on its way down`);
        }
      }
    }
  };
  return run(lex(command, env.known), env, visit, true);
}
var FILE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Read", "Write"]);
async function inspect(raw, environment) {
  const {
    cwd,
    tool_input: input,
    tool_name: tool
  } = JSON.parse(raw);
  const folder = typeof cwd === "string" ? cwd : undefined;
  const targets = targetsOf(environment);
  if (tool === "Bash" && typeof input?.command === "string")
    return judgeBash(input.command, folder, environment);
  if (typeof tool === "string" && FILE_TOOLS.has(tool)) {
    const path = input?.file_path ?? input?.notebook_path;
    if (typeof path === "string" && worst(path, targets) === "inside")
      return refuse(`a ${tool} of ${path}`);
    if (typeof path === "string" && worst(path, queuesOf(environment)) === "inside")
      return refuseJob(`a ${tool} of ${path}, an owner-word job's queue`);
    return;
  }
  if (tool === "Grep" || tool === "Glob") {
    const path = typeof input?.path === "string" ? input.path : folder;
    if (!path)
      return;
    const at = worst(path, targets);
    if (at === "inside" || tool === "Grep" && at === "above")
      return refuse(`a ${tool} through ${path}, which reads whatsapp/ in the data folder`);
    const pattern = input?.pattern;
    if (tool === "Glob" && typeof pattern === "string" && worst(resolve4(path, pattern), targets, true) === "inside")
      return refuse(`a Glob of ${pattern}, which reaches whatsapp/ in the data folder`);
  }
}
async function check(raw, environment = process.env) {
  try {
    return await eachInput(raw, "no-raw-wa", (one) => inspect(one, environment));
  } catch {
    return;
  }
}
if (import.meta.main) {
  const raw = await input("no-raw-wa", "guard");
  const reason = await fromFactory(raw) ? await check(raw) : undefined;
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}
export {
  check,
  reach
};
