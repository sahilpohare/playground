// @bun
const __CHECKOUT = import.meta.dir.slice(0, import.meta.dir.lastIndexOf("/scripts/hooks/bundled"));

// scripts/hooks/no-desktop-owner-app.ts
import { realpathSync as realpathSync2 } from "fs";
import { join as join5, resolve as resolve3 } from "path";

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

// packages/scripts/src/main-checkout.ts
import { existsSync } from "fs";
import { dirname, join } from "path";
var mainCheckout = (from = join(__CHECKOUT + "/packages/scripts/src", "..", "..", "..")) => {
  if (process.env.PLAYGROUND_REPO)
    return process.env.PLAYGROUND_REPO;
  const git = Bun.spawnSync([
    "git",
    "-C",
    from,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  const root = git.exitCode === 0 ? dirname(git.stdout.toString().trim()) : from;
  return existsSync(join(root, "scripts", "spawn.sh")) ? root : join(dirname(from), "playground");
};

// scripts/hooks/lists.ts
import { existsSync as existsSync3 } from "fs";

// packages/env/src/data-dir.ts
import { homedir } from "os";
import { isAbsolute, join as join2, resolve } from "path";
var dataDirOf = (env, home = env.HOME || homedir()) => {
  const named = env.PLAYGROUND_DATA_DIR;
  if (!named)
    return join2(home, ".playground");
  if (!isAbsolute(named))
    throw new Error(`PLAYGROUND_DATA_DIR is relative (${named}), so each process would read it from its own folder: set it to an absolute path`);
  return resolve(named);
};
var dataDir = (env = process.env) => dataDirOf(env);

// packages/settings/src/rendered.ts
import { existsSync as existsSync2, readFileSync } from "fs";
import { join as join3 } from "path";
import { fileURLToPath } from "url";
var CORE = "core";
var coreDir = () => fileURLToPath(new URL("../../../extensions/core", import.meta.url));
var extensionsDir = (data) => join3(data, "extensions");
var markerPath = extensionsDir;
var loginPath = (data) => join3(data, "extensions", "login");
var loginOf = (data, env = process.env) => {
  if (env.PLAYGROUND_LOGIN)
    return env.PLAYGROUND_LOGIN;
  try {
    const login = readFileSync(loginPath(data), "utf8").trim();
    if (login)
      return login;
  } catch {}
  throw new Error(`no login for the extensions in ${loginPath(data)}: run playground ext init`);
};
var fixFor = (file) => {
  const list = /^hooks\/(.+)\.json$/.exec(file)?.[1];
  if (list && !existsSync2(join3(coreDir(), "lists", `${list}.json`)))
    return `tell your lead, and the dispatcher hands the owner ! playground ext put <login> list ${list} <file> --reason <why> to type in the dispatcher's terminal window, which writes it, since core ships no such list`;
  return file.startsWith("hooks/") ? "tell your lead, and the dispatcher hands the owner ! playground ext import --from-tree extensions/core/lists to type in the dispatcher's terminal window, which seeds the guards' lists" : "tell your lead, and the dispatcher asks the owner to set up settings, then fill in and save Privacy on the Dashboard's Settings page, which writes it";
};
var readRendered = async (data, file) => readRenderedSync(data, file);
var readRenderedSync = (data, file) => {
  const dir = extensionsDir(data);
  if (!existsSync2(dir))
    return {};
  const parts = file.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return { refusal: `${file} is not a path inside the extensions (${dir})` };
  const path = parts[0] === CORE ? join3(coreDir(), ...parts.slice(1)) : join3(dir, file);
  return existsSync2(path) ? { path } : { refusal: `the extensions root (${dir}) holds no ${file}: ${fixFor(file)}` };
};
var readPolicy = async (data, org) => readPolicySync(data, org);
var readPolicySync = (data, org) => {
  const read = readRenderedSync(data, "policy.json");
  if (read.refusal)
    return { refusal: read.refusal };
  if (!read.path)
    return { settings: { schemaVersion: 1, values: {} } };
  let policy;
  try {
    policy = JSON.parse(readFileSync(read.path, "utf8"));
  } catch {
    return {
      refusal: `the extensions' policy.json does not parse (${read.path}): ${fixFor("policy.json")}`
    };
  }
  return {
    settings: {
      schemaVersion: 1,
      values: { ...policy.values, ...org ? policy.orgs?.[org.toLowerCase()] : undefined }
    }
  };
};

// scripts/hooks/lists.ts
var storeMarker = (environment = process.env) => markerPath(dataDir(environment));
async function guardList(guard, name, valid, empty, environment = process.env, file) {
  const read = await readRendered(dataDir(environment), `hooks/${name}.json`);
  if (read.refusal)
    return { refusal: `${guard} hook refused this call: ${read.refusal}, then run the call again.` };
  const path = read.path ?? file;
  return path ? loadList(guard, path, valid, empty, environment) : { list: empty };
}
async function loadList(guard, path, valid, empty, environment = process.env) {
  const refuse = (what) => ({
    refusal: `${guard} hook refused this call: its list ${path} ${what}, so it cannot check the call. Restore the file (git checkout -- it, in the checkout that holds it) or fix it, then run the call again.`
  });
  if (!existsSync3(path))
    return existsSync3(storeMarker(environment)) ? refuse(`is missing on a machine with a store (${storeMarker(environment)})`) : { list: empty };
  let value;
  try {
    value = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    return refuse(`is not JSON (${error})`);
  }
  return valid(value) ? { list: value } : refuse("lacks a key or holds a value of the wrong type");
}
var isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// scripts/hooks/shell.ts
import { AsyncLocalStorage } from "async_hooks";
import { realpathSync, statSync } from "fs";
import { homedir as homedir2 } from "os";
import { basename, dirname as dirname2, isAbsolute as isAbsolute2, resolve as resolve2 } from "path";
var UNKNOWN = "\x00";
var READ = "\x01";
var NOT_RUN = "The refusal stopped this whole Bash call, so none of its commands ran: once it is fixed, run again each one you still need.";
var MAX_BYTES = 1048576;
var MAX_SCRIPT = 131072;
var LARGE = "a text too large to read";
var deadlines = new AsyncLocalStorage;
async function withDeadline(budget, body) {
  return await deadlines.run(performance.now() + budget, body);
}
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
var held = (text) => text.value.length > MAX_BYTES ? unknown(LARGE) : text;
var BREAK = new Set([" ", "\t", `
`, ";", "&", "|", "<", ">", "(", ")"]);
var REDIRECT = /^(\d*|&)(<<<|<<-|<<|<>|<&|>&!?|>>[!|]?|>[!|]|<|>)/;
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
    } else if (ASSIGN.test(w.value))
      k++;
    else
      break;
  }
  return out;
}
var ownFirst = (cmd, first) => !!first && first === cmd.words.find((w) => w.quoted || !RESERVED.has(w.value));
var GROUPING = new Set(["}", "done", "esac", "fi"]);
var ASSIGN = /^[A-Za-z_]\w*=/;
var WRAPPERS = new Map(Object.entries({
  builtin: ["", ""],
  busybox: ["", ""],
  caffeinate: ["-d -i -m -s -u", "-t -w"],
  command: ["-p -V -v", ""],
  doas: ["-L -n -s", "-a -C -u"],
  env: ["-0 -i -v --debug --ignore-environment --null", "-P -S -u --unset"],
  exec: ["-c -l", "-a"],
  nice: ["", "-n --adjustment"],
  nocorrect: ["", ""],
  noglob: ["", ""],
  nohup: ["", ""],
  pkexec: ["--disable-internal-agent --help --keep-cwd --version", "--user"],
  repeat: ["", ""],
  stdbuf: ["", "-e -i -o --error --input --output"],
  sudo: [
    "-A -B -b -E -e -H -i -K -k -l -N -n -P -S -s -V -v --askpass --background --bell --edit --help --list --login --non-interactive --preserve-env --preserve-groups --remove-timestamp --reset-timestamp --set-home --shell --stdin --validate --version",
    "-C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user"
  ],
  time: [
    "-a -h -l -p -q -V -v --append --portability --quiet --verbose",
    "-f -o --format --output"
  ],
  timeout: ["-f -p -v --foreground --preserve-status --verbose", "-k -s --kill-after --signal"],
  xargs: [
    "-0 -o -p -r -t -x --exit --interactive --no-run-if-empty --null --open-tty --show-limits --verbose",
    "-a -d -E -L -n -P -R -S -s --arg-file --delimiter --max-args --max-chars --max-lines --max-procs --process-slot-var"
  ]
}).map(([name, [flags, values]]) => [
  name,
  { flags: new Set(flags.split(" ")), values: new Set(values.split(" ")) }
]));
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
function stdinShellOf(cmd, { args, first, name, xargs }) {
  const fed = !!cmd.stdin || !!xargs;
  if (first && !marked(first.value)) {
    if (name === "." || name === "source" || name === "eval")
      return fed || name !== "eval" && STDIN_PATHS.has(args[0]?.value ?? "") ? "shell" : undefined;
    const family = familyOf(name);
    if (family)
      return fed && interpreted(family, args, xargs) ? "code" : undefined;
    if (name === "su")
      return suCommand(args) ? undefined : "root";
    if (!SHELLS.has(name))
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
var COUNTED = new Set(["repeat", "timeout"]);
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
var join4 = (parts, separator = "") => {
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
var PYTHON = /^python(?:\d+(?:\.\d+)*)?$/;
function pythonModule(name, args) {
  if (!PYTHON.test(name))
    return;
  const at = args.findIndex((a) => a.value === "-m");
  const module = at === -1 ? undefined : args[at + 1];
  return module && { module: module.value, rest: args.slice(at + 2) };
}
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
  braced(lx.commands);
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
  const fresh = () => ({ redirects: [], scope, stdin: inherit, words: [] });
  let cmd = fresh();
  const opens = [];
  let depth = 0;
  let loops = 0;
  let after = "";
  const bodies = [];
  const heads = [];
  const end = (op) => {
    const done = cmd;
    const pipe = op === "|" || op === "|&";
    const brace = (c, value) => c.words[0]?.value === value && !c.words[0].quoted;
    if (brace(done, "}")) {
      const open = opens.pop();
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
      if (loops > 0 || loop || head || each === "foreach")
        done.repeated = true;
      if (outer && !loop && reserved.some((w) => w === "while" || w === "until"))
        done.atLeastOnce = true;
      depth = Math.max(0, depth + opened - closed);
      loops = Math.max(0, loops + (loop ? 1 : 0) - (reserved.includes("done") ? 1 : 0));
      if (depth === 0 && FREES.has(op)) {
        lx.token = freshToken();
        lx.orRun = op === "||";
      }
      after = op;
      for (const w of done.words) {
        if (w.value !== "{" || w.quoted)
          break;
        opens.push(lx.commands.length);
      }
      lx.commands.push(done);
    }
    cmd = fresh();
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
      lx.i++;
      const piped = cmd.words.length === 0 && cmd.redirects.length === 0 ? cmd.stdin : undefined;
      end(";");
      const from = lx.commands.length;
      const scope = lx.scopes.length;
      nest(lx, piped);
      cmd.group = true;
      const members = topLevel(lx.commands.slice(from), scope);
      cmd.inner = () => members;
    } else if ((c === "<" || c === ">") && src[lx.i + 1] === "(") {
      cmd.words.push(procSub(lx));
    } else if (redirect) {
      lx.i += redirect[0].length;
      while (src[lx.i] === " " || src[lx.i] === "\t")
        lx.i++;
      const [, fd] = redirect;
      const op = redirect[2].replace(/!$/, "|").replace(/^(>[>&])\|$/, "$1");
      const target = src.startsWith("<(", lx.i) ? procSub(lx) : word(lx);
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
function word(lx) {
  const { src } = lx;
  const start = lx.i;
  const out = { quoted: false, value: "" };
  let bare = "";
  while (lx.i < src.length && (!BREAK.has(src[lx.i]) || src[lx.i] === "(" && lx.i > start && src[lx.i + 1] !== ")")) {
    tick();
    const c = src[lx.i];
    const next = src[lx.i + 1] ?? "";
    if (c === "(") {
      const end = balanced(src, lx.i, "(", ")");
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
      out.value += homedir2();
      lx.i++;
    } else {
      if (c === UNKNOWN || c === READ)
        out.splits = true;
      out.value += c;
      bare += c;
      lx.i++;
    }
  }
  if (/\{(?=[^{}]*\})[^{}]*(?:,|\.\.)/.test(bare))
    out.unknown ??= "a brace expansion";
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
    const name = /^\$\{([A-Za-z_]\w*)\}$/.exec(src.slice(lx.i, end))?.[1];
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
    if ((src[sub.i] === "<" || src[sub.i] === ">") && src[sub.i + 1] === "(")
      procSub(sub);
    else
      word(sub);
    if (sub.i === from)
      sub.i++;
  }
}
function balanced(src, from, open, close, plain = false) {
  let depth = 0;
  for (let i = from;i < src.length; i++) {
    tick();
    const c = src[i];
    if (c === "\\")
      i++;
    else if (c === "'" && !plain) {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end;
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
      rest: rest.slice(0, Math.max(0, rest.length - drop)),
      xargs: state.xargs && { ...state.xargs }
    }, wrapper, budget));
  };
  for (let wrapper = inside;; wrapper = undefined) {
    if (!wrapper) {
      wrapper = program(peek()?.value ?? "");
      if (!WRAPPERS.has(wrapper))
        break;
      if (wrapper === "xargs")
        state.xargs ??= {};
      take();
    }
    const options = WRAPPERS.get(wrapper);
    for (let w = peek();w; w = peek()) {
      const v = w.value;
      if (ASSIGN.test(v))
        assign(local, take());
      else if (wrapper === "env" && SPLIT.test(v)) {
        const attached = SPLIT.exec(v)?.[1] ?? "";
        take();
        const split = (attached || take()?.value || "").split(/\s+/).filter(Boolean);
        for (let j = split.length - 1;j >= 0; j--)
          rest.push({ quoted: false, value: split[j] });
      } else if (wrapper === "env" && (v === "-C" || v === "--chdir")) {
        take();
        state.chdir = take();
      } else if (wrapper === "env" && /^(?:-C|--chdir=)./.test(v)) {
        state.chdir = slice(w, v.startsWith("-C") ? 2 : "--chdir=".length);
        take();
      } else if (state.xargs && /^(?:-[IiJ]|--replace)/.test(v)) {
        const attached = /^(?:-[IiJ]|--replace=?)(.*)$/.exec(v)?.[1] ?? "";
        take();
        state.xargs.replace = v === "-I" || v === "-J" ? take()?.value : attached || "{}";
      } else if (wrapper === "env" && v === "-") {
        take();
      } else if (v === "--") {
        take();
        while (ASSIGN.test(peek()?.value ?? ""))
          assign(local, take());
        break;
      } else if (v.startsWith("-") && v !== "-") {
        const end = wrapper === "nice" && /^-\d+$/.test(v) ? "own" : marked(v) ? undefined : optionValue(v, options);
        if (!end)
          fork(wrapper, 2);
        else if (end === "next" && marked(rest[rest.length - 2]?.value ?? "")) {
          fork(wrapper, 1);
          fork(wrapper, 3);
        }
        rest.length = Math.max(0, rest.length - (end === "next" ? 2 : 1));
      } else
        break;
    }
    if (COUNTED.has(wrapper))
      take();
  }
  const first = take();
  return {
    also,
    args: rest.reverse(),
    chdir: state.chdir,
    first,
    local,
    name: first ? program(first.value) : "",
    xargs: state.xargs
  };
}
function slotWords({ args, name }) {
  if (name !== "run-slot.sh")
    return;
  const at = args.findIndex((a) => a.value === "--");
  return at === -1 ? [] : args.slice(at + 1);
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
  for (const cmd of lexed.commands) {
    const verdict = await examine(cmd, envOf(cmd.scope), visit, builtins);
    if (verdict)
      return verdict;
  }
}
var subshell = (env) => ({ ...env, vars: new Map(env.vars) });
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
  const expanded = expandTilde(cmd, primary.name, env);
  const before = others.length > 0 || expanded.length > 0 ? apart(env) : env;
  const verdict = await examineReading(cmd, primary, env, visit, builtins);
  if (verdict)
    return verdict;
  for (const parsed of others) {
    const verdict = await examineReading(cmd, parsed, apart(before), visit, builtins);
    if (verdict)
      return verdict;
  }
  for (const variant of expanded) {
    const verdict = await examineExpanded(cmd, variant, before, visit, builtins);
    if (verdict)
      return verdict;
  }
  if (!cmd.runsStdin || stdinScript(primary))
    return;
  for (const script of await scriptStdin(cmd, env)) {
    const verdict = await nested(cmd, env, () => run(lexScript(known(script), env), subshell(env), visit, builtins));
    if (verdict)
      return verdict;
  }
}
function stdinScript({ args, name }) {
  if (name === "." || name === "source")
    return STDIN_PATHS.has(args[0]?.value ?? "");
  if (!SHELLS.has(name))
    return false;
  const { inline, operand } = shellOperand(args, name);
  return !operand || !inline && STDIN_PATHS.has(operand.value);
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
async function examineReading(cmd, parsed, env, visit, builtins) {
  const { args, chdir, local, name } = parsed;
  const into = chdir && pathOf(chdir, env);
  const here = chdir ? {
    ...env,
    cwd: into,
    cwdHeld: [],
    cwdMaybe: [],
    cwdSure: into,
    cwdUnread: into === undefined
  } : env;
  let verdict;
  const followed = SHELLS.has(name) || [".", "cd", "eval", "popd", "pushd", "source"].includes(name);
  if (followed && builtins && cmd.redirects.length > 0) {
    const bare = { ...cmd, bareOf: cmd, words: [] };
    verdict = await visit(bare, parse(bare), here);
    if (verdict)
      return verdict;
  }
  if (name === "") {
    for (const [key, value] of local)
      setVar(env.vars, key, value);
    if (builtins || cmd.feedsShell || rootFed(cmd))
      verdict = await visit(cmd, parsed, here);
  } else if (name === "cd" || name === "popd" || name === "pushd") {
    if (name !== "popd" && args.some((a) => GLOB_CHARS.test(a.value)))
      verdict = await visit(cmd, parsed, here);
    await chdirTo(name, cmd, parsed, env);
  } else if (EXPORTS.has(name)) {
    for (const w of args.filter((a) => ASSIGN.test(a.value))) {
      const eq = w.value.indexOf("=");
      setVar(env.vars, w.value.slice(0, eq), slice(w, eq + 1));
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
    verdict = (args.some(unreadWord) ? await visit(cmd, parsed, here) : undefined) ?? await nested(cmd, env, () => run(again(lexScript(args.map((a) => a.value).join(" "), env), cmd, parsed), here, visit, builtins));
  } else
    verdict = await visit(cmd, parsed, here);
  await record(cmd, name, args, here);
  return verdict;
}
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
var manyTimes = (cmd, { first }) => !!cmd.repeated || cmd.words.slice(0, first ? cmd.words.indexOf(first) : 0).some((w) => !w.quoted && COUNTED.has(program(w.value)));
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
  for (let dir = dirname2(path);; dir = dirname2(dir)) {
    tick();
    out.push(dir);
    if (dir === dirname2(dir))
      return out;
  }
}
var tildeSign = (name, dir, env) => (name === "cd" || name === "pushd") && env.old && dir?.tilde && !dir.unknown && !dir.reads?.length ? dir.value[1] : undefined;
async function cdTarget(name, args, env) {
  const dir = args.find((a) => !(a.value.startsWith("-") && a.value.length > 1));
  if (!dir)
    return homedir2();
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
function cdTargets(name, cmd, parsed, env, from) {
  const dirs = parsed.args.filter((a) => !(a.value.startsWith("-") && a.value.length > 1));
  const [dir] = dirs;
  if (!dir) {
    return name === "cd" ? { paths: [homedir2()], unread: false } : { back: true, paths: [homedir2()], unread: true };
  }
  if (dir.value === "-")
    return { back: true, paths: [], unread: true };
  const paths = new Set;
  const many = manyTimes(cmd, parsed);
  const physical = physicalCd(parsed.args);
  let unread = dirs.length > 1;
  for (const typed of dirs.length > 1 ? dirs : [dir]) {
    const word = env.hold?.(typed, cmd, env) ?? typed;
    if (word !== typed)
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
    return realpathSync.native(isAbsolute2(word.value) ? word.value : `${base}/${word.value}`);
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
  env.cwd = name === "popd" || cmd.detached ? undefined : await cdTarget(name, parsed.args, env);
  if (env.old)
    env.old = name === "popd" ? {} : { dir: env.cwd === undefined ? undefined : left };
  if (env.old)
    env.oldFrom = [];
  const from = startFolders(env);
  const back = [...new Set([...env.cwdBack ?? [], ...from])];
  const bases = [...new Set([...from, ...env.cwdHeld ?? []])];
  const move = name === "popd" ? { back: true, paths: [], unread: true } : tildeMove(cdTargets(name, cmd, parsed, env, bases), name, parsed, env, from, back);
  const { paths, unread } = move;
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
  if (!env.cwdChain?.length || cmd.chain === env.cwdChainToken)
    return;
  env.cwdMaybe = keep([...new Set([...env.cwdMaybe ?? [], ...env.cwdSure ? [env.cwdSure] : [], ...env.cwdChain])], env);
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
function shellOperand(args, shell) {
  const takes = shell === "bash" || shell === "sh" ? BASH_TAKES : SHELL_TAKES;
  let inline = false;
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (takes.has(v))
      k++;
    else if (/^[-+][A-Za-z]+$/.test(v))
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
  return join4(await Promise.all(cmds.map((c) => outputOf(c, env))));
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
    env.files.set(path, held(r.op === ">>" ? join4([await existing(path, env), out]) : out));
  }
  if (name !== "tee")
    return;
  const input = await stdinOf(cmd, env);
  const append = args.some((a) => a.value === "-a" || a.value === "--append");
  for (const a of args) {
    const path = a.value.startsWith("-") ? undefined : pathOf(a, env);
    if (path)
      env.files.set(path, held(append ? join4([await existing(path, env), input]) : input));
  }
}
async function existing(path, env) {
  return env.files.get(path) ?? await readFile(path) ?? { value: "" };
}
async function outputOf(cmd, env) {
  tick();
  const { args, name } = parse(cmd);
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
    return join4(parts);
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
    return { value: printf(values.map((v) => v.value)) };
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
    return held(cmd.stdin ? await outputOf(cmd.stdin, env) : unknown("stdin the hook cannot see"));
  return held(await redirectText(input, env, false));
}
async function scriptStdin(cmd, env) {
  const own = await stdinOf(cmd, env);
  tick();
  const fed = held(await stdinText(cmd, env));
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
  if (isAbsolute2(text.value))
    return text.value;
  return env.cwd ? resolve2(env.cwd, text.value) : undefined;
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
function parseFlags(args, takes) {
  const flags = [];
  const positionals = [];
  for (let k = 0;k < args.length; k++) {
    const w = args[k];
    const v = w.value;
    if (v === "--") {
      positionals.push(...args.slice(k + 1));
      break;
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const name = eq === -1 ? v : v.slice(0, eq);
      flags.push({
        name,
        value: eq !== -1 ? slice(w, eq + 1) : takes.has(name) ? args[++k] : undefined
      });
    } else if (v.startsWith("-") && v.length > 1) {
      for (let c = 1;c < v.length; c++) {
        const name = `-${v[c]}`;
        if (!takes.has(name)) {
          flags.push({ name });
          continue;
        }
        const rest = c + 1 < v.length ? slice(w, v[c + 1] === "=" ? c + 2 : c + 1) : args[++k];
        flags.push({ name, value: rest });
        break;
      }
    } else
      positionals.push(w);
  }
  return { flags, positionals };
}
var unreadable = (text) => Boolean(text.unknown) || Boolean(text.reads?.length) || marked(text.value);
var fromXargs = (text, xargs) => Boolean(xargs?.replace) && text.value.includes(xargs?.replace ?? "");
var flagFromXargs = (text, xargs) => fromXargs(text, xargs) && (text.value.startsWith(xargs?.replace ?? "") || text.value.startsWith("-"));
function viaXargs(text, xargs) {
  return fromXargs(text, xargs) ? unknown(`what xargs puts in place of ${xargs?.replace}`) : text;
}
function ghCommand(args) {
  const repos = [];
  const head = [];
  let k = 0;
  while (k < args.length && head.length < (head[0] === "api" ? 1 : 2)) {
    const v = args[k].value;
    if (v === "-R" || v === "--repo") {
      if (args[k + 1])
        repos.push(args[k + 1]);
      k += 2;
    } else if (v.startsWith("--repo="))
      repos.push(slice(args[k++], 7));
    else if (v.startsWith("-R"))
      repos.push(slice(args[k++], 2));
    else if (v.startsWith("-"))
      k++;
    else
      head.push(args[k++].value);
  }
  return { head, repos, rest: args.slice(k) };
}
async function ghApi(args, cmd, env, xargs) {
  const { flags, positionals } = parseFlags(args, API_TAKES);
  const [endpoint] = positionals;
  if (!endpoint)
    return;
  const fields = [];
  const inputs = [];
  let method;
  for (const { name, value } of flags) {
    if (!value)
      continue;
    if (name === "-X" || name === "--method")
      method = value.unknown ? "POST" : value.value.toUpperCase();
    else if (name === "--input")
      inputs.push(value.value === "-" ? await stdinOf(cmd, env) : await readPath(value, env));
    else if (API_FIELDS.has(name)) {
      const eq = value.value.indexOf("=");
      const key = eq === -1 ? value.value : value.value.slice(0, eq);
      const field = eq === -1 ? { quoted: false, value: "" } : slice(value, eq + 1);
      const fromFile = (name === "-F" || name === "--field") && field.value.startsWith("@") && !field.unknown;
      const text = !fromFile ? field : field.value === "@-" ? await stdinOf(cmd, env) : await readPath(slice(field, 1), env);
      fields.push(fromXargs(value, xargs) ? { key: "body", text: viaXargs(value, xargs) } : { key, text });
    }
  }
  if (xargs && !xargs.replace) {
    fields.push({
      key: "body",
      text: unknown("the arguments xargs appends; a read passes with -X GET")
    });
  }
  if (args.some((a) => flagFromXargs(a, xargs))) {
    fields.push({ key: "body", text: unknown(`what xargs puts in place of ${xargs?.replace}`) });
  }
  const sent = fields.length + inputs.length > 0;
  return { endpoint, fields, inputs, method: method ?? (sent ? "POST" : "GET") };
}
var curlUrls = (flags, positionals) => [
  ...positionals,
  ...flags.filter((f) => f.name === "--url" && f.value).map((f) => f.value)
];
async function curlData(flags, cmd, env) {
  const data = [];
  for (const { name, value } of flags) {
    if (!value || !CURL_DATA.has(name))
      continue;
    if (name === "-T" || name === "--upload-file")
      data.push(await readPath(value, env));
    else if (value.value.startsWith("@") && name !== "--data-raw" && name !== "--form-string") {
      data.push(value.value === "@-" ? await stdinOf(cmd, env) : await readPath(slice(value, 1), env));
    } else
      data.push(value);
  }
  return data;
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

// scripts/hooks/no-desktop-owner-app.ts
var GUARD = "no-desktop-owner-app";
var TOOL = /^agent-desktop(?:@.*)?$/;
var MENTION = /agent-desktop/i;
var LAUNCHERS = new Set([
  "bun",
  "bunx",
  "find",
  "flock",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "setsid",
  "watch",
  "yarn"
]);
var BUN_DATA_SCRIPTS = new Map([
  ["ask", "api/hono/src/bin/dashboard-ask.ts"],
  ["thread", "api/hono/src/bin/dashboard-thread.ts"]
]);
var PREBUILD = "bun --no-env-file packages/scripts/src/verify/prebuild.ts api";
var realOf = (path) => {
  try {
    return realpathSync2(path);
  } catch {
    return resolve3(path);
  }
};
async function mapsDataScript(cwd, script) {
  const entry = BUN_DATA_SCRIPTS.get(script);
  if (entry === undefined || cwd === undefined)
    return false;
  if (realOf(cwd) !== realOf(mainCheckout()))
    return false;
  const pkg = Bun.file(join5(cwd, "package.json"));
  if (!await pkg.exists())
    return false;
  try {
    const { scripts } = JSON.parse(await pkg.text());
    if (scripts?.[script] !== `${PREBUILD} && bun ${entry}`)
      return false;
  } catch {
    return false;
  }
  return await Bun.file(join5(cwd, entry)).exists();
}
var LINES = new Set(["flock", "setsid", "watch"]);
var WATCH_TAKES = new Set(["--equexit", "--interval", "--shotsdir", "-n", "-q", "-s"]);
var INTERPRETERS = new Set([
  "bun",
  "deno",
  "node",
  "osascript",
  "perl",
  "python",
  "python3",
  "ruby"
]);
var TAKES = new Set([
  "--agent-id",
  "--screenshot",
  "--session",
  "--trace",
  "--wait-for",
  "--wait-for-gone",
  "--wait-timeout",
  "-w"
]);
var FRONT = new Set([
  "dismiss-all-notifications",
  "dismiss-notification",
  "find",
  "focus-window",
  "list-notifications",
  "list-surfaces",
  "maximize",
  "minimize",
  "move-window",
  "press",
  "resize-window",
  "restore",
  "screenshot",
  "snapshot"
]);
var ROOTED = new Set(["find", "snapshot"]);
var TARGETED = new Set(["close-app", "launch"]);
var OWNER = "tell your lead, and the dispatcher hands the owner the command to run with the ! prefix in the dispatcher's terminal window, where it runs outside the hooks";
var headed = () => `${GUARD} hook refused this agent-desktop call: it carries --headed, whose physical input moves the owner's own pointer and focus. --headed is the owner's alone, so ${OWNER}.`;
var listed = (app) => `${GUARD} hook refused this agent-desktop call: it targets ${app}, an app on the desktop-owner-apps guard list of the owner's own apps. Leave it alone; when the task needs it, ${OWNER}; or, to take ${app} off the list in the owner's login extension, tell your lead, who posts an apps decision with playground ask new (.agents/dashboard/asks.md), whose Approve takes it off.`;
var unread = (what) => `${GUARD} hook refused this agent-desktop call: it cannot read ${what} before the command runs, so it cannot tell whether the call carries --headed or targets an app on the desktop-owner-apps list. Write the agent-desktop command's every word literally as a command of its own, or ${OWNER}.`;
var front = (sub) => `${GUARD} hook refused this agent-desktop call: ${sub} with no --app acts on the app in front, which may be one of the owner's own. Name the app with --app <App>, or act on a ref a snapshot of that app gave.`;
var SCRIPT_IN_CALL = "a script file in a call that names agent-desktop, since the call may change it";
var reasonOf = (refusal) => refusal.split(/: tell your lead, and the dispatcher hands the owner|\. Restore the file/)[0];
var appName = (value) => (value.split("/").filter(Boolean).pop() ?? "").replace(/\.app$/i, "").trim().toLowerCase();
function judge(words, viaXargs, apps) {
  if (viaXargs)
    return unread("the words xargs appends");
  const hidden = words.find((w) => unreadable(w));
  if (hidden)
    return unread(hidden.unknown ? `a word built from ${hidden.unknown}` : "a word");
  const values = words.map((w) => w.value);
  if (values.some((v) => v === "--headed" || v.startsWith("--headed=")))
    return headed();
  let sub = "";
  let at = -1;
  for (let k = 0;k < values.length; k++) {
    if (TAKES.has(values[k]))
      k++;
    else if (!values[k].startsWith("-")) {
      sub = values[k];
      at = k;
      break;
    }
  }
  if (sub === "batch")
    return unread("the commands a batch's JSON holds; run each on its own");
  if (sub === "notification-action")
    return unread("which app a notification index belongs to");
  if (values.some((v) => v === "--window-id" || v.startsWith("--window-id=")))
    return unread("which app a --window-id belongs to");
  const named = [];
  values.forEach((v, k) => {
    if (v === "--app" && values[k + 1] !== undefined)
      named.push(values[k + 1]);
    else if (v.startsWith("--app="))
      named.push(v.slice("--app=".length));
  });
  if (TARGETED.has(sub))
    named.push(...values.slice(at + 1).filter((v) => !v.startsWith("-")));
  const hit = named.find((v) => apps.has(appName(v)));
  if (hit)
    return listed(hit);
  const rooted = ROOTED.has(sub) && values.some((v) => v === "--root" || v.startsWith("--root="));
  if (FRONT.has(sub) && named.length === 0 && !rooted)
    return front(sub);
}
var OPENER_BEFORE = new Set(["(", ",", "=", ":", "+", ";"]);
var CLOSER_AFTER = new Set([")", "]", "}", ",", ";", ".", "+", ":"]);
var opensAt = (code, k) => k === 0 || /\s/.test(code[k - 1]) || OPENER_BEFORE.has(code[k - 1]);
var closesAt = (code, k) => k >= code.length || /\s/.test(code[k]) || CLOSER_AFTER.has(code[k]);
function quotedParts(code) {
  const strings = [];
  let outside = "";
  let k = 0;
  while (k < code.length) {
    const c = code[k];
    if (c !== "'" && c !== '"' && c !== "`" || !opensAt(code, k)) {
      outside += c;
      k++;
      continue;
    }
    const quote = code.startsWith(c.repeat(3), k) ? c.repeat(3) : c;
    let text = "";
    let closed = false;
    k += quote.length;
    while (k < code.length) {
      if (code[k] === "\\") {
        text += code.slice(k, k + 2);
        k += 2;
      } else if (code.startsWith(quote, k)) {
        closed = closesAt(code, k + quote.length);
        k += quote.length;
        break;
      } else
        text += code[k++];
    }
    strings.push({ closed, quote, text });
    outside += " ";
  }
  return { outside, strings };
}
var RUNNERS = new Set([...LAUNCHERS, ...SHELLS, "command", "exec", "time", "xargs"]);
async function runsTool(line) {
  try {
    const env = { cwd: undefined, files: new Map, known: {}, process: {}, vars: new Map };
    const visit = async (_, { args, first, name }) => TOOL.test(name) || first !== undefined && unreadable(first) || LAUNCHERS.has(name) && args.some((a) => TOOL.test(program(a.value))) || (INTERPRETERS.has(name) || LINES.has(name)) && args.some((a) => MENTION.test(a.value)) || name === "source" || name === "." || first?.value.includes("/") ? "runs" : undefined;
    return await run(lex(line), env, visit) !== undefined;
  } catch {
    return true;
  }
}
async function prose(text) {
  if (/['"`\\${}\n\r]/.test(text))
    return false;
  for (const match of text.matchAll(/agent-desktop/gi)) {
    const before = text.slice(0, match.index);
    const word = before.trimEnd().split(/\s+/).pop() ?? "";
    if (!/\s$/.test(before) || !/[\p{L}\p{N},:.]$/u.test(word) || word.startsWith("-"))
      return false;
    const last = word.replace(/[,:.]+$/, "").split(/[^\w.-]/).pop() ?? "";
    if (RUNNERS.has(last.toLowerCase()))
      return false;
  }
  return !await runsTool(text);
}
async function callsTool(code) {
  if (!MENTION.test(code))
    return false;
  const { outside, strings } = quotedParts(code);
  if (MENTION.test(outside))
    return true;
  for (const { closed, quote, text } of strings)
    if (MENTION.test(text) && !(closed && (quote === "'" || quote === '"') && await prose(text)))
      return true;
  return false;
}
function lister(environment) {
  let loaded;
  return () => loaded ??= guardList(GUARD, "desktop-owner-apps", isStrings, [], environment).then((l) => l.refusal ? {
    refusal: `${reasonOf(l.refusal)}. The list changes only by the owner's act: tell your lead, and the dispatcher hands the owner the command that restores the list, then run the call again.`
  } : { apps: new Set((l.list ?? []).map(appName)) });
}
async function judgeText(text, cwd, apps, depth) {
  const lexed = lex(text);
  const mention = MENTION.test(text.replace(/["'\\]/g, ""));
  const env = { cwd, files: new Map, known: {}, process: {}, vars: new Map };
  for (const cmd of lexed.commands) {
    const { args, name } = parse(cmd);
    if (!SHELLS.has(name))
      continue;
    const { inline, operand } = shellOperand(args, name);
    if (operand && !inline) {
      const verdict = await script(operand, env, mention, apps, depth);
      if (verdict)
        return verdict;
    }
  }
  const visit = async (cmd, parsed, here) => {
    const { args, first, name, xargs } = parsed;
    if (name === "run-slot.sh") {
      const at = args.findIndex((a) => a.value === "--");
      const inner = { ...cmd, words: at === -1 ? [] : args.slice(at + 1) };
      return inner.words.length === 0 ? undefined : examine(inner, here, visit, false);
    }
    if (LINES.has(name) && mention) {
      const lines = args.filter((a) => /\s/.test(a.value)).map((a) => a.value);
      if (name === "watch") {
        let k = 0;
        while (args[k]?.value.startsWith("-"))
          k += WATCH_TAKES.has(args[k].value) ? 2 : 1;
        lines.push(args.slice(k).map((a) => a.value).join(" "));
      }
      for (const line of lines) {
        const verdict = await judgeText(line, here.cwd, apps, depth + 1);
        if (verdict)
          return verdict;
      }
    }
    let words;
    if (TOOL.test(name))
      words = args;
    else if (LAUNCHERS.has(name)) {
      const at = args.findIndex((a) => TOOL.test(program(a.value)));
      if (at !== -1)
        words = args.slice(at + 1);
    }
    if (words) {
      const list = await apps();
      return list.refusal ?? judge(words, xargs !== undefined, list.apps ?? new Set);
    }
    if (!mention) {
      const path = name === "source" || name === "." ? args[0] : undefined;
      return path || first?.value.includes("/") ? script(path ?? first, here, false, apps, depth) : undefined;
    }
    if (first && unreadable(first))
      return unread(`the program it runs (it comes from ${first.unknown ?? "a word it cannot read"})`);
    if (name === "bun" && args[0]?.value === "run" && args[1] !== undefined && !unreadable(args[1]) && args.slice(2).every((a) => !unreadable(a)) && await mapsDataScript(here.cwd, args[1].value))
      return;
    if (INTERPRETERS.has(name)) {
      for (const a of args)
        if (await callsTool(a.value))
          return unread(`what ${name} runs`);
    }
    if (name === "source" || name === "." || first?.value.includes("/"))
      return unread(SCRIPT_IN_CALL);
  };
  return run(lexed, env, visit);
}
async function script(path, env, mention, apps, depth) {
  if (mention)
    return unread(SCRIPT_IN_CALL);
  const text = await readPath(path, env);
  if (text.unknown || !MENTION.test(text.value) || depth > 2)
    return;
  return judgeText(text.value, env.cwd, apps, depth + 1);
}
async function check(raw, environment = process.env) {
  try {
    const {
      cwd,
      tool_input: toolInput,
      tool_name: tool
    } = JSON.parse(raw);
    if (tool !== "Bash" || typeof toolInput?.command !== "string")
      return;
    return await judgeText(toolInput.command, typeof cwd === "string" ? cwd : undefined, lister(environment), 0);
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/role.ts
import { homedir as homedir3 } from "os";
import { join as join6 } from "path";

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
var held2 = globalThis;
var setSessionNames = (next) => {
  held2[NAMES] = next;
};
var getSessionNames = () => held2[NAMES] ?? DEFAULT_SESSION_NAMES;
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
      const setting = join6(__CHECKOUT + "/scripts/hooks", "../../packages/scripts/src/playground/setting.ts");
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
  const dir = join6(environment.CLAUDE_CONFIG_DIR || join6(homedir3(), ".claude"), "sessions");
  for await (const file of new Bun.Glob("*.json").scan(dir)) {
    try {
      const entry = await Bun.file(join6(dir, file)).json();
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
    const index = await Bun.file(join6(environment.CODEX_HOME, "session_index.jsonl")).text();
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
  const path = join6(dataDirOf(environment), "roster.json");
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

// scripts/hooks/no-env-dump.ts
var DECLARES = new Set(["declare", "export", "typeset"]);
var refuse = (what) => `no-env-dump hook refuses ${what}: it prints environment variables, tokens included, into the transcript. To check that a variable is set, run [ -n "\${VAR:-}" ] && echo set; to run a command with a variable, run env VAR=x <command>.`;
var visit = async (cmd, { args, name }) => {
  if (name === "") {
    if (cmd.words.some((w) => !/^[A-Za-z_]\w*=/.test(w.value) && program(w.value) === "env"))
      return refuse("env with no command");
    return;
  }
  if (name === "printenv")
    return refuse("printenv");
  if (name === "set" && args.length === 0)
    return refuse("a bare set");
  if (!DECLARES.has(name))
    return;
  const operands = args.filter((a) => !/^[-+]/.test(a.value));
  if (operands.length === 0 && !args.some((a) => /^[-+]\w*[fF]/.test(a.value)))
    return refuse(`a bare ${name}`);
};
async function inspect(raw) {
  const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
  if (tool !== "Bash" || typeof toolInput?.command !== "string")
    return;
  if (!/\b(?:declare|env|export|printenv|set|typeset)\b/.test(toolInput.command.replace(/["'\\]/g, "")))
    return;
  const env = { files: new Map, known: {}, process: {}, vars: new Map };
  return run(lex(toolInput.command), env, visit, true);
}
async function check2(raw) {
  try {
    return await inspect(raw);
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-extension-repo-write.ts
import { existsSync as existsSync6 } from "fs";
import { join as join9 } from "path";

// packages/settings/src/folder.ts
import {
  existsSync as existsSync4,
  mkdirSync,
  readdirSync,
  readFileSync as readFileSync2,
  renameSync,
  rmdirSync,
  rmSync,
  statSync as statSync2,
  utimesSync,
  writeFileSync
} from "fs";
import { basename as basename2, dirname as dirname3, join as join7, relative } from "path";

// packages/safe-delete/src/index.ts
var LIMITS = { bytes: 2 * 1024 ** 3, files: 5000, perMinute: 3 };
var PLAYGROUND_AGENT = /^com\.playground\.[\w.-]+\.plist$/;
var CARVE_OUTS = {
  "dashboard-supervisor": {
    bytes: 256 * 1024 ** 2,
    files: 4000,
    folder: "ops/dashboard/builds"
  },
  jobs: { bytes: 64 * 1024, files: 1, folder: "ops/launch-agents" },
  "jobs-installed": {
    bytes: 64 * 1024,
    files: 1,
    folder: "Library/LaunchAgents",
    home: true,
    name: PLAYGROUND_AGENT
  }
};

// packages/settings/src/folder.ts
var STALE_MS = 5 * 60000;
var scopesIn = (data) => {
  const root = extensionsDir(data);
  return existsSync4(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync4(join7(root, entry.name, ".git"))).map((entry) => entry.name).sort() : [];
};

// scripts/hooks/github.ts
function repoOf(text) {
  if (text.unknown || text.reads?.length)
    return;
  const parts = text.value.trim().replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split("/").filter(Boolean);
  const [owner, repo] = parts.length === 2 ? parts : parts.slice(1, 3);
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, "") } : undefined;
}
function implicitRepos(env, local) {
  const fromEnv = local.get("GH_REPO") ?? env.vars.get("GH_REPO") ?? (env.process.GH_REPO ? { value: env.process.GH_REPO } : undefined);
  const candidates = fromEnv && fromEnv.value !== "" ? [repoOf(fromEnv)] : [];
  return [...candidates, ...remotes(env.cwd)];
}
function remoteRepo(url) {
  const path = /^(?:[a-z][a-z\d+.-]*:\/\/)?(?:[^@/]+@)?[^/:]+[:/](.+)$/i.exec(url.trim());
  const parts = path?.[1].split("/").filter(Boolean) ?? [];
  if (parts.length < 2)
    return;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1].replace(/\.git$/, "") };
}
function remotes(cwd) {
  if (!cwd)
    return [];
  const git = Bun.spawnSync(["git", "-C", cwd, "config", "--get-regexp", "^remote\\..*\\.url$"], {
    stderr: "ignore"
  });
  if (git.exitCode !== 0)
    return [];
  return git.stdout.toString().split(`
`).flatMap((line) => {
    const repo = remoteRepo(line.slice(line.indexOf(" ") + 1));
    return repo ? [repo] : [];
  });
}

// scripts/hooks/no-playground-leak.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "async_hooks";
import { existsSync as existsSync5, readdirSync as readdirSync2, readFileSync as readFileSync3, statSync as statSync3 } from "fs";
import { basename as basename3, join as join8 } from "path";

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}

class Cached {
  constructor(getter) {
    this._getter = getter;
    this._value = undefined;
  }
  get value() {
    const getter = this._getter;
    if (getter !== undefined) {
      this._value = getter();
      this._getter = undefined;
    }
    return this._value;
  }
}
function cached(getter) {
  return new Cached(getter);
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function rawShape(def) {
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
  return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
  Object.defineProperty(target, key, {
    get() {
      const value = getter();
      assignProp(this, key, value);
      return value;
    },
    enumerable: true,
    configurable: true
  });
}
function putProp(target, key, value) {
  if (key in target)
    assignProp(target, key, value);
  else
    target[key] = value;
}
function mirrorShape(target, source, keys, wrap) {
  const raw = sourceShape(source);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc.enumerable)
      continue;
    if (desc.get) {
      deferProp(target, key, () => {
        const value = source._zod.def.shape[key];
        return wrap ? wrap(value, key) : value;
      });
    } else
      putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
}
function mirrorProps(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (!desc.enumerable)
      continue;
    if (desc.get)
      deferProp(target, key, () => source[key]);
    else
      putProp(target, key, desc.value);
  }
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== undefined && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const newShape = {};
  mirrorShape(newShape, schema, maskedKeys(schema, mask));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function maskedKeys(schema, mask) {
  const raw = sourceShape(schema);
  const keys = [];
  for (const key of Reflect.ownKeys(mask)) {
    if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) {
      throw new Error(`Unrecognized key: "${String(key)}"`);
    }
    if (mask[key])
      keys.push(key);
  }
  return keys;
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const omitted = new Set(maskedKeys(schema, mask));
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = sourceShape(schema);
    for (const key of Reflect.ownKeys(shape)) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
  mirrorProps(newShape, shape);
  return newShape;
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge2(a, b) {
  if (!b?._zod?.def) {
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const newShape = {};
  mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
  mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
  const def = mergeDefs(a._zod.def, {
    shape: newShape,
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask, name = "partial") {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
  }
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({ type: "optional", innerType: value })));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape, checks: [] }));
}
function required(Class, schema, mask) {
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({ type: "nonoptional", innerType: value }));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check))
      break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0)
      caps.push([max, ch]);
  }
  return caps;
}
function attachSchema(issues, start, inst) {
  var _a;
  for (let i = start;i < issues.length; i++) {
    (_a = issues[i]).schema ?? (_a.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config) {
  var _a;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a = iss).schema ?? (_a.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : undefined;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
  const units = str.length;
  if (!highSurrogate.test(str))
    return units;
  let count = units;
  for (let i = 0;i < units - 1; i++) {
    if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function derived(computes, table) {
  for (const key in computes) {
    const compute = computes[key];
    Object.defineProperty(table, key, {
      configurable: true,
      enumerable: true,
      get() {
        return own(this, key, compute(this));
      },
      set(value) {
        own(this, key, value);
      }
    });
  }
  return table;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? undefined : proto;
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = undefined;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: undefined };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}
var CONSTANT_CATCH = "~constantCatch";
function constantCatch(value) {
  const fn = () => value;
  fn[CONSTANT_CATCH] = true;
  return fn;
}

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: undefined, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition;
      }
      try {
        return new Definition;
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition;
}
function $constructor(name, initializer, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = new Set;
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && new WeakSet;
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = undefined;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    if (initialized) {
      const own = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto = _.prototype;
    for (const k in proto) {
      if (!Object.prototype.hasOwnProperty.call(proto, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = undefined;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _issuesDesc = { value: undefined, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = undefined;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, undefined, {
  Parent: Error
});
function node(obj, key, make) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (el === "_errors") {
              if (terminal)
                curr._errors.push(mapper(issue));
              i++;
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true,
                writable: true,
                configurable: true
              });
            }
            const node = curr[el];
            if (terminal) {
              node._errors.push(mapper(issue));
            }
            curr = node;
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
  return { callee: params?.callee ?? callee, Err: params?.Err };
}
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError;
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = undefined;
        ctx = undefined;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = undefined;
      ctx = undefined;
    }
  };
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate = (schema, value, _ctx) => {
  const validator = schema._zod.bag.validator;
  if (validator !== undefined) {
    if (validator(value) !== COMPILE_INVALID)
      return true;
    if (validator.definite === true && _ctx === undefined)
      return false;
  }
  return validateFallback(schema, value, _ctx);
};
function validateFallback(schema, value, _ctx) {
  const ctx = _ctx ? { ..._ctx, async: false, abortEarly: true } : { async: false, abortEarly: true };
  const fallbackRun = schema._zod.bag.fallbackRun;
  let result;
  if (fallbackRun) {
    ctx[COMPILE_FALLBACK] = true;
    result = fallbackRun({ value, issues: [] }, ctx);
  } else {
    result = schema._zod.run({ value, issues: [] }, ctx);
  }
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length === 0;
}
var validateAsync = async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true, abortEarly: true } : { async: true, abortEarly: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length === 0;
};
var _encode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return parse(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    return parse(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _encodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
  return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function anchor(source) {
  return new RegExp(`^${source}$`);
}
var date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var _whenHasLength = (payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== undefined;
};
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units > def.maximum ? codePointLength(input) : units;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = [], closed = {}) {
    this.content = [];
    this.indent = 0;
    this.args = args;
    this.closed = closed;
  }
  indented(fn) {
    this.indent += 1;
    try {
      fn(this);
    } finally {
      this.indent -= 1;
    }
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const content = this?.content ?? [``];
    const factory = new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {
${content.join(`
`)}
};`);
    return factory(...Object.values(this.closed));
  }
}

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 7
};

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync2(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {}
      return validateAsync2(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var URL_BAD_FORMAT = 1;
var URL_UNPARSEABLE = 2;
function canParseURL(input) {
  try {
    if (typeof URL !== "undefined" && typeof URL.canParse === "function")
      return URL.canParse(input);
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
function validateURL(trimmed, def) {
  if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) {
    return canParseURL(trimmed) || URL_UNPARSEABLE;
  }
  return parseURLObject(trimmed, def);
}
function parseURLObject(trimmed, def) {
  if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) {
    return URL_BAD_FORMAT;
  }
  try {
    if (typeof URL !== "undefined") {
      const URLStatic = URL;
      if (typeof URLStatic.parse === "function")
        return URLStatic.parse(trimmed) ?? URL_UNPARSEABLE;
    }
    return new URL(trimmed);
  } catch {
    return URL_UNPARSEABLE;
  }
}
var asciiTabOrNewline = /[\t\n\r]/g;
function stripTabAndNewline(value) {
  return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
  hostname.lastIndex = 0;
  return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
  protocol.lastIndex = 0;
  return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = validateURL(trimmed, def);
      if (url === URL_BAD_FORMAT) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid URL format",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === URL_UNPARSEABLE) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === true) {
        payload.value = stripTabAndNewline(trimmed);
        return;
      }
      if (def.hostname && !urlHostnameOk(url, def.hostname)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid hostname",
          pattern: def.hostname.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      if (def.protocol && !urlProtocolOk(url, def.protocol)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid protocol",
          pattern: def.protocol.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  if (def.length !== undefined && (!Number.isInteger(def.length) || def.length < 1))
    throw new Error(`Invalid nanoid length: ${def.length}`);
  def.pattern ?? (def.pattern = def.length === undefined ? nanoid : nanoidOfLength(def.length));
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
});
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
  if (!ipv6Alphabet.test(value))
    return false;
  return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidIPv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
  const parts = value.split("/");
  if (parts.length !== 2)
    return false;
  const [address, prefix] = parts;
  if (!prefix)
    return false;
  const prefixNum = Number(prefix);
  if (`${prefixNum}` !== prefix)
    return false;
  if (prefixNum < 0 || prefixNum > 128)
    return false;
  return isValidIPv6(address);
}
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidCIDRv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64Charset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
  if (!base64urlCharset.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64urlCharset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length)
    return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse(payload, ctx);
  };
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result))
          break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
  capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== undefined && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === undefined) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent || optin === "defaulted" && !isOptionalOut) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen))
        break;
      seen = payload.issues.length;
    }
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  const sh = desc?.get ? desc.get.raw : def.shape ?? {};
  if (sh) {
    const get = () => {
      const newSh = { ...sh };
      Object.defineProperty(def, "shape", { value: newSh });
      get.raw = newSh;
      return newSh;
    };
    get.raw = sh;
    Object.defineProperty(def, "shape", { get });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
          assignProp(propValues, key, new Set);
        }
        for (const v of field.values)
          propValues[key].add(v);
        if (field.optin !== undefined)
          propValues[key].add(undefined);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    const abortEarly = ctx?.abortEarly;
    let seen = payload.issues.length;
    for (const key of value.allKeys) {
      if (abortEarly && payload.issues.length !== seen) {
        if (aborted(payload, seen))
          break;
        seen = payload.issues.length;
      }
      if (key === "__proto__")
        continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const memo = globalConfig.memoizer;
  const generateFastpass = (shape) => {
    const normalized = _normalized.value;
    const syms = normalized.symbolKeys;
    const doc = new Doc(["payload", "ctx"], { shape, inst, memo, syms });
    const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.allKeys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
    for (const key of normalized.allKeys) {
      if (key === "__proto__")
        continue;
      const id = ids[key];
      const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
      const isPresent = `${k} in input`;
      const schema = shape[key];
      const optin = schema?._zod?.optin;
      const isOptionalIn = optin !== undefined;
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(k)};`);
      if (isOptionalIn && isOptionalOut) {
        const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
        doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
        if (optin === "defaulted") {
          doc.write(`newResult[${k}] = ${id}.value;`);
        } else {
          doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
        }
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    return doc.compile();
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== undefined) ? "optional" : undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__"))
      delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__")
        continue;
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  const keyIssues = new Map;
  const collect = (iss, side) => {
    let keys;
    if (iss.code === "unrecognized_keys" && !iss.path?.length) {
      unrecIssue ?? (unrecIssue = iss);
      keys = iss.keys;
    } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
      const k = String(iss.path[0]);
      if (!keyIssues.has(k))
        keyIssues.set(k, iss);
      keys = [k];
    } else {
      return false;
    }
    for (const k of keys) {
      if (!unrecKeys.has(k))
        unrecKeys.set(k, {});
      unrecKeys.get(k)[side] = true;
    }
    return true;
  };
  for (const iss of left.issues) {
    if (!collect(iss, "l"))
      result.issues.push(iss);
  }
  for (const iss of right.issues) {
    if (!collect(iss, "r"))
      result.issues.push(iss);
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length) {
    const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
    if (aggregated.length)
      result.issues.push({ ...unrecIssue, keys: aggregated });
    for (const k of bothKeys) {
      if (!aggregated.includes(k) && keyIssues.has(k))
        result.issues.push(keyIssues.get(k));
    }
  }
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    if (aborted(result))
      return result;
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = new Set;
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__")
            continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__")
            continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result) => {
              if (result.issues.length) {
                payload.issues.push(...prefixIssues(key, result.issues));
              }
              payload.value[outKey] = result.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__")
              continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__")
          continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result) => {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  defineLazyInternal(inst, "pattern", (zod) => {
    const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
    return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  defineLazyInternal(inst, "pattern", (zod) => {
    const vals = zod.def.values;
    return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  globalConfig.memoizer?.guard(inst);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? undefined : result.value;
  return payload;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? new Set([...values, undefined]) : undefined;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === undefined) {
      if (def.innerType._zod.optin !== "defaulted")
        return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleOptionalResult(payload, result));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazyInternal(inst, "values", (zod) => {
    return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => {
    const v = zod.def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
function handleCatchResult(payload, result, def, ctx) {
  if (!result.issues.length) {
    payload.value = result.value;
    if (result.memo)
      payload.memo = true;
    return payload;
  }
  payload.value = def.catchValue({
    ...result,
    value: payload.value,
    error: {
      issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
    },
    input: payload.value
  });
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleCatchResult(payload, result, def, ctx));
    }
    return handleCatchResult(payload, result, def, ctx);
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  if (!payload.memo)
    payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/memoizer.js
class $ZodCyclicError extends Error {
  constructor() {
    super(`Cannot parse a reference cycle that closes through a transform`);
    this.name = "ZodCyclicError";
  }
}
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
  return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
  return issues.map((iss) => iss.path ? { ...iss, path: iss.path.slice() } : { ...iss });
}
var recursive = /* @__PURE__ */ new WeakMap;
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
function isRecursive(inst, stack, resolve) {
  const cached = recursive.get(inst);
  if (cached !== undefined)
    return cached ? PROVEN : NONE;
  if (stack.has(inst))
    return PROVEN;
  stack.add(inst);
  let result = NONE;
  const check = (child) => {
    if (result !== PROVEN && child?._zod) {
      const answer = isRecursive(child, stack, resolve);
      if (answer > result)
        result = answer;
    }
  };
  const shape = (sh, spread) => {
    let answer = NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key);
      if (spread && !desc.enumerable)
        continue;
      const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
      if (child > answer)
        answer = child;
    }
    return answer;
  };
  const merge = (answer) => {
    if (answer > result)
      result = answer;
  };
  const def = inst._zod.def;
  const kind = def.type;
  switch (kind) {
    case "object": {
      const raw = rawShape(def);
      merge(raw ? shape(raw, true) : ASSUMED);
      check(def.catchall);
      break;
    }
    case "array":
      check(def.element);
      break;
    case "tuple":
      for (const el of def.items)
        check(el);
      check(def.rest);
      break;
    case "record":
    case "map":
      check(def.keyType);
      check(def.valueType);
      break;
    case "set":
      check(def.valueType);
      break;
    case "union":
      for (const el of def.options)
        check(el);
      break;
    case "intersection":
      check(def.left);
      check(def.right);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "promise":
    case "success":
      check(def.innerType);
      break;
    case "pipe":
      check(def.in);
      check(def.out);
      break;
    case "function":
      check(def.input);
      check(def.output);
      break;
    case "lazy": {
      const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : undefined);
      merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
      break;
    }
    case "template_literal":
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "date":
    case "nan":
    case "enum":
    case "literal":
    case "file":
    case "transform":
    case "custom":
      break;
    default: {
      for (const key in def) {
        const desc = Object.getOwnPropertyDescriptor(def, key);
        if (!desc || desc.get)
          continue;
        const value = desc.value;
        if (!value || typeof value !== "object")
          continue;
        if (value._zod)
          check(value);
        else if (Array.isArray(value))
          for (const el of value)
            check(el);
      }
    }
  }
  stack.delete(inst);
  return settle(inst, result);
}
function settle(inst, answer) {
  if (answer !== ASSUMED)
    recursive.set(inst, answer === PROVEN);
  return answer;
}
function bucketFor(state, inst) {
  let bucket = state.buckets.get(inst);
  if (!bucket) {
    bucket = new WeakMap;
    state.buckets.set(inst, bucket);
  }
  return bucket;
}
var handoff;
var open = [];
var memo = {
  alloc(_inst, payload, empty) {
    const bucket = handoff;
    if (!bucket)
      return empty;
    handoff = undefined;
    const entry = { value: empty, issues: null };
    bucket.set(payload.value, entry);
    open.push(entry);
    return empty;
  },
  guard(inst) {
    var _a;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value))
          throw new $ZodCyclicError;
        return base(payload, ctx);
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  },
  attach(inst) {
    var _a;
    let isRecursiveInst;
    let rechecked = false;
    let lastCtx;
    let lastBucket;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (isRecursiveInst === undefined) {
          const walked = isRecursive(inst, new Set, false);
          if (walked === NONE) {
            inst._zod.parse = base;
            if (inst._zod.run === wrapped)
              inst._zod.run = base;
            return base(payload, ctx);
          }
          if (walked === PROVEN || rechecked)
            isRecursiveInst = true;
          else
            rechecked = true;
        }
        const input = payload.value;
        if (!isRef(input))
          return base(payload, ctx);
        let state = ctx[STATE];
        if (!state) {
          state = { buckets: new WeakMap, backEdges: undefined };
          ctx[STATE] = state;
        }
        let bucket;
        if (lastCtx === ctx) {
          bucket = lastBucket;
        } else {
          bucket = bucketFor(state, inst);
          lastCtx = ctx;
          lastBucket = bucket;
        }
        const hit = bucket.get(input);
        if (hit) {
          payload.value = hit.value;
          if (hit.issues) {
            if (hit.issues.length)
              payload.issues.push(...cloneIssues(hit.issues));
          } else {
            payload.memo = true;
            state.backEdges ?? (state.backEdges = new WeakSet);
            state.backEdges.add(hit.value);
          }
          return payload;
        }
        handoff = bucket;
        const depth = open.length;
        const result = base(payload, ctx);
        handoff = undefined;
        const entry = open.length > depth ? open.pop() : undefined;
        if (result instanceof Promise) {
          return result.then((r) => {
            if (entry)
              entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
            return r;
          });
        }
        if (entry)
          entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
        return result;
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  }
};
function memoizer() {
  return memo;
}
function isBackEdge(ctx, value) {
  const backEdges = ctx[STATE]?.backEdges;
  return backEdges !== undefined && isRef(value) && backEdges.has(value);
}
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/locales/en.js
var error = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    currency_code: "currency code",
    credit_card: "credit card number",
    iban: "IBAN",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  function getTypeName(type, input) {
    if (type === "number" && typeof input === "number" && !Number.isFinite(input)) {
      return String(input);
    }
    return TypeDictionary[type] ?? type;
  }
  return (issue) => {
    switch (issue.code) {
      case "invalid_type": {
        const expected = getTypeName(issue.expected);
        const receivedType = parsedType(issue.input);
        const received = getTypeName(receivedType, issue.input);
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue.origin}`;
      case "invalid_union":
        if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) {
          const opts = issue.options.map((o) => `'${o}'`).join(" | ");
          return `Invalid discriminator value. Expected ${opts}`;
        }
        if (issue.inclusive === false) {
          return "Invalid input: more than one option matched";
        }
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error()
  };
}
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/registries.js
var _a2;
class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks)
    def.checks = [...def.checks];
  return def;
}
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
  for (const source of sources) {
    for (const key of Reflect.ownKeys(source)) {
      if (Object.prototype.propertyIsEnumerable.call(source, key)) {
        assignProp(target, key, source[key]);
      }
    }
  }
  return target;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    sharedDefsExtractedFor: undefined,
    sharedEmitDoneFor: undefined,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? undefined
  };
}
function handleUnrepresentable(schema, ctx, json, params, message) {
  const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message }) : ctx.unrepresentable;
  if (result === "any")
    return false;
  if (result === undefined || result === "throw")
    throw new Error(message);
  Object.assign(json, result);
  return true;
}
function processSchema(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = undefined;
  ctx.sharedEmitDoneFor = undefined;
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    assignProps(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function encodeJSONPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external)
    return;
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) {
      return { ref: uriPrefix };
    }
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
      }
    }
  }
  if (ctx.external)
    ctx.sharedDefsExtractedFor = ctx.external;
}
function compactTypeUnion(schema) {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== undefined)
    return;
  const types = [];
  for (const option of options) {
    if (!option || typeof option !== "object")
      return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type")
      return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string")
        return;
      if (!types.includes(member))
        types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}
var FOLDABLE_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
var UNION_KEYS = ["oneOf", "anyOf"];
function undeclaredConstraint(member) {
  const extra = member.additionalProperties;
  if (extra === undefined || extra === false || typeof extra !== "object" || extra === null)
    return null;
  return Object.keys(extra).length ? extra : null;
}
function foldObjects(members) {
  const objects = [];
  for (const member of members) {
    if (typeof member !== "object" || member.type !== "object")
      return null;
    for (const key in member) {
      if (!FOLDABLE_KEYS.has(key))
        return null;
    }
    objects.push(member);
  }
  const properties = {};
  const required = new Set;
  for (const object of objects) {
    for (const key in object.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        continue;
      const parts = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === undefined)
          continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part)))
          parts.push(part);
      }
      const merged = parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts };
      assignProp(properties, key, merged);
    }
    for (const key of object.required ?? [])
      required.add(key);
  }
  const folded = { type: "object", properties };
  if (required.size)
    folded.required = [...required];
  if (objects.every((object) => object.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints = [];
    for (const object of objects) {
      const constraint = undeclaredConstraint(object);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1)
      folded.additionalProperties = constraints[0];
    else if (constraints.length > 1)
      folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}
function foldIntersection(json) {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2)
    return;
  for (const key of FOLDABLE_KEYS)
    if (key in json)
      return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
    if (Object.keys(union).length !== 1)
      return;
    const rest = allOf.filter((m) => m !== union);
    const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
    if (branches.some((b) => !b))
      return;
    folded = { [keyword]: branches };
  }
  if (!folded)
    return;
  delete json.allOf;
  assignProps(json, folded);
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        assignProps(schema, refSchema);
      }
      assignProps(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) {
      flattenRef(entry[0]);
    }
    if (ctx.target !== "openapi-3.0") {
      for (const entry of ctx.seen.entries()) {
        compactTypeUnion(entry[1].def ?? entry[1].schema);
      }
    }
    for (const rewrite of ctx.deferred)
      rewrite();
    if (ctx.intersections.length) {
      const carriers = new Map;
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf))
            continue;
          const existing = carriers.get(allOf);
          if (existing)
            existing.push(json);
          else
            carriers.set(allOf, [json]);
        }
      }
      for (const allOf of ctx.intersections) {
        for (const json of carriers.get(allOf) ?? [])
          foldIntersection(json);
      }
    }
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId)
          delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external)
    ctx.sharedEmitDoneFor = ctx.external;
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
  if (agg[key] === undefined || value > agg[key])
    agg[key] = value;
};
var narrowMax = (agg, key, value) => {
  if (agg[key] === undefined || value < agg[key])
    agg[key] = value;
};
var narrowBoth = (agg, value) => {
  narrowMin(agg, "minimum", value);
  narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
  agg.multipleOf ?? (agg.multipleOf = []);
  if (!agg.multipleOf.includes(value))
    agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
  agg.patterns ?? (agg.patterns = new Set);
  agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
  agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
  agg.format = format;
  if (format.includes("int"))
    agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
  setFormat(agg, def.format);
  const [minimum, maximum] = ranges[def.format];
  narrowMin(agg, "minimum", minimum);
  narrowMax(agg, "maximum", maximum);
};
var contributors = {
  greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
  less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
  multiple_of: (agg, def) => addDivisor(agg, def.value),
  number_format: formatContributor(NUMBER_FORMAT_RANGES),
  bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
  min_length: minContributor,
  max_length: maxContributor,
  length_equals: (agg, def) => narrowBoth(agg, def.length),
  min_size: minContributor,
  max_size: maxContributor,
  size_equals: (agg, def) => narrowBoth(agg, def.size),
  string_format: (agg, def) => {
    setFormat(agg, def.format);
    if (def.pattern)
      addPattern(agg, def.pattern);
    if (def.format === "base64" || def.format === "base64url")
      agg.contentEncoding = def.format;
    if (def.local || def.precision === -1)
      agg.laxFormat = true;
  },
  mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
  const agg = {};
  const def = schema._zod.def;
  const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
  for (const ch of list)
    contributors[ch._zod.def.check]?.(agg, ch._zod.def);
  const bag = schema._zod.bag;
  if (bag.minimum !== undefined)
    narrowMin(agg, "minimum", bag.minimum);
  if (bag.exclusiveMinimum !== undefined)
    narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
  if (bag.maximum !== undefined)
    narrowMax(agg, "maximum", bag.maximum);
  if (bag.exclusiveMaximum !== undefined)
    narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
  if (bag.multipleOf !== undefined)
    addDivisor(agg, bag.multipleOf);
  if (bag.format !== undefined) {
    agg.format ?? (agg.format = bag.format);
    if (bag.format.includes("int"))
      agg.isInt = true;
  }
  if (bag.mime)
    intersectMime(agg, bag.mime);
  for (const pattern of bag.patterns ?? [])
    addPattern(agg, pattern);
  return agg;
}
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var exactPatterns = new Map([
  [base64Charset, base64],
  [base64urlCharset, base64url]
]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time" || laxFormat) {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const patternList = [...patterns].map(exactPattern);
    if (patternList.length === 1)
      json.pattern = patternList[0].source;
    else if (patternList.length > 1) {
      json.allOf = [
        ...patternList.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
  json.type = isInt ? "integer" : "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (multipleOf) {
    const divisors = new Set;
    for (const divisor of multipleOf) {
      if (Number.isFinite(divisor) && divisor !== 0)
        divisors.add(Math.abs(divisor));
      else
        handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
    }
    const [first, ...rest] = divisors;
    if (first !== undefined)
      json.multipleOf = first;
    if (rest.length)
      json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
  }
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.length === 0) {
    json.not = {};
    return;
  }
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  if (def.values.length === 0) {
    json.not = {};
    return;
  }
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
        return;
    } else if (typeof val === "bigint") {
      if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
        return;
      vals.push(Number(val));
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var customProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = processSchema(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
function inputOptin(schema) {
  const def = schema._zod.def;
  if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) {
    return inputOptin(def.out);
  }
  if (def.type === "catch") {
    return inputOptin(def.innerType);
  }
  return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const shape = def.shape;
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  if (symbolKeys.length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) {
    return;
  }
  json.type = "object";
  json.properties = {};
  for (const key in shape) {
    assignProp(json.properties, key, processSchema(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    }));
  }
  const requiredKeys = [];
  for (const key of Object.keys(shape)) {
    const field = def.shape[key];
    if (ctx.io === "input" ? inputOptin(field) === undefined : field._zod.optout === undefined) {
      requiredKeys.push(key);
    }
  }
  if (requiredKeys.length > 0) {
    json.required = requiredKeys;
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = processSchema(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = processSchema(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = processSchema(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
  ctx.intersections.push(allOf);
};
function stringifyKeyNames(bySchema, json, visited) {
  if (json.$ref) {
    if (visited.has(json))
      return json;
    visited.add(json);
    const def = bySchema.get(json)?.def;
    if (!def)
      return json;
    const inlined = stringifyKeyNames(bySchema, def, visited);
    return inlined === def ? json : inlined;
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = json[keyword];
    if (!Array.isArray(branches))
      continue;
    const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
    if (mapped.some((branch, i) => branch !== branches[i]))
      json = { ...json, [keyword]: mapped };
  }
  const types = Array.isArray(json.type) ? json.type : [json.type];
  const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
  const values = json.enum ?? (json.const !== undefined ? [json.const] : undefined);
  if (!numericType && !values?.some((v) => typeof v === "number"))
    return json;
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
  if (rest.enum)
    rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
  else if (typeof rest.const === "number")
    rest.const = String(rest.const);
  if (!numericType)
    return rest;
  rest.type = "string";
  if (!values)
    rest.pattern = (types.includes("number") ? number : integer).source;
  return rest;
}
var pendingRecords = new WeakMap;
function rewriteKeyNames(ctx) {
  const bySchema = new Map;
  for (const entry of ctx.seen.values()) {
    if (entry.def && !bySchema.has(entry.schema))
      bySchema.set(entry.schema, entry);
  }
  const rewrites = new Map;
  for (const record of pendingRecords.get(ctx) ?? []) {
    const seen = ctx.seen.get(record);
    const names = (seen?.def ?? seen?.schema)?.propertyNames;
    if (!names || names === true || rewrites.has(names))
      continue;
    const rewritten = stringifyKeyNames(bySchema, names, new Set);
    if (rewritten !== names)
      rewrites.set(names, rewritten);
  }
  if (!rewrites.size)
    return;
  for (const entry of ctx.seen.values()) {
    for (const carrier of [entry.schema, entry.def]) {
      const rewritten = carrier && rewrites.get(carrier.propertyNames);
      if (rewritten)
        carrier.propertyNames = rewritten;
    }
  }
}
var recordProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const patterns = aggregateChecks(keyType).patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json.patternProperties = {};
    for (const pattern of patterns) {
      assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = processSchema(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
      let pending = pendingRecords.get(ctx);
      if (!pending) {
        pending = [];
        pendingRecords.set(ctx, pending);
        ctx.deferred.push(() => rewriteKeyNames(ctx));
      }
      pending.push(schema);
    }
    json.additionalProperties = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== undefined;
  if (keyValues && !def.partial && !omittableOnInput) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json.required = validKeyValues.map(String);
    }
  }
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint")
      return val;
    unrepresentable = true;
    return null;
  });
  if (!unrepresentable)
    return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io !== "input")
    return;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
    return;
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: false,
    get() {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    }
  });
}
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  const proto = Object.getPrototypeOf(inst);
  if (_installedErrorProtos.has(proto))
    return;
  _installedErrorProtos.add(proto);
  _lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
  _lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
  _lazyMethod(proto, "addIssue", (self) => (issue) => {
    self.issues.push(issue);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  _lazyMethod(proto, "addIssues", (self) => (issues) => {
    self.issues.push(...issues);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  Object.defineProperty(proto, "isEmpty", {
    configurable: true,
    enumerable: false,
    get() {
      return this.issues.length === 0;
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, undefined, {
  Parent: Error
});

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/parse.js
var parse3 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
  if (!globalConfig.localeError)
    config(en_default());
}
function _ensureDefaultMemoizer() {
  if (!globalConfig.memoizer)
    config({ memoizer: memoizer() });
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  _ensureDefaultLocale();
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  return inst;
}, {
  check(...chks) {
    const def = this.def;
    return this.clone(mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), { parent: true });
  },
  with(...chks) {
    return this.check(...chks);
  },
  clone(def, params) {
    return clone(this, def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta) {
    reg.add(this, meta);
    return this;
  },
  refine(check, params) {
    return this.check(refine(check, params));
  },
  superRefine(refinement, params) {
    return this.check(superRefine(refinement, params));
  },
  overwrite(fn) {
    return this.check(_overwrite(fn));
  },
  optional() {
    return optional(this);
  },
  exactOptional() {
    return exactOptional(this);
  },
  nullable() {
    return nullable(this);
  },
  nullish() {
    return optional(nullable(this));
  },
  nonoptional(params) {
    return nonoptional(this, params);
  },
  array() {
    return array(this);
  },
  or(arg) {
    return union([this, arg]);
  },
  and(arg) {
    return intersection(this, arg);
  },
  transform(tx) {
    return pipe(this, transform(tx));
  },
  default(d) {
    return _default(this, d);
  },
  prefault(d) {
    return prefault(this, d);
  },
  catch(params) {
    return _catch(this, params);
  },
  pipe(target) {
    return pipe(this, target);
  },
  readonly() {
    return readonly(this);
  },
  describe(description) {
    const cl = this.clone();
    globalRegistry.add(cl, { description });
    return cl;
  },
  meta(...args) {
    if (args.length === 0)
      return globalRegistry.get(this);
    const cl = this.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  },
  isOptional() {
    return this.safeParse(undefined).success;
  },
  isNullable() {
    return this.safeParse(null).success;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  },
  get "~standard"() {
    return hide(this, "~standard", {
      ...standardProps(this),
      jsonSchema: {
        input: createStandardJSONSchemaMethod(this, "input"),
        output: createStandardJSONSchemaMethod(this, "output")
      }
    });
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  },
  parse: function _parse(data, params) {
    return parse3(this, data, params, { callee: _parse });
  },
  parseAsync: async function _parseAsync(data, params) {
    return await parseAsync(this, data, params, { callee: _parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  async safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  get spa() {
    return this?.safeParseAsync;
  },
  set spa(value) {
    own(this, "spa", value);
  },
  validate(data, params) {
    return validate(this, data, params);
  },
  validateAsync(data, params) {
    return validateAsync(this, data, params);
  },
  encode: function _encode(data, params) {
    return encode(this, data, params, { callee: _encode });
  },
  decode: function _decode(data, params) {
    return decode2(this, data, params, { callee: _decode });
  },
  encodeAsync: async function _encodeAsync(data, params) {
    return await encodeAsync(this, data, params, { callee: _encodeAsync });
  },
  decodeAsync: async function _decodeAsync(data, params) {
    return await decodeAsync(this, data, params, { callee: _decodeAsync });
  },
  safeEncode(data, params) {
    return safeEncode(this, data, params);
  },
  safeDecode(data, params) {
    return safeDecode(this, data, params);
  },
  async safeEncodeAsync(data, params) {
    return safeEncodeAsync(this, data, params);
  },
  async safeDecodeAsync(data, params) {
    return safeDecodeAsync(this, data, params);
  },
  toJSONSchema(params) {
    return createToJSONSchemaMethod(this, {})(params);
  },
  get description() {
    return globalRegistry.get(this)?.description;
  },
  get _def() {
    return this._zod.def;
  }
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
  format: (inst) => aggregateChecks(inst).format ?? null,
  minLength: (inst) => aggregateChecks(inst).minimum ?? null,
  maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
  regex(...args) {
    return this.check(_regex(...args));
  },
  includes(...args) {
    return this.check(_includes(...args));
  },
  startsWith(...args) {
    return this.check(_startsWith(...args));
  },
  endsWith(...args) {
    return this.check(_endsWith(...args));
  },
  min(...args) {
    return this.check(_minLength(...args));
  },
  max(...args) {
    return this.check(_maxLength(...args));
  },
  length(...args) {
    return this.check(_length(...args));
  },
  nonempty(...args) {
    return this.check(_minLength(1, ...args));
  },
  lowercase(params) {
    return this.check(_lowercase(params));
  },
  uppercase(params) {
    return this.check(_uppercase(params));
  },
  trim() {
    return this.check(_trim());
  },
  normalize(...args) {
    return this.check(_normalize(...args));
  },
  toLowerCase() {
    return this.check(_toLowerCase());
  },
  toUpperCase() {
    return this.check(_toUpperCase());
  },
  slugify() {
    return this.check(_slugify());
  }
}));
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
}, {
  email(params) {
    return this.check(_email(ZodEmail, params));
  },
  url(params) {
    return this.check(_url(ZodURL, params));
  },
  jwt(params) {
    return this.check(_jwt(ZodJWT, params));
  },
  emoji(params) {
    return this.check(_emoji2(ZodEmoji, params));
  },
  guid(params) {
    return this.check(_guid(ZodGUID, params));
  },
  uuid(params) {
    return this.check(_uuid(ZodUUID, params));
  },
  uuidv4(params) {
    return this.check(_uuidv4(ZodUUID, params));
  },
  uuidv6(params) {
    return this.check(_uuidv6(ZodUUID, params));
  },
  uuidv7(params) {
    return this.check(_uuidv7(ZodUUID, params));
  },
  nanoid(params) {
    return this.check(_nanoid(ZodNanoID, params));
  },
  cuid(params) {
    return this.check(_cuid(ZodCUID, params));
  },
  cuid2(params) {
    return this.check(_cuid2(ZodCUID2, params));
  },
  ulid(params) {
    return this.check(_ulid(ZodULID, params));
  },
  base64(params) {
    return this.check(_base64(ZodBase64, params));
  },
  base64url(params) {
    return this.check(_base64url(ZodBase64URL, params));
  },
  xid(params) {
    return this.check(_xid(ZodXID, params));
  },
  ksuid(params) {
    return this.check(_ksuid(ZodKSUID, params));
  },
  ipv4(params) {
    return this.check(_ipv4(ZodIPv4, params));
  },
  ipv6(params) {
    return this.check(_ipv6(ZodIPv6, params));
  },
  cidrv4(params) {
    return this.check(_cidrv4(ZodCIDRv4, params));
  },
  cidrv6(params) {
    return this.check(_cidrv6(ZodCIDRv6, params));
  },
  e164(params) {
    return this.check(_e164(ZodE164, params));
  },
  datetime(params) {
    return this.check(_isoDateTime(ZodISODateTime, params));
  },
  date(params) {
    return this.check(_isoDate(ZodISODate, params));
  },
  time(params) {
    return this.check(_isoTime(ZodISOTime, params));
  },
  duration(params) {
    return this.check(_isoDuration(ZodISODuration, params));
  }
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  inst.isFinite = true;
}, /* @__PURE__ */ derived({
  minValue: (inst) => {
    const { minimum, exclusiveMinimum } = aggregateChecks(inst);
    return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
  },
  maxValue: (inst) => {
    const { maximum, exclusiveMaximum } = aggregateChecks(inst);
    return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
  },
  isInt: (inst) => {
    const { isInt, multipleOf } = aggregateChecks(inst);
    return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
  },
  format: (inst) => aggregateChecks(inst).format ?? null
}, {
  gt(value, params) {
    return this.check(_gt(value, params));
  },
  gte(value, params) {
    return this.check(_gte(value, params));
  },
  min(value, params) {
    return this.check(_gte(value, params));
  },
  lt(value, params) {
    return this.check(_lt(value, params));
  },
  lte(value, params) {
    return this.check(_lte(value, params));
  },
  max(value, params) {
    return this.check(_lte(value, params));
  },
  int(params) {
    return this.check(int(params));
  },
  safe(params) {
    return this.check(int(params));
  },
  positive(params) {
    return this.check(_gt(0, params));
  },
  nonnegative(params) {
    return this.check(_gte(0, params));
  },
  negative(params) {
    return this.check(_lt(0, params));
  },
  nonpositive(params) {
    return this.check(_lte(0, params));
  },
  multipleOf(value, params) {
    return this.check(_multipleOf(value, params));
  },
  step(value, params) {
    return this.check(_multipleOf(value, params));
  },
  finite() {
    return this;
  }
}));
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown2() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
}, {
  min(n, params) {
    return this.check(_minLength(n, params));
  },
  nonempty(params) {
    return this.check(_minLength(1, params));
  },
  max(n, params) {
    return this.check(_maxLength(n, params));
  },
  length(n, params) {
    return this.check(_length(n, params));
  },
  unwrap() {
    return this.element;
  }
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
  keyof() {
    return _enum(Object.keys(this._zod.def.shape));
  },
  catchall(catchall) {
    return this.clone(mergeDefs(this._zod.def, { catchall }));
  },
  passthrough() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown2() }));
  },
  loose() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown2() }));
  },
  strict() {
    return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
  },
  strip() {
    return this.clone(mergeDefs(this._zod.def, { catchall: undefined }));
  },
  extend(incoming) {
    return extend(this, incoming);
  },
  safeExtend(incoming) {
    return safeExtend(this, incoming);
  },
  merge(other) {
    return merge2(this, other);
  },
  pick(mask) {
    return pick(this, mask);
  },
  omit(mask) {
    return omit(this, mask);
  },
  partial(...args) {
    return partial(ZodOptional, this, args[0]);
  },
  exactPartial(...args) {
    return partial(ZodExactOptional, this, args[0], "exactPartial");
  },
  required(...args) {
    return required(ZodNonOptional, this, args[0]);
  }
});
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: never(),
    ...normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record2(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodRecord({
      type: "record",
      keyType: string2(),
      valueType: keyType,
      ...normalizeParams(valueType)
    });
  }
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = [...inst._zod.values];
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
// packages/settings/src/settings.ts
var KINDS = ["doc", "learning", "list", "rule", "script", "skill", "template"];
var REVIEWED_KINDS = KINDS.filter((kind) => kind !== "list");
var CORE_READ_ONLY = "core is read-only: it changes by a pull request to the Playground repo";
var extScopeSchema = string2().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "a scope is your GitHub login or an org's name").refine((scope) => scope !== CORE, CORE_READ_ONLY);
var settingKeySchema = string2().regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/, "a setting key is dotted camelCase");
var itemKeySchema = string2().regex(/^[a-z0-9][a-z0-9._-]*$/, "an item key is lowercase letters, digits, dots, dashes and underscores");
var fields = new Map;
var aliases = new Map;
var defineSettings = (defined) => {
  for (const [key, field] of Object.entries(defined)) {
    settingKeySchema.parse(key);
    for (const name of [key, ...field.aliases ?? []])
      if (fields.has(name) || aliases.has(name))
        throw new Error(`setting ${name} is defined twice`);
    field.schema.parse(field.default);
    if (field.schema.safeParse(null).success)
      throw new Error(`setting ${key}'s schema takes null, which stands for no value`);
    fields.set(key, field);
    for (const alias of field.aliases ?? [])
      aliases.set(alias, key);
  }
  return {
    get: (settings, key) => (key in settings.values) ? settings.values[key] : defined[key].default
  };
};
var extLinkSchema = string2().regex(/^(?:\*|[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})$/, "a link is a GitHub org, lowercase, or * for every repo");
var extOrderSchema = array(extScopeSchema).refine((names) => new Set(names).size === names.length, "an extension is in the order once");
var extLinksSchema = record2(extScopeSchema, array(extLinkSchema));

// packages/settings/src/ext.ts
var BUNDLED_EXTENSIONS = ["slack", "whatsapp"];
var extSettings = defineSettings({
  "ext.bundled": {
    default: [],
    description: "The extensions Playground ships under extensions/ that you have turned on, each read as a scope after your installed extensions and before core; one not named here loads no skill.",
    schema: array(_enum(BUNDLED_EXTENSIONS)).refine((names) => new Set(names).size === names.length, "a bundled extension is on once")
  },
  "ext.links": {
    default: {},
    description: "Each extension to the GitHub orgs whose repos read it, lowercase, or * for every repo; your login's is read by every repo, and an extension it does not name by none.",
    schema: extLinksSchema
  },
  "ext.order": {
    default: [],
    description: "The extensions in priority order, first wins when two hold the same name; your login's comes first unless named here, and core always comes last.",
    schema: extOrderSchema
  },
  "ext.repos": {
    default: {},
    description: "The private GitHub repository each extension syncs with, as name to owner/name; one it does not name syncs with <login>/playground-<name>.",
    schema: record2(extScopeSchema, string2().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "a repository as owner/name"))
  }
});
var guardedOrgs = (values) => {
  const links = extLinksSchema.parse(values["ext.links"] ?? {});
  return [...new Set(Object.values(links).flat())].filter((link) => link !== "*").sort();
};

// packages/settings/src/slack.ts
var gatedSendsSchema = strictObject({
  path: string2().min(1),
  selfDm: string2().regex(/^D[A-Z0-9]+$/, "a Slack DM id"),
  servers: array(string2().min(1)).min(1)
});
var slackSettings = defineSettings({
  "slack.dmChannel": {
    default: "",
    description: "The Slack id of the owner's own DM, which the DM watch reads and playground dm send posts to; neither runs until it is set.",
    schema: string2().regex(/^(?:D[A-Z0-9]+)?$/, "a Slack DM id")
  },
  "slack.dmOwner": {
    default: "",
    description: "The owner's Slack member id: the DM watch hands on only this member's messages, and dm send posts as this member; neither runs until it is set.",
    schema: string2().regex(/^(?:[UW][A-Z0-9]+)?$/, "a Slack member id")
  },
  "slack.gatedSends": {
    default: "",
    description: "An org's Slack gate, set in that org's extension: the MCP servers its workspace posts through, its self-DM and the send path every other post takes, as {path, selfDm, servers}; no-playground-leak then refuses every Slack MCP write on those servers but a post to the self-DM, and any curl to a Slack URL but an /api/ read. None when empty.",
    schema: union([literal(""), gatedSendsSchema])
  },
  "slack.linkConverter": {
    default: "",
    description: "The command an agent pipes a Slack archives link through to get its app form, which the Inbox's link refusal and a draft's instructions name; none when empty.",
    schema: string2()
  },
  "slack.mode": {
    default: false,
    description: "Slack mode: the owner is away and the DM is the owner's remote access, so the DM watch hands each owner message to the dispatcher, nudges it for an update every 15 minutes and fails over to the session in the assistant seat; off until the owner turns it on, on until the owner turns it off.",
    schema: boolean2()
  },
  "slack.sendServer": {
    default: "",
    description: "The MCP server a sent Slack message goes through, which the Inbox names when the dispatcher carries out an ended poster's send; your Slack tool when empty.",
    schema: string2()
  }
});

// scripts/hooks/read-only.ts
var READ_FILE = { count: true, operands: true, values: ["-c", "-n"] };
var GH_VIEW = {
  flags: ["-c", "--comments"],
  operands: true,
  values: ["--jq", "--json", "-q", "-R", "--repo"]
};
var READERS = {
  cat: { flags: ["-n"], operands: true },
  cd: { operands: true },
  echo: { flags: ["-n"], operands: true },
  grep: {
    flags: ["-c", "-E", "-F", "-h", "-i", "-l", "-n", "-q", "-r", "-rn", "-s", "-v"],
    operands: true,
    values: ["-e"]
  },
  head: READ_FILE,
  ls: { flags: ["-1", "-a", "-l", "-la"], operands: true },
  pwd: {},
  tail: READ_FILE,
  wc: { flags: ["-c", "-l", "-w"], operands: true }
};
var GIT = {
  branch: { flags: ["-a", "-r", "--show-current", "-v"] },
  diff: {
    flags: ["--cached", "--name-only", "--name-status", "--staged", "--stat"],
    operands: true
  },
  log: {
    count: true,
    flags: ["--name-only", "--oneline", "--stat"],
    operands: true,
    values: ["--format", "-n", "--pretty"]
  },
  remote: { flags: ["-v", "--verbose"] },
  "rev-parse": {
    flags: ["--abbrev-ref", "--short", "--show-toplevel", "--verify"],
    operands: true
  },
  show: {
    flags: ["--name-only", "--oneline", "--stat"],
    operands: true,
    values: ["--format", "--pretty"]
  },
  status: { flags: ["-b", "--branch", "--porcelain", "-s", "--short"], operands: true }
};
var GH = {
  "issue list": {
    values: [
      "-A",
      "--author",
      "--jq",
      "--json",
      "-L",
      "-l",
      "--label",
      "--limit",
      "-q",
      "-R",
      "--repo",
      "-S",
      "-s",
      "--search",
      "--state"
    ]
  },
  "issue view": GH_VIEW,
  "pr checks": { operands: true, values: ["-R", "--repo"] },
  "pr diff": { flags: ["--name-only"], operands: true, values: ["-R", "--repo"] },
  "pr list": {
    values: [
      "-A",
      "--author",
      "-B",
      "--base",
      "-H",
      "--head",
      "--jq",
      "--json",
      "-L",
      "--limit",
      "-q",
      "-R",
      "--repo",
      "-s",
      "--state"
    ]
  },
  "pr view": GH_VIEW
};
var OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
function fits(args, shape, git = false) {
  for (let i = 0;i < args.length; i++) {
    const v = args[i];
    const [option, value] = v.startsWith("--") && v.includes("=") ? [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)] : [v, undefined];
    if (v.includes("://"))
      return false;
    if (v === "--")
      return shape.operands === true && args.slice(i + 1).every((a) => !a.includes("://"));
    if (shape.values?.includes(option)) {
      const given = value ?? (git && option.startsWith("--") ? undefined : args[++i]);
      if (given === undefined || value === undefined && given.startsWith("-"))
        return false;
      if ((option === "-R" || option === "--repo") && !OWNER_REPO.test(given))
        return false;
    } else if (shape.flags?.includes(v) || shape.count && /^-\d+$/.test(v))
      continue;
    else if (v.startsWith("-") || !shape.operands)
      return false;
  }
  return true;
}
function apiReads(args) {
  const endpoints = [];
  for (let i = 0;i < args.length; i++) {
    const v = args[i];
    if (v === "-X" || v === "--method") {
      if (!["GET", "HEAD"].includes(args[++i]?.toUpperCase()))
        return false;
    } else if (v === "--jq" || v === "-q")
      i++;
    else if (v !== "--paginate") {
      if (v.startsWith("-"))
        return false;
      endpoints.push(v);
    }
  }
  return endpoints.length === 1 && !endpoints[0].includes("://") && endpoints[0] !== "graphql";
}
var shapeOf = (shapes, key) => key !== undefined && Object.hasOwn(shapes, key) ? shapes[key] : undefined;
function commandReads(cmd) {
  if (cmd.redirects.length > 0 || cmd.words.some((w) => /[*?[{()$]/.test(w.value)))
    return false;
  const words = cmd.words.map((w) => w.value);
  return words.length === 0 || !words.some(marked) && readsWords(words);
}
function readsWords(words) {
  const [name, ...args] = words;
  if (name === "git") {
    const k = args[0] === "-C" ? 2 : 0;
    const shape = shapeOf(GIT, args[k]);
    return shape !== undefined && fits(args.slice(k + 1), shape, true);
  }
  if (name === "gh") {
    if (args[0] === "api")
      return apiReads(args.slice(1));
    const shape = shapeOf(GH, `${args[0]} ${args[1]}`);
    return shape !== undefined && fits(args.slice(2), shape);
  }
  const shape = shapeOf(READERS, name);
  return shape !== undefined && fits(args, shape);
}
function readOnly(raw) {
  try {
    const { tool_input: input, tool_name: tool } = JSON.parse(raw);
    if (tool !== "Bash" || typeof input?.command !== "string")
      return false;
    return lex(input.command).commands.every(commandReads);
  } catch {
    return false;
  }
}

// scripts/hooks/no-playground-leak.ts
var EMPTY_TERMS = {
  aliases: [],
  everyday: [],
  names: [],
  paths: [],
  probe: "probe",
  sessions: { roles: [], sins: [] }
};
var isTerms = (value) => isRecord(value) && ["aliases", "everyday", "names", "paths"].every((key) => isStrings(value[key])) && typeof value.probe === "string" && isRecord(value.sessions) && isStrings(value.sessions.roles) && isStrings(value.sessions.sins);
var terms = EMPTY_TERMS;
var isCleared = (value) => isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && typeof entry.name === "string" && (entry.signature === undefined || typeof entry.signature === "string"));
var CHAT_TOOL = /^chat_(?:me_message|post_ephemeral|post_message|schedule_message|update)$/;
var POST_KEYS = { channel: "channel", text: "text" };
var CONNECTOR_TOOL = "slack_send_message";
var CONNECTOR_KEYS = { channel: "channel_id", text: "message" };
var signed = () => {
  const { cleared } = state();
  return Object.keys(cleared).filter((c) => cleared[c].signature);
};
var OTHER_DESTINATION = /channel|conversation/i;
var RICH = ["attachments", "blocks", "markdown_text"];
var isJson = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function chipsSigned(blocks, signature) {
  let parsed = blocks;
  if (typeof blocks === "string") {
    try {
      parsed = JSON.parse(blocks);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed) || !parsed.length)
    return false;
  const children = [];
  const starts = new Set;
  for (const block of parsed) {
    if (!isJson(block) || block.type !== "rich_text" || !Array.isArray(block.elements))
      return false;
    if (!block.elements.length)
      return false;
    for (const section of block.elements) {
      if (!isJson(section) || section.type !== "rich_text_section")
        return false;
      if (!Array.isArray(section.elements))
        return false;
      if (isJson(section.elements[0]))
        starts.add(section.elements[0]);
      for (const child of section.elements) {
        if (!isJson(child))
          return false;
        const text = child.type === "text" && typeof child.text === "string";
        const link = child.type === "link" && typeof child.url === "string" && (child.text === undefined || typeof child.text === "string");
        if (!text && !link)
          return false;
        children.push(child);
      }
    }
  }
  const last = children.findLast((c) => c.type !== "text" || String(c.text).trim());
  const style = last?.style;
  if (last?.type !== "text" || !isJson(style) || style.italic !== true)
    return false;
  const text = String(last.text).trimEnd();
  const before = children[children.indexOf(last) - 1];
  const opensLine = text.includes(`
`) || starts.has(last) || String(before?.text ?? "").endsWith(`
`);
  return opensLine && text.split(`
`).at(-1)?.trim() === signature.replace(/^_(.*)_$/, "$1");
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var HANDLE = /^[a-z\d][\w.-]{1,63}$/i;
var MAX_ROSTER_BYTES = 1048576;
var CHECKOUT = join8(__CHECKOUT + "/scripts/hooks", "..", "..");
function rosterNames(environment) {
  const path = join8(dataDirOf(environment), "roster.json");
  try {
    if (statSync3(path).size > MAX_ROSTER_BYTES)
      return [];
    const agents = JSON.parse(readFileSync3(path, "utf8"))?.agents;
    if (!Array.isArray(agents))
      return [];
    return agents.flatMap((a) => {
      const name = a?.name;
      return typeof name === "string" && notEveryday(name) ? [name] : [];
    });
  } catch {
    return [];
  }
}
var notEveryday = (name) => HANDLE.test(name) && !terms.everyday.some((w) => w.toLowerCase() === name.toLowerCase());
function skillNames(checkout = CHECKOUT) {
  const ours = join8(checkout, "skills", "playground");
  try {
    return readdirSync2(ours, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync5(join8(ours, d.name, "SKILL.md"))).map((d) => d.name).filter(notEveryday);
  } catch {
    return [];
  }
}
function pattern(environment, checkout = CHECKOUT) {
  const sources = [
    ...[...terms.names, ...terms.aliases, ...rosterNames(environment), ...skillNames(checkout)].map((n) => escape(n).replace(/ /g, "[\\s_-]+") + (n.endsWith("_") ? "[a-z\\d_]*" : "")),
    ...terms.paths.map(escape),
    ...terms.sessions.sins.length ? [
      `${escape(terms.probe)}-(?:(?:${terms.sessions.roles.join("|")})-)?(?:${terms.sessions.sins.join("|")})`,
      `(?:${terms.sessions.roles.join("|")})-(?:${terms.sessions.sins.join("|")})`
    ] : []
  ];
  if (!sources.length)
    return /(?!)/;
  return new RegExp(`(?<![a-z\\d])(?:${sources.join("|")})(?![a-z\\d])`, "i");
}
var REPHRASE = "Say it without the term: name the work, not who did it or how it is run.";
var READABLE = `Put the text in the command itself, or write the text to a file with the Write tool first, then run the command again in a call of its own that names that file by its literal absolute path (--body-file /abs/body.md, or -F /abs/msg.md for a commit). ${NOT_RUN}`;
var MCP_READABLE = "Pass the input as an object whose fields are strings.";
var spec = (texts, files, others = []) => ({
  files,
  takes: new Set([...files, ...others, ...texts, "-R", "--repo"]),
  texts
});
var BODY = ["-b", "--body"];
var BODY_FILE = ["-F", "--body-file"];
var CLOSING = spec(["-c", "--comment"], [], ["-r", "--reason", "--duplicate-of"]);
var EDIT = [
  "--add-assignee",
  "--add-label",
  "--add-project",
  "--add-reviewer",
  "-B",
  "--base",
  "-m",
  "--milestone",
  "--remove-assignee",
  "--remove-label",
  "--remove-project",
  "--remove-reviewer"
];
var NEW = [
  "-a",
  "--assignee",
  "-B",
  "--base",
  "-l",
  "--label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "-r",
  "--reviewer",
  "--recover",
  "-T",
  "--template"
];
var GH_WRITES = new Map([
  ["issue close", CLOSING],
  ["issue comment", spec([...BODY, "--attach"], BODY_FILE)],
  ["issue create", spec([...BODY, "-t", "--title"], BODY_FILE, NEW)],
  ["issue edit", spec([...BODY, "-t", "--title"], BODY_FILE, EDIT)],
  ["issue reopen", CLOSING],
  ["label create", spec(["-d", "--description"], [], ["-c", "--color"])],
  ["label edit", spec(["-d", "--description", "-n", "--name"], [], ["-c", "--color"])],
  ["pr close", CLOSING],
  ["pr comment", spec([...BODY, "--attach"], BODY_FILE)],
  ["pr create", spec([...BODY, "--attach", "-H", "--head", "-t", "--title"], BODY_FILE, NEW)],
  ["pr edit", spec([...BODY, "-t", "--title"], BODY_FILE, EDIT)],
  [
    "pr merge",
    spec([...BODY, "-t", "--subject"], BODY_FILE, ["-A", "--author-email", "--match-head-commit"])
  ],
  ["pr reopen", CLOSING],
  ["pr review", spec(BODY, BODY_FILE)],
  [
    "release create",
    spec(["-n", "--notes", "-t", "--title"], ["-F", "--notes-file"], ["--discussion-category", "--notes-start-tag", "--target"])
  ],
  [
    "release edit",
    spec(["-n", "--notes", "-t", "--title", "--tag"], ["-F", "--notes-file"], ["--discussion-category", "--target"])
  ]
]);
var GH_GROUPS = new Set(["api", "issue", "label", "pr", "release"]);
var PR_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/i;
var COMMIT_TAKES = new Set([
  "--author",
  "-c",
  "-C",
  "--cleanup",
  "--date",
  "-F",
  "--file",
  "--fixup",
  "-m",
  "--message",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "-t",
  "--template",
  "--trailer"
]);
var PUSH_TAKES = new Set(["--exec", "-o", "--push-option", "--receive-pack", "--repo"]);
var REPO_WRITES = new Map([
  ["repo archive", []],
  ["repo delete", []],
  [
    "repo edit",
    [
      "--add-topic",
      "-d",
      "--default-branch",
      "--description",
      "-h",
      "--homepage",
      "--remove-topic",
      "--visibility"
    ]
  ],
  ["repo rename", []],
  ["repo sync", ["-b", "--branch", "-s", "--source"]],
  ["repo unarchive", []]
]);
var CONVERSATION = new Set([
  "pr close",
  "pr comment",
  "pr create",
  "pr edit",
  "pr reopen",
  "pr review"
]);
var CONVERSATION_TOOL = /^(?:add_comment_to_pending_review|add_issue_comment|add_reply_to_pull_request_comment|create_pull_request|issue_write|pull_request_review_write|request_copilot_review|sub_issue_write|update_issue_comment|update_pull_request)$/;
var CREATE_TAKES = [
  "-d",
  "--description",
  "-g",
  "--gitignore",
  "-h",
  "--homepage",
  "-l",
  "--license",
  "-p",
  "--template",
  "-r",
  "--remote",
  "-s",
  "--source",
  "-t",
  "--team"
];
var SUBTREE_TAKES = new Set(["-b", "--branch", "-m", "--message", "--onto", "-P", "--prefix"]);
var PLACE_FIX = `Run any setup (a git config or remote change, a clone, gh repo set-default) in a call of its own first, then name where the write goes by its literal value in a call of its own: a git push run plainly, with no -c, --config-env, --git-dir or GIT_ variable, to a remote or URL the hook can read (a remote whose URL is a local path cannot be placed, so push from a clone of its GitHub URL), gh -R <owner>/<repo>, or repos/<owner>/<name>/... for gh api. ${NOT_RUN}`;
var ANY_GH_WRITES = new Map([
  ["pr update-branch", spec([], [])],
  ["release delete", spec([], [])],
  ["release upload", spec([], [])]
]);
var PLACEHOLDER = /^(?::owner|:repo|\{owner\}|\{repo\})$/;
var GH_STATE = new Set(["config set", "repo clone", "repo fork", "repo set-default"]);
var GIT_CONFIG_PATH = /(?:^|\/)\.git(?:\/|$)|\.gitconfig|(?:^|\/)git\/config$/;
var CONFIG_WRITE = /^--(?:add|edit|remove-section|rename-section|replace-all|unset|unset-all)$|^-e$/;
var CONFIG_READ = /^--(?:get|get-all|get-color|get-colorbool|get-regexp|get-urlmatch|list)$|^-l$/;
var CONFIG_TAKES = new Set(["--blob", "--default", "-f", "--file", "--type"]);
var builtins;
var MCP_TOOL = /^mcp__(.+?)__(.+)$/;
var READ_TOOL = /^(?:download|extract|fetch|get|list|read|search)_|_(?:history|info|list|read|replies|search|unreads)$/;
var INNER = new Set(["curl", "gh", "git"]);
var MAYBE = /curl|gh|git/i;
var MAYBE_ANY = /alias|curl|gh|git|repo|send-pack|subtree/i;
var WRITE_CALL = /\b(?:curl|gh|git)\b|github|linear|slack/i;
var leakPolicy = (orgs, term = /(?!)/) => ({
  find: (text) => {
    const found = term.exec(visible(text))?.[0];
    return found ? { detail: `"${found}", a factory term`, fix: REPHRASE } : undefined;
  },
  git: true,
  guard: "no-playground-leak",
  guarded: (repo) => orgs.has(repo.owner.toLowerCase()),
  hosts: true,
  place: "a guarded org",
  what: "a factory term",
  why: "the factory is private, so nothing about it, its skills or its sessions goes into anything a guarded org sees, in any shape."
});
var calls = new AsyncLocalStorage2;
var IDLE = {
  changed: false,
  cleared: {},
  moved: false,
  movedBefore: false,
  policy: leakPolicy(new Set)
};
var state = () => calls.getStore() ?? IDLE;
var lower = (text) => text[0].toLowerCase() + text.slice(1);
function refuse2(what, target, detail, fix) {
  return `${state().policy.guard} hook refused ${what} to ${target.label}: ${detail}. ${state().policy.why} ${fix}`;
}
function refuseAny(what, target, fix = NOT_RUN) {
  return target.where === "guarded" ? refuse2(what, target, `it writes to ${state().policy.place}`, fix) : refuse2(what, target, `the hook cannot tell whether it writes to ${state().policy.place}`, PLACE_FIX);
}
async function judge2(what, target, texts, env, extras = []) {
  if (target.where === "other")
    return;
  if (state().policy.anyWrite && !target.byText)
    return refuseAny(what, target);
  const resolved = await Promise.all(texts.map((t) => resolveText(t, env)));
  const seen = (await Promise.all(extras.map((t) => resolveText(t, env)))).filter((t) => !t.unknown);
  const hit = [...resolved, ...seen].map((t) => state().policy.find(t.value)).find(Boolean);
  if (target.where === "unknown") {
    if (!hit)
      return;
    return refuse2(what, target, `the hook cannot tell whether it writes to ${state().policy.place}, and its text holds ${hit.detail}`, `Name where it goes by its literal value in a call of its own (gh -R <owner>/<repo>, the pull request number or URL, git -C /abs/checkout, the URL itself, or a REST endpoint naming the repository in place of a GraphQL node id), or ${lower(hit.fix)} ${NOT_RUN}`);
  }
  if (hit)
    return refuse2(what, target, `its text holds ${hit.detail}`, hit.fix);
  const hidden = resolved.find((t) => t.unknown);
  if (hidden) {
    return refuse2(what, target, `the hook cannot read its text before it runs (it comes from ${hidden.unknown}), so it may hold ${state().policy.what}`, READABLE);
  }
}
function decide(candidates) {
  const ours = candidates.find((c) => c && state().policy.guarded(c));
  if (ours)
    return { label: `${ours.owner}/${ours.repo}`, where: "guarded" };
  if (candidates.length === 0 || candidates.some((c) => !c)) {
    return { label: "a repository the hook cannot resolve", where: "unknown" };
  }
  return { label: "", where: "other" };
}
var XARGS_INPUT = { quoted: false, unknown: "xargs's input", value: UNKNOWN };
var leak = async (cmd, parsed, env) => {
  const { first, name, xargs } = parsed;
  if (state().policy.anyWrite)
    pastDeadline();
  const appended = state().policy.anyWrite && xargs && xargs.replace === undefined;
  const args = appended && parsed.args.at(-1) !== XARGS_INPUT ? [...parsed.args, XARGS_INPUT] : parsed.args;
  if (state().policy.anyWrite && changesState(cmd, parsed))
    state().changed = true;
  if (state().policy.anyWrite) {
    state().movedBefore = state().moved;
    if (MOVERS.has(name) || first?.unknown)
      state().moved = true;
  }
  const head = args[0]?.value ?? "";
  const group = GH_GROUPS.has(head) || state().policy.anyWrite && (head === "alias" || head === "repo");
  if (name === "gh" || first?.unknown && group) {
    const verdict = await gh(args, cmd, env, parsed.local, xargs);
    if (verdict || name === "gh" || !state().policy.anyWrite)
      return verdict;
  }
  const pusher = state().policy.anyWrite && (head === "send-pack" || head === "subtree");
  if (name === "git" || first?.unknown && (head === "commit" || head === "push" || pusher))
    return state().policy.git ? git(args, cmd, env, parsed.local) : undefined;
  if (name === "curl")
    return curl(args, cmd, env, xargs);
  if (PRINTERS.has(name))
    return;
  const at = args.findIndex((a) => INNER.has(program(a.value)));
  if (at === -1)
    return;
  const inner = {
    ...parsed,
    args: args.slice(at + 1),
    first: args[at],
    name: program(args[at].value)
  };
  const verdict = await leak(cmd, inner, env);
  if (!verdict || args[at].value === inner.name)
    return verdict;
  const read = `It read a word whose path ends in /${inner.name} as ${inner.name} run by ${name}, a program it does not know: a folder or file passes under a path that does not end in /${inner.name}, and ${inner.name} run by ${name} is read the same when written by its own name, ${inner.name}.`;
  return verdict.endsWith(NOT_RUN) ? `${verdict.slice(0, -NOT_RUN.length)}${read} ${NOT_RUN}` : `${verdict} ${read}`;
};
function changesState(cmd, { args, name }) {
  const words = args.map((a) => a.value);
  if (name === "gh")
    return GH_STATE.has(ghCommand(args).head.join(" "));
  if (name === "git") {
    let k = 0;
    while (k < words.length && words[k].startsWith("-"))
      k += GIT_TAKES.has(words[k]) ? 2 : 1;
    const [sub, ...rest] = words.slice(k);
    if (sub === "clone" || sub === "init" || sub === "submodule")
      return true;
    const verb = rest.find((w) => !w.startsWith("-"));
    if (sub === "remote")
      return ["add", "remove", "rename", "rm", "set-url"].includes(verb ?? "");
    if (sub !== "config")
      return false;
    const { flags, positionals } = parseFlags(args.slice(k + 1), CONFIG_TAKES);
    const first = positionals[0]?.value ?? "";
    if (flags.some((f) => CONFIG_WRITE.test(f.name)))
      return true;
    if (first === "get" || first === "list")
      return false;
    if (["edit", "remove-section", "rename-section", "set", "unset"].includes(first))
      return true;
    if (flags.some((f) => CONFIG_READ.test(f.name)))
      return false;
    return positionals.length > 1;
  }
  const targets = cmd.redirects.flatMap((r) => r.target ? [r.target] : []);
  return [...args, ...targets].some((w) => GIT_CONFIG_PATH.test(w.value));
}
var MOVERS = new Set(["gh", "git"]);
var implicit = (env, local) => state().policy.anyWrite && state().changed ? [undefined] : implicitRepos(env, local);
async function gh(args, cmd, env, local, xargs) {
  const { head, repos, rest } = ghCommand(args);
  if (head[0] === "api")
    return api2(rest, cmd, env, local, xargs);
  const key = head.join(" ");
  if (state().policy.anyWrite) {
    if (key === "alias import" || key === "alias set") {
      return refuse2(`gh ${key}`, decide([]), "an alias can run any gh write under a name the hook does not read", `Run the gh command itself, in a call of its own. ${NOT_RUN}`);
    }
    if (head[0] === "issue" || head[0] === "label" || CONVERSATION.has(key))
      return;
    if (key === "repo create" || key === "repo fork" || key === "repo rename") {
      const refused = created(key, rest, env, xargs);
      if (refused || key !== "repo rename")
        return refused;
    }
    const takes = REPO_WRITES.get(key);
    if (takes)
      return repoWrite(key, rest, repos, env, local, xargs, takes);
  }
  const found = GH_WRITES.get(key) ?? (state().policy.anyWrite ? ANY_GH_WRITES.get(key) : undefined);
  if (!found)
    return;
  const { flags, positionals } = parseFlags(rest, found.takes);
  const texts = [];
  for (const { name, value } of flags) {
    const posts = found.texts.includes(name) || found.files.includes(name);
    if (!value) {
      if (posts)
        texts.push(unknown(`${name} with no value`));
    } else if (found.texts.includes(name))
      texts.push(value);
    else if (found.files.includes(name)) {
      texts.push(value.value === "-" && !value.unknown ? await stdinOf(cmd, env) : await readPath(value, env));
    } else if (name === "-R" || name === "--repo")
      repos.push(value);
  }
  if (xargs && !xargs.replace)
    texts.push(unknown("the arguments xargs appends"));
  if (rest.some((a) => flagFromXargs(a, xargs))) {
    texts.push(unknown(`what xargs puts in place of ${xargs?.replace}`));
  }
  const flagged = repos.map((r) => fromXargs(r, xargs) ? undefined : repoOf(r));
  const urls = positionals.flatMap((p) => {
    if (fromXargs(p, xargs))
      return [undefined];
    if (p === XARGS_INPUT || p.unknown || p.reads?.length || p.value.includes(UNKNOWN))
      return state().policy.anyWrite ? [] : [undefined];
    return PR_URL.test(p.value) ? [repoOf(p)] : [];
  });
  const named = [...flagged, ...urls];
  const placed = urls.some(Boolean);
  const fallback = flagged.length > 0 || placed ? [] : implicit(env, local);
  if (!placed) {
    const refused = unplaced(`gh ${key}`, flagged.length > 0 ? flagged : fallback, env);
    if (refused)
      return refused;
  }
  const target = decide(named.length > 0 ? named : fallback);
  if (key === "pr create" && target.where !== "other")
    texts.push(...prCreate(rest, env));
  return judge2(`gh ${key}`, target, texts.map((t) => viaXargs(t, xargs)), env, positionals);
}
function destination(what, owner, name, fix) {
  if (owner === undefined || name === undefined)
    return refuseAny(what, decide([undefined]));
  if (!state().policy.guarded({ owner, repo: name }))
    return;
  const label = owner === "*" ? `a repository named ${name}` : `${owner}/${name}`;
  return refuseAny(what, { label, where: "guarded" }, fix);
}
function created(key, rest, env, xargs) {
  const takes = key === "repo create" ? CREATE_TAKES : ["--fork-name", "--org", "--remote-name"];
  const { flags, positionals } = parseFlags(rest, new Set([...takes, "-R", "--repo"]));
  const flag = (...names) => flags.findLast((f) => names.includes(f.name));
  const read = (w) => !w || w.unknown || w.reads?.length || marked(w.value) || fromXargs(w, xargs) ? undefined : w.value;
  const what = `gh ${key}`;
  if (key === "repo fork") {
    const name = flag("--fork-name");
    if (!name)
      return;
    const org = flag("--org");
    return destination(what, org ? read(org.value) : "*", read(name.value));
  }
  const [given] = positionals;
  if (given || key === "repo rename") {
    const parts = read(given)?.split("/").filter(Boolean) ?? [];
    const owner = key === "repo create" && parts.length > 1 ? parts.at(-2) : "*";
    return destination(what, owner, parts.at(-1));
  }
  const source = flag("-s", "--source")?.value;
  const path = source && read(source) !== undefined ? pathOf(source, env) : undefined;
  return destination(what, "*", path && basename3(path));
}
function repoWrite(key, rest, repos, env, local, xargs, takes) {
  const { flags, positionals } = parseFlags(rest, new Set([...takes, "-R", "--repo"]));
  for (const { name, value } of flags)
    if (value && (name === "-R" || name === "--repo"))
      repos.push(value);
  const named = key === "repo rename" ? [] : positionals.slice(0, 1);
  if (key === "repo sync" && named.length === 0)
    return Promise.resolve(undefined);
  const given = (named.length > 0 ? named : repos).map((w) => fromXargs(w, xargs) || marked(w.value) ? undefined : repoOf(w));
  return judge2(`gh ${key}`, decide(given.length > 0 ? given : implicit(env, local)), [], env);
}
function unplaced(what, source, env) {
  const lost = source.length === 0 && !env.cwd;
  if (!lost && source.every(Boolean))
    return;
  if (state().policy.anyWrite && state().changed)
    return refuse2(what, decide([]), "an earlier command in the call changes the git or gh state it is placed by", PLACE_FIX);
  return refuse2(what, decide([]), lost ? "the hook cannot tell which repository it writes to, since it names none and runs in a directory the hook lost (after a cd, popd or env -C it cannot follow)" : "the hook cannot tell which repository it writes to, since it names it through a value the hook cannot read", `Name the repository by its literal value (--repo <owner>/<name>, or repos/<owner>/<name>/... for gh api), or cd to a literal path, in a call of its own. ${NOT_RUN}`);
}
function prCreate(rest, env) {
  const values = rest.map((w) => w.value);
  const texts = [
    gitText(env.cwd, ["log", "--format=%B", "-n", "500", "HEAD", "--not", "--remotes"], "the commits it may push")
  ];
  if (!values.some((v) => /^(?:-H|--head)(?:=|$)/.test(v)))
    texts.push(branch(env.cwd));
  if (values.some((v) => v === "-f" || v.startsWith("--fill"))) {
    const at = values.findIndex((v) => /^(?:-B|--base)(?:=|$)/.test(v));
    const base = at === -1 ? "HEAD" : values[at].includes("=") ? values[at].split("=")[1] : values[at + 1];
    texts.push(base && !base.includes(UNKNOWN) ? gitText(env.cwd, ["log", "--format=%B", "-n", "500", `origin/${base}..HEAD`], "the commits --fill reads") : unknown("the base --fill reads from"));
  }
  return texts;
}
var branch = (dir) => gitText(dir, ["branch", "--show-current"], "the current branch");
var TEXT_FIELD = /body|branch|comment|description|head|message|name|notes|query|ref|subject|text|title/i;
async function api2(args, cmd, env, local, xargs) {
  const request = await ghApi(args, cmd, env, xargs);
  if (!request || ["GET", "HEAD"].includes(request.method))
    return;
  if (state().policy.anyWrite && xargs && !xargs.replace) {
    const method = args.some((a) => /^(?:-[A-Za-z]*X|--method)/.test(a.value));
    if (!method && request.fields.length === 1 && request.inputs.length === 0)
      return;
  }
  if (request.method === "DELETE" && !state().policy.anyWrite)
    return;
  const { endpoint, fields, inputs } = request;
  const posted = (f) => endpoint.value === "graphql" || f.key.includes(UNKNOWN) || TEXT_FIELD.test(f.key);
  const texts = [...fields.filter(posted).map((f) => f.text), ...inputs];
  const extras = [endpoint, ...fields.filter((f) => !posted(f)).map((f) => f.text)];
  if (endpoint.value === "graphql") {
    const documents = await Promise.all([...fields.filter((f) => f.key === "query").map((f) => f.text), ...inputs].map((d) => resolveText(d, env)));
    if (!documents.some((d) => d.unknown || /\bmutation\b/.test(d.value)))
      return;
    const target = {
      byText: true,
      label: "a repository named only by a GraphQL node id",
      where: "unknown"
    };
    return judge2("gh api graphql", target, texts, env, extras);
  }
  const value = endpoint.value;
  const host = hostTarget(value);
  if (host)
    return judge2(`gh api ${host.label}`, host, texts, env, extras);
  const typed = value.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "").replace(/^api\/v3\//, "");
  const path = state().policy.anyWrite ? dotless(typed) : typed;
  const repo = /^repos\/([^/]+)\/([^/]+)/.exec(path);
  const org = /^orgs\/([^/]+)/.exec(path);
  const what = `gh api ${path.split("?")[0]}`;
  if (state().policy.anyWrite) {
    const refused = await apiDestination(what, request, path, env);
    if (refused)
      return refused;
  }
  if (state().policy.anyWrite && repo && conversation(path.slice(repo[0].length)))
    return;
  if (state().policy.anyWrite && path.startsWith("repositories/"))
    return judge2(what, { label: "a repository named only by its id", where: "unknown" }, [], env);
  let candidates;
  if (fromXargs(endpoint, xargs))
    candidates = [undefined];
  else if (state().policy.anyWrite && repo && (PLACEHOLDER.test(repo[1]) || PLACEHOLDER.test(repo[2])))
    candidates = implicit(env, local).map((r) => r && {
      owner: PLACEHOLDER.test(repo[1]) ? r.owner : repo[1],
      repo: PLACEHOLDER.test(repo[2]) ? r.repo : repo[2]
    });
  else if (repo?.[1] === "{owner}")
    candidates = implicit(env, local);
  else if (repo)
    candidates = [marked(repo[0]) ? undefined : { owner: repo[1], repo: repo[2] }];
  else if (org)
    candidates = [marked(org[0]) ? undefined : { owner: org[1], repo: "*" }];
  else if (marked(value) && (/^(repos|orgs)\//.test(path) || marked(path.split("/")[0])))
    candidates = [undefined];
  else if (marked(value))
    return judge2(what, decide([undefined]), texts, env, extras);
  else
    return;
  return unplaced(what, candidates, env) ?? judge2(what, decide(candidates), texts, env, extras);
}
async function apiDestination(what, request, path, env) {
  const { fields, inputs, method } = request;
  const route = path.split(/[?#]/)[0].replace(/\/+$/, "");
  const has = (key) => fields.some((f) => f.key === key);
  const repo = /^repos\/([^/]+)\/([^/]+)(?:\/(forks|generate|transfer))?$/.exec(route);
  const org = /^orgs\/([^/]+)\/repos$/.exec(route);
  const fixed = (owner) => PLACEHOLDER.test(owner) || marked(owner) ? "*" : owner;
  const key = (k) => ({ key: k });
  const lit = (v) => ({ value: v });
  let dest;
  if (method === "PATCH" && repo && !repo[3] && has("name"))
    dest = [lit(fixed(repo[1])), key("name")];
  else if (method !== "POST")
    return;
  else if (repo?.[3] === "generate")
    dest = [has("owner") ? key("owner") : lit("*"), key("name")];
  else if (repo?.[3] === "transfer") {
    if (!has("new_name") && PLACEHOLDER.test(repo[2]))
      return destination(what);
    dest = [key("new_owner"), has("new_name") ? key("new_name") : lit(repo[2])];
  } else if (repo?.[3] === "forks" && has("name"))
    dest = [has("organization") ? key("organization") : lit("*"), key("name")];
  else if (route === "user/repos")
    dest = [lit("*"), key("name")];
  else if (org)
    dest = [lit(fixed(org[1])), key("name")];
  if (!dest)
    return;
  if (inputs.length > 0)
    return destination(what);
  const value = async (part) => {
    if ("value" in part)
      return part.value;
    const text = fields.findLast((f) => f.key === part.key)?.text;
    const read = text && await resolveText(text, env);
    return read && !read.unknown && !marked(read.value) ? read.value : undefined;
  };
  return destination(what, await value(dest[0]), await value(dest[1]));
}
function dotless(path) {
  const [route, ...query] = path.split(/(?=[?#])/);
  const kept = [];
  for (const segment of route.split("/")) {
    const plain = segment.toLowerCase().replaceAll("%2e", ".");
    if (plain === "..")
      kept.pop();
    else if (plain !== "." && plain !== "")
      kept.push(segment);
  }
  return [kept.join("/"), ...query].join("");
}
function conversation(route) {
  const segments = route.split(/[?#]/)[0].split("/").filter(Boolean);
  if (/[%\\]/.test(route) || segments.some((s) => s === "." || s === ".."))
    return false;
  if (segments[0] === "issues" || segments[0] === "labels")
    return true;
  return segments[0] === "pulls" && !segments.some((s) => s === "merge" || s === "update-branch");
}
var hostOf = (url) => /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(url)?.[1]?.toLowerCase().replace(/\.+$/, "");
var slackHost = (host) => host === "slack.com" || !!host?.endsWith(".slack.com");
function hostTarget(url) {
  const host = hostOf(url);
  if (!host || !state().policy.hosts)
    return;
  if (host === "linear.app" || host.endsWith(".linear.app"))
    return { label: "Linear", where: "guarded" };
  if (slackHost(host))
    return { label: "Slack", where: "guarded" };
}
async function curl(args, cmd, env, xargs) {
  const { flags, positionals } = parseFlags(args, CURL_TAKES);
  const urls = curlUrls(flags, positionals);
  const globs = state().policy.anyWrite === true && !flags.some((f) => f.name === "-g" || f.name === "--globoff");
  if (state().policy.anyWrite) {
    const redirect = args.some((a, i) => /^--(?:connect-to|request-target|resolve)(?:=|$)/.test(a.value) || (a.value === "-H" || a.value === "--header") && /^\s*host\s*:/i.test(args[i + 1]?.value ?? "") || /^(?:-H|--header=)\s*host\s*:/i.test(a.value));
    if (redirect && args.some((a) => /github/i.test(a.value)))
      return judge2("curl", { label: "a host the call redirects to", where: "unknown" }, [], env);
  }
  const targets = urls.map((u) => {
    if (u.unknown === XARGS_INPUT.unknown || state().policy.anyWrite && fromXargs(u, xargs))
      return u.unknown || curlWrites(flags) ? { label: "a URL xargs supplies from its input", where: "unknown" } : { label: "", where: "other" };
    const value = visible(u.value);
    if (u.unknown || u.reads?.length || value.includes(UNKNOWN) || fromXargs(u, xargs))
      return { byText: true, label: "a URL the hook cannot read", where: "unknown" };
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    const host = hostTarget(url);
    if (host)
      return host;
    if (state().policy.anyWrite)
      return curlTarget(url, globs);
    if (/^https?:\/\/api\.github\.com(?::\d+)?\/graphql(?:[/?#]|$)/i.test(url))
      return {
        byText: true,
        label: "a repository named only by a GraphQL node id",
        where: "unknown"
      };
    const repo = /api\.github\.com\/repos\/([^/\s]+)\/([^/\s?#]+)/i.exec(value);
    return repo ? decide([{ owner: repo[1], repo: repo[2] }]) : { label: "", where: "other" };
  });
  const target = targets.find((t) => t.where === "guarded") ?? targets.find((t) => t.where === "unknown");
  if (!target)
    return;
  if (targets.some((t) => t.label === "Slack")) {
    const gated = gatedCurl(urls);
    if (gated)
      return gated;
  }
  const data = await curlData(flags, cmd, env);
  const get = flags.some((f) => f.name === "-G" || f.name === "--get");
  const writes = data.length > 0 && !get || urls.some((u) => /\/api\/chat\./i.test(u.value));
  if (writes && targets.some((t) => t.label === "Slack")) {
    const read = await Promise.all([...urls, ...data].map((t) => resolveText(t, env)));
    const id = signed().find((c) => read.some((t) => t.value.includes(c)));
    if (id) {
      return `no-playground-leak hook refused curl to ${state().cleared[id].name}: post there through the Slack MCP chat tools, which check that its last line is ${state().cleared[id].signature}.`;
    }
  }
  if (xargs && !xargs.replace)
    data.push(unknown("the arguments xargs appends"));
  return judge2("curl", target, data.map((t) => viaXargs(t, xargs)), env, urls);
}
function curlWrites(flags) {
  const method = flags.find((f) => f.name === "-X" || f.name === "--request")?.value;
  if (method && (unreadable(method) || !/^(?:GET|HEAD)$/i.test(method.value)))
    return true;
  if (flags.some((f) => /^(?:-F|--form(?:-string)?|-T|--upload-file)$/.test(f.name)))
    return true;
  const get = flags.some((f) => f.name === "-G" || f.name === "--get");
  return !get && flags.some((f) => /^(?:-d|--data(?:-[a-z]+)?|--json)$/.test(f.name));
}
function curlTarget(url, globs) {
  const cannot = { label: "a URL the hook cannot place", where: "unknown" };
  const other = { label: "", where: "other" };
  const host = /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]*)/i.exec(url)?.[1] ?? "";
  if (globs && /[{[]/.test(host) && !/^\[[\da-f:.]+\]$/i.test(host))
    return cannot;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return /github/i.test(url) ? cannot : other;
  }
  const name = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!/(?:^|\.)github\.com$/.test(name))
    return other;
  if (globs && /[{[]/.test(url))
    return cannot;
  const [first, second, third] = parsed.pathname.split("/").filter(Boolean);
  if (name === "api.github.com" || name === "uploads.github.com") {
    if (first === "graphql")
      return {
        byText: true,
        label: "a repository named only by a GraphQL node id",
        where: "unknown"
      };
    if (first === "repositories")
      return { label: "a repository named only by its id", where: "unknown" };
    return first === "repos" && second && third ? decide([{ owner: second, repo: third }]) : other;
  }
  if (name !== "github.com" && name !== "www.github.com")
    return other;
  return first && second ? decide([{ owner: first, repo: second.replace(/\.git$/i, "") }]) : other;
}
function clearedPost(what, input, at, signedOnly) {
  const keys = Object.keys(input);
  if (keys.some((k) => k !== at.channel && OTHER_DESTINATION.test(k)))
    return;
  const channel = input[at.channel];
  const text = input[at.text];
  if (typeof channel !== "string" || !Object.hasOwn(state().cleared, channel))
    return;
  const { name, signature } = state().cleared[channel];
  if (!signature)
    return signedOnly ? undefined : "";
  const signed = typeof text === "string" && text.trimEnd().split(`
`).at(-1) === signature;
  const rich = keys.filter((k) => RICH.includes(k));
  if (signed && rich.every((k) => k === "blocks" && chipsSigned(input.blocks, signature)))
    return "";
  return `no-playground-leak hook refused ${what} to ${name}: every post there ends with the line ${signature}, since it goes out through the owner's Slack account and must never read as the owner's own. Put that line last in its text, with no attachments or markdown_text; blocks pass only as rich_text sections of text and links whose last line is that signature as italic text, then run it again.`;
}
function gitText(dir, args, what) {
  if (!dir)
    return unknown(`${what}, in a checkout the hook cannot resolve`);
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stderr: "ignore"
  });
  return proc.exitCode === 0 ? { value: proc.stdout.toString() } : unknown(what);
}
async function git(args, cmd, env, local = new Map, depth = 0) {
  let dir = env.cwd;
  let k = 0;
  let carried = [...local.keys(), ...env.vars.keys()].some((name) => name.startsWith("GIT_"));
  let aliasSet = false;
  const aliases = new Map;
  let anyAlias = false;
  for (;k < args.length; k++) {
    const v = args[k].value;
    if (v === "-C") {
      const next = args[++k];
      dir = next ? pathOf(next, { ...env, cwd: dir }) : undefined;
    } else if (GIT_TAKES.has(v)) {
      if (v === "-c" || v === "--config-env" || v === "--git-dir")
        carried = true;
      const next = args[k + 1]?.value ?? "";
      if (v !== "--git-dir" && /^alias\./i.test(next)) {
        aliasSet = true;
        const eq = next.indexOf("=");
        const name = next.slice("alias.".length, eq === -1 ? undefined : eq);
        if (marked(name))
          anyAlias = true;
        else if (eq > 0)
          aliases.set(name.toLowerCase(), v === "-c" && !marked(next) ? next.slice(eq + 1) : undefined);
      } else if (v === "-c" && marked(next))
        anyAlias = true;
      k++;
    } else if (/^--(?:config-env|git-dir)=/.test(v)) {
      carried = true;
      const alias = /^--config-env=alias\.([^=]+)=/i.exec(v);
      if (alias) {
        aliasSet = true;
        if (marked(alias[1]))
          anyAlias = true;
        else
          aliases.set(alias[1].toLowerCase(), undefined);
      }
    } else if (!v.startsWith("-"))
      break;
  }
  const sub = args[k]?.value;
  const rest = args.slice(k + 1);
  const here = { ...env, cwd: dir };
  const maybeAlias = anyAlias || aliasSet && !!sub && marked(sub);
  if (!state().policy.anyWrite && sub && (maybeAlias || aliases.has(sub.toLowerCase())) && !builtin(sub)) {
    const value = aliases.get(sub.toLowerCase());
    const words = value === undefined || value.trim().startsWith("!") ? undefined : splitCmdline(value);
    const head = words?.[0]?.value;
    if (!words || !head || aliases.has(head.toLowerCase()) || depth > 8)
      return refuse2("git", decide([]), `its alias ${sub}, set with -c or --config-env, runs a command, holds a value the hook cannot read, or names another alias`, `Write the git command out in full in place of the alias, then run it again. ${NOT_RUN}`);
    return git([...args.slice(0, k), ...words, ...rest], cmd, env, local, depth + 1);
  }
  if (state().policy.anyWrite) {
    const cannot = (detail) => refuse2("git", decide([]), detail, PLACE_FIX);
    if (aliasSet)
      return cannot("it sets a git alias with -c or --config-env, which can run a push under a name the hook does not read");
    if (sub && marked(sub))
      return cannot("its subcommand is a value the hook cannot read");
    if (sub && !["commit", "push", "send-pack", "subtree"].includes(sub) && !builtin(sub)) {
      if (carried)
        return cannot(`it runs ${sub}, which -c, --config-env, --git-dir or a GIT_ variable may define as an alias`);
      if (state().changed)
        return cannot(`it runs ${sub}, which an earlier command in the call may define as an alias`);
      const alias = gitText(dir ?? "/", ["config", "--get", `alias.${sub}`], `alias ${sub}`);
      if (!alias.unknown) {
        if (alias.value.trim().startsWith("!") || depth > 8)
          return cannot(`its alias ${sub} runs a command the hook does not read`);
        const words = splitCmdline(alias.value);
        if (!words)
          return cannot(`its alias ${sub} has an unclosed quote or a trailing backslash`);
        return git([...args.slice(0, k), ...words, ...rest], cmd, env, local, depth + 1);
      }
    }
    const subtree = sub === "subtree" && rest[0]?.value === "push";
    if (sub === "push" || sub === "send-pack" || subtree) {
      if (carried)
        return refuse2("git push", decide([]), "it carries -c, --config-env, --git-dir or a GIT_ variable, which can change where it pushes", PLACE_FIX);
      return push(subtree ? rest.slice(1) : rest, here, [], subtree ? SUBTREE_TAKES : PUSH_TAKES);
    }
  }
  if (sub !== "commit" && sub !== "push")
    return;
  const checkout = dir ? remotes(dir) : [];
  if (sub === "push")
    return push(rest, here, checkout);
  if (dir && checkout.length === 0)
    return;
  if (state().policy.anyWrite) {
    const target = decide(dir ? checkout : [undefined]);
    return target.where === "guarded" ? judge2("git commit", target, [], env) : undefined;
  }
  const { flags } = parseFlags(rest, COMMIT_TAKES);
  const texts = [branch(dir)];
  const extras = [];
  for (const { name, value } of flags) {
    if (!value)
      continue;
    if (name === "-m" || name === "--message")
      texts.push(value);
    else if (name === "-F" || name === "--file") {
      texts.push(value.value === "-" && !value.unknown ? await stdinOf(cmd, here) : await readPath(value, here));
    } else if (["-C", "-c", "--reedit-message", "--reuse-message"].includes(name)) {
      texts.push(value.unknown || value.reads?.length ? unknown("the message of a commit the hook cannot name") : gitText(dir, ["log", "-1", "--format=%B", value.value], `the message of ${value.value}`));
    } else
      extras.push(value);
  }
  return judge2("git commit", decide(dir ? checkout : [undefined]), texts, env, extras);
}
function builtin(sub) {
  builtins ??= new Set(Bun.spawnSync(["git", "--list-cmds=builtins"], { stderr: "ignore" }).stdout.toString().split(`
`).filter(Boolean));
  return builtins.has(sub);
}
function splitCmdline(body) {
  const words = [];
  let word;
  let quote = "";
  for (let i = 0;i < body.length; i++) {
    let c = body[i];
    if (!quote && /\s/.test(c)) {
      if (word !== undefined)
        words.push({ quoted: false, value: word });
      word = undefined;
      continue;
    }
    word ??= "";
    if (!quote && (c === "'" || c === '"'))
      quote = c;
    else if (c === quote)
      quote = "";
    else {
      if (c === "\\" && quote !== "'") {
        c = body[++i];
        if (c === undefined)
          return;
      }
      word += c;
    }
  }
  if (quote)
    return;
  if (word !== undefined)
    words.push({ quoted: false, value: word });
  return words;
}
function placeUrl(url) {
  if (url.includes("::") || /^file:/i.test(url))
    return;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url) || /^[^/:]+:/.test(url))
    return remoteRepo(url);
}
function pushTarget(remote, dir) {
  if (state().changed || !dir || remote && (remote.unknown || remote.reads?.length || marked(remote.value)))
    return decide([undefined]);
  const lines = (args) => {
    const text = gitText(dir, args, "a remote");
    return text.unknown ? undefined : text.value.split(`
`).filter(Boolean);
  };
  const urls = (name) => lines(["remote", "get-url", "--push", "--all", name])?.map(placeUrl);
  const rules = () => lines(["config", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]) ?? [];
  const literal = (url) => {
    const rewritten = rules().some((line) => {
      const prefix = line.slice(line.indexOf(" ") + 1);
      return line.includes(" ") && prefix !== "" && url.startsWith(prefix);
    });
    return rewritten ? undefined : placeUrl(url);
  };
  if (!remote) {
    const names = lines(["remote"]);
    const branch = lines(["symbolic-ref", "--short", "HEAD"])?.[0];
    const name = state().movedBefore || dir !== state().startCwd ? ".*" : branch?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const current = name ? `|branch\\.${name}\\.(pushremote|remote)` : "";
    const keys = lines(["config", "--get-regexp", `^(remote\\.pushdefault${current})$`]);
    const picked = (keys ?? []).map((line) => line.slice(line.indexOf(" ") + 1)).filter((value) => value !== "" && value !== "." && !names?.includes(value));
    return decide([
      ...names ? names.flatMap((name) => urls(name) ?? [undefined]) : [undefined],
      ...picked.map(literal)
    ]);
  }
  return decide(urls(remote.value) ?? [literal(remote.value)]);
}
async function push(rest, env, checkout, takes = PUSH_TAKES) {
  const { flags, positionals } = parseFlags(rest, takes);
  if (state().policy.anyWrite) {
    const remote = positionals[0] ?? flags.findLast((f) => f.name === "--repo")?.value;
    return judge2("git push", pushTarget(remote, env.cwd), [], env);
  }
  const names = new Set(flags.map((f) => f.name));
  const [remote, ...refspecs] = positionals;
  let target;
  let remoteName;
  if (!remote)
    target = decide(env.cwd ? checkout : [undefined]);
  else if (remote.unknown || remote.reads?.length || remote.value.includes(UNKNOWN))
    target = decide([undefined]);
  else if (/[:/]/.test(remote.value))
    target = decide([remoteRepo(remote.value)]);
  else {
    remoteName = remote.value;
    const url = gitText(env.cwd, ["remote", "get-url", remote.value], `the URL of remote ${remote.value}`);
    target = decide([url.unknown ? undefined : remoteRepo(url.value)]);
  }
  if (target.where === "other")
    return;
  const texts = flags.flatMap((f) => f.value && (f.name === "-o" || f.name === "--push-option") ? [f.value] : []);
  const sources = [];
  if (names.has("--all") || names.has("--branches") || names.has("--mirror")) {
    texts.push(gitText(env.cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], "the branches it pushes"));
    sources.push("--branches");
  }
  if (names.has("--tags") || names.has("--follow-tags") || names.has("--mirror")) {
    texts.push(gitText(env.cwd, ["for-each-ref", "--format=%(refname:short)%0a%(contents)", "refs/tags"], "the tags it pushes"));
  }
  const deleting = names.has("--delete") || names.has("-d");
  for (const spec of refspecs) {
    texts.push(spec);
    if (spec.unknown || spec.reads?.length || spec.value.includes(UNKNOWN))
      continue;
    const [source, destination] = spec.value.replace(/^\+/, "").split(":");
    if (destination === undefined && (source === "HEAD" || source === "@"))
      texts.push(branch(env.cwd));
    if (source !== "" && !deleting)
      sources.push(source);
  }
  if (refspecs.length === 0 && sources.length === 0) {
    texts.push(branch(env.cwd));
    sources.push("HEAD");
  }
  if (sources.length > 0) {
    const not = remoteName ? `--remotes=${remoteName}` : "--remotes";
    texts.push(gitText(env.cwd, ["log", "--format=%B", "-n", "500", ...sources, "--not", not], "the messages of the commits it pushes"));
  }
  return judge2("git push", target, texts, env);
}
var GATED_READS = new Set(["usergroups_me", "users_conversations"]);
function gatedPost(tool, server, name, input) {
  const read = name.replace(/^slack_/, "");
  if (READ_TOOL.test(read) || GATED_READS.has(read))
    return;
  const connector = name === CONNECTOR_TOOL;
  const posting = CHAT_TOOL.test(name) || connector;
  const what = tool.replace(/^mcp__/, "");
  for (const gate of state().policy.gates ?? []) {
    if ("broken" in gate) {
      if (/slack/i.test(server))
        return brokenGate(what, gate);
      continue;
    }
    if (!gate.servers.includes(server))
      continue;
    const keys = connector ? CONNECTOR_KEYS : POST_KEYS;
    const alone = posting && input !== undefined && input[keys.channel] === gate.selfDm && !Object.keys(input).some((k) => k !== keys.channel && OTHER_DESTINATION.test(k));
    if (!alone)
      return `no-playground-leak hook refused ${what}: the ${gate.org} extension gates its Slack sends on ${server}, so every write there goes through ${gate.path}; only a post whose one destination is its self-DM (${gate.selfDm}) passes here. Send it through that path.`;
  }
}
var brokenGate = (what, gate) => `no-playground-leak hook refused ${what}: the ${gate.org} extension's slack.gatedSends does not read (${gate.broken}), so the hook cannot tell which Slack writes its gate covers. Tell your lead: it is set in that extension's settings as {"path": "<its send path>", "selfDm": "D\u2026", "servers": ["<MCP server>"]}, or "" for no gate; then run the call again.`;
var SLACK_READ_METHOD = /^(?:auth\.test|search\.[a-z]+|(?:[a-z]+\.)+(?:history|info|list|replies|unreads|get[A-Za-z]*|lookup[A-Za-z]*))$/;
function gatedCurl(urls) {
  const gates = state().policy.gates ?? [];
  if (!gates.length)
    return;
  const writes = urls.some((u) => {
    const value = visible(u.value);
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    if (!slackHost(hostOf(url)))
      return false;
    const method = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*\/api\/([^/?#]+)(?:[?#]|$)/i.exec(url)?.[1];
    return !method || !SLACK_READ_METHOD.test(method);
  });
  if (!writes)
    return;
  const broken = gates.find((g) => ("broken" in g));
  if (broken && "broken" in broken)
    return brokenGate("curl", broken);
  const paths = gates.flatMap((g) => ("path" in g) ? [`${g.org}'s ${g.path}`] : []);
  return `no-playground-leak hook refused curl to Slack's API: an org gates its Slack sends (slack.gatedSends), so a Slack write goes through ${paths.join(" or ")}, and curl passes only a read method on /api/. Send it through that path.`;
}
function strings(node) {
  if (typeof node === "string")
    return [node];
  if (Array.isArray(node))
    return node.flatMap(strings);
  if (typeof node === "object" && node !== null)
    return Object.values(node).flatMap(strings);
  return [];
}
function mcp(tool, input) {
  const [, server = "", name = ""] = MCP_TOOL.exec(tool) ?? [];
  const gated = gatedPost(tool, server, name, input);
  if (gated)
    return gated;
  const surface = /linear/i.test(server) ? "Linear" : /slack/i.test(server) ? "Slack" : /github/i.test(server) ? "GitHub" : undefined;
  if (!surface || READ_TOOL.test(name) || surface !== "GitHub" && !state().policy.hosts)
    return;
  const what = tool.replace(/^mcp__/, "");
  let target = { label: surface, where: "guarded" };
  if (!input)
    return refuse2(what, target, "its input is not an object the hook can read", MCP_READABLE);
  if (surface === "Slack" && (CHAT_TOOL.test(name) || name === CONNECTOR_TOOL)) {
    const connector = name === CONNECTOR_TOOL;
    const verdict = clearedPost(what, input, connector ? CONNECTOR_KEYS : POST_KEYS, connector);
    if (verdict !== undefined)
      return verdict || undefined;
  }
  if (surface === "GitHub" && state().policy.anyWrite && name === "create_repository") {
    const owner = input.organization ?? "*";
    const named = input.name;
    return destination(what, typeof owner === "string" ? owner : undefined, typeof named === "string" ? named : undefined, "");
  }
  if (surface === "GitHub") {
    const owner = input.owner ?? input.organization;
    if (owner === undefined)
      return;
    if (typeof owner !== "string") {
      return refuse2(what, { label: "GitHub", where: "unknown" }, "its owner is not text the hook can read", MCP_READABLE);
    }
    const repo = { owner, repo: typeof input.repo === "string" ? input.repo : "*" };
    if (!state().policy.guarded(repo))
      return;
    target = { label: `${repo.owner}/${repo.repo}`, where: "guarded" };
    if (state().policy.anyWrite)
      return CONVERSATION_TOOL.test(name) ? undefined : refuseAny(what, target, "");
  }
  const hit = strings(input).map(state().policy.find).find(Boolean);
  if (hit)
    return refuse2(what, target, `its text holds ${hit.detail}`, hit.fix);
}
function candidate(command) {
  const maybe = state().policy.anyWrite ? MAYBE_ANY : MAYBE;
  return command.includes("$'") || maybe.test(command.replace(/[\\'"]/g, ""));
}
async function factoryTerms(environment = process.env, checkout = CHECKOUT, lists = join8(coreDir(), "lists")) {
  const loaded = await guardList("no-playground-leak", "playground-terms", isTerms, EMPTY_TERMS, environment, join8(lists, "playground-terms.json"));
  if (loaded.refusal !== undefined)
    return { refusal: loaded.refusal };
  terms = loaded.list;
  return { pattern: pattern(environment, checkout) };
}
async function check3(raw, environment = process.env, checkout = CHECKOUT, lists = join8(coreDir(), "lists")) {
  const loadedTerms = await factoryTerms(environment, checkout, lists);
  if (loadedTerms.refusal !== undefined)
    return refusedList(raw, loadedTerms.refusal);
  const loadedCleared = await guardList("no-playground-leak", "slack-cleared", isCleared, {}, environment, join8(lists, "slack-cleared.json"));
  if (loadedCleared.refusal !== undefined)
    return refusedList(raw, loadedCleared.refusal);
  const read = await readPolicy(dataDir(environment));
  if (read.refusal !== undefined)
    return refusedList(raw, `no-playground-leak hook refused this call: ${read.refusal}, then run the call again.`);
  const orgs = guardedOrgs(read.settings.values);
  const gates = orgs.flatMap((org) => gateOf(org, readPolicySync(dataDir(environment), org).settings?.values ?? {}));
  return inspectAs({ ...leakPolicy(new Set(orgs), loadedTerms.pattern), gates }, raw, environment, loadedCleared.list);
}
function gateOf(org, values) {
  const value = values["slack.gatedSends"];
  if (value === undefined || value === "")
    return [];
  const parsed = gatedSendsSchema.safeParse(value);
  return [
    parsed.success ? { org, ...parsed.data } : {
      broken: parsed.error.issues.map((i) => `${i.path.join(".") || "its value"}: ${i.message}`).join("; "),
      org
    }
  ];
}
var refusedList = (raw, refusal) => WRITE_CALL.test(subjectOf(raw)) && !readOnly(raw) ? refusal : undefined;
async function inspectAs(given, raw, environment, cleared = {}) {
  const call = { changed: false, cleared, moved: false, movedBefore: false, policy: given };
  return await calls.run(call, async () => {
    try {
      return await inspect2(raw, environment);
    } catch (error) {
      const subject = subjectOf(raw);
      const writes = WRITE_CALL.test(subject) || given.anyWrite && candidate(subject);
      if (!writes || !given.anyWrite && !given.find(subject))
        return;
      if (given.anyWrite)
        return `${given.guard} hook refused this call: it could not read it (${error}), so it cannot tell whether it is ${given.what}. Split it into plain commands and run them again.`;
      return `${given.guard} hook could not read this call (${error}), which may carry ${given.what} to ${given.place}, so it refuses it. Split it into plain commands and run them again.`;
    }
  });
}
function subjectOf(raw) {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
    if (tool === "Bash" && typeof toolInput?.command === "string")
      return toolInput.command;
    return `${String(tool)} ${JSON.stringify(toolInput)}`;
  } catch {
    return raw;
  }
}
async function inspect2(raw, environment) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return WRITE_CALL.test(raw) && state().policy.find(raw) ? `${state().policy.guard} hook could not parse its input, which may carry ${state().policy.what} to ${state().policy.place}, so it refuses the call.` : undefined;
  }
  const { cwd, tool_input: toolInput, tool_name: tool } = payload;
  state().startCwd = typeof cwd === "string" ? cwd : undefined;
  const input = typeof toolInput === "object" && toolInput !== null ? toolInput : undefined;
  if (tool === "Bash") {
    const command = input?.command;
    if (typeof command !== "string" || !candidate(command))
      return;
    const directory = typeof cwd === "string" ? cwd : undefined;
    const env = {
      cwd: directory,
      files: new Map,
      known: knownVariables(command, environment, directory),
      process: environment,
      vars: new Map
    };
    return run(lex(command, env.known), env, leak);
  }
  if (typeof tool === "string")
    return mcp(tool, input);
}
if (false) {}

// scripts/hooks/no-extension-repo-write.ts
var GUARD2 = "no-extension-repo-write";
var OWNER_ROUTE = "Only the owner changes one, typing the command as a ! command in the dispatcher's terminal window: tell your lead what it should do, and the dispatcher hands the owner the command.";
var REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
var decoded = (text) => text.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
function guardedRepos(data, values, environment) {
  const given = values["ext.repos"];
  const named = new Map;
  if (typeof given === "object" && given !== null) {
    for (const [scope, repo] of Object.entries(given))
      if (typeof repo === "string" && REPO.test(repo))
        named.set(scope, repo.toLowerCase());
  }
  const repos = new Set(named.values());
  const scopes = scopesIn(data);
  for (const scope of scopes) {
    const config = join9(extensionsDir(data), scope, ".git", "config");
    const url = Bun.spawnSync(["git", "config", "--file", config, "--get", "remote.origin.url"], {
      stderr: "ignore"
    });
    const repo = remoteRepo(url.stdout.toString());
    if (repo)
      repos.add(`${repo.owner}/${repo.repo}`.toLowerCase());
  }
  const unnamed = scopes.filter((scope) => !named.has(scope));
  if (unnamed.length === 0)
    return repos;
  const logins = new Set([loginOf(data, environment)]);
  try {
    logins.add(loginOf(data, {}));
  } catch {}
  for (const login of logins)
    for (const scope of unnamed)
      repos.add(`${login}/playground-${scope}`.toLowerCase());
  return repos;
}
function finder(repos) {
  const names = [...repos].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\w.-])(?:${names.join("|")})(?:\\.git)?(?![\\w.-])`, "i");
  return (text) => {
    const found = pattern.exec(decoded(text))?.[0];
    return found ? { detail: `it names ${found}`, fix: OWNER_ROUTE } : undefined;
  };
}
var policy = (repos) => ({
  anyWrite: true,
  find: finder(repos),
  git: true,
  guard: GUARD2,
  guarded: (repo) => {
    const owner = decoded(repo.owner).toLowerCase();
    const name = decoded(repo.repo).replace(/\.git$/i, "").toLowerCase();
    if (/[%/]/.test(owner + name))
      return true;
    if (owner !== "*")
      return repos.has(`${owner}/${name}`);
    return [...repos].some((guarded) => guarded.endsWith(`/${name}`));
  },
  hosts: false,
  place: "an extension repository",
  what: "a write to an extension repository",
  why: `The sync renders each extension repository's main into every session's store. ${OWNER_ROUTE}`
});
async function check4(raw, environment = process.env, budget = 8000) {
  const data = dataDir(environment);
  if (!existsSync6(extensionsDir(data)))
    return;
  const read = await readPolicy(data);
  if (read.refusal !== undefined)
    return refusedList(raw, `${GUARD2} hook refused this call: ${read.refusal}, then run the call again.`);
  let repos;
  try {
    repos = guardedRepos(data, read.settings.values, environment);
  } catch (error) {
    return refusedList(raw, `${GUARD2} hook refused this call: ${error.message}, so it cannot name the extension repositories. ${OWNER_ROUTE}`);
  }
  if (repos.size === 0)
    return;
  return withDeadline(budget, () => inspectAs(policy(repos), raw, environment));
}
if (false) {}

// scripts/hooks/no-extensions-write.ts
import { dirname as dirname5, join as join11, resolve as resolve6, sep as sep2 } from "path";

// packages/settings/src/jobs.ts
var jobSchema = strictObject({
  callsModel: boolean2(),
  command: string2().min(1).optional(),
  config: record2(string2(), unknown2()).optional(),
  cwd: string2().min(1).optional(),
  description: string2().min(1),
  disabledWhy: string2().optional(),
  enabled: boolean2(),
  heartbeat: string2().min(1),
  launchd: string2().min(1).optional(),
  model: string2().min(1).optional(),
  neverPause: boolean2().optional(),
  pausedFor: string2().optional(),
  program: array(string2().min(1)).min(1).optional(),
  runtime: _enum(["herdr"]).optional(),
  schedule: union([
    strictObject({ always: literal(true) }),
    strictObject({ every: number2().int().positive() })
  ]),
  stop: string2().min(1).optional()
});
var fromStored = (row) => {
  if (!row || typeof row !== "object" || Array.isArray(row))
    return row;
  const kept = Object.fromEntries(Object.entries(row).filter(([key]) => Object.hasOwn(jobSchema.shape, key)));
  return kept.runtime === undefined ? kept : { ...kept, runtime: "herdr" };
};
var jobRowSchema = jobSchema.partial();
var jobKey = (name) => `jobs.${name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}`;
var terminal = (name, command, job) => ({
  callsModel: false,
  command,
  cwd: "{checkout}",
  enabled: false,
  heartbeat: name,
  runtime: "herdr",
  ...job
});
var launchd = (name, job) => ({
  callsModel: false,
  cwd: "{checkout}",
  enabled: false,
  heartbeat: name,
  launchd: `com.playground.${name}`,
  program: ["{bun}", "--no-env-file", `{checkout}/packages/scripts/src/${name}/cli.ts`],
  ...job
});
var bunJob = (name, root = "{checkout}") => `{bun} --no-env-file ${root}/packages/scripts/src/${name}/cli.ts`;
var JOBS = {
  "ops-awake": terminal("ops-awake", `${bunJob("ops-awake")} --data {data}`, {
    description: "Keeps the Mac awake on AC power and on battery with caffeinate, display and lock unchanged.",
    schedule: { always: true }
  }),
  "ops-changelog": terminal("ops-changelog", bunJob("ops-changelog", "{dashboard}"), {
    cwd: "{dashboard}",
    description: "Syncs new canary merges and main versions into the Changelog every 5 minutes.",
    schedule: { every: 300 }
  }),
  "ops-dashboard": terminal("ops-dashboard", "{dashboard}/scripts/ops/dashboard/run.sh", {
    cwd: "{dashboard}",
    description: "Keeps the live dashboard running on its branch's latest head.",
    enabled: true,
    schedule: { every: 60 },
    stop: "dashboard"
  }),
  "ops-dm-watch": terminal("ops-dm-watch", bunJob("ops-dm-watch"), {
    description: "In Slack mode, hands each message in the owner's DM to the dispatcher, the session in the assistant seat too when no reply lands in 3 minutes.",
    schedule: { every: 60 }
  }),
  "ops-ext-sync": terminal("ops-ext-sync", bunJob("ops-ext-sync"), {
    description: "Syncs each extension with its private repository at 02:30, pushed only after a clean secrets scan.",
    schedule: { every: 86400 }
  }),
  "ops-flow": launchd("ops-flow", {
    description: "Tells the leads when a session holds a run slot over 15 minutes, or a model slot over 120.",
    schedule: { every: 60 }
  }),
  "ops-herdr": launchd("ops-herdr", {
    description: "Starts each herdr server that is down, on the pinned binary and the repo's config.",
    schedule: { every: 60 }
  }),
  "ops-machine": terminal("ops-machine", `${bunJob("ops-machine")} --data {data}`, {
    description: "Writes one line a minute of the machine's load, memory and live sessions to machine.jsonl.",
    schedule: { every: 60 }
  }),
  "ops-merge-train": terminal("ops-merge-train", "python3 -I {checkout}/scripts/ops/merge-train/run.py", {
    description: "Runs the merge train: builds a train of ready PRs and checks each step.",
    neverPause: true,
    schedule: { every: 60 }
  }),
  "ops-restore": {
    ...launchd("ops-restore", {
      description: "Restores a lost main checkout by the playbook's steps once a guard is gone on two looks 5 minutes apart.",
      schedule: { every: 60 }
    }),
    cwd: "{dashboard}",
    program: [
      "{bun}",
      "--no-env-file",
      "{dashboard}/packages/scripts/src/ops-restore/cli.ts",
      "--main",
      "{checkout}"
    ]
  },
  "ops-session-resume": launchd("ops-session-resume", {
    description: "Queues a carry-on line for each factory session once its usage limit resets.",
    schedule: { every: 60 }
  }),
  "ops-sweep": terminal("ops-sweep", bunJob("ops-sweep"), {
    description: "The Ops lead's sweep: runners, probes, asks, heartbeats and the forecast.",
    schedule: { every: 300 }
  }),
  "ops-tick": launchd("ops-tick", {
    description: "The factory's timed beats: the roll gate, the tick, the usage-limit watch and the sweeps.",
    schedule: { every: 60 }
  }),
  "ops-unstick": terminal("ops-unstick", "python3 -I {checkout}/scripts/ops/unstick/run.py", {
    description: "Reads every live session's screen and clears a factory session stuck on a prompt.",
    neverPause: true,
    schedule: { every: 120 }
  }),
  "ops-usage": terminal("ops-usage", "python3 -I {checkout}/scripts/ops/usage/run.py", {
    description: "Reads the account's usage windows into usage.json every 5 minutes.",
    enabled: true,
    neverPause: true,
    schedule: { every: 300 }
  }),
  "ops-wa": terminal("ops-wa", `${bunJob("ops-wa")} --data {data}`, {
    description: "Holds the WhatsApp link on the spare number: hands each owner message to the dispatcher, sends its replies, and drops every other message.",
    schedule: { always: true }
  }),
  "ops-zai-usage": launchd("ops-zai-usage", {
    description: "Reads the GLM plan's credits into zai-usage.json, which the spawn gate reads.",
    schedule: { every: 300 }
  })
};
var OLD_KEYS = { "ops-dashboard": ["jobs.opsDesk"] };
var jobSettings = defineSettings(Object.fromEntries(Object.entries(JOBS).map(([name, job]) => [
  jobKey(name),
  {
    aliases: OLD_KEYS[name],
    default: job,
    description: `The ${name} ops job: ${job.description}`,
    merge: true,
    schema: jobRowSchema,
    stored: fromStored
  }
])));
var REGISTRY_KEYS = new Set([...Object.keys(JOBS).map(jobKey), ...Object.values(OLD_KEYS).flat()]);

// scripts/hooks/codex.ts
import { isAbsolute as isAbsolute3, resolve as resolve4 } from "path";
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
    tool_input: { content: patch, file_path: isAbsolute3(path) ? path : resolve4(cwd, path) },
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

// scripts/hooks/no-main-checkout.ts
import { existsSync as existsSync7, readdirSync as readdirSync3, readFileSync as readFileSync4, realpathSync as realpathSync3 } from "fs";
import { basename as basename4, dirname as dirname4, isAbsolute as isAbsolute4, join as join10, normalize, resolve as resolve5, sep } from "path";

// packages/settings/src/live.ts
var liveSettings = defineSettings({
  "live.branch": {
    default: "live/dashboard",
    description: "The branch the live dashboard's checkout stays on: a stack on it reads the live machine, and ops-desk's roll resets it to canary.",
    schema: string2().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "a git branch name")
  },
  "live.container": {
    default: "playground-dashboard-db",
    description: "The Docker container holding the live dashboard's database, which every stack off the live checkout refuses.",
    schema: string2().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "a Docker container name")
  }
});

// scripts/hooks/steady.ts
var unquoted = (text) => text.replace(/\\\n|\$(?=["'])|["'\\]/g, "");
var READS_ONLY = /^(?:\}|:?[-+?]|[#%/])/;
var EVALUATES = [
  /\(\([^)]*[A-Za-z_]/,
  /\$\[[^\]]*[A-Za-z_]/,
  /\[\[[\s\S]*\s-(?:eq|ge|gt|le|lt|ne)\s/,
  /\$\{[#!]?\w+:(?![-+=?:])[^}]*[A-Za-z_]/,
  /@P\}/
];
var SUBSCRIPT = /\w\[(?!(?:[@*]|[-\d:,\s]*)\]|\^)/;
var INDIRECTS = /\$\{!(?!\}|[A-Za-z_]\w*(?:[*@]|\[[*@]\])\})/;
var QUALIFIER = /[^\s(|&;<>$=]\((?:#q)?[^()\s|]*?(?:e(?:\[[^]*?\]|\{[^]*?\}|<[^]*?>|([^\s[{<])[^]*?\1)|\+\w+)[^()\s]*\)(?=$|[\s;&|)<>`}])/;
function singleQuotesOut(command) {
  if (command.includes("$'"))
    return command;
  let out = "";
  let double = false;
  const docs = [];
  for (let i = 0;i < command.length; i++) {
    const c = command[i];
    if (c === "\\") {
      out += command.slice(i, i + 2);
      i++;
    } else if (double) {
      if (c === '"')
        double = false;
      out += c;
    } else if (c === '"') {
      double = true;
      out += c;
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
      const end = command.indexOf(`
`, i);
      const stop = end === -1 ? command.length : end;
      out += command.slice(i, stop);
      i = stop - 1;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1)
        return command;
      out += "x";
      i = end;
    } else if (command.startsWith("<<<", i)) {
      out += "<<<";
      i += 2;
    } else if (command.startsWith("<<", i)) {
      const doc = command.slice(i).match(/^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w.-]+))/);
      if (!doc)
        return command;
      docs.push({ delim: doc[2] ?? doc[3] ?? doc[4], strip: doc[1] === "-" });
      out += doc[0];
      i += doc[0].length - 1;
    } else if (c === `
` && docs.length) {
      out += c;
      let at = i + 1;
      for (const { delim, strip } of docs) {
        for (;; ) {
          if (at > command.length)
            return command;
          const end = command.indexOf(`
`, at);
          const stop = end === -1 ? command.length : end;
          const line = command.slice(at, stop);
          out += command.slice(at, Math.min(stop + 1, command.length));
          at = stop + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delim)
            break;
          if (end === -1)
            return command;
        }
      }
      docs.length = 0;
      i = at - 1;
    } else
      out += c;
  }
  return double || docs.length ? command : out;
}
var READ2 = /\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})(?!\[)/.source;
var TEXT = /[^"$`\\]/.source;
var WORD = new RegExp(String.raw`^(?:(?:[\w./:=@%+,~-]|${READ2})+|'[^']*'|"(?:${TEXT}|${READ2})*")`);
var REDIRECT2 = /^(?:[<>]&(?:\d+|-)|<<<|&>>?|>>?\|?|<>?)/;
var KEEPS_PROGRAM = /^(?:builtin|command|do|elif|else|exec|if|nocorrect|noglob|then|time|until|while)$/;
var PROMPT_PARAM = /^(?:PS[0-4]|PROMPT[2-4]?|RPROMPT2?|RPS[12]|SPROMPT)(?!\w)/;
var QUOTED_DOC = /^<<(-?)[ \t]*((?:[\w.-]*(?:'[^'\n]*'|"[^"\n$`\\]*"|\\[\w.-])[\w.-]*)+)(?=[\s;&|<>]|$)/;
function quotedBodiesOut(command) {
  let out = "";
  const docs = [];
  let program = true;
  let target = false;
  let word = "";
  const endWord = () => {
    if (word && target)
      target = false;
    else if (word && !/^[A-Za-z_]\w*=/.test(word) && !KEEPS_PROGRAM.test(word))
      program = false;
    word = "";
  };
  for (let i = 0;i < command.length; ) {
    const rest = command.slice(i);
    let token;
    let doc = null;
    if (rest[0] === `
`) {
      endWord();
      out += `
`;
      i++;
      for (const { delim, strip } of docs)
        for (;; ) {
          if (i >= command.length)
            return command;
          const end = command.indexOf(`
`, i);
          const stop = end === -1 ? command.length : end;
          const line = command.slice(i, stop);
          const last = (strip ? line.replace(/^\t+/, "") : line) === delim;
          out += (last ? line : "") + (end === -1 ? "" : `
`);
          i = stop + 1;
          if (last)
            break;
        }
      docs.length = 0;
      program = true;
      continue;
    } else if (token = rest.match(/^[ \t]+/)?.[0])
      endWord();
    else if (token = rest.match(/^(?:&&|\|\||[;|])/)?.[0]) {
      endWord();
      program = true;
    } else if (rest.startsWith("<<") && !rest.startsWith("<<<")) {
      doc = rest.match(QUOTED_DOC);
      if (!doc)
        return command;
      if (/^\d+$/.test(word))
        word = "";
      endWord();
      token = doc[0];
      docs.push({
        delim: doc[2].replace(/\\(.)/g, "$1").replace(/["']/g, ""),
        strip: doc[1] === "-"
      });
    } else if (token = rest.match(REDIRECT2)?.[0]) {
      if (/^\d+$/.test(word))
        word = "";
      endWord();
      target = !/&(?:\d+|-)$/.test(token);
    } else if (token = rest.match(WORD)?.[0]) {
      word += token;
      if (program && !target && token.includes("$") && !/^[A-Za-z_]\w*=/.test(word))
        return command;
      if (PROMPT_PARAM.test(word))
        return command;
    }
    if (!token || docs.length && token.includes(`
`))
      return command;
    out += token;
    i += token.length;
  }
  return docs.length ? command : out;
}
function namings(command) {
  const counts = new Map;
  const plain = new Set;
  const add = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const text = quotedBodiesOut(command);
  const singleQuotedOut = singleQuotesOut(text);
  let blind = EVALUATES.some((evaluates) => evaluates.test(text)) || SUBSCRIPT.test(singleQuotedOut) || SUBSCRIPT.test(unquoted(singleQuotedOut)) || QUALIFIER.test(singleQuotedOut) || INDIRECTS.test(text);
  for (const [, flags, closed] of text.matchAll(/\$\{\(([^)]*)(\)?)/g))
    if (!closed || !/^[\w@~^=!*-]*$/.test(flags) || /[eP]/.test(flags))
      blind = true;
  for (const m of command.matchAll(/(\$\{[#!]?)?(?<![\w$])([A-Za-z_]\w*)/g)) {
    const [whole, expanded, key] = m;
    const next = command.slice(m.index + whole.length);
    if (expanded && READS_ONLY.test(next))
      continue;
    const assigns = next[0] === "=" ? "=" : undefined;
    const at = m.index + (expanded?.length ?? 0);
    if (!expanded && command[at - 1] === "-" && (at < 2 || /\s/.test(command[at - 2]))) {
      for (let k = 0;k < key.length - 1; k++)
        if (key[k] === "a" || key[k] === "v")
          add(key.slice(k + 1));
      continue;
    }
    add(key);
    if (!expanded && assigns === "=" && (at === 0 || /[\s;&|(]/.test(command[at - 1])))
      plain.add(key);
  }
  const from = [];
  let joined = "";
  for (let i = 0;i < command.length; i++)
    if (!'\\\'"'.includes(command[i])) {
      from.push(i);
      joined += command[i];
    }
  for (const m of joined.matchAll(/(?<![\w$])[A-Za-z_]\w*/g)) {
    const end = m.index + m[0].length - 1;
    if (from[end] - from[m.index] !== end - m.index)
      add(m[0]);
  }
  return { blind, counts, plain };
}
var SHELL_SETS = new Set([
  "ARGC",
  "BASH",
  "BASHOPTS",
  "BASHPID",
  "COLUMNS",
  "COPROC",
  "CPUTYPE",
  "DIRSTACK",
  "EGID",
  "EPOCHREALTIME",
  "EPOCHSECONDS",
  "ERRNO",
  "EUID",
  "FUNCNAME",
  "FUNCNEST",
  "GID",
  "GROUPS",
  "HISTCMD",
  "HOST",
  "HOSTNAME",
  "HOSTTYPE",
  "LINENO",
  "LINES",
  "LOGNAME",
  "MACHTYPE",
  "MAPFILE",
  "MATCH",
  "MBEGIN",
  "MEND",
  "OLDPWD",
  "OPTARG",
  "OPTIND",
  "OSTYPE",
  "PIPESTATUS",
  "PPID",
  "PWD",
  "RANDOM",
  "REPLY",
  "SECONDS",
  "SHELLOPTS",
  "SHLVL",
  "SRANDOM",
  "TRY_BLOCK_ERROR",
  "TRY_BLOCK_INTERRUPT",
  "TTY",
  "TTYIDLE",
  "UID",
  "USERNAME",
  "VENDOR",
  "ZCURSES_COLORS",
  "ZCURSES_COLOR_PAIRS",
  "ZPCRE_OP",
  "_",
  "aliases",
  "argv",
  "builtins",
  "commands",
  "dirstack",
  "dis_aliases",
  "dis_builtins",
  "dis_functions",
  "dis_functions_source",
  "dis_galiases",
  "dis_patchars",
  "dis_reswords",
  "dis_saliases",
  "epochtime",
  "errnos",
  "funcfiletrace",
  "funcsourcetrace",
  "funcstack",
  "functions",
  "functions_source",
  "functrace",
  "galiases",
  "history",
  "historywords",
  "jobdirs",
  "jobstates",
  "jobtexts",
  "keymaps",
  "langinfo",
  "mapfile",
  "match",
  "mbegin",
  "mend",
  "modules",
  "nameddirs",
  "options",
  "parameters",
  "patchars",
  "pipestatus",
  "reply",
  "reswords",
  "saliases",
  "signals",
  "status",
  "sysparams",
  "termcap",
  "terminfo",
  "userdirs",
  "usergroups",
  "widgets",
  "zcurses_attrs",
  "zcurses_colors",
  "zcurses_keycodes",
  "zcurses_windows",
  "zgdbm_tied"
]);
var SHELL_SETS_PREFIX = /^(?:BASH_|COMP_|READLINE_|ZFTP_|ZSH_|zsh_)/;
var TIED = new Set([
  "CDPATH",
  "FIGNORE",
  "FPATH",
  "HISTCHARS",
  "MAILPATH",
  "MANPATH",
  "MODULE_PATH",
  "PATH",
  "PROMPT",
  "PROMPT2",
  "PROMPT3",
  "PROMPT4",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PSVAR",
  "WATCH",
  "cdpath",
  "fignore",
  "fpath",
  "histchars",
  "mailpath",
  "manpath",
  "module_path",
  "path",
  "prompt",
  "psvar",
  "watch"
]);
function holdable(key, named, counts) {
  return counts.get(key) === 1 && named.plain.has(key) && !SHELL_SETS.has(key) && !SHELL_SETS_PREFIX.test(key) && !TIED.has(key);
}
var NONE2 = { has: () => false };
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
var NUMERIC = new Set(["float", "integer"]);
var TYPESETS = new Set(["declare", "export", "local", "readonly", "typeset"]);
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
var TESTS = new Set(["[", "[[", "test"]);
var PLAIN_NAME = /^[A-Za-z_]\w*$/;
var EXPANDS = /\$(?![A-Za-z_]\w*|\{[A-Za-z_]\w*\})|`|[<>]\(/;
var BINARY = new Set([
  "!=",
  "-a",
  "-ef",
  "-eq",
  "-ge",
  "-gt",
  "-le",
  "-lt",
  "-ne",
  "-nt",
  "-o",
  "-ot",
  "<",
  "=",
  "==",
  "=~",
  ">"
]);
var testsAName = (args, expands) => args.some((w, k) => {
  const next = args[k + 1];
  if (w.value === "-v")
    return next !== undefined && !PLAIN_NAME.test(next.source ?? "");
  if (!expands)
    return false;
  if (EXPANDS.test(w.source ?? "$"))
    return true;
  if (!marked(w.value))
    return false;
  return !w.quoted || next !== undefined && next.value !== "]" && !BINARY.has(next.value);
});
var OPENS2 = new Set(["case", "for", "if", "select", "until", "while", "{"]);
var CLOSES2 = new Set(["done", "esac", "fi", "}"]);
var LEADS = new Set(["!", "coproc", "do", "elif", "else", "then", "time"]);
function steadyNames(named, commands) {
  if (named.blind || named.counts.has("IFS"))
    return () => NONE2;
  const counts = new Map(named.counts);
  const parses = commands.map((cmd) => parse(cmd));
  for (const [at, cmd] of commands.entries()) {
    const { name } = parses[at];
    if (RUNS_TEXT.has(name) || marked(name))
      return () => NONE2;
    const flagged = (letters) => cmd.words.some((w, k) => k > 0 && /^-[^-\s]/.test(w.value) && letters.test(w.value));
    if (NUMERIC.has(name) || TYPESETS.has(name) && flagged(/[EFin]/))
      return () => NONE2;
    if (name === "let" && cmd.words.some((w, k) => k > 0 && /[A-Za-z_]/.test(w.value)))
      return () => NONE2;
    if (name === "print" && flagged(/P/))
      return () => NONE2;
    if (TESTS.has(name) && testsAName(parses[at].args, name !== "[["))
      return () => NONE2;
    const loop = cmd.words.findIndex((w) => !w.quoted && (w.value === "for" || w.value === "select"));
    if (!NAME_SETTERS.has(name) && loop === -1)
      continue;
    if (bareExport(parses[at]))
      continue;
    const vNames = cmd.words.flatMap((w, k) => k > 0 && /^-[^-\s]*v/.test(w.value) ? [{ ...w, value: w.value.slice(w.value.indexOf("v") + 1) }, cmd.words[k + 1]] : []);
    const names = loop !== -1 ? [cmd.words[loop + 1]] : PRINTS.has(name) ? vNames : cmd.words;
    for (const word of names) {
      if (!word)
        continue;
      if (marked(word.value.split("=")[0]))
        return () => NONE2;
      if (word.quoted && word.value.includes("["))
        return () => NONE2;
      for (const key of word.value.match(/[A-Za-z_]\w*/g) ?? [])
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const set = new Map;
  const exports = new Map;
  const where = new Map;
  const open = [];
  const loops = new Map;
  let chain = 0;
  let depth = 0;
  for (const [at, cmd] of commands.entries()) {
    if (cmd.follows !== "&&")
      chain++;
    where.set(cmd, { at, chain });
    const top = depth === 0 && cmd.scope === 0;
    for (let k = 0;k < cmd.words.length; k++) {
      const { quoted, value } = cmd.words[k];
      if (quoted)
        break;
      if (value === "function")
        k++;
      else if (OPENS2.has(value))
        depth++;
      else if (CLOSES2.has(value))
        depth--;
      else if (!LEADS.has(value))
        break;
    }
    if (depth < 0)
      return () => NONE2;
    while (open.length > 0 && depth < open.at(-1).depth)
      open.pop();
    if (open.length > 0)
      loops.set(cmd, new Map(open.map((o) => [o.key, o.values])));
    const head = forList(cmd, named);
    if (head)
      open.push({ depth, ...head });
    const always = !cmd.follows || cmd.follows === ";" || cmd.follows === "&";
    if (!top || cmd.detached || !always && cmd.follows !== "&&")
      continue;
    if (bareExport(parses[at])) {
      for (const w of parses[at].args) {
        const key = w.value.slice(0, w.value.indexOf("="));
        if (holdable(key, named, counts))
          exports.set(key, always ? { at } : { at, chain });
      }
      continue;
    }
    const [first] = cmd.words;
    if (!first || !ASSIGN.test(first.value) || parses[at].name !== "")
      continue;
    if (/^[A-Za-z_]\w*\+?=\(/.test(first.value))
      continue;
    for (const key of parses[at].local.keys())
      if (holdable(key, named, counts))
        set.set(key, always ? { at } : { at, chain });
  }
  return (cmd) => {
    const here = where.get(cmd);
    if (!here)
      return NONE2;
    const before = (from) => !!from && from.at < here.at && (from.chain === undefined || from.chain === here.chain);
    return {
      exported: (key) => before(exports.get(key)),
      has: (key) => before(set.get(key)),
      loop: (key) => loops.get(cmd)?.get(key)
    };
  };
}
var bareExport = ({ args, name }) => name === "export" && args.length > 0 && args.every((w) => !w.quoted && ASSIGN.test(w.value) && PLAIN_NAME.test(w.value.slice(0, w.value.indexOf("="))));
function forList(cmd, named) {
  const at = cmd.words.findIndex((w) => w.quoted || !(LEADS.has(w.value) || w.value === "{"));
  if (at === -1 || cmd.words[at].quoted || cmd.words[at].value !== "for")
    return;
  const [key, word, ...values] = cmd.words.slice(at + 1);
  if (!key || key.quoted || !PLAIN_NAME.test(key.value) || named.counts.get(key.value) !== 1)
    return;
  if (!word || word.quoted || word.value !== "in" || values.length === 0)
    return;
  if (values.some((w) => marked(w.value) || /[*?[\]{}]/.test(w.value)))
    return;
  return { key: key.value, values: values.map((w) => w.value) };
}
function heldWord(word, env, steady) {
  return word.raw && marked(word.value) ? relexed(word.raw, heldVars(env, steady)) : undefined;
}
function relexed(raw, known) {
  const words = lex(raw, known).commands.at(-1)?.words ?? [];
  return words.length === 1 && !marked(words[0].value) ? words[0] : undefined;
}
function heldVars(env, steady) {
  const known = { ...env.known };
  for (const [key, text] of env.vars) {
    if (key === "TMPDIR" || !steady.has(key))
      continue;
    if (!text.unknown && !marked(text.value))
      known[key] = text.value;
    else if ("raw" in text && typeof text.raw === "string") {
      const again = relexed(text.raw, known)?.value;
      if (again?.startsWith(`${key}=`))
        known[key] = again.slice(key.length + 1);
    }
  }
  return known;
}

// scripts/hooks/no-main-checkout.ts
function mainCheckout2(dir) {
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync4(join10(dir, ".git"), "utf8"))?.[1];
    const main = gitdir && /^(.+)\/\.git\/worktrees\/[^/]+$/.exec(resolve5(dir, gitdir.trim()))?.[1];
    if (main)
      return main;
  } catch {}
  return dir;
}
function liveCheckout(main, environment) {
  const settings = readPolicySync(dataDirOf(environment)).settings ?? {
    schemaVersion: 1,
    values: {}
  };
  const head = `ref: refs/heads/${liveSettings.get(settings, "live.branch")}`;
  const worktrees = join10(main, ".git", "worktrees");
  let names;
  try {
    names = readdirSync3(worktrees);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (readFileSync4(join10(worktrees, name, "HEAD"), "utf8").trim() !== head)
        continue;
      return dirname4(resolve5(join10(worktrees, name), readFileSync4(join10(worktrees, name, "gitdir"), "utf8").trim()));
    } catch {}
  }
}
function inWorktree(path, worktrees) {
  if (!path.startsWith(worktrees))
    return false;
  const tree = join10(worktrees, path.slice(worktrees.length).split(sep)[0]);
  return existsSync7(join10(tree, ".git")) || !isFolder(tree);
}
function real(path) {
  const found = resolved(path);
  if (found !== undefined || !isAbsolute4(path))
    return found ?? nearest(path);
  const parts = normalize(path).split(sep).filter(Boolean);
  let low = 0;
  let high = parts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (resolved(sep + parts.slice(0, mid).join(sep)) === undefined)
      high = mid - 1;
    else
      low = mid;
  }
  return join10(resolved(sep + parts.slice(0, low).join(sep)) ?? sep, ...parts.slice(low));
}
var resolved = (path) => {
  try {
    return realpathSync3(path);
  } catch {
    return;
  }
};
function nearest(path) {
  const rest = [];
  for (let dir = path;; dir = dirname4(dir)) {
    const found = resolved(dir);
    if (found !== undefined)
      return join10(found, ...rest.reverse());
    if (dir === dirname4(dir))
      return path;
    rest.push(basename4(dir));
  }
}
var FILE_TOOLS = {
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Write: "file_path"
};
var INSTEAD = `the main checkout is what every installed skill follows, so it stays clean. Run it in your own worktree under the main checkout's .claude/worktrees/, made by absolute path so it nests in no other worktree (git worktree add --no-track "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" -b <branch> origin/canary), or start lefthook from a script with cwd set to a scratch repo, as tests/lefthook.test.ts does.`;
var refuse3 = (what, fix = INSTEAD) => `no-main-checkout hook refuses ${what}: ${fix}`;
var UNKNOWN_FIX = "the hook cannot tell which folder it runs in, since a cd before it may not run, may run many times, or names a path it cannot read, so it reads every folder the shell may be in. Name the folder instead: git -C <your worktree>, bun --cwd <your worktree>, or cd by a literal path.";
var ANYWHERE_FIX = "the line names more folders than the hook carries, so it cannot rule out the main checkout. Name the folder on the command instead: git -C <your worktree>, bun --cwd <your worktree>, or run it as a line of its own after a cd to a literal path.";
var fixFor2 = (sure, own = INSTEAD) => sure ? own : UNKNOWN_FIX;
var BUN_SCRIPTS = new Set(["build", "check-types", "test", "test:file"]);
var RUNNERS2 = new Set(["npx"]);
var X = { quoted: false, value: "x" };
var TOOLS = new Set(["lefthook", "turbo"]);
var DUPLICATE = /^(?:\d+|-)$/;
var PACKAGES_BUILD = ["run", "build", "--filter=./packages/*"];
var BUILD_FIX = "the main checkout has no .env, so the packages' env checks fail. Run it as playground update's build step types it, env NODE_ENV=production SKIP_ENV_VALIDATION=true <main checkout>/node_modules/.bin/turbo run build --filter='./packages/*' --cwd <main checkout>.";
function packagesBuild(args) {
  const words = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--cwd")
      k++;
    else if (v === "--filter")
      words.push(`--filter=${args[++k]?.value}`);
    else if (!v.startsWith("--cwd="))
      words.push(v);
  }
  return words.length === PACKAGES_BUILD.length && words.every((w, i) => w === PACKAGES_BUILD[i]);
}
function cwdFlag(args, env) {
  let cwd = env.cwd;
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--cwd")
      cwd = args[k + 1] && pathOf(args[++k], env);
    else if (v.startsWith("--cwd="))
      cwd = pathOf({ ...args[k], value: v.slice(6) }, env);
  }
  return cwd;
}
function bunCall(args, env) {
  let cwd = env.cwd;
  let xCwd;
  let chained = env.cwd;
  let filtered = false;
  let sub = -1;
  const words = [];
  let k = 0;
  for (;k < args.length; k++) {
    const v = args[k].value;
    const value = v === "--cwd" ? args[k + 1] : v.startsWith("--cwd=") ? { ...args[k], value: v.slice(6) } : undefined;
    if (v === "--cwd" || v.startsWith("--cwd=")) {
      if (v === "--cwd")
        k++;
      cwd = value && pathOf(value, env);
      chained = value && pathOf(value, { ...env, cwd: chained });
      if (words[0] === "x")
        xCwd = { dir: cwd };
    } else if (v === "--filter" || v === "-F") {
      filtered = true;
      k++;
    } else if (v.startsWith("--filter="))
      filtered = true;
    else if (words[0] === "x" && RUNNER_TAKES.has(v))
      k++;
    else if (!v.startsWith("-")) {
      if (v === "x" && words.length === 1 && words[0] === "x" && args[sub - 1]?.value.startsWith("-")) {
        sub = k;
        continue;
      }
      if (words.push(v) === 1)
        sub = k;
      if (v !== "run" && v !== "x")
        break;
    }
  }
  return { at: k, chained, cwd, filtered, sub, words, xCwd };
}
var landing = (word, env, from) => {
  if (!word || pathOf(word, { ...env, cwd: from }) === undefined)
    return;
  return kernelPath(word, from, real(resolve5(from ?? "", word.value)));
};
function gitCall(args, env, local) {
  let cwd = env.cwd;
  let gitDir;
  let workTree;
  const value = (k, flag) => args[k].value === flag ? args[k + 1] : { ...args[k], value: args[k].value.slice(flag.length + 1) };
  let k = 0;
  for (;k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value;
    if (v === "-C")
      cwd = args[k + 1] && landing(args[++k], env, cwd);
    else if (v === "--git-dir" || v.startsWith("--git-dir=")) {
      const word = value(k, "--git-dir");
      if (v === "--git-dir")
        k++;
      gitDir = landing(word, env, cwd);
    } else if (v === "--work-tree" || v.startsWith("--work-tree=")) {
      const word = value(k, "--work-tree");
      if (v === "--work-tree")
        k++;
      workTree = landing(word, env, cwd);
    } else if (GIT_TAKES.has(v))
      k++;
  }
  const checkout = (dir) => {
    const repo = dir?.replace(/\/+$/, "");
    return repo?.endsWith(`${sep}.git`) ? dirname4(repo) : undefined;
  };
  const also = [];
  for (const key of ["GIT_DIR", "GIT_WORK_TREE"]) {
    const set = local?.get(key) ?? env.vars.get(key);
    if (!set || set.value === "")
      continue;
    const word = { ...set, quoted: true };
    const at = unreadWord(word) ? undefined : landing(word, env, cwd);
    also.push(key === "GIT_DIR" ? checkout(at) ?? at : at);
  }
  return {
    also,
    cwd: checkout(gitDir) ?? workTree ?? cwd,
    rest: args.slice(k + 1).map((a) => a.value),
    sub: args[k]?.value
  };
}
var GIT_MOVES = new Set([
  "am",
  "bisect",
  "checkout",
  "cherry-pick",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "switch",
  "update-ref"
]);
var APPLY_READS = new Set(["--check", "--numstat", "--stat", "--summary"]);
var STEP_FIVE = /^(?:-q |--quiet )?--ff-only (?:-q |--quiet )?origin\/main$/;
var GIT_FIX = `it moves the HEAD, index or files of the main checkout, which every installed skill, hook and ops job runs from. Name your own tree on every git call, git -C <your worktree> ..., after git -C <your worktree> rev-parse --show-toplevel names it; the main checkout moves only by the release skill's step 5, git -C <main checkout> fetch -q origin main && git -C <main checkout> merge --ff-only -q origin/main, a stray local commit on its main goes by git -C <main checkout> reset --keep origin/main while its tree is clean, and a worktree is made by absolute path under the main checkout's .claude/worktrees/, so it nests in no other worktree, by git worktree add --no-track "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" -b <branch> origin/canary.`;
var LIVE_FIX = "it moves the live Dashboard's checkout, which serves the owner's Dashboard, and only the runner that holds it and the ops lead change it. Ask Ops: its supervisor rolls the checkout onto each canary head, and a change it needs goes through a PR into canary.";
function liveWrite(args, env, local) {
  const { also, cwd, rest, sub } = gitCall(args, env, local);
  if (sub && (sub === "commit" || sub === "merge" || gitMoves(sub, rest)))
    return { also, cwd, what: `git ${sub}` };
}
async function liveWriter(raw, environment) {
  try {
    const session = sessionOf(raw);
    const role = await sessionRole(environment, session);
    if (role === "runner")
      return true;
    if (role !== "lead" || typeof session !== "string")
      return false;
    const name = await registryName(session, environment);
    return name !== undefined && await rosterKind(name, environment) === "ops";
  } catch {
    return false;
  }
}
function keepReset(sub, rest, cwd) {
  if (sub !== "reset" || rest.join(" ") !== "--keep origin/main" || !cwd)
    return false;
  const git = (...args) => {
    const read = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore", stdout: "pipe" });
    return read.exitCode === 0 ? read.stdout.toString() : undefined;
  };
  if (git("symbolic-ref", "-q", "HEAD")?.trim() !== "refs/heads/main")
    return false;
  if (git("status", "--porcelain") !== "")
    return false;
  const dropped = git("rev-list", "origin/main..main");
  return dropped !== undefined && dropped === git("rev-list", "origin/main..main", "--not", "--remotes");
}
function gitMoves(sub, rest) {
  if (GIT_MOVES.has(sub))
    return true;
  if (sub === "merge")
    return !STEP_FIVE.test(rest.join(" "));
  if (sub === "stash")
    return !["list", "show"].includes(rest[0] ?? "push");
  if (sub === "clean")
    return !rest.some((w) => w === "--dry-run" || /^-[a-z]*n/.test(w));
  if (sub === "add")
    return !rest.some((w) => w === "--dry-run" || /^-[a-zA-Z]*n/.test(w));
  if (sub === "apply")
    return rest.includes("--apply") || !rest.some((w) => APPLY_READS.has(w));
  if (sub === "branch")
    return rest.some((w) => w === "--force" || /^-[a-zA-Z]*f/.test(w));
  return false;
}
function turboWords(name, args, env) {
  if (name === "turbo")
    return args;
  if (RUNNERS2.has(name) || name === "bunx")
    return runnerTurbo(args);
  if (name !== "bun")
    return;
  const { at, sub, words } = bunCall(args, env);
  if (words[0] === "x")
    return runnerTurbo(args.slice(sub + 1));
  const target = words[0] === "run" ? words[1] : words[0];
  return isTurbo(target) ? args.slice(at + 1) : undefined;
}
function runnerTurbo(args) {
  const at = runnerTarget(args);
  if (isTurbo(args[at]?.value))
    return args.slice(at + 1);
  return packagedTools(args).includes("turbo") ? args.slice(at) : undefined;
}
var RUNNER_TAKES = new Set([
  "--ca",
  "--cafile",
  "--cwd",
  "--env-file",
  "--minimum-release-age",
  "--package",
  "--registry",
  "-p"
]);
function packagedTools(args) {
  const tools = [];
  for (let k = 0;k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value;
    if (v === "-p" || v === "--package")
      tools.push(toolName(args[++k]?.value));
    else if (v.startsWith("--package=") || v.startsWith("-p="))
      tools.push(toolName(v.slice(v.indexOf("=") + 1)));
    else if (RUNNER_TAKES.has(v))
      k++;
  }
  return tools;
}
function runnerFolders(name, args, env, tool) {
  if (name === "bunx")
    return runnerFolders("bun", [X, ...args], env, tool);
  if (name !== "bun")
    return;
  const { chained, words, xCwd } = bunCall(args, env);
  if (words[0] !== "x")
    return;
  const folders = [cwdFlag(tool, { ...env, cwd: chained })];
  return xCwd ? [...folders, xCwd.dir] : folders;
}
function runnerTarget(args) {
  let k = 0;
  while (k < args.length && args[k].value.startsWith("-"))
    k += RUNNER_TAKES.has(args[k].value) ? 2 : 1;
  return k;
}
var toolName = (word) => program((word ?? "").replace(/(?<=.)@[^/]*$/, ""));
var isTurbo = (word) => toolName(word) === "turbo";
function validationOff(local, env) {
  const read = (key) => local.get(key)?.value ?? env.vars.get(key)?.value ?? env.process[key];
  return !!read("NODE_ENV") && read("SKIP_ENV_VALIDATION") === "true";
}
var withChained = (also, chained) => [...also ?? [], ...chained === undefined ? [undefined] : []];
var ranIn = (dir, also) => [
  dir,
  ...also ?? []
];
var unreadFolder = (also) => also?.includes(undefined) ?? false;
function runs(name, args, local, env) {
  if (name === "bunx")
    return runs("bun", [X, ...args], local, env);
  const turbo = turboWords(name, args, env);
  if (turbo && packagesBuild(turbo)) {
    if (validationOff(local, env))
      return;
    return {
      also: runnerFolders(name, args, env, turbo),
      cwd: cwdFlag(turbo, env),
      fix: BUILD_FIX,
      what: "the packages build without NODE_ENV and SKIP_ENV_VALIDATION=true"
    };
  }
  if (TOOLS.has(name))
    return { cwd: cwdFlag(args, env), what: name };
  if (RUNNERS2.has(name)) {
    const tool = [toolName(args[runnerTarget(args)]?.value), ...packagedTools(args)].find((t) => TOOLS.has(t));
    if (tool)
      return { cwd: cwdFlag(args, env), what: `${name} ${tool}` };
  }
  if (name === "git") {
    const { also, cwd, rest, sub } = gitCall(args, env, local);
    if (sub === "commit")
      return { also, cwd, what: "git commit, which runs lefthook's pre-commit" };
    if (keepReset(sub, rest, cwd))
      return;
    return sub && gitMoves(sub, rest) ? { also, cwd, fix: GIT_FIX, what: `git ${sub}` } : undefined;
  }
  if (name !== "bun")
    return;
  const { at, chained, cwd, filtered, sub, words } = bunCall(args, env);
  const target = words[0] === "run" || words[0] === "x" ? words[1] : words[0];
  const packaged = words[0] === "x" ? packagedTools(args.slice(sub + 1)) : [];
  const tool = [toolName(target), ...packaged].find((t) => TOOLS.has(t));
  if (tool) {
    const dir = words[0] === "x" ? env.cwd : cwd;
    return {
      also: runnerFolders(name, args, env, args.slice(at + 1)),
      cwd: cwdFlag(args.slice(at + 1), { ...env, cwd: dir }),
      what: `bun ${words.join(" ")}`
    };
  }
  if (words[0] === "test")
    return { cwd: cwdFlag(args.slice(at + 1), { ...env, cwd }), what: "bun test" };
  if (target && BUN_SCRIPTS.has(target) && (words[0] === "run" || filtered || target !== "build"))
    return { cwd, what: `bun ${words.join(" ")}` };
  if (words[0] === "x" && target && args[at]?.value === target) {
    const ran = runs(toolName(target), args.slice(at + 1), local, { ...env, cwd: chained });
    return ran && {
      ...ran,
      also: withChained(ran.also, chained),
      what: `bun x ${ran.what}`
    };
  }
}
var LETTERS = {
  perl: {
    "0": "digits",
    C: "rest",
    D: "rest",
    E: "script",
    F: "rest",
    I: "rest",
    M: "rest",
    V: "rest",
    d: "rest",
    e: "script",
    i: "edit",
    l: "digits",
    m: "rest",
    x: "rest"
  },
  sed: { I: "edit", e: "script", f: "script", i: "edit", l: "value" }
};
var SED_VALUES = new Set(["--expression", "--file", "--line-length"]);
var BSD_SUFFIX = /^(\.[\w.-]*)?$/;
function inPlace(name, args) {
  const letters = LETTERS[name];
  if (!letters)
    return [];
  let edits = false;
  let scripted = false;
  const positionals = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--") {
      positionals.push(...args.slice(k + 1));
      break;
    }
    if (name === "sed" && v.startsWith("--")) {
      const flag = v.split("=")[0];
      if (flag === "--in-place")
        edits = true;
      else if (SED_VALUES.has(flag)) {
        scripted ||= flag !== "--line-length";
        if (!v.includes("="))
          k++;
      }
    } else if (/^-[^-]/.test(v)) {
      for (let j = 1;j < v.length; j++) {
        const kind = letters[v[j]];
        const rest = v.slice(j + 1);
        if (kind === "digits")
          j += /^(x[0-9A-Fa-f]*|[0-7]*)/.exec(rest)[0].length;
        else if (kind === "edit") {
          edits = true;
          if (name === "sed" && rest === "" && BSD_SUFFIX.test(args[k + 1]?.value ?? "-"))
            k++;
          break;
        } else if (kind === "script" || kind === "value") {
          scripted ||= kind === "script";
          if (rest === "")
            k++;
          break;
        } else if (kind === "rest")
          break;
      }
    } else if (!v.startsWith("-"))
      positionals.push(args[k]);
  }
  if (!edits)
    return [];
  return scripted ? positionals : positionals.slice(1);
}
function writes(name, args) {
  const positionals = args.filter((a) => !a.value.startsWith("-"));
  if (name === "sed" || name === "perl")
    return inPlace(name, args);
  if (name === "touch" || name === "tee")
    return positionals;
  if (name === "cp" || name === "mv")
    return positionals.slice(-1);
  if (name !== "curl")
    return [];
  const out = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (["-c", "--cookie-jar", "-o", "--output"].includes(v) && args[k + 1])
      out.push(args[++k]);
    const attached = /^--(?:cookie-jar|output)=(.+)$/.exec(v)?.[1];
    if (attached)
      out.push({ ...args[k], value: attached });
  }
  return out;
}
var BROWSER_SAVES = new Set(["pdf", "screenshot"]);
var BROWSER_FIX = "agent-browser saves a relative path in the folder its browser started in, which can be the main checkout, where playground rm cannot clean it. Name an absolute path under your scratchpad or your worktree: agent-browser screenshot <your scratchpad>/<name>.png.";
function browserPathless(args, env) {
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (BROWSER_SAVES.has(v))
      return args.slice(k + 1).some((w) => pathOf(w, { ...env, cwd: undefined })) ? undefined : v;
    if (!v.startsWith("-") && !args[k - 1]?.value.startsWith("-"))
      return;
  }
}
function writeTargets(cmd, name, args) {
  const targets = [
    ...cmd.redirects.filter((r) => [">", ">>", ">|"].includes(r.op) || r.op === ">&" && !DUPLICATE.test(r.target?.value ?? "")).flatMap((r) => r.target ? [r.target] : []),
    ...writes(name, args)
  ];
  return targets.filter((t) => !["-", "/dev/null"].includes(t.value));
}
async function unreadScript(shell, here, sure, inMain) {
  const script = await stdinOf(shell, here);
  if (!script.unknown || !inMain(here.cwd))
    return;
  return refuse3(`a shell whose script (${script.unknown}) the hook cannot read`, fixFor2(sure));
}
var EXPORTS2 = new Set(["declare", "export", "local", "readonly", "typeset"]);
async function fedScript(cmd, here, sure, inMain, visit) {
  const shell = cmd.bareOf ?? cmd;
  if (!stdinFed(shell) && shell.stdin === undefined)
    return;
  const kind = stdinShell(shell);
  if (!kind || kind === "code")
    return;
  const script = await stdinOf(shell, here);
  const unread = script.unknown ?? (marked(script.value) ? "a value it cannot read" : undefined);
  if (unread) {
    if (!inMain(here.cwd))
      return;
    return refuse3(`a shell whose script (${unread}) the hook cannot read`, fixFor2(sure));
  }
  if (kind === "root" && !cmd.bareOf)
    return run(lex(script.value, here.known), { ...here, vars: new Map }, visit, true);
}
async function inspect3(raw, environment, main) {
  const { cwd, tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
  const input = toolInput ?? {};
  const directory = typeof cwd === "string" ? cwd : undefined;
  const checkout = real(main);
  const worktrees = join10(checkout, ".claude", "worktrees") + sep;
  const inMain = (raw) => {
    const path = raw === undefined ? undefined : real(resolve5(directory ?? "", raw));
    return path !== undefined && (path === checkout || path.startsWith(checkout + sep)) && !inWorktree(path, worktrees);
  };
  let live;
  const inLive = (raw) => {
    const path = raw === undefined ? undefined : real(resolve5(directory ?? "", raw));
    return live !== undefined && path !== undefined && (path === live || path.startsWith(live + sep));
  };
  let writer;
  const liveRefusal = async (args, local, env, lands, fix) => {
    const move = liveWrite(args, env, local);
    if (!move || !(ranIn(move.cwd, move.also).some(lands) || unreadFolder(move.also)))
      return;
    if (await (writer ??= liveWriter(raw, environment)))
      return;
    return refuse3(`${move.what} in the live Dashboard's checkout`, fix);
  };
  const file = typeof tool === "string" ? input[FILE_TOOLS[tool]] : undefined;
  if (typeof file === "string")
    return inMain(file) ? refuse3(`a write to ${file}`) : undefined;
  if (tool !== "Bash")
    return;
  const { command } = input;
  if (typeof command !== "string")
    return;
  try {
    const found = liveCheckout(main, environment);
    live = found === undefined ? undefined : real(found);
  } catch {
    live = undefined;
  }
  const known = knownVariables(command, environment, directory);
  const lexed = lex(command, known);
  const fed = codeFed(lexed.commands);
  const browserOnly = new Set(lexed.commands.every((c) => c.words[0]?.source === "agent-browser") ? lexed.commands : []);
  const visit = async (cmd, parsed, env) => {
    const pathless = browserOnly.has(cmd) ? browserPathless(parsed.args, env) : undefined;
    if (pathless)
      return refuse3(`agent-browser ${pathless} with a relative path or none`, BROWSER_FIX);
    if (parsed.name === "" && !cmd.feedsShell || EXPORTS2.has(parsed.name)) {
      for (const here of places(env, directory)) {
        const sure = env.cwdSure !== undefined && here.cwd === env.cwdSure;
        const verdict = await fedScript(cmd, here, sure, inMain, visit);
        if (verdict)
          return verdict;
      }
      return;
    }
    const slot = slotWords(parsed);
    if (slot)
      return slot.length === 0 ? undefined : examine({ ...cmd, words: slot }, env, visit, false);
    const { args, local, name } = parsed;
    if (env.cwdAnywhere) {
      const blind = { ...env, cwd: undefined };
      const ran = runs(name, args, local, blind);
      if (ran && ranIn(ran.cwd, ran.also).some((dir) => dir === undefined || inMain(dir)))
        return refuse3(ran.what, ANYWHERE_FIX);
      const blindWrite = writeTargets(cmd, name, args).find((t) => {
        const path = pathOf(t, blind);
        return path === undefined || inMain(path);
      });
      if (blindWrite)
        return refuse3(`a write to ${blindWrite.value}`, ANYWHERE_FIX);
      const blindLive = name === "git" ? await liveRefusal(args, local, blind, (cwd) => cwd === undefined || inLive(cwd), ANYWHERE_FIX) : undefined;
      if (blindLive)
        return blindLive;
    }
    for (const here of places(env, directory)) {
      const sure = env.cwdSure !== undefined && here.cwd === env.cwdSure;
      const pipedTo = fed.get(cmd);
      if (pipedTo?.kind === "code" && inMain(here.cwd))
        return refuse3(`a pipe into an interpreter whose script, the piped input, the hook cannot read`, fixFor2(sure));
      if (pipedTo) {
        const verdict = await unreadScript(pipedTo.consumer, here, sure, inMain);
        if (verdict)
          return verdict;
      }
      const script = await fedScript(cmd, here, sure, inMain, visit);
      if (script)
        return script;
      const ran = runs(name, args, local, here);
      if (ran && (ranIn(ran.cwd, ran.also).some((dir) => inMain(dir)) || unreadFolder(ran.also)))
        return refuse3(ran.what, fixFor2(sure, ran.fix));
      const moved = name === "git" ? await liveRefusal(args, local, here, inLive, fixFor2(sure, LIVE_FIX)) : undefined;
      if (moved)
        return moved;
      const wrote = writeTargets(cmd, name, args).find((t) => inMain(pathOf(t, here)));
      if (wrote)
        return refuse3(`a write to ${pathOf(wrote, here)}`, fixFor2(sure));
    }
  };
  const steadyAt = steadyNames(namings(command), lexed.commands);
  const env = {
    cwd: directory,
    cwdSure: directory,
    files: new Map,
    hold: (word, cmd, here) => heldWord(word, here, steadyAt(cmd)),
    known,
    old: { dir: directory },
    process: environment,
    vars: new Map
  };
  return run(lexed, env, visit, true);
}
async function check5(raw, environment = process.env, main = mainCheckout2(resolve5(__CHECKOUT + "/scripts/hooks", "..", ".."))) {
  try {
    return await eachInput(raw, "no-main-checkout", (one) => inspect3(one, environment, main));
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-extensions-write.ts
var WHY_ROOT = "every guard reads its list and policy.json from there, so a session's write would change what a guard allows.";
var ROUTE = `${WHY_ROOT} A guard's list or setting changes only by the owner typing the playground command as a ! command in the dispatcher's terminal window, which runs without hooks: tell your lead, and the dispatcher hands the owner the command. A session writes nothing there by hand.`;
var PRIVACY_KEYS = new Set(["factory.archiveRepo", "owner.names"]);
var PRIVACY = "at your login's scope, which Privacy on the Dashboard's Settings page saves";
var PRIVACY_ROUTE = "every guard reads policy.json from there, so a session's write would change what a guard allows: tell your lead, and the dispatcher asks the owner to save it in Privacy on the Dashboard's Settings page. A session writes nothing there by hand.";
var refuse4 = (what) => `no-extensions-write hook refuses ${what}: ${what.endsWith(PRIVACY) ? PRIVACY_ROUTE : ROUTE}`;
var TOO_LONG = "a command too long or nested too deep to read inside the hook's time: split it into shorter calls";
var READERS2 = new Set([
  "[",
  "cat",
  "cmp",
  "diff",
  "grep",
  "head",
  "jq",
  "ls",
  "readlink",
  "realpath",
  "shasum",
  "stat",
  "tail",
  "test",
  "wc"
]);
var GIT_READS = new Set([
  "blame",
  "cat-file",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status"
]);
var EXPORTS3 = new Set(["declare", "export", "local", "readonly", "typeset"]);
var REMOVERS = new Set(["find", "mv", "rm", "rmdir", "rsync", "unlink"]);
var GETOPT_REMOVERS = new Set(["mv", "rm", "rmdir", "unlink"]);
var RSYNC_FLAGS = new Set(["backup", "partial"]);
var WRITERS = new Set(["cp", "dd", "install", "ln", "mkdir", "tee", "touch"]);
var CLI = join11("packages", "scripts", "src", "playground", "cli.ts");
var varsRun = new WeakMap;
var GH_READS = new Set([
  "api",
  "issue list",
  "issue view",
  "pr list",
  "pr view",
  "run list",
  "run view",
  "search"
]);
var GH_POSTS = new Set([
  "issue comment",
  "issue create",
  "issue edit",
  "pr comment",
  "pr create",
  "pr edit"
]);
var GUARD_KEYS = new Set([
  "ext.links",
  "ext.order",
  "ext.repos",
  "factory.archiveRepo",
  "factory.publicRepo",
  "glm.readOnlyLoad5",
  "live.branch",
  "owner.names",
  "paths.codeRoot",
  "sessions.aliases",
  "sessions.names",
  "slack.gatedSends",
  "usage.keychainService"
]);
var EXT_WRITES = new Set(["add", "import", "init", "link", "order", "remove", "sync", "unlink"]);
var EXT_DRY = new Set(["add", "import", "init"]);
var IDENTITY = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "PLAYGROUND_ROLE"];
var SCORE_AS_OTHER = `playground ext score on a line that clears or sets ${IDENTITY.join(", ")}, which reads as another author than the calling session`;
var AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
var EVALUATES2 = new Set(["-e", "-ep", "--eval", "-p", "-pe", "--print"]);
var SEDS = new Set(["gsed", "sed"]);
var SED_BRACKET = String.raw`\[\^?\]?[^\]/[\n]*\]`;
var SED_BODY = String.raw`(?:[^/\\\n[]|\\.|${SED_BRACKET})*/`;
var SED_TEXT = String.raw`(?:[^/\\\n]|\\.)*/`;
var SED_ADDRESS = String.raw`(?:\d+|\$|/${SED_BODY})`;
var SED_ITEM = String.raw`[ \t]*(?:${SED_ADDRESS}(?:[ \t]*,[ \t]*(?:${SED_ADDRESS}|[+~]\d+))?[ \t]*!?[ \t]*)?(?:[=dlnNpPqQ]|s/${SED_BODY}${SED_TEXT}[giImMp0-9]*)[ \t]*`;
var SED_SCRIPT = new RegExp(String.raw`^${SED_ITEM}(?:[;\n]${SED_ITEM})*;?$`);
var SED_EDIT_ADDRESS = String.raw`(?:\d+|\$|/${SED_BODY})`;
var SED_EDIT_ITEM = String.raw`[ \t]*(?:${SED_EDIT_ADDRESS}(?:[ \t]*,[ \t]*${SED_EDIT_ADDRESS})?[ \t]*)?(?:[dp]|s/${SED_BODY}${SED_TEXT}[gpI0-9]*)[ \t]*`;
var SED_EDIT = new RegExp(String.raw`^${SED_EDIT_ITEM}(?:[;\n]${SED_EDIT_ITEM})*;?$`);
var PERL_BODY = String.raw`(?:[^/\\\n@$(]|\((?![?*]\??\{)|\\.|\$(?=[/|)]))*/`;
var PERL_RE = `/${PERL_BODY}`;
var PERL_MATCH = String.raw`\$[1-9&](?![[{]|->)`;
var PERL_VALUE = String.raw`(?:"(?:[^"\\$@\n]|\\[nt"\\]|${PERL_MATCH})*"|\$[1-9&_])`;
var PERL_PRINT = String.raw`print(?:[ \t]+${PERL_VALUE}(?:[ \t]*,[ \t]*${PERL_VALUE})*)?(?:[ \t]+(?:for|if|unless|while)[ \t]+${PERL_RE}[gimsx]*)?`;
var PERL_SUB = String.raw`s/${PERL_BODY}(?:[^/\\\n@$]|\\.|${PERL_MATCH})*/[gimsx]*`;
var PERL_ITEM = String.raw`[ \t]*(?:${PERL_PRINT}|${PERL_SUB})[ \t]*`;
var PERL_SCRIPT = new RegExp(String.raw`^${PERL_ITEM}(?:;${PERL_ITEM})*;?[ \t]*$`);
var CODE_QUALIFIER = new RegExp(QUALIFIER.source.replace("([^\\s[{<])[^]*?\\1", "([^\\s[{<\\w])[^\\n]*?\\1").replace("|\\+\\w+", ""));
var IMPLICIT_SHELL = new Set(["exec", "execSync"]);
async function guarded(raw, environment = process.env, wait = 12000, url = new URL(`./no-extensions-write-worker.${import.meta.path.endsWith(".js") ? "js" : "ts"}`, import.meta.url).href) {
  const worker = new Worker(url);
  let timer;
  try {
    return await Promise.race([
      new Promise((done) => {
        worker.onmessage = (event) => done(event.data);
        worker.onerror = () => done(undefined);
        worker.postMessage({ environment, raw });
      }),
      new Promise((done) => {
        timer = setTimeout(() => done(refuse4(TOO_LONG)), wait);
      })
    ]);
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}
if (false) {}

// scripts/hooks/no-false-green.ts
var TAKES2 = new Set([
  "-C",
  "-c",
  "--config",
  "--cwd",
  "--dir",
  "--env-file",
  "-F",
  "--filter",
  "--prefix",
  "-w",
  "--workspace"
]);
var RUNNERS3 = new Set(["bun", "npm", "pnpm", "yarn"]);
var EXECS = new Set(["bunx", "npx", "pnpx"]);
var TEST_BINS = new Set(["jest", "vitest"]);
var PY_TOOLS = new Set(["pytest", "ruff", "ty"]);
var TEST_SCRIPT = /^(?:check-types|test)(?::|$)/;
var positionals = (args) => {
  const out = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (TAKES2.has(v))
      k++;
    else if (!v.startsWith("-"))
      out.push(v);
  }
  return out;
};
function inner2(cmd, parsed) {
  const { args, name } = parsed;
  const slot = slotWords(parsed);
  if (slot)
    return slot.length === 0 ? [] : [{ ...cmd, scope: 0, words: slot }];
  if (!SHELLS.has(name))
    return;
  const script = shellSlot(args, name);
  if (script)
    return [{ ...cmd, scope: 0, words: script }];
  const { inline, operand } = shellOperand(args, name);
  return inline && operand !== undefined ? lex(operand.value).commands : [];
}
function pushes(cmd) {
  const parsed = parse(cmd);
  const commands = inner2(cmd, parsed);
  if (commands)
    return commands.some(pushes);
  const { args, name } = parsed;
  if (name !== "git")
    return false;
  let k = 0;
  for (;k < args.length && args[k].value.startsWith("-"); k++)
    if (GIT_TAKES.has(args[k].value))
      k++;
  return args[k]?.value === "push";
}
function runsTests(cmd) {
  const parsed = parse(cmd);
  const commands = inner2(cmd, parsed);
  if (commands)
    return commands.some(runsTests);
  const { args, name } = parsed;
  if (TEST_BINS.has(name) || PY_TOOLS.has(name.replace(/@.*$/, "")))
    return true;
  const python = pythonModule(name, args);
  if (python)
    return PY_TOOLS.has(python.module);
  if (name === "uv" || name === "uvx") {
    const { positionals: words } = parseFlags(args, UV_TAKES);
    const sub = words[0]?.value;
    const from = name === "uvx" ? words[0] : sub === "run" ? words[1] : sub === "tool" && words[1]?.value === "run" ? words[2] : undefined;
    return from !== undefined && runsTests({ ...cmd, scope: 0, words: args.slice(args.indexOf(from)) });
  }
  const [sub = "", next = ""] = positionals(args);
  if (EXECS.has(name))
    return TEST_BINS.has(program(sub));
  if (!RUNNERS3.has(name))
    return false;
  if (sub === "run" || sub === "run-script")
    return TEST_SCRIPT.test(next);
  if (sub === "x" || sub === "exec" || sub === "dlx")
    return TEST_BINS.has(program(next));
  return TEST_SCRIPT.test(sub);
}
function misread(args) {
  let flag;
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (!v.startsWith("-"))
      return v === "run" || v === "test" ? flag && `${flag} <value>, with a space, before ${v}` : undefined;
    const next = args[k + 1]?.value ?? "";
    if (v.includes("=") || next.startsWith("-") || next === "run" || next === "test")
      continue;
    flag ??= v;
    k++;
  }
}
var setsPipefail = (s) => /\bset\b[^;&|\n]*\bpipefail\b/.test(s);
var setoptPipefail = (s) => [...s.matchAll(/\bsetopt\b([^;&|\n]*)/g)].some((m) => /\bpipefail\b/.test(m[1].replaceAll("_", "").toLowerCase()));
var KEEPS_STATUS = {
  bash: (s) => setsPipefail(s) || /\$\{PIPESTATUS\[/.test(s),
  zsh: (s) => setsPipefail(s) || setoptPipefail(s) || /\$\{?pipestatus\[[1-9]/.test(s)
};
var dialect = (shell) => program(shell) === "zsh" ? "zsh" : "bash";
function judge3(script, shell) {
  const guarded = KEEPS_STATUS[shell](script);
  for (const cmd of lex(script).commands) {
    const reason = judgeCommand(cmd, guarded);
    if (reason)
      return reason;
  }
}
function judgeCommand(cmd, guarded) {
  const parsed = parse(cmd);
  const { args, name } = parsed;
  const slot = slotWords(parsed);
  if (slot)
    return slot.length === 0 ? undefined : judgeCommand({ ...cmd, scope: 0, words: slot }, guarded);
  if (SHELLS.has(name)) {
    const script = shellSlot(args, name);
    if (script)
      return judgeCommand({ ...cmd, scope: 0, words: script }, guarded);
    const { inline, operand } = shellOperand(args, name);
    const reason = inline && operand ? judge3(operand.value, dialect(name)) : undefined;
    if (reason)
      return reason;
  }
  const flag = name === "bun" ? misread(args) : undefined;
  if (flag)
    return `no-false-green hook refuses bun ${flag}: bun then misreads the subcommand (run prints its usage and exits 0, test runs package.json's test script with the paths appended in place of the tests), so its exit says nothing about the tests. Join the value with = (--opt=value) or put the option after the subcommand: bun --cwd=<dir> run test:file <files>, or bun run --cwd <dir> <script>.`;
  if (!guarded && cmd.stdin && runsTests(cmd.stdin))
    return `no-false-green hook refuses a test run piped into ${name || "a command group"} with no pipefail: a pipeline's exit status is its last command's, so a failing run reads 0. Drop the pipe (the Bash tool keeps long output), or set pipefail inside the script that holds the pipe (set -o pipefail; first, inside the quotes of a bash -c script) so the test's own exit status comes through.`;
  if (!guarded && cmd.stdin && pushes(cmd.stdin))
    return `no-false-green hook refuses a git push piped into ${name || "a command group"} with no pipefail: a pipeline's exit status is its last command's, so a failed push reads 0. Push bare (the Bash tool keeps its output), then check it with git ls-remote origin refs/heads/<branch>, which prints the local head's sha once the push has landed.`;
}
async function inspect4(raw, shell) {
  const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
  if (tool !== "Bash" || typeof toolInput?.command !== "string")
    return;
  const { command } = toolInput;
  const words = /\b(?:bun|bunx|git|jest|npm|npx|pnpm|pnpx|pytest|ruff|ty|vitest|yarn)\b/;
  if (!words.test(command.replace(/["'\\]/g, "")))
    return;
  return judge3(command, dialect(shell));
}
async function check6(raw, shell = process.env.SHELL ?? "zsh") {
  try {
    return await inspect4(raw, shell);
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-glm-heavy-path.ts
import { existsSync as existsSync8, readdirSync as readdirSync4, readFileSync as readFileSync5, readlinkSync, realpathSync as realpathSync4 } from "fs";
import { loadavg } from "os";
import { basename as basename5, dirname as dirname6, isAbsolute as isAbsolute5, join as join13, resolve as resolve7 } from "path";

// packages/settings/src/harnesses.ts
var HARNESSES = [
  { backends: ["claude", "glm"], id: "claude-code" },
  { backends: ["openai"], id: "codex" }
];
var GLM_MODEL = "glm";
var readPin = (text) => {
  const words = text.trim().split(/\s+/);
  const [harnessId, backend] = words.length === 1 ? ["claude-code", words[0]] : words;
  if (words.length > 2)
    return null;
  const harness = HARNESSES.find((h) => h.id === harnessId);
  const found = harness?.backends.find((b) => b === backend);
  return harness && found ? { backend: found, harness: harness.id } : null;
};

// packages/settings/src/rules.ts
var percent = number2().int().min(1).max(100);
var ruleSettings = defineSettings({
  "battery.alert": {
    default: 5,
    description: "The battery percent, while the charge falls on battery or on a charger losing to the load, at which the battery check posts its red alert and the heavy runs wait in run-slot.",
    schema: percent
  },
  "battery.ask": {
    default: 10,
    description: "The battery percent, while the Mac discharges on battery, at which the battery check posts its orange ask.",
    schema: percent
  },
  "clock.ownerZone": {
    default: "UTC",
    description: "The time zone, by its IANA name, a time shown to the owner reads in.",
    schema: string2().refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "an IANA time zone, such as UTC or America/New_York")
  },
  "context.window": {
    default: 400000,
    description: "The context window, in tokens, every session compacts itself in.",
    schema: number2().int().positive()
  },
  "github.pollMinutes": {
    default: 5,
    description: "The fewest minutes between two polls of one pull request by a session.",
    schema: number2().int().positive()
  },
  "glm.readOnlyLoad5": {
    default: 15,
    description: "The 5-minute load average above which a GLM session may not install, commit or push.",
    schema: number2().positive()
  },
  "release.hours": {
    default: 4,
    description: "The hours of merging after which Ops ships canary to main, whatever the count.",
    schema: number2().positive()
  },
  "release.merges": {
    default: 3,
    description: "The user-facing merges since the last ship at which Ops ships canary to main.",
    schema: number2().int().positive()
  },
  "tickets.tracker": {
    default: "the tracker",
    description: "The issue tracker the tickets rule names, read inside its sentence, such as Linear.",
    schema: string2().min(1)
  },
  "unstick.escalateMinutes": {
    default: 5,
    description: "The minutes a session stays stuck with no turn before ops-session-resume tells the primary dispatcher.",
    schema: number2().int().positive()
  }
});

// scripts/hooks/no-headless-login.ts
import { join as join12 } from "path";
var TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
var ROLE = "PLAYGROUND_ROLE";
var KEYCHAIN_SERVICE = "playground-claude-oauth";
var keychainOf = async (environment) => {
  const read = await readPolicy(dataDir(environment));
  const service = read.settings?.values["usage.keychainService"];
  return typeof service === "string" && service ? service : KEYCHAIN_SERVICE;
};
async function accountOf(id, environment) {
  if (typeof id !== "string")
    return;
  try {
    const name = await registryName(id, environment);
    if (!name)
      return;
    const record = await Bun.file(join12(dataDir(environment), "resume", `${name}.sh`)).text();
    return /^# account: (\S+)/m.exec(record)?.[1] ?? /--account (\S+)/.exec(record)?.[1];
  } catch {
    return;
  }
}
var headless = ({ args }) => args.some((a) => a.value === "--print" || /^-[A-Za-z]*p[A-Za-z]*$/.test(a.value));
var sets = (key, { local }, env) => {
  const value = local.get(key) ?? env.vars.get(key);
  return value !== undefined && value.value !== "";
};
async function check7(raw, environment = process.env) {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
    if (tool !== "Bash" || typeof toolInput?.command !== "string")
      return;
    if (!/claude/.test(toolInput.command.replace(/["'\\]/g, "")))
      return;
    const id = sessionOf(raw);
    const role = await sessionRole(environment, id);
    if (!role)
      return;
    const missing = [];
    const visit = async (_cmd, parsed, shell) => {
      if (parsed.name !== "claude" || !headless(parsed))
        return;
      if (!sets(TOKEN, parsed, shell))
        missing.push(TOKEN);
      if (!environment[ROLE] && !sets(ROLE, parsed, shell))
        missing.push(ROLE);
      return missing.length ? "refuse" : undefined;
    };
    const env = { files: new Map, known: {}, process: {}, vars: new Map };
    if (!await run(lex(toolInput.command), env, visit))
      return;
    const account = await accountOf(id, environment) ?? "<your --account>";
    return `no-headless-login hook refuses a headless claude that does not set ${missing.join(" or ")}: without the token it bills this machine's own login, not your account, and without the role the factory's hooks pass it. Run it as: tk="$(security find-generic-password -s ${await keychainOf(environment)} -a ${account} -w)"; ${TOKEN}="$tk" ${ROLE}=${role} env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY claude -p ...`;
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-glm-heavy-path.ts
var OPUS_PATHS = [
  ".github/workflows/",
  "lefthook.yml",
  "packages/scripts/src/pr-merge/",
  "packages/scripts/src/verify/",
  "scripts/hooks/",
  "scripts/spawn.sh",
  "web/next/"
];
var COMMIT_TAKES2 = new Set([
  "--author",
  "-c",
  "-C",
  "--cleanup",
  "--date",
  "-F",
  "--file",
  "--fixup",
  "-m",
  "--message",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "-t",
  "--template",
  "--trailer"
]);
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
var ADD_TAKES = new Set(["--chmod", "--pathspec-from-file"]);
var PUSH_TAKES2 = new Set(["--exec", "-o", "--push-option", "--receive-pack", "--repo"]);
var loadLimit = async (environment) => {
  const read = await readPolicy(dataDir(environment)).catch(() => {
    return;
  });
  return ruleSettings.get(read?.settings ?? { schemaVersion: 1, values: {} }, "glm.readOnlyLoad5");
};
var currentLoad5 = () => loadavg()[1];
var INSTALLS = new Set([
  "add",
  "ci",
  "cit",
  "i",
  "install",
  "install-ci-test",
  "install-test",
  "it",
  "up",
  "update"
]);
var YARN_INFO = new Set(["-h", "--help", "-v", "--version"]);
var PIP = /^pip(?:\d+(?:\.\d+)*)?$/;
var PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
var RUNNER_TAKES2 = new Set([
  "-C",
  "--cwd",
  "--dir",
  "-F",
  "--filter",
  "--prefix",
  "-w",
  "--workspace"
]);
var COPIERS = new Set(["cp", "ditto", "rsync"]);
var BUSY_RUN = /\b(?:bun|cp|ditto|npm|pip[\d.]*|pipx|pnpm|python[\d.]*|rsync|uv|yarn)\b/i;
var GIT_CALL = /\bgit\b[\s\S]*\b(?:commit|push)\b/i;
var MCP_RESOURCE_TOOLS = new Set([
  "ListMcpResourcesTool",
  "ReadMcpResourceDirTool",
  "ReadMcpResourceTool"
]);
var ORG_CALL = /\b(?:claude|curl|dm|gh|git|https?|wget|xh)\b|linear[-:]|mcp__/i;
var heavy = (path) => OPUS_PATHS.some((p) => p.endsWith("/") ? path.startsWith(p) : path === p);
async function onGlm(raw, environment = process.env) {
  if (/(?:^|\/\/|\.)api\.z\.ai(?:[:/]|$)/.test(environment.ANTHROPIC_BASE_URL ?? ""))
    return true;
  const id = sessionOf(raw);
  if (typeof id !== "string")
    return false;
  try {
    const name = await registryName(id, environment);
    if (!name || name.includes("/"))
      return false;
    const pin = join13(dataDir(environment), "backends", name);
    return readPin(await Bun.file(pin).text())?.backend === "glm";
  } catch {
    return false;
  }
}
var refuse5 = (what, files) => `no-glm-heavy-path hook refuses this ${what}: it touches ${files.join(", ")}, which is Opus work, and this session runs on GLM. Stop, report to your lead with this file list, and the lead moves the change to a Claude worker.`;
var unread2 = (what, why) => `no-glm-heavy-path hook refuses this ${what}: it cannot read ${why}, and this session runs on GLM, whose commits and pushes must stay off Opus paths. Run it again from your own worktree with a literal path, or report to your lead.`;
var loaded = (what, load5, limit) => `no-glm-heavy-path hook refuses this ${what}: load5 is ${load5.toFixed(1)}, and a GLM session goes read-only while load5 is over ${limit} (no install, node_modules clone, commit or push). Wait until load5 is ${limit} or under (the middle figure of sysctl -n vm.loadavg), then run it again, or report to your lead.`;
function installOrClone(name, args) {
  if (COPIERS.has(name))
    return args.some((a) => /(?:^|\/)node_modules$/.test(a.value.replace(/\/(?:\.|\*)?$/, ""))) ? "node_modules clone" : undefined;
  const python = pythonModule(name, args);
  if (python)
    return PIP.test(python.module) ? installOrClone("pip", python.rest) : undefined;
  const { flags, positionals } = parseFlags(args, name === "uv" ? UV_TAKES : RUNNER_TAKES2);
  const [sub, next] = positionals.map((w) => w.value);
  if (name === "uv" && sub === "run" && next !== undefined)
    return installOrClone(program(next), args.slice(args.indexOf(positionals[1]) + 1));
  if (name === "yarn" && sub === undefined && !flags.some((f) => YARN_INFO.has(f.name)))
    return "yarn install";
  if (name === "yarn" && sub === "global" && next === "add")
    return "yarn global add";
  if (name === "yarn" && sub === "workspace" && next !== undefined)
    return installOrClone("yarn", args.slice(args.indexOf(positionals[1]) + 1));
  const upgrade = sub === "upgrade" && name !== "bun";
  if (PACKAGE_MANAGERS.has(name) && sub !== undefined && (INSTALLS.has(sub) || upgrade))
    return `${name} ${sub}`;
  if (name === "uv" && (sub === "add" || sub === "sync"))
    return `uv ${sub}`;
  if (name === "uv" && sub === "pip" && (next === "install" || next === "sync"))
    return `uv pip ${next}`;
  if (name === "uv" && sub === "tool" && next === "install")
    return "uv tool install";
  if ((PIP.test(name) || name === "pipx") && sub === "install")
    return `${name} install`;
}
function names2(dir, args, separator = `
`) {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stderr: "ignore"
  });
  if (proc.exitCode !== 0)
    return null;
  return proc.stdout.toString().split(separator).filter((line) => line !== "");
}
var pathsOf = (dir, [sub, ...rest]) => names2(dir, [sub, "-z", ...rest], "\x00");
var plain = (w) => !unreadable(w);
function changedBy(dir, ours, theirs) {
  const base = names2(dir, ["merge-base", ours, theirs])?.[0];
  return base ? pathsOf(dir, ["diff", "--name-only", "--no-renames", base, theirs]) : null;
}
function mergedTree(dir, ours, theirs) {
  const proc = Bun.spawnSync(["git", "-C", dir, "merge-tree", "--write-tree", ours, theirs], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stderr: "ignore"
  });
  if (proc.exitCode !== 0 && proc.exitCode !== 1)
    return null;
  return proc.stdout.toString().split(`
`)[0] || null;
}
function beyondMerge(files, ours, theirs, read, dir) {
  const tree = mergedTree(dir, ours, theirs);
  const lists = tree ? read(tree) : [null];
  if (lists.some((l) => l === null))
    return;
  const own = new Set(lists.flat());
  for (const file of files)
    if (!own.has(file))
      files.delete(file);
}
async function mergeHeads(dir) {
  const path = names2(dir, ["rev-parse", "--git-path", "MERGE_HEAD"])?.[0];
  if (!path)
    return null;
  const file = Bun.file(resolve7(dir, path));
  if (!await file.exists())
    return [];
  return (await file.text()).split(`
`).filter((line) => line.trim() !== "");
}
var STAGING = new Set(["add", "diff", "log", "show", "status"]);
var BRANCH_READS = new Set(["branch --show-current", "rev-parse --abbrev-ref HEAD"]);
var SUBSTITUTION = unknown("a command substitution");
var PURE = new Set(["cat", "date", "echo", "printf", "pwd", "true"]);
var writes2 = (cmd) => cmd.redirects.some((r) => r.op.includes(">") && !/^(?:\d+|-|\/dev\/null)$/.test(r.target?.value ?? ""));
var chainRefusal = (what, made) => `no-glm-heavy-path hook refuses this ${what}: it runs after another command in the same call, which may make ${made} before it runs, and the hook reads the checkout before the call starts, while this session runs on GLM. Run ${what} as its own call${what === "git commit" ? ", or after git add alone" : ""}.`;
async function commit(rest, dir, chained, forced) {
  const { flags, positionals } = parseFlags(rest, COMMIT_TAKES2);
  if (positionals.some((w) => !plain(w)))
    return unread2("git commit", "the paths it names, built at run time");
  if (flags.some((f) => f.name === "--pathspec-from-file"))
    return unread2("git commit", "the paths --pathspec-from-file names");
  const all = flags.some((f) => f.name === "-a" || f.name === "--all");
  const paths = positionals.map((w) => w.value);
  const worktree = all || paths.length > 0 || chained;
  const untracked = chained ? pathsOf(dir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--full-name",
    "--",
    ...paths.length > 0 ? paths : [":(top)"]
  ]) : [];
  const ignored = chained && forced.length > 0 ? pathsOf(dir, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--full-name",
    "--",
    ...forced
  ]) : [];
  if (untracked === null || ignored === null)
    return unread2("git commit", "the files it commits");
  untracked.push(...ignored);
  const against = (base) => [
    pathsOf(dir, ["diff", "--cached", "--name-only", "--no-renames", base]),
    ...worktree ? [pathsOf(dir, ["diff", base, "--name-only", "--no-renames", "--", ...paths])] : [],
    untracked
  ];
  const born = names2(dir, ["rev-parse", "-q", "--verify", "HEAD"]) !== null;
  const lists = against(born ? "HEAD" : EMPTY_TREE);
  if (lists.some((l) => l === null))
    return unread2("git commit", "the files it commits");
  const heads = await mergeHeads(dir);
  if (heads === null)
    return unread2("git commit", "the merge it concludes");
  const sides = heads.map((head) => ({
    changed: changedBy(dir, "HEAD", head),
    differs: against(head)
  }));
  if (sides.some((s) => [s.changed, ...s.differs].some((l) => l === null)))
    return unread2("git commit", "the files it commits");
  const differ = sides.map((s) => new Set(s.differs.flat()));
  const files = new Set([...new Set(lists.flat())].filter((f) => differ.every((d) => d.has(f))));
  sides.forEach((side, i) => {
    for (const file of side.changed)
      if (differ[i].has(file))
        files.add(file);
  });
  if (heads.length === 1)
    beyondMerge(files, "HEAD", heads[0], against, dir);
  const heavyFiles = [...files].filter(heavy).sort();
  if (heavyFiles.length === 0)
    return;
  const staged = new Set(lists[0]);
  if (chained && !all && paths.length === 0 && heavyFiles.every((f) => !staged.has(f)))
    return `no-glm-heavy-path hook refuses this git commit: ${heavyFiles.join(", ")} is on disk and not staged, and the hook cannot tell before the call runs whether the git add before it stages it, while this session runs on GLM and that is Opus work. Run git commit as its own call.`;
  return refuse5("git commit", heavyFiles);
}
function rebased(dir, named, source, dest, not) {
  const branch = dest === "HEAD" ? names2(dir, ["symbolic-ref", "-q", "--short", "HEAD"])?.[0] : dest.replace(/^refs\/heads\//, "");
  if (!branch)
    return;
  const config = (key) => names2(dir, ["config", "--get", key])?.[0];
  const remote = named ?? config(`branch.${branch}.pushRemote`) ?? config("remote.pushDefault") ?? config(`branch.${branch}.remote`) ?? "origin";
  const old = names2(dir, ["rev-parse", "-q", "--verify", `refs/remotes/${remote}/${branch}`])?.[0];
  if (!old)
    return;
  const ancestor = Bun.spawnSync(["git", "-C", dir, "merge-base", "--is-ancestor", old, source], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stderr: "ignore"
  });
  if (ancestor.exitCode !== 1)
    return;
  const oldest = names2(dir, ["rev-list", "--reverse", "--topo-order", source, "--not", not])?.[0];
  const base = oldest && names2(dir, ["rev-parse", "-q", "--verify", `${oldest}^`])?.[0];
  return base ? [old, base] : undefined;
}
function push2(rest, dir, branchReads) {
  const { flags, positionals } = parseFlags(rest, PUSH_TAKES2);
  const given = new Set(flags.map((f) => f.name));
  const reads = branchReads.filter((d) => d === dir);
  const [remote, ...refspecs] = positionals.map((w, i) => i > 0 && w.unknown === SUBSTITUTION.unknown && w.value === SUBSTITUTION.value && reads.pop() ? { quoted: w.quoted, value: "HEAD" } : w);
  if ([remote, ...refspecs].some((w) => w && !plain(w)))
    return `no-glm-heavy-path hook refuses this git push: it cannot read the refs it pushes, built at run time, and this session runs on GLM, whose pushes must stay off Opus paths. Run it again naming each ref literally (git push origin <branch>), or report to your lead.`;
  const sources = [];
  if (given.has("--all") || given.has("--branches") || given.has("--mirror"))
    sources.push("--branches");
  if (given.has("--tags") || given.has("--follow-tags") || given.has("--mirror"))
    sources.push("--tags");
  const deleting = given.has("--delete") || given.has("-d");
  const dests = [];
  for (const spec of refspecs) {
    const [source, dest = source] = spec.value.replace(/^\+/, "").split(":");
    if (source !== "" && !deleting) {
      sources.push(source);
      dests.push(dest);
    }
  }
  const replaced = ["--all", "--branches", "--mirror", "--tags"].some((f) => given.has(f));
  if (refspecs.length === 0 && !replaced) {
    sources.push("HEAD");
    dests.push("HEAD");
  }
  if (deleting && sources.length === 0)
    return;
  const name = remote && !/[:/]/.test(remote.value) ? remote.value : undefined;
  const tracked = name && names2(dir, ["for-each-ref", "--count=1", `refs/remotes/${name}`])?.length;
  const not = tracked ? `--remotes=${name}` : "--remotes";
  const listed = pathsOf(dir, [
    "log",
    "--name-only",
    "--no-renames",
    "--diff-merges=off",
    "--format=",
    ...sources,
    "--not",
    not
  ]);
  const merges = names2(dir, ["rev-list", "--merges", ...sources, "--not", not]);
  if (listed === null || merges === null)
    return unread2("git push", "the files of the commits it pushes");
  const files = new Set(listed);
  for (const merge of merges) {
    const [first, ...others] = names2(dir, ["rev-parse", `${merge}^@`]) ?? [];
    if (!first)
      return unread2("git push", "the parents of a merge it pushes");
    const own = pathsOf(dir, [
      "show",
      "--name-only",
      "--no-renames",
      "--diff-merges=dense-combined",
      "--format=",
      merge
    ]);
    if (own === null)
      return unread2("git push", "the files of the commits it pushes");
    const made = new Set(own);
    for (const other of others) {
      const changed = changedBy(dir, first, other);
      const differs = pathsOf(dir, ["diff", "--name-only", "--no-renames", other, merge]);
      if (changed === null || differs === null)
        return unread2("git push", "the files of the commits it pushes");
      for (const file of changed)
        if (differs.includes(file))
          made.add(file);
    }
    if (others.length === 1)
      beyondMerge(made, first, others[0], (tree) => [pathsOf(dir, ["diff", "--name-only", "--no-renames", tree, merge])], dir);
    for (const file of made)
      files.add(file);
  }
  const bases = sources.length === 1 && dests.length === 1 && (!remote || name) ? rebased(dir, name, sources[0], dests[0], not) : undefined;
  if (bases)
    beyondMerge(files, bases[0], bases[1], (tree) => [pathsOf(dir, ["diff", "--name-only", "--no-renames", tree, sources[0]])], dir);
  const heavyFiles = [...files].filter(heavy).sort();
  return heavyFiles.length > 0 ? refuse5("git push", heavyFiles) : undefined;
}
function forcedPaths(rest, dir) {
  const { flags, positionals } = parseFlags(rest, ADD_TAKES);
  if (!flags.some((f) => f.name === "-f" || /^--f(?:o(?:r(?:ce?)?)?)?$/.test(f.name)))
    return [];
  const named = !dir || flags.some((f) => f.name === "--pathspec-from-file") ? [] : positionals;
  if (named.length === 0 || named.some((w) => !plain(w) || w.value.startsWith(":")))
    return [":(top)"];
  return named.map((w) => resolve7(dir, w.value));
}
var guardedOf = async (environment) => {
  try {
    const read = await readPolicy(dataDir(environment));
    return read.refusal !== undefined ? { refusal: read.refusal } : guardedOrgs(read.settings.values);
  } catch (error) {
    return { refusal: String(error) };
  }
};
var LEAD = "Stop, report to your lead with this call, and the lead moves the task to a Claude worker.";
var orgRefusal = (what, why, fix = LEAD) => `no-glm-heavy-path hook refuses ${what}: ${why}, and this session runs on GLM, which the glm rule (playground rules glm) keeps off every org's tracker, chat, docs, repos, checkouts and databases, and off a headless Claude run. ${fix}`;
var PLACE_FIX2 = `Name the repository literally (--repo <owner>/<name>, or repos/<owner>/<name>/... for gh api) in a call of its own, or report to your lead.`;
var ORG_HOSTS = [
  [/(?:^|[/@.])(linear\.app)(?=[:/?#]|$)/i, "tracker"],
  [/(?:^|[/@.])(notion\.(?:com|site|so))(?=[:/?#]|$)/i, "docs"],
  [/(?:^|[/@.])(slack\.com)(?=[:/?#]|$)/i, "chat"]
];
var FETCHERS = new Set(["curl", "http", "https", "wget", "xh"]);
var GH_API_TAKES = new Set([
  "--cache",
  "-F",
  "-f",
  "--field",
  "-H",
  "--header",
  "--hostname",
  "--input",
  "-p",
  "--preview",
  "-q",
  "--jq",
  "--raw-field",
  "-t",
  "--template",
  "-X",
  "--method"
]);
var ORG_SCRIPT_DIRS = [
  [
    /(?<!\/tests)\/packages\/scripts\/src\/linear-[\w-]+(?:\/|$)/,
    "a Linear script, which reads or writes an org's tracker"
  ],
  [
    /(?<!\/tests)\/packages\/scripts\/src\/dm(?:\/|$)/,
    "the DM sender, which posts to the owner's chat"
  ]
];
var RUNNERS4 = new Set([
  "bash",
  "bun",
  "bunx",
  "deno",
  "node",
  "npm",
  "npx",
  "pnpm",
  "sh",
  "tsx",
  "yarn",
  "zsh"
]);
var RUNNER_DIR = /^(?:--cwd|--dir|--prefix|-C)(?:=|$)/;
var scriptDir = (path) => path === undefined ? undefined : ORG_SCRIPT_DIRS.find(([at]) => at.test(path))?.[1];
function packageScripts(dir) {
  const found = new Map;
  for (let at = dir;; at = dirname6(at)) {
    try {
      const { scripts } = JSON.parse(readFileSync5(join13(at, "package.json"), "utf8"));
      for (const [name, command] of Object.entries(scripts ?? {}))
        if (!found.has(name) && typeof command === "string")
          found.set(name, { at, command });
    } catch {}
    if (dirname6(at) === at)
      return found;
  }
}
var FOLDER_FIX = "Name the folder literally, in a call of its own, or report to your lead.";
function orgScript(parsed, env) {
  const { args, first, name } = parsed;
  if (first?.value.includes("/")) {
    const program = pathOf(first, env);
    if (!program)
      return {
        fix: FOLDER_FIX,
        why: "the hook cannot tell which script it runs, since a value or folder it cannot read names its program"
      };
    const own = scriptDir(program);
    if (own)
      return { why: `it runs ${own}` };
  }
  if (name === "playground" && args.find((a) => !a.value.startsWith("-"))?.value === "dm")
    return { why: `it runs ${ORG_SCRIPT_DIRS[1][1]}` };
  if (!RUNNERS4.has(name))
    return;
  let at = env.cwd;
  for (let i = 0;i < args.length; i++) {
    const flag = RUNNER_DIR.exec(args[i].value);
    if (!flag)
      continue;
    const value = flag[0].endsWith("=") ? { ...args[i], value: args[i].value.slice(flag[0].length) } : args[++i];
    at = value ? pathOf(value, { ...env, cwd: at }) : undefined;
  }
  if (!at)
    return {
      fix: FOLDER_FIX,
      why: "the hook cannot tell which script it runs, since it runs in a folder a value it cannot read names"
    };
  at = realOf2(at);
  const scripts = packageScripts(at);
  for (const a of args) {
    if (a.value.startsWith("-") || unreadValue(a))
      continue;
    const script = scripts.get(a.value);
    const hit = scriptDir(pathOf(a, { ...env, cwd: at })) ?? script?.command.split(/\s+/).map((word) => scriptDir(resolve7(script.at, word))).find(Boolean);
    if (hit)
      return { why: `it runs ${hit}` };
  }
}
var CLAUDE_PACKAGE = /^@anthropic-ai\/claude-code(?:@\S*)?$/;
var URL_FILE = /^(?:-[A-Za-z]*K|--config(?:=|$))/;
var WGET_URL_FILE = /^(?:-[A-Za-z]*i|--input-file(?:=|$))/;
var ACCOUNT_WIDE = new Set(["org", "status"]);
var PLAIN_ENDPOINTS = new Set(["markdown", "rate_limit", "user"]);
var GH_PLACEHOLDERS = /^repos\/\{owner\}\/\{repo\}(?:\/|$)/;
var GITHUB_URL = /(?:github\.com|githubusercontent\.com)[/:](?:(?:repos|orgs|users)\/)?([\w.-]+)(?:\/([\w.-]+))?/i;
var REST_PATH = /^\/?(?:repos|orgs|users)\/([\w.-]+)(?:\/([\w.-]+))?/i;
var SCOPED = /^(?:--owner|--repo|-R)(?:=|$)|(?:^|\s)(?:org|owner|repo|user):\S/;
var isGuarded = (orgs, owner) => orgs.some((org) => org.toLowerCase() === owner.toLowerCase());
var label = (owner, repo) => repo ? `${owner}/${repo.replace(/\.git$/, "")}` : owner;
var namedOrg = (orgs, text) => orgs.find((org) => new RegExp(`(?:^|[^a-z\\d])${org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z\\d])`, "i").test(text));
var urlOrg = (orgs, value, rest = false) => {
  const m = GITHUB_URL.exec(value) ?? (rest ? REST_PATH.exec(value) : null);
  return m && isGuarded(orgs, m[1]) ? label(m[1], m[2]) : undefined;
};
var unreadValue = (w) => w.unknown !== undefined || Boolean(w.reads?.length) || marked(w.value);
var GRAPHQL_FIX = `Use a REST endpoint under repos/<owner>/<name>/ (gh api repos/<owner>/<name>/..., gh pr, gh issue), and reply to a review thread by REST, or report to your lead.`;
function ghOrg(parsed, env, orgs) {
  const { args } = parsed;
  const words = args.filter((a) => !a.value.startsWith("-") && !unreadValue(a)).map((a) => a.value);
  const head = args.slice(0, words[0] === "api" ? 1 : 2).filter((a) => !a.value.startsWith("-") && !unreadValue(a));
  const what = `this gh ${head.map((a) => a.value).join(" ")} call`;
  let placed = false;
  for (let i = 0;i < args.length; i++) {
    const v = args[i].value;
    const flag = v === "-R" || v === "--repo";
    const repo = flag ? args[++i] : v.startsWith("--repo=") ? { ...args[i], value: v.slice(7) } : undefined;
    if (!repo && !flag)
      continue;
    if (!repo || unreadValue(repo))
      return orgRefusal(what, "the hook cannot tell which repository it reaches, since a value it cannot read names it", PLACE_FIX2);
    const named = repoOf(repo);
    if (named && isGuarded(orgs, named.owner))
      return orgRefusal(what, `it reaches ${label(named.owner, named.repo)}, a guarded org's repository`);
    placed = true;
  }
  if (ACCOUNT_WIDE.has(words[0] ?? ""))
    return orgRefusal(what, "its reach is the whole account, every org it can read included");
  const api = words[0] === "api";
  const endpoint = api ? parseFlags(args.slice(1), GH_API_TAKES).positionals[0] : undefined;
  if (endpoint && unreadValue(endpoint))
    return orgRefusal(what, "the hook cannot tell which repository it reaches, since a value it cannot read names its endpoint", PLACE_FIX2);
  const path = endpoint?.value.replace(/^https?:\/\/api\.github\.com\//i, "").replace(/^\//, "").replace(/[?#].*$/, "");
  if (path === "graphql")
    return orgRefusal(what, "a GraphQL query can walk from any repository to every org the account can read", GRAPHQL_FIX);
  if (path !== undefined && !REST_PATH.test(path) && !GH_PLACEHOLDERS.test(path) && !path.startsWith("search/") && !PLAIN_ENDPOINTS.has(path))
    return orgRefusal(what, `its endpoint ${path} reaches across the account, every org it can read included`, PLACE_FIX2);
  for (const a of args) {
    const hit = urlOrg(orgs, a.value, a === endpoint);
    if (hit)
      return orgRefusal(what, `it reaches ${hit}, ${hit.includes("/") ? "a guarded org's repository" : "a guarded org"}`);
    if (GITHUB_URL.test(a.value) || a === endpoint && REST_PATH.test(a.value))
      placed = true;
  }
  const org = namedOrg(orgs, args.map((a) => a.value).join(" "));
  if (org)
    return orgRefusal(what, `it names ${org}, a guarded org`);
  if (placed)
    return;
  const search = words[0] === "search" || api && /^\/?search\//.test(endpoint?.value ?? "");
  if (search && !args.some((a) => SCOPED.test(a.value)))
    return orgRefusal(what, "a search with no owner or repository reaches every org the account can read", `Scope it with --repo <owner>/<name> or --owner <owner>, or report to your lead.`);
  if (search)
    return;
  const implicit = implicitRepos(env, parsed.local);
  if (implicit.some((r) => r === undefined) || !env.cwd && implicit.length === 0)
    return orgRefusal(what, "the hook cannot tell which repository it reaches, since it names none and runs where the hook cannot read GH_REPO or the checkout", PLACE_FIX2);
  const fallback = implicit.find((r) => r && isGuarded(orgs, r.owner));
  return fallback ? orgRefusal(what, `it falls back to ${label(fallback.owner, fallback.repo)}, a guarded org's repository`) : undefined;
}
function gitPlaces(parsed, env, dir) {
  const places = [dir];
  const at = (w) => unreadValue(w) ? undefined : pathOf(w, { ...env, cwd: dir });
  const { args, local } = parsed;
  for (let i = 0;i < args.length; i++) {
    const v = args[i].value;
    const joined = /^--(?:git-dir|work-tree)=/.exec(v);
    if (joined)
      places.push(at({ ...args[i], value: v.slice(joined[0].length) }));
    else if (v === "--git-dir" || v === "--work-tree")
      places.push(args[i + 1] ? at(args[++i]) : undefined);
    else if (GIT_TAKES.has(v))
      i++;
    else if (!v.startsWith("-"))
      break;
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE"]) {
    const set = local.get(key) ?? env.vars.get(key) ?? (env.process[key] ? { value: env.process[key] } : undefined);
    if (set && set.value !== "")
      places.push(at(set));
  }
  return places;
}
function gitOrg(parsed, env, dir, sub, orgs) {
  const { args } = parsed;
  const what = sub ? `this git ${sub} call` : "this git call";
  for (const a of args) {
    const hit = urlOrg(orgs, a.value);
    if (hit)
      return orgRefusal(what, `it reaches ${hit}, a guarded org's repository`);
  }
  const places = gitPlaces(parsed, env, dir);
  if (places.includes(undefined))
    return orgRefusal(what, "the hook cannot tell which repository it reads, since a value it cannot read names it", "Name the checkout by its literal path, in a call of its own, or report to your lead.");
  const remote = places.flatMap((place) => remotes(place)).find((r) => isGuarded(orgs, r.owner));
  return remote ? orgRefusal(what, `it runs in a checkout of ${label(remote.owner, remote.repo)}, a guarded org's repository`) : undefined;
}
var realOf2 = (path, depth = 0) => {
  try {
    return realpathSync4(path);
  } catch {}
  if (depth > 40)
    return path;
  try {
    return realOf2(resolve7(dirname6(path), readlinkSync(path)), depth + 1);
  } catch {}
  const parent = dirname6(path);
  return parent === path ? path : join13(realOf2(parent, depth + 1), basename5(path));
};
function checkoutOf(path, orgs, roots) {
  if (!path)
    return;
  const walked = [];
  let found;
  for (let at = realOf2(resolve7(path));; at = dirname6(at)) {
    if (roots.has(at)) {
      found = roots.get(at);
      break;
    }
    walked.push(at);
    if (existsSync8(join13(at, ".git"))) {
      found = remotes(at).find((r) => isGuarded(orgs, r.owner));
      break;
    }
    if (dirname6(at) === at)
      break;
  }
  for (const at of walked)
    roots.set(at, found);
  return found;
}
var checkoutRefusal = (what, repo) => orgRefusal(what, `it reads the checkout of ${label(repo.owner, repo.repo)}, a guarded org's repository`);
var READ_TOOLS = { Glob: "path", Grep: "path", Read: "file_path" };
var READS_NOTHING = new Set(["date", "echo", "printf", "pwd", "true"]);
var PATH_LIKE = /[/~]/;
var GLOB_CHARS2 = /[*?[]/;
var namesFile = (r) => r.target !== undefined && !r.body && (r.op === "<" || r.op === "<>" || r.op.startsWith(">") && !r.op.startsWith(">&"));
function braces(value, depth = 0) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(value);
  if (!m || depth > 8)
    return [value];
  const out = [];
  for (const part of m[1].split(","))
    out.push(...braces(value.slice(0, m.index) + part + value.slice(m.index + m[0].length), depth + 1));
  return out.slice(0, 64);
}
function globRegex(segment) {
  let re = "^";
  for (let i = 0;i < segment.length; i++) {
    const c = segment[i];
    if (c === "*")
      re += "[^/]*";
    else if (c === "?")
      re += "[^/]";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end < 0)
        re += "\\[";
      else {
        re += `[${segment.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}
function globbed(value, cwd) {
  const out = [];
  for (const pattern of braces(value)) {
    const root = isAbsolute5(pattern) ? "/" : cwd;
    if (!root)
      continue;
    let candidates = [root];
    for (const segment of pattern.split("/").filter((part) => part !== "")) {
      if (!GLOB_CHARS2.test(segment)) {
        candidates = candidates.map((at) => join13(at, segment));
        continue;
      }
      const re = globRegex(segment.replaceAll("**", "*"));
      const hidden = segment.startsWith(".");
      const next = [];
      for (const at of candidates) {
        let entries;
        try {
          entries = readdirSync4(at);
        } catch {
          continue;
        }
        for (const entry of entries)
          if ((hidden || !entry.startsWith(".")) && re.test(entry))
            next.push(join13(at, entry));
        if (next.length >= 200)
          break;
      }
      candidates = next.slice(0, 200);
      if (candidates.length === 0)
        break;
    }
    out.push(...candidates);
  }
  return out;
}
function opened(cmd, parsed, env) {
  const { args, name } = parsed;
  const plain = READS_NOTHING.has(name);
  const places = plain ? [] : [env.cwd];
  const open = (w, argument) => {
    for (const read of w.reads ?? [])
      if (!read.unknown && !marked(read.value))
        places.push(pathOf(read, env));
    if (unreadValue(w) || plain && argument && !PATH_LIKE.test(w.value))
      return;
    places.push(pathOf(w, env));
    if (w.glob)
      places.push(...globbed(w.value, env.cwd));
  };
  for (const a of args)
    open(a, true);
  for (const r of cmd.redirects)
    if (namesFile(r))
      open(r.target, false);
  return places;
}
var DB_CLIENTS = new Set([
  "mongo",
  "mongosh",
  "mycli",
  "mysql",
  "mysqldump",
  "pgbench",
  "pgcli",
  "psql",
  "redis-cli"
]);
var dbClient = (name) => DB_CLIENTS.has(name) || /^pg_\w+$/.test(name);
var RUNNER_CALL = new RegExp(`\\b(?:${["bash", "bun", "bunx", "cd", "deno", "node", "npm", "npx", "pnpm", "pushd", "sh", "tsx", "yarn", "zsh", ...DB_CLIENTS, "pg_\\w+"].join("|")})\\b|/`, "i");
var pgClient = (name) => name === "pgbench" || name === "pgcli" || name === "psql" || name.startsWith("pg_");
var mysqlClient = (name) => name === "mycli" || name === "mysql" || name === "mysqldump";
var mongoClient = (name) => name === "mongo" || name === "mongosh";
var MONGO_FLAGS = new Set([
  "--json",
  "--nodb",
  "--norc",
  "--quiet",
  "--retryWrites",
  "--shell",
  "--ssl",
  "--tls",
  "--verbose"
]);
var CONTAINER_RUNNERS = new Set(["docker", "nerdctl", "podman"]);
var DB_URL = /\b(?:mariadb|mongodb(?:\+srv)?|mysql|postgres(?:ql)?|rediss?):\/\/(?:[^@\s/?#]*@)?([^/?#\s]*)[^?#\s]*(?:\?([^#\s]*))?/gi;
var CONNINFO = /(?:^|\s)(host|hostaddr|service)=('[^']*'|"[^"]*"|\S+)/g;
var hostOf2 = (raw) => {
  let host = raw.replace(/^['"]|['"]$/g, "");
  try {
    host = decodeURIComponent(host);
  } catch {}
  const bracket = /^\[([^\]]*)\](?::\d*)?$/.exec(host);
  if (bracket)
    return bracket[1];
  const parts = host.split(":");
  return parts.length === 2 ? parts[0] : host;
};
var onThisMachine = (host) => host === "" || host.startsWith("/") || /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i.test(host);
var DB_FIX = "Name a database on this machine literally (127.0.0.1, or the worktree's own container), in a call of its own, or report to your lead.";
function containedClient(parsed) {
  const { args, local } = parsed;
  const words = args.map((a) => unreadValue(a) ? "" : a.value);
  const start = words[0] === "compose" ? 2 : 1;
  if (words[start - 1] !== "exec" && words[start - 1] !== "run")
    return;
  const at = words.findIndex((w, i) => i >= start && dbClient(w));
  if (at < 0)
    return;
  const given = new Map(local);
  for (let i = start;i < at; i++) {
    const w = words[i];
    const pair = w === "-e" || w === "--env" ? args[++i] : w.startsWith("--env=") ? { ...args[i], value: args[i].value.slice(6) } : /^-e./.test(w) ? { ...args[i], value: args[i].value.slice(2) } : undefined;
    const eq = pair?.value.indexOf("=") ?? -1;
    if (pair && eq > 0)
      given.set(pair.value.slice(0, eq), { ...pair, value: pair.value.slice(eq + 1) });
  }
  return { ...parsed, args: args.slice(at + 1), local: given, name: words[at] };
}
function dbCall(parsed, env) {
  const inner = CONTAINER_RUNNERS.has(parsed.name) ? containedClient(parsed) : undefined;
  if (inner)
    return dbCall(inner, env);
  const { args, local, name } = parsed;
  const client = dbClient(name);
  const hosts = [];
  const named = (value, service = false) => {
    if (service)
      hosts.push(undefined);
    else
      for (const host of value.split(","))
        hosts.push(hostOf2(host));
  };
  const queried = (query) => {
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (key === "host" || key === "hostaddr")
        named(pair.slice(eq + 1));
      else if (key === "service")
        named("", true);
    }
  };
  for (let i = 0;i < args.length; i++) {
    const a = args[i];
    if (unreadValue(a)) {
      if (client)
        hosts.push(undefined);
      continue;
    }
    const v = a.value;
    for (const m of v.matchAll(DB_URL)) {
      named(m[1]);
      if (m[2])
        queried(m[2]);
    }
    if (!client)
      continue;
    for (const m of v.matchAll(CONNINFO))
      named(m[2], m[1] === "service");
    const mongo = mongoClient(name);
    if (v === "--host" || v === "-h" && !mongo) {
      const next = args[++i];
      if (next && !unreadValue(next))
        named(next.value);
      else
        hosts.push(undefined);
    } else if (v.startsWith("--host="))
      named(v.slice(7));
    else if (/^-h[^-]/.test(v) && !mongo)
      named(v.slice(2));
    else if (mongo && !v.startsWith("-") && !v.includes("://") && !/\.[cm]?[jt]s$/.test(v) && /^[A-Za-z0-9][A-Za-z0-9.-]*[:/]/.test(v) && (i === 0 || !args[i - 1].value.startsWith("-") || MONGO_FLAGS.has(args[i - 1].value)))
      named(v.split(/[:/]/)[0]);
  }
  const keys = pgClient(name) ? ["PGHOST", "PGHOSTADDR", "PGSERVICE"] : mysqlClient(name) ? ["MYSQL_HOST"] : [];
  for (const key of keys) {
    const set = local.get(key) ?? env.vars.get(key) ?? (env.process[key] ? { value: env.process[key] } : undefined);
    if (!set)
      continue;
    if (unreadValue(set) || key === "PGSERVICE")
      hosts.push(undefined);
    else
      named(set.value);
  }
  const at = hosts.findIndex((h) => h === undefined || !onThisMachine(h));
  if (at < 0)
    return;
  const host = hosts[at];
  return host === undefined ? orgRefusal(`this ${name} call`, "the hook cannot tell which database it reaches, since a value it cannot read names it", DB_FIX) : orgRefusal(`this ${name} call`, `it reaches ${host}, a database off this machine, which may be an org's`);
}
function orgCall(parsed, env, dir, sub, orgs) {
  const { args, name } = parsed;
  const runs = args.findIndex((a) => CLAUDE_PACKAGE.test(a.value.replace(/^--package=/, "")));
  if (name === "claude" && headless(parsed) || runs >= 0 && headless({ ...parsed, args: args.slice(runs + 1) }))
    return orgRefusal("this headless Claude run", "a GLM session starts no Claude run of its own, which would reach what it may not");
  if (FETCHERS.has(name))
    for (const a of args)
      for (const [host, kind] of ORG_HOSTS) {
        const m = host.exec(a.value);
        if (m)
          return orgRefusal(`this ${name} call`, `it reaches ${m[1]}, an org's ${kind}`);
      }
  if (FETCHERS.has(name) && args.some((a) => (name === "wget" ? WGET_URL_FILE : URL_FILE).test(a.value)))
    return orgRefusal(`this ${name} call`, "it reads its URL from a file the hook cannot read", "Give the URL literally, in a call of its own, or report to your lead.");
  const script = orgScript(parsed, env);
  if (script)
    return orgRefusal(`this ${name} call`, script.why, script.fix);
  if (name !== "gh" && name !== "git" && !FETCHERS.has(name))
    return;
  if (!Array.isArray(orgs))
    return orgRefusal(`this ${name} call`, `the hook cannot read which orgs ext.links guards (${orgs.refusal})`, `Fix the policy, or report to your lead.`);
  if (name === "gh")
    return ghOrg(parsed, env, orgs);
  if (name === "git")
    return gitOrg(parsed, env, dir, sub, orgs);
  for (const a of args) {
    const hit = urlOrg(orgs, a.value);
    if (hit)
      return orgRefusal(`this ${name} call`, `it reaches ${hit}, a guarded org's repository`);
  }
}
var visitor = (load5, limit, orgs, roots) => {
  const busy = load5 > limit;
  let earlier = "none";
  const forced = [];
  let branchReads = [];
  const visit = async (cmd, parsed, env) => {
    const slot = slotWords(parsed);
    if (slot)
      return slot.length === 0 ? undefined : examine({ ...cmd, words: slot }, env, visit, false);
    const { args, name } = parsed;
    if (Array.isArray(orgs) && orgs.length > 0)
      for (const place of opened(cmd, parsed, env)) {
        const repo = checkoutOf(place, orgs, roots);
        if (repo)
          return checkoutRefusal(`this ${name} call`, repo);
      }
    const reads = branchReads;
    branchReads = [];
    const busyRun = busy ? installOrClone(name, args) : undefined;
    if (busyRun)
      return loaded(busyRun, load5, limit);
    if (PURE.has(name) && !writes2(cmd))
      return;
    const before = earlier;
    const isGit = name === "git";
    let dir = env.cwd;
    let k = 0;
    for (;isGit && k < args.length; k++) {
      const v = args[k].value;
      if (v === "-C") {
        const next = args[++k];
        dir = next ? pathOf(next, { ...env, cwd: dir }) : undefined;
      } else if (GIT_TAKES.has(v))
        k++;
      else if (!v.startsWith("-"))
        break;
    }
    const sub = isGit ? args[k]?.value : undefined;
    const org = orgCall(parsed, env, dir, sub, orgs) ?? dbCall(parsed, env);
    if (org)
      return org;
    if (isGit && !writes2(cmd) && BRANCH_READS.has(args.slice(k).map((a) => a.value).join(" "))) {
      branchReads = [...reads, dir];
      return;
    }
    if (earlier !== "other")
      earlier = sub && STAGING.has(sub) ? "staging" : "other";
    if (sub === "add")
      forced.push(...forcedPaths(args.slice(k + 1), dir));
    if (sub !== "commit" && sub !== "push")
      return;
    if (sub === "push" && before !== "none")
      return chainRefusal("git push", "a commit it pushes");
    if (before === "other")
      return chainRefusal("git commit", "a file it commits");
    if (!dir)
      return unread2(`git ${sub}`, "which checkout it runs in");
    const reason = sub === "commit" ? await commit(args.slice(k + 1), dir, before === "staging", forced) : push2(args.slice(k + 1), dir, reads);
    return reason ?? (busy ? loaded(`git ${sub}`, load5, limit) : undefined);
  };
  return visit;
};
async function inspect5(raw, environment, load5, limit) {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool
  } = JSON.parse(raw);
  if (typeof tool === "string" && (tool.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(tool)))
    return orgRefusal(`this ${tool} call`, "an MCP tool reaches an org's or an outside service's data");
  const directory = typeof cwd === "string" ? cwd : undefined;
  if (typeof tool === "string" && tool in READ_TOOLS) {
    const orgs = await guardedOf(environment);
    if (!Array.isArray(orgs))
      return;
    const given = toolInput?.[READ_TOOLS[tool]];
    const path = typeof given !== "string" || given === "" ? directory : given.startsWith("~/") && environment.HOME ? join13(environment.HOME, given.slice(2)) : isAbsolute5(given) ? given : directory && resolve7(directory, given);
    const repo = orgs.length > 0 ? checkoutOf(path, orgs, new Map) : undefined;
    return repo ? checkoutRefusal(`this ${tool} call`, repo) : undefined;
  }
  if (tool !== "Bash" || typeof toolInput?.command !== "string")
    return;
  const command = toolInput.command;
  const orgs = await guardedOf(environment);
  const roots = new Map;
  const guarding = Array.isArray(orgs) && orgs.length > 0;
  const text = command.replace(/["'\\]/g, "");
  if (!guarding && !mayRefuse(text, load5, limit) && !RUNNER_CALL.test(text))
    return;
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    old: { dir: directory },
    process: environment,
    vars: new Map
  };
  const home = guarding ? checkoutOf(directory, orgs, roots) : undefined;
  try {
    return await run(lex(command, env.known), env, visitor(load5, limit, orgs, roots));
  } catch (error) {
    if (home)
      return checkoutRefusal("this call, which the hook could not read,", home);
    throw error;
  }
}
var mayRefuse = (text, load5, limit) => GIT_CALL.test(text) || ORG_CALL.test(text) || load5 > limit && BUSY_RUN.test(text);
async function check8(raw, environment = process.env, load5 = currentLoad5()) {
  const limit = await loadLimit(environment);
  try {
    return await inspect5(raw, environment, load5, limit);
  } catch (error) {
    if (!mayRefuse(raw, load5, limit))
      return;
    return `no-glm-heavy-path hook could not read this call (${error}), which reads as a git commit or push, an org tool, or an install or clone on a busy machine, from a GLM session, so it refuses it, as the glm rule (playground rules glm) asks of an org tool it cannot read. Run it as one plain command, or report to your lead.`;
  }
}
async function refusal(raw, environment = process.env, load5 = currentLoad5()) {
  return await onGlm(raw, environment) ? check8(raw, environment, load5) : undefined;
}
if (false) {}

// scripts/hooks/no-kill-by-name.ts
var BY_NAME = new Set(["killall", "pkill"]);
var SEARCHES = new Set(["fuser", "lsof", "pgrep", "pidof", "ps"]);
var READS_ONLY2 = new Set(["--help", "--version", "-V", "-h"]);
var WAY_OUT = "Stop a background task with TaskStop, a dev stack with bun run dev:stop in its worktree, and a process you spawned with kill <pid> on the pid you hold ($! or its pid file).";
var refuse6 = (what, beside = "") => `no-kill-by-name hook refuses ${what}: a name, pattern or port matches the live dashboard and every worker's stack, not only your own process. ${WAY_OUT}${beside}`;
var readsOnly = (cmd, first, args) => {
  const before = cmd.words.slice(0, first ? cmd.words.indexOf(first) : 0);
  return before.some((w, i) => program(w.value) === "command" && /^-[vV]$/.test(before[i + 1]?.value ?? "")) || args.length > 0 && args.every((a) => READS_ONLY2.has(a.value));
};
var isSearch = (name, args) => SEARCHES.has(name) && !(name === "ps" && args.some((a) => /^-[A-Za-z]*[pq]$|^-[pq]\d|^--(?:quick-)?pid\b/.test(a.value)));
async function inspect6(raw) {
  const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
  if (tool !== "Bash" || typeof toolInput?.command !== "string")
    return;
  if (!/\b(?:fuser|kill|killall|pkill)\b/.test(toolInput.command.replace(/["'\\]/g, "")))
    return;
  const lexed = lex(toolInput.command);
  const fresh = () => ({ files: new Map, known: {}, process: {}, vars: new Map });
  let search;
  await run(lexed, fresh(), async (_cmd, { args, name }) => {
    if (isSearch(name, args))
      search ??= name;
    return;
  });
  const handed = lexed.commands.flatMap((c) => parse(c).xargs?.replace || []);
  const visit = async (cmd, { args, first, name, xargs }) => {
    if (BY_NAME.has(name) && !readsOnly(cmd, first, args))
      return refuse6(name);
    if (name === "fuser" && args.some((a) => /^-\w*k|^--kill\b/.test(a.value)))
      return refuse6("fuser -k");
    if (name !== "kill" || !search)
      return;
    const fed = xargs || args.some((a) => a.value.includes(UNKNOWN) || handed.some((h) => a.value.includes(h)));
    if (fed)
      return refuse6(`a kill in a call that searches with ${search}`, ` Run a kill of a pid you hold in a Bash call of its own, apart from the search.`);
  };
  return run(lexed, fresh(), visit);
}
async function check9(raw) {
  try {
    return await inspect6(raw);
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-linear-ticket.ts
import { realpath } from "fs/promises";
import { basename as basename6, dirname as dirname7, isAbsolute as isAbsolute6, join as join14, resolve as resolve8, sep as sep3 } from "path";
var CREATE = /\bissue(?:batch)?create\b/i;
var LINEAR = /linear\.app/i;
var GITHUB = /^https?:\/\/(?:[\w-]+\.)*github\.com(?:[/:?#]|$)/i;
var URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
var MCP_TOOL2 = /^mcp__(.+?)__(.+)$/;
var CREATE_TOOL = /^(?:\w+_)?create_?issues?$|^issues?_?create$/i;
var FILE_TOOLS2 = new Map([
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
  ["Write", "file_path"]
]);
var CODE_FLAGS = new Map([
  ["bun", new Set(["-e", "--eval", "-p", "--print"])],
  ["deno", new Set],
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["perl", new Set(["-E", "-e"])],
  ["python", new Set(["-c"])],
  ["ruby", new Set(["-e"])]
]);
var MAYBE2 = /issue(?:batch)?create|linear|ticket-approvals|curl|\bgh\b|bun|deno|node|perl|python|ruby/i;
var MAX_APPROVAL_BYTES = 65536;
var interpreter = (name) => /^python[\d.]*$/.test(name) ? "python" : name;
var isDispatcher = (environment) => environment.PLAYGROUND_ROLE === "dispatcher";
var approvalsDir = (environment) => join14(dataDirOf(environment), "ticket-approvals");
var slug = (team) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
var day = (now) => now.toISOString().slice(0, 10);
var RULE = "A new Linear ticket needs the owner's yes first, and the factory's own work never goes in Linear.";
var ASK_UP = "Ask up the chain with the team and the exact title; once the owner says yes, the dispatcher records it, and the same save_issue call then runs.";
function refuse7(what, detail, next) {
  return `no-linear-ticket hook refused ${what}: ${detail}. ${RULE} ${next}`;
}
async function real2(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
var within = (path, dir) => path === dir || path.startsWith(`${dir}${sep3}`);
async function inApprovals(path, environment) {
  const dir = approvalsDir(environment);
  const dirs = [dir, await real2(dir)];
  const target = resolve8(path);
  const targets = [target, join14(await real2(dirname7(target)), basename6(target))];
  return targets.some((t) => dirs.some((d) => within(t, d)));
}
function refuseApprovals(what, environment) {
  return `no-linear-ticket hook refused ${what}: it reaches into ${approvalsDir(environment)}, which the dispatcher alone writes, to record the owner's yes to a new Linear ticket. ${ASK_UP}`;
}
async function touchesApprovals(cmd, parsed, env) {
  const dirs = [approvalsDir(env.process), await real2(approvalsDir(env.process))];
  const texts = [
    ...parsed.first ? [parsed.first] : [],
    ...parsed.args,
    ...parsed.local.values(),
    ...cmd.redirects.flatMap((r) => r.target ? [r.target] : [])
  ];
  for (const text of texts) {
    if (dirs.some((d) => visible(text.value).includes(d)))
      return true;
    const path = pathOf(text, env);
    if (path && await inApprovals(path, env.process))
      return true;
  }
  return false;
}
var ticket = async (cmd, parsed, env) => {
  if (!isDispatcher(env.process) && await touchesApprovals(cmd, parsed, env)) {
    return refuseApprovals(parsed.name || "this command", env.process);
  }
  return sender(cmd, parsed, env, false);
};
async function sender(cmd, parsed, env, nested) {
  const { args, first, name, xargs } = parsed;
  if (name === "curl" || first?.unknown)
    return curl2(args, cmd, env, xargs);
  if (name === "gh")
    return gh2(args, cmd, env, xargs);
  const language = interpreter(name);
  if (CODE_FLAGS.has(language))
    return script2(language, args, cmd, env, !nested);
  if (PRINTERS.has(name))
    return;
  const at = args.findIndex((a) => {
    const inner = program(a.value);
    return inner === "curl" || inner === "gh" || CODE_FLAGS.has(interpreter(inner));
  });
  if (at === -1)
    return;
  const inner = {
    ...parsed,
    args: args.slice(at + 1),
    first: args[at],
    name: program(args[at].value)
  };
  return sender(cmd, inner, env, true);
}
async function curl2(args, cmd, env, xargs) {
  const { flags, positionals } = parseFlags(args, CURL_TAKES);
  const urls = curlUrls(flags, positionals);
  const sent = await curlData(flags, cmd, env);
  if (xargs && !xargs.replace)
    sent.push(unknown("the arguments xargs appends"));
  if (args.some((a) => flagFromXargs(a, xargs))) {
    sent.push(unknown(`what xargs puts in place of ${xargs?.replace}`));
  }
  const texts = await Promise.all([...urls, ...sent].map((t) => resolveText(viaXargs(t, xargs), env)));
  return judge4("curl", texts, urls.some((u) => LINEAR.test(visible(u.value))), env.process, urls.length);
}
async function gh2(args, cmd, env, xargs) {
  const { head, rest } = ghCommand(args);
  if (head[0] !== "api")
    return;
  const request = await ghApi(rest, cmd, env, xargs);
  if (!request)
    return;
  const where = await resolveText(request.endpoint, env);
  const open = where.value.startsWith(UNKNOWN);
  if (!open && !(URL_SCHEME.test(where.value) && !GITHUB.test(where.value)))
    return;
  const texts = await Promise.all([where, ...request.fields.map((f) => f.text), ...request.inputs].map((t) => resolveText(t, env)));
  return judge4("gh api", texts, open || LINEAR.test(visible(where.value)), env.process, 1);
}
async function script2(language, args, cmd, env, stdin) {
  const takes = CODE_FLAGS.get(language) ?? new Set;
  const code = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--")
      break;
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      if (!takes.has(eq === -1 ? v : v.slice(0, eq)))
        continue;
      if (eq !== -1)
        code.push(slice(args[k], eq + 1));
      else if (args[k + 1])
        code.push(args[k + 1]);
    } else if (/^-[A-Za-z]/.test(v)) {
      const at = v.slice(1).split("").findIndex((c) => takes.has(`-${c}`));
      if (at === -1)
        continue;
      if (at + 2 < v.length)
        code.push(slice(args[k], at + 2));
      if (args[k + 1])
        code.push(args[k + 1]);
    }
  }
  if (language === "deno" && args[0]?.value === "eval")
    code.push(...args.slice(1));
  if (stdin && code.length === 0 && args.every((a) => a.value.startsWith("-"))) {
    code.push(await stdinOf(cmd, env));
  }
  const texts = await Promise.all(code.map((c) => resolveText(c, env)));
  return judge4(language, texts, false, env.process);
}
function judge4(what, texts, toLinear, environment, targets = 0) {
  if (texts.some((t) => CREATE.test(visible(t.value)))) {
    return refuse7(what, "it sends Linear's issueCreate, which files a new ticket", isDispatcher(environment) ? "Once he says yes, record it and file the ticket with the Linear MCP's save_issue, which the hook matches to the approval; a GraphQL create matches none." : ASK_UP);
  }
  if (!toLinear)
    return;
  const at = texts.findIndex((t) => t.unknown);
  if (at === -1)
    return;
  const hidden = texts[at];
  if (at < targets) {
    return refuse7(what, `the hook cannot read where it goes (it comes from ${hidden.unknown}), so it may be Linear's API and file a ticket`, `Name the endpoint or URL by its literal value in the command itself (gh api https://api.linear.app/graphql, or curl https://api.linear.app/graphql). ${NOT_RUN}`);
  }
  return refuse7(what, `it goes to Linear's API, and the hook cannot read what it sends before it runs (it comes from ${hidden.unknown}), so it may file a ticket`, `To read Linear, put the query in the command itself, or write the query to a file with the Write tool first, then run the command again in a call of its own that names that file by its literal absolute path (curl -d @/abs/query.json, or gh api --input /abs/query.json). ${NOT_RUN}`);
}
var hasId = (input) => typeof input.id === "string" && input.id.trim() !== "";
var textOf = (value) => typeof value === "string" ? value.trim() : "";
function creates(tool, input) {
  const [, server = "", name = ""] = MCP_TOOL2.exec(tool) ?? [];
  if (name === "save_issue")
    return !input || !hasId(input);
  return CREATE_TOOL.test(name) && /linear/i.test(server);
}
async function mcp2(tool, input, environment, now) {
  if (!creates(tool, input))
    return;
  const what = tool.replace(/^mcp__/, "");
  const team = textOf(input?.team ?? input?.teamId ?? input?.teamKey);
  const title = textOf(input?.title);
  if (slug(team) === "" || title === "") {
    return refuse7(what, "it files a new Linear ticket, and the hook cannot read its team and title to match an approval", "Name the team and the title as the owner approved them.");
  }
  const path = join14(approvalsDir(environment), `${slug(team)}-${day(now)}.json`);
  const approval = await readApproval(path);
  if (approval.titles?.includes(title))
    return;
  const problem = approval.problem ?? `today's approval does not name ${JSON.stringify(title)}`;
  const shape = `{"ask": "<the Inbox decision he approved>", "titles": [${JSON.stringify(title)}]}`;
  return refuse7(what, `it files a new Linear ticket in ${JSON.stringify(team)}, and ${problem}`, isDispatcher(environment) ? `Once he says yes, write ${path} as ${shape}, and the same call then runs. An approval holds for the UTC day in its name.` : ASK_UP);
}
async function readApproval(path) {
  const file = Bun.file(path);
  let stats;
  try {
    stats = await file.stat();
  } catch (error) {
    if (error.code === "ENOENT") {
      return { problem: "the owner has not approved a ticket in this team today" };
    }
    return { problem: "today's approval for this team cannot be read" };
  }
  if (!stats.isFile() || stats.size > MAX_APPROVAL_BYTES) {
    return { problem: "today's approval for this team is not a small regular file" };
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { problem: "today's approval for this team is not JSON" };
  }
  const titles = parsed?.titles;
  if (!Array.isArray(titles) || !titles.every((t) => typeof t === "string")) {
    return { problem: `today's approval for this team holds no "titles" list of strings` };
  }
  return { titles: titles.map((t) => t.trim()) };
}
async function fileTool(tool, path, cwd, environment) {
  if (isDispatcher(environment) || typeof path !== "string" || path === "")
    return;
  const absolute = isAbsolute6(path) ? path : resolve8(typeof cwd === "string" ? cwd : "/", path);
  if (await inApprovals(absolute, environment))
    return refuseApprovals(tool, environment);
}
function candidate2(command) {
  return command.includes("$'") || MAYBE2.test(command.replace(/[\\'"]/g, ""));
}
function createCall(subject) {
  return CREATE.test(subject) || /save_issue|create_?issue|issues?_?create/i.test(subject);
}
async function check10(raw, environment = process.env, now = new Date) {
  const role = await sessionRole(environment, sessionOf(raw));
  if (!role)
    return;
  try {
    return await eachInput(raw, "no-linear-ticket", (one) => inspect7(one, { ...environment, PLAYGROUND_ROLE: role }, now));
  } catch (error) {
    if (!createCall(subjectOf2(raw)))
      return;
    return `no-linear-ticket hook could not read this call (${error}), which reads as filing a Linear ticket, so it refuses it. Split it into plain commands and run them again.`;
  }
}
function subjectOf2(raw) {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
    if (tool === "Bash" && typeof toolInput?.command === "string")
      return toolInput.command;
    return typeof tool === "string" ? tool : raw;
  } catch {
    return raw;
  }
}
async function inspect7(raw, environment, now) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return createCall(raw) ? "no-linear-ticket hook could not parse its input, which reads as filing a Linear ticket, so it refuses the call." : undefined;
  }
  const { cwd, tool_input: toolInput, tool_name: tool } = payload;
  const input = typeof toolInput === "object" && toolInput !== null ? toolInput : undefined;
  if (tool === "Bash") {
    const command = input?.command;
    if (typeof command !== "string" || !candidate2(command))
      return;
    const directory = typeof cwd === "string" ? cwd : undefined;
    const env = {
      cwd: directory,
      files: new Map,
      known: knownVariables(command, environment, directory),
      process: environment,
      vars: new Map
    };
    return run(lex(command, env.known), env, ticket);
  }
  if (typeof tool !== "string")
    return;
  const key = FILE_TOOLS2.get(tool);
  if (key)
    return fileTool(tool, input?.[key], cwd, environment);
  return mcp2(tool, input, environment, now);
}
if (false) {}

// scripts/hooks/no-mac-web-build.ts
import { join as join15 } from "path";

// scripts/hooks/docker-build.ts
var DOCKERS = new Set(["docker", "docker-compose"]);
var DOCKER_TAKES = new Set([
  "--config",
  "--context",
  "--host",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
  "-c",
  "-H",
  "-l"
]);
var COMPOSE_TAKES = new Set([
  "--ansi",
  "--env-file",
  "--file",
  "--parallel",
  "--profile",
  "--progress",
  "--project-directory",
  "--project-name",
  "-f",
  "-p"
]);
var SERVICE_TAKES = new Set([
  "--attach",
  "--build-arg",
  "--builder",
  "--cap-add",
  "--cap-drop",
  "--entrypoint",
  "--env",
  "--env-from-file",
  "--exit-code-from",
  "--label",
  "--memory",
  "--name",
  "--no-attach",
  "--progress",
  "--publish",
  "--pull",
  "--scale",
  "--ssh",
  "--timeout",
  "--user",
  "--volume",
  "--wait-timeout",
  "--workdir",
  "-e",
  "-l",
  "-m",
  "-p",
  "-t",
  "-u",
  "-v",
  "-w"
]);
var BUILD_TAKES = new Set([
  "--build-arg",
  "--builder",
  "--memory",
  "--provenance",
  "--sbom",
  "--ssh",
  "-m"
]);
var union2 = (...sets) => new Set(sets.flatMap((set) => [...set]));
var COMPOSE_SERVICE_TAKES = union2(SERVICE_TAKES, COMPOSE_TAKES);
var COMPOSE_BUILD_TAKES = union2(BUILD_TAKES, COMPOSE_TAKES);
function positionals2(args, takes) {
  const out = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (takes.has(v))
      k++;
    else if (!v.startsWith("-") || v === "-")
      out.push(args[k]);
  }
  return out;
}
function subcommand(args, takes) {
  let k = 0;
  while (k < args.length && args[k].value.startsWith("-"))
    k += takes.has(args[k].value) ? 2 : 1;
  return { rest: args.slice(k + 1), sub: args[k] };
}
var help = (args) => args.some((a) => a.value === "-h" || a.value === "--help");
var COMPOSE_ROOT_TAKES = new Set([...COMPOSE_TAKES, ...DOCKER_TAKES]);
function composeBuild(args) {
  const found = subcommand(args, COMPOSE_ROOT_TAKES);
  const { rest, sub } = found.sub?.value === "alpha" ? subcommand(found.rest, new Set) : found;
  if (!sub)
    return;
  const own = sub.value === "run" ? beforeService(rest) : rest;
  if (help(own))
    return;
  if (sub.value === "watch")
    return { kind: "compose", rest, sub: "watch" };
  if (!["build", "create", "run", "up"].includes(sub.value))
    return;
  if (own.some((a) => a.value === "--no-build"))
    return;
  return { kind: "compose", rest, sub: sub.value };
}
function beforeService(rest) {
  for (let k = 0;k < rest.length; k++) {
    const v = rest[k].value;
    if (COMPOSE_SERVICE_TAKES.has(v))
      k++;
    else if (!v.startsWith("-") || v === "-")
      return rest.slice(0, k);
  }
  return rest;
}
function dockerBuild(args, compose) {
  if (compose)
    return composeBuild(args);
  const { rest, sub } = subcommand(args, DOCKER_TAKES);
  if (!sub)
    return;
  if (sub.value === "compose")
    return composeBuild(rest);
  const image = (words) => help(words) ? undefined : { kind: "image", rest: words, sub: "build" };
  if (sub.value === "build")
    return image(rest);
  if (sub.value === "bake")
    return help(rest) ? undefined : { kind: "bake", rest, sub: "bake" };
  if (["builder", "buildx", "image"].includes(sub.value)) {
    const inner = subcommand(rest, new Set(["--builder"]));
    if (inner.sub?.value === "build" || inner.sub?.value === "b")
      return image(inner.rest);
    if (sub.value !== "image" && ["bake", "f"].includes(inner.sub?.value ?? "") && !help(inner.rest))
      return { kind: "bake", rest: inner.rest, sub: "bake" };
  }
}
var buildName = (build) => build.kind === "image" ? "a docker build" : build.kind === "bake" ? "docker buildx bake" : `docker compose ${build.sub}`;
function atOnce(build) {
  if (build.kind === "bake")
    return "it builds its targets at once in the one Docker VM: build each image with docker build, one run-slot run at a time";
  if (build.kind === "image" || build.sub === "build")
    return;
  const what = build.sub === "watch" ? "it builds and rebuilds its images" : "without --no-build it builds each missing image";
  return `${what} at once in the one Docker VM: build first with run-slot.sh <your name> -- docker compose build, which builds one service at a time, then start it with docker compose up --no-build`;
}
function portlessCompose(name, args) {
  let words = args;
  if (name === "bun") {
    if (args[0]?.value !== "x")
      return;
    words = args.slice(1);
  }
  if (name !== "portless") {
    if (!["bun", "bunx", "npx"].includes(name))
      return;
    let k = 0;
    while (k < words.length && words[k].value.startsWith("-"))
      k += ["--package", "-p"].includes(words[k].value) ? 2 : 1;
    if (program(words[k]?.value ?? "").replace(/@.*$/, "") !== "portless")
      return;
    words = words.slice(k + 1);
  }
  return words[0]?.value === "compose" ? words.slice(1) : undefined;
}

// scripts/hooks/no-mac-web-build.ts
var INSPECT_TIMEOUT_MS = 8000;
var WEB_DOCKERFILE = "web/next/Dockerfile";
var API_HERE = "The api image still builds here (docker compose build api).";
var BOX_ROUTE = `Build the web image on the box instead: commit, then from the checkout run bash ~/.playground/ops/runner-host/ci.sh web HEAD, which builds HEAD's tree there and never on the Mac. ${API_HERE}`;
var NO_HOST_ROUTE = `No runner host is set (RUNNER_HOST, or the data folder's ops/runner-host/ip), so there is no box to build it on, and the live dashboard's Postgres stays up: set one up (scripts/ops/runner-host/host.sh setup <ip>, then write its address to that ip file), or build the web image on a machine with no live dashboard running. ${API_HERE}`;
async function hasRunnerHost(environment) {
  const ip = environment.RUNNER_HOST || (await Bun.file(join15(dataDirOf(environment), "ops", "runner-host", "ip")).text().catch(() => "")).replace(/\n+$/, "");
  return /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip);
}
function composeBuild2({ rest, sub }) {
  const words = positionals2(rest, COMPOSE_SERVICE_TAKES);
  const services = sub === "run" ? words.slice(0, 1) : words;
  if (services.length === 0 || services.some((s) => s.value === "web" || marked(s.value)))
    return `docker compose ${sub} of the web image`;
}
function dockerfile(args) {
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "-f" || v === "--file")
      return args[k + 1];
    const attached = /^(?:-f|--file=)(.+)$/.exec(v)?.[1];
    if (attached)
      return { ...args[k], value: attached };
  }
}
function imageBuild(args) {
  const file = dockerfile(args);
  if (!file)
    return;
  const path = file.value.replace(/^\.\//, "");
  if (marked(path) || path === WEB_DOCKERFILE || path.endsWith(`/${WEB_DOCKERFILE}`))
    return `docker build -f ${WEB_DOCKERFILE}`;
}
function webBuild(args, compose) {
  const build = dockerBuild(args, compose);
  if (build?.kind === "compose")
    return composeBuild2(build);
  if (build?.kind === "image")
    return imageBuild(build.rest);
}
async function dashboardRuns(what, environment) {
  const route = async () => await hasRunnerHost(environment) ? BOX_ROUTE : NO_HOST_ROUTE;
  const cannot = async (why) => `no-mac-web-build hook refuses ${what}: ${why}, so it cannot tell whether the live dashboard's Postgres runs in this Mac's Docker VM, where a web image build's memory takes the VM's out-of-memory killer to the dashboard's database. ${await route()}`;
  let name;
  try {
    name = (await Bun.file(join15(dataDirOf(environment), "ops", "dashboard", "dashboard-db")).text()).trim();
  } catch (error) {
    if (error.code === "ENOENT")
      return cannot("there is no dashboard-db in the dashboard supervisor's state folder");
    return cannot(`dashboard-db could not be read (${error})`);
  }
  if (!name)
    return cannot("dashboard-db names no container, which the supervisor writes both when the dashboard has none and when its lookup failed");
  const docker = Bun.which("docker", { PATH: environment.PATH ?? "" });
  if (!docker)
    return cannot("there is no docker on PATH to ask");
  const p = Bun.spawn([docker, "inspect", "-f", "{{.State.Running}}", name], {
    env: { HOME: environment.HOME, PATH: environment.PATH },
    stderr: "pipe",
    stdout: "pipe",
    timeout: INSPECT_TIMEOUT_MS
  });
  const answer = await Promise.race([
    Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]),
    new Promise((done) => setTimeout(() => done(undefined), INSPECT_TIMEOUT_MS + 1000).unref())
  ]);
  if (!answer || p.signalCode)
    return cannot(`docker inspect ${name} gave no answer in ${INSPECT_TIMEOUT_MS / 1000}s`);
  const [out, err, code] = answer;
  if (code === 0 && out.trim() === "false")
    return;
  if (code !== 0 && /no such (?:object|container)/i.test(err))
    return;
  if (code === 0 && out.trim() === "true")
    return `no-mac-web-build hook refuses ${what}: the live dashboard's Postgres (${name}) runs in this Mac's Docker VM, and a web image build peaks past the VM's memory, so its out-of-memory killer takes the dashboard's database. ${await route()}`;
  return cannot(`docker inspect ${name} answered ${(err || out).trim().slice(0, 200) || `exit ${code}`}`);
}
var visit2 = async (_cmd, { args, first, name }, env) => {
  const judge = async (words, compose) => {
    const what = webBuild(words, compose);
    return what ? dashboardRuns(what, env.process) : undefined;
  };
  if (DOCKERS.has(name))
    return judge(args, name === "docker-compose");
  const compose = portlessCompose(name, args);
  if (compose)
    return judge(compose, true);
  if (first && (first.unknown || marked(first.value)) && webBuild(args, false))
    return judge(args, false);
  if (PRINTERS.has(name) || name === "ssh")
    return;
  const nested = args.findIndex((a, j) => DOCKERS.has(program(a.value)) && webBuild(args.slice(j + 1), program(a.value) === "docker-compose"));
  if (nested !== -1)
    return judge(args.slice(nested + 1), program(args[nested].value) === "docker-compose");
};
var BARE = (command) => command.replace(/[\\'"]/g, "");
var BUILDS = /build|compose/;
var candidate3 = (command) => command.includes("$'") || BUILDS.test(BARE(command));
var buildCall = (command) => /\bdocker/i.test(BARE(command)) && BUILDS.test(BARE(command));
async function inspect8(raw, environment) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null)
    return buildCall(raw) ? "no-mac-web-build hook could not parse its input, which reads as a docker build, so it refuses the call." : undefined;
  const { cwd, tool_input: toolInput, tool_name: tool } = payload;
  if (tool !== "Bash")
    return;
  const command = toolInput?.command;
  if (typeof command !== "string" || !candidate3(command))
    return;
  const directory = typeof cwd === "string" ? cwd : undefined;
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map
  };
  return run(lex(command, env.known), env, visit2);
}
async function check11(raw, environment = process.env) {
  try {
    return await inspect8(raw, environment);
  } catch (error) {
    let command = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.tool_input?.command === "string")
        command = parsed.tool_input.command;
    } catch {}
    if (!buildCall(command))
      return;
    return `no-mac-web-build hook could not read this call (${error}), which reads as a docker build, so it refuses it. Split it into plain commands and run them again.`;
  }
}
if (false) {}

// scripts/hooks/no-off-palette-label.ts
var TAILWIND_500 = {
  red: "ef4444",
  orange: "f97316",
  amber: "f59e0b",
  yellow: "eab308",
  lime: "84cc16",
  green: "22c55e",
  emerald: "10b981",
  teal: "14b8a6",
  cyan: "06b6d4",
  sky: "0ea5e9",
  blue: "3b82f6",
  indigo: "6366f1",
  violet: "8b5cf6",
  purple: "a855f7",
  fuchsia: "d946ef",
  pink: "ec4899",
  rose: "f43f5e",
  slate: "64748b",
  gray: "6b7280",
  zinc: "71717a",
  neutral: "737373",
  stone: "78716c"
};
var HEXES = new Set(Object.values(TAILWIND_500));
var PALETTE = Object.entries(TAILWIND_500).map(([name, hex]) => `${name} ${hex}`).join(", ");
var SPECS = new Map([
  ["label create", new Set(["-c", "--color", "-d", "--description", "-R", "--repo"])],
  ["label edit", new Set(["-c", "--color", "-d", "--description", "-n", "--name", "-R", "--repo"])]
]);
var LABELS = /^repos\/[^/]+\/[^/]+\/labels(\/[^/]+)?$/;
var MCP_LABEL = /^mcp__.+__label_write$/;
var refuse8 = (what, detail) => `no-off-palette-label hook refused ${what}: ${detail}. Every label is a Tailwind 500: ${PALETTE}. Give one of them as the color, written literally, and leave existing labels as they are.`;
function judge5(what, color, create) {
  if (!color || color.value === "" && !unreadable(color))
    return create ? refuse8(what, "it sets no color, so GitHub picks one") : undefined;
  if (unreadable(color))
    return refuse8(what, `the hook cannot read its color (it comes from ${color.unknown ?? "a variable"})`);
  if (!HEXES.has(color.value.replace(/^#/, "").toLowerCase()))
    return refuse8(what, `its color ${color.value} is not a Tailwind 500`);
}
var visit3 = async (cmd, { args, first, name }, env) => {
  if (name === "gh" || first?.unknown && ["api", "label"].includes(args[0]?.value ?? ""))
    return gh3(args, cmd, env);
  const nested = args.findIndex((a) => program(a.value) === "gh");
  if (nested !== -1 && !PRINTERS.has(name))
    return gh3(args.slice(nested + 1), cmd, env);
};
async function gh3(args, cmd, env) {
  const { head, rest } = ghCommand(args);
  if (head[0] === "api")
    return api3(rest, cmd, env);
  const key = head.join(" ");
  const takes = SPECS.get(key);
  if (!takes)
    return;
  const { flags } = parseFlags(rest, takes);
  const color = flags.findLast((f) => f.name === "-c" || f.name === "--color")?.value;
  return judge5(`gh ${key}`, color && await resolveText(color, env), key === "label create");
}
async function api3(args, cmd, env) {
  const request = await ghApi(args, cmd, env, undefined);
  if (!request || !["PATCH", "POST"].includes(request.method))
    return;
  const path = request.endpoint.value.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "").replace(/^api\/v3\//, "").split("?")[0];
  const match = LABELS.exec(path);
  if (!match)
    return;
  const create = request.method === "POST" && !match[1];
  let color = request.fields.findLast((f) => f.key === "color")?.text;
  for (const input of request.inputs)
    color = colorOf(await resolveText(input, env)) ?? color;
  return judge5(`gh api ${request.method} ${path}`, color && await resolveText(color, env), create);
}
function colorOf(body) {
  if (body.unknown)
    return body;
  try {
    const { color } = JSON.parse(body.value);
    if (color === undefined)
      return;
    return typeof color === "string" ? { value: color } : { unknown: "a color that is not text", value: "" };
  } catch {
    return { unknown: "a body that is not JSON", value: "" };
  }
}
function mcp3(input) {
  const method = String(input.method).toLowerCase();
  if (method !== "create" && method !== "update")
    return;
  const { color } = input;
  const text = color === undefined || color === "" ? undefined : typeof color === "string" ? { value: color } : { unknown: "a color that is not text", value: "" };
  return judge5(`label_write ${method}`, text, method === "create");
}
async function inspect9(raw) {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool
  } = JSON.parse(raw);
  if (typeof tool === "string" && MCP_LABEL.test(tool))
    return mcp3(toolInput ?? {});
  const command = toolInput?.command;
  if (tool !== "Bash" || typeof command !== "string")
    return;
  const bare = command.replace(/["'\\]/g, "");
  if (!/label/i.test(bare))
    return;
  const directory = typeof cwd === "string" ? cwd : undefined;
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, process.env, directory),
    process: process.env,
    vars: new Map
  };
  return run(lex(command, env.known), env, visit3);
}
async function check12(raw) {
  try {
    return await inspect9(raw);
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-stash.ts
var FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var READS = new Set(["list", "show"]);
var WRITES = new Set(["create", "store"]);
var INSTEAD2 = `Every worktree shares one stash list, so a stash taken by position or without a name can be another session's work. Commit a WIP commit on your own branch instead (git commit -m 'chore: wip <what>'), or take before-shots from a separate worktree on origin/canary, made by absolute path under the main checkout so it nests in no other worktree (git worktree add --detach "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" origin/canary). git stash list, git stash show, git stash push -m <message> and git stash apply <full sha> stay allowed.`;
var refuse9 = (what, why) => `no-stash hook refuses ${what}: ${why}. ${INSTEAD2}`;
var BROWSER_CLOSE = new Set(["close", "exit", "quit"]);
var BROWSER_INSTEAD = "Close only the browser you opened; pass --session <name>: agent-browser --session <name> close.";
function judgeBrowser(args, session, named) {
  const batch = args.findIndex((a) => a.value === "batch");
  const words = args.flatMap((a, k) => batch !== -1 && k > batch ? a.value.split(/\s+/) : [a.value]).filter(Boolean);
  if (words.some((w) => w === "-h" || w === "--help"))
    return;
  const closes = words.some((w, k) => BROWSER_CLOSE.has(w) && words[k - 1] !== "tab");
  const all = words.some((w) => w === "--all" || w.startsWith("--all="));
  const hidden = words.find((w) => marked(w));
  if (all && (closes || named && hidden))
    return `no-stash hook refuses agent-browser ${hidden && !closes ? "with an action it cannot read and" : "close"} --all: it closes every session's browser, other sessions' included. ${BROWSER_INSTEAD}`;
  const hasSession = session || words.some((w) => w === "--session" || w.startsWith("--session="));
  if (named && closes && !hasSession)
    return `no-stash hook refuses a bare agent-browser close: with no --session it closes the shared default session, which another session may be using. ${BROWSER_INSTEAD}`;
}
var sessionIn = (local, env) => ["AGENT_BROWSER_SESSION", "AGENT_BROWSER_SESSION_NAME"].some((key) => local.has(key) || env.vars.has(key) || Boolean(env.process[key]));
function message(args) {
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--")
      break;
    if (v === "-m" || v === "--message")
      return args[k + 1]?.value || undefined;
    const attached = /^(?:-m|--message=)(.+)$/.exec(v)?.[1];
    if (attached)
      return attached;
  }
}
function judgeStash(args, xargs) {
  if (xargs)
    return refuse9("git stash under xargs", "the hook cannot read the arguments xargs adds");
  const action = args[0];
  if (!action)
    return refuse9("a bare git stash", "it saves your changes with no name to find them by");
  if (marked(action.value))
    return refuse9("this git stash", `the hook cannot read its action (${visible(action.value)})`);
  const name = action.value;
  if (args.some((a) => a.value === "-h" || a.value === "--help"))
    return;
  if (READS.has(name) || WRITES.has(name))
    return;
  if (name === "push" || name === "save" || name.startsWith("-")) {
    const implied = name.startsWith("-");
    if (message(implied ? args : args.slice(1)))
      return;
    return refuse9(`${implied ? "git stash" : `git stash ${name}`} without -m <message>`, "an unnamed stash is found again only by its position, which another session's stash moves");
  }
  if (name === "apply") {
    const target = args.slice(1).find((a) => !a.value.startsWith("-"));
    if (target && !marked(target.value) && FULL_SHA.test(target.value))
      return;
    return refuse9("git stash apply without a full commit SHA", "stash@{n} and the default name whatever entry is newest, which can be another session's");
  }
  if (name === "pop" || name === "drop" || name === "clear" || name === "branch")
    return refuse9(`git stash ${name}`, "it removes an entry by position from the list every worktree shares");
  return refuse9(`git stash ${name}`, "it is not a stash action the hook knows to be safe");
}
function gitCommand(args) {
  const aliases = [];
  let k = 0;
  while (k < args.length && args[k].value.startsWith("-")) {
    const v = args[k].value;
    if (v === "-c")
      aliases.push(args[k + 1]?.value ?? "");
    else if (v.startsWith("-c"))
      aliases.push(v.slice(2));
    k += GIT_TAKES.has(v) ? 2 : 1;
  }
  return { aliases, rest: args.slice(k + 1), sub: args[k] };
}
var stashes = (args) => gitCommand(args).sub?.value === "stash";
var visit4 = async (_cmd, { args, first, local, name, xargs }, env) => {
  const session = sessionIn(local, env);
  if (name === "agent-browser")
    return judgeBrowser(args, session, true);
  if (name === "git")
    return judgeGit(args, xargs);
  if (first && (first.unknown || marked(first.value))) {
    if (stashes(args))
      return judgeGit(args, xargs);
    const verdict = judgeBrowser(args, session, false);
    if (verdict)
      return verdict;
  }
  if (PRINTERS.has(name))
    return;
  const browser = args.findIndex((a) => program(a.value) === "agent-browser");
  if (browser !== -1) {
    const verdict = judgeBrowser(args.slice(browser + 1), session, true);
    if (verdict)
      return verdict;
  }
  const nested = args.findIndex((a, j) => program(a.value) === "git" && stashes(args.slice(j + 1)));
  if (nested !== -1)
    return judgeGit(args.slice(nested + 1), xargs);
};
function judgeGit(args, xargs) {
  const { aliases, rest, sub } = gitCommand(args);
  if (!sub)
    return;
  if (marked(sub.value))
    return refuse9("this git call", `the hook cannot read which git command it runs (${visible(sub.value)})`);
  if (sub.value === "stash")
    return judgeStash(rest, xargs !== undefined);
  const alias = aliases.find((a) => a.startsWith(`alias.${sub.value}=`));
  if (alias && /\bstash\b/.test(alias))
    return refuse9(`git ${sub.value}`, "it is an alias for git stash");
}
var BARE2 = (command) => command.replace(/[\\'"]/g, "");
var teardown = (command) => /agent-browser/i.test(BARE2(command)) && /\b(?:close|exit|quit)\b/.test(BARE2(command));
var candidate4 = (command) => command.includes("$'") || /stash|--all\b/.test(BARE2(command)) || teardown(command);
var stashCall = (command) => /\bgit\b/i.test(BARE2(command)) && /\bstash\b/.test(BARE2(command)) || teardown(command);
function commandOf(raw) {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
    return tool === "Bash" && typeof toolInput?.command === "string" ? toolInput.command : undefined;
  } catch {
    return;
  }
}
async function inspect10(raw, environment) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null)
    return stashCall(raw) ? "no-stash hook could not parse its input, which reads as a git stash, so it refuses the call." : undefined;
  const { cwd, tool_input: toolInput, tool_name: tool } = payload;
  if (tool !== "Bash")
    return;
  const command = toolInput?.command;
  if (typeof command !== "string" || !candidate4(command))
    return;
  const directory = typeof cwd === "string" ? cwd : undefined;
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map
  };
  return run(lex(command, env.known), env, visit4);
}
async function check13(raw, environment = process.env) {
  try {
    return await inspect10(raw, environment);
  } catch (error) {
    if (!stashCall(commandOf(raw) ?? raw))
      return;
    return `no-stash hook could not read this call (${error}), which reads as a git stash, so it refuses it. Split it into plain commands and run them again.`;
  }
}
if (false) {}

// scripts/hooks/no-ours-merge.ts
var SUBS = new Set(["merge", "pull"]);
var SHORT_TAKES = new Set(["F", "X", "j", "m", "o", "s"]);
var INSTEAD3 = "Merge canary in plainly instead: git merge origin/canary, and resolve each conflict keeping both sides' meaning. With ours, the PR's squash onto canary deletes whatever canary added that the merge ignored, while every gate still reads green.";
var strategyLong = (name) => name === "strategy" || name.length > "strategy".length && "strategy-option".startsWith(name);
function strategies(args) {
  const found = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--")
      break;
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const name = v.slice(2, eq === -1 ? undefined : eq);
      if (!strategyLong(name))
        continue;
      if (eq !== -1)
        found.push({ flag: `--${name}`, value: { ...args[k], value: v.slice(eq + 1) } });
      else
        found.push({ flag: v, value: args[++k] });
      continue;
    }
    if (!v.startsWith("-") || v === "-")
      continue;
    for (let c = 1;c < v.length; c++) {
      const letter = v[c];
      if (letter === "S")
        break;
      if (!SHORT_TAKES.has(letter))
        continue;
      const attached = v.slice(c + 1);
      const value = attached ? { ...args[k], value: attached } : args[++k];
      if (letter === "s" || letter === "X")
        found.push({ flag: `-${letter}`, value });
      break;
    }
  }
  return found;
}
function judgeGit2(args) {
  const { aliases, rest, sub } = gitCommand(args);
  if (!sub)
    return;
  if (marked(sub.value)) {
    return rest.some((a) => a.value === "ours") ? `no-ours-merge hook refuses this git call: it cannot read which git command runs (${visible(sub.value)}) beside ours. ${INSTEAD3}` : undefined;
  }
  const alias = aliases.find((a) => a.startsWith(`alias.${sub.value}=`));
  if (alias && /\b(?:merge|pull)\b/.test(alias) && /\bours\b/.test(alias))
    return `no-ours-merge hook refuses git ${sub.value}: it is an alias for a merge with ours. ${INSTEAD3}`;
  if (!SUBS.has(sub.value))
    return;
  if (rest.some((a) => a.value === "-h" || a.value === "--help"))
    return;
  for (const { flag, value } of strategies(rest)) {
    if (value && marked(value.value))
      return `no-ours-merge hook refuses git ${sub.value} ${flag} with a value it cannot read (${visible(value.value)}). ${INSTEAD3}`;
    if (value?.value === "ours")
      return `no-ours-merge hook refuses git ${sub.value} ${flag} ours. ${INSTEAD3}`;
  }
}
var merges = (args) => SUBS.has(gitCommand(args).sub?.value ?? "");
var visit5 = async (_cmd, { args, first, name }) => {
  if (name === "git")
    return judgeGit2(args);
  if (first && (first.unknown || marked(first.value)) && merges(args))
    return judgeGit2(args);
  if (PRINTERS.has(name))
    return;
  const nested = args.findIndex((a, j) => program(a.value) === "git" && merges(args.slice(j + 1)));
  if (nested !== -1)
    return judgeGit2(args.slice(nested + 1));
};
var BARE3 = (command) => command.replace(/[\\'"]/g, "");
var candidate5 = (command) => command.includes("$'") || /ours/.test(BARE3(command));
var mergeCall = (command) => /\bgit\b/i.test(BARE3(command)) && /\b(?:merge|pull)\b/.test(BARE3(command)) && /ours/.test(BARE3(command));
async function inspect11(raw, environment) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null)
    return mergeCall(raw) ? "no-ours-merge hook could not parse its input, which reads as a merge with ours, so it refuses the call." : undefined;
  const { cwd, tool_input: toolInput, tool_name: tool } = payload;
  if (tool !== "Bash")
    return;
  const command = toolInput?.command;
  if (typeof command !== "string" || !candidate5(command))
    return;
  const directory = typeof cwd === "string" ? cwd : undefined;
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map
  };
  return run(lex(command, env.known), env, visit5);
}
async function check14(raw, environment = process.env) {
  try {
    return await inspect11(raw, environment);
  } catch (error) {
    let command = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.tool_input?.command === "string")
        command = parsed.tool_input.command;
    } catch {}
    if (!mergeCall(command))
      return;
    return `no-ours-merge hook could not read this call (${error}), which reads as a merge with ours, so it refuses it. Split it into plain commands and run them again.`;
  }
}
if (false) {}

// scripts/hooks/no-prompt-stop.ts
var GUARDED = /\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}/g;
var GUARD3 = "__guarded__";
var VARIABLES_TO_STOP = 2;
var variables = (path) => path.split("/").filter((part) => part.startsWith(UNKNOWN)).length;
var shown = (path) => path.replaceAll(UNKNOWN, "$\u2026").replaceAll(GUARD3, "${\u2026:?}");
var FIX = {
  rm: "Name each path literally: a file in your worktree or scratchpad with rm, anything else with playground rm <literal path> (in a script, removeScratch for a folder makeScratch made), and run it again.",
  rmdir: 'Guard each one as ${VAR:?} ("${S:?}/${m:?}"), or name a literal path, and run it again.'
};
var refuse10 = (name, path) => `no-prompt-stop hook refuses ${name} ${shown(path)}: Claude Code stops on a removal whose target has two or more parts that start with a variable and waits for a person, who is not there. ${FIX[name]}`;
var AT_ROOT = /^\/[^/\u0000]+\/?$/;
var AT_ROOT_FIX = {
  rm: "Write and remove in the session's scratchpad, a folder there with playground rm <literal path>, and run it again.",
  rmdir: "Write and remove in $TMPDIR or the session's scratchpad, and run it again."
};
var refuseAtRoot = (name, path) => `no-prompt-stop hook refuses ${name} ${path}: Claude Code stops on a removal of a name directly in / and waits for a person, who is not there. ${AT_ROOT_FIX[name]}`;
var visit6 = async (_cmd, { args, name }) => {
  if (name !== "rm" && name !== "rmdir")
    return;
  const operands = args.filter((a) => !a.value.startsWith("-"));
  const path = operands.find((a) => variables(a.value) >= VARIABLES_TO_STOP);
  if (path)
    return refuse10(name, path.value);
  const atRoot = operands.find((a) => AT_ROOT.test(a.value));
  if (atRoot)
    return refuseAtRoot(name, atRoot.value);
};
async function inspect12(raw) {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool
  } = JSON.parse(raw);
  if (tool !== "Bash" || typeof toolInput?.command !== "string")
    return;
  if (!/\brm(?:dir)?\b/.test(toolInput.command))
    return;
  const command = toolInput.command.replace(GUARDED, GUARD3);
  const directory = typeof cwd === "string" ? cwd : undefined;
  const env = {
    cwd: directory,
    files: new Map,
    known: {},
    process: {},
    vars: new Map
  };
  return run(lex(command, env.known), env, visit6);
}
async function check15(raw) {
  try {
    return await inspect12(raw);
  } catch {
    return;
  }
}
if (false) {}

// packages/scripts/src/release-notes/notes.ts
var HIDDEN = new Set(["ci"]);
var ARTICLES = new Set(["a", "an", "the"]);
var COMMANDS = new Set(["bun", "bunx", "gh", "git", "npx", "playground"]);
var CONTRIBUTORS_HEADING = "### \u2764\uFE0F Contributors";
function ownerWords(name, login, owner) {
  const own = new Set(owner.map((word) => word.toLowerCase()));
  if (!own.has(login.toLowerCase()))
    return [];
  return name.split(/\s+/).filter((word) => own.has(word.toLowerCase()));
}

// packages/settings/src/accounts.ts
var email2 = string2().email();
var label2 = string2().regex(/^[a-z0-9][a-z0-9._-]*$/, "a label of lowercase letters, digits, dots, dashes and underscores");
var claudeAccount = strictObject({
  email: email2,
  ends: string2().datetime({ offset: true }).nullable().optional(),
  endsFirst: boolean2().optional(),
  label: label2.optional(),
  nearLimit: boolean2().optional(),
  own: boolean2().optional(),
  parkedUntil: string2().datetime({ offset: true }).optional(),
  provider: literal("claude").optional(),
  renews: number2().int().min(1).max(31).nullable().optional(),
  weekReset: strictObject({ hour: number2().min(0).lt(24), weekday: number2().int().min(0).max(6) }).optional()
});
var glmAccount = strictObject({ label: label2, provider: literal("glm") });
var account = union([claudeAccount, glmAccount]);
var providerOf = (row) => row.provider === "glm" ? "glm" : "claude";
var accountKey = (row) => (providerOf(row) === "glm" ? row.label : row.email) ?? "";
var accountsOf = (rows, provider) => rows.filter((row) => providerOf(row) === provider);
var accountSettings = defineSettings({
  "models.probe": {
    default: "claude-haiku-4-5",
    description: "The model the usage scripts send one 1-token call to, as an account's own token, to read its 5-hour and week use from the reply's rate-limit headers.",
    schema: string2().min(1)
  },
  "usage.accounts": {
    default: [],
    description: "The accounts the factory spends, any number of each provider: a Claude row by its email, in the order the login flip reads them, with its plan's end or billing day, whether the near-limit marks count it, whether it is the owner's own (own, spent at a fifth of its share unless it resets within a day), the time until which no new session starts on it (parkedUntil), and its week's reset; a GLM row (provider glm) by its label, the Keychain item its key is kept under.",
    schema: array(account).refine((rows) => new Set(rows.map((row) => `${providerOf(row)}:${accountKey(row)}`)).size === rows.length, "each account is listed once")
  },
  "usage.keychainService": {
    default: "playground-claude-oauth",
    description: "The macOS Keychain service each account's long-lived token is kept under, one item an account by its email: spawn.sh's --account and the usage probes read it.",
    schema: string2().regex(/^[A-Za-z0-9._-]+$/, "a Keychain service name")
  },
  "usage.switchAccount": {
    default: "",
    description: "The account whose full week the ops tick tells the dispatchers and leads about, so the factory moves off it; empty for none.",
    schema: union([email2, literal("")])
  }
});
// packages/settings/src/channel.ts
var channelSettings = defineSettings({
  "channel.skipUser": {
    default: "",
    description: "The Slack member id whose own posts the channel watch skips, the account it posts as; none until set.",
    schema: string2().regex(/^(?:[UW][A-Z0-9]+)?$/, "a Slack member id")
  },
  "channel.slackId": {
    default: "",
    description: "The Slack channel id of the shared channel the channel watch relays to the dispatcher; the watch reads nothing until it is set.",
    schema: string2().regex(/^(?:[CG][A-Z0-9]+)?$/, "a Slack channel id")
  }
});
// packages/settings/src/content.ts
var contentFields = {
  body: string2().nullable(),
  files: record2(string2(), string2()).nullable(),
  meta: record2(string2(), unknown2()).nullable(),
  value: union([array(unknown2()), record2(string2(), unknown2())]).nullable()
};
// packages/settings/src/items.ts
var ATTACHMENT_LIMIT = 50 * 1024 * 1024;
// packages/settings/src/factory.ts
var repo = string2().regex(/^(?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?$/, "a repository as owner/name, or empty for unset");
var factorySettings = defineSettings({
  "factory.archiveRepo": {
    default: "",
    description: "The archive repository: a link to it is private history, so the trace ratchet counts it and no-public-leak refuses it in a public write.",
    schema: repo
  },
  "factory.publicRepo": {
    default: "",
    description: "The public repository, or a list of them, the checkout's origin when unset: no-public-leak refuses a write to one that holds private text, and the trace ratchet reads past each one's own name.",
    schema: union([repo, array(repo)])
  },
  "factory.repo": {
    default: "",
    description: "The repository the factory's pull requests land in, the checkout's origin when unset: pr:merge needs GitGuardian's check there, Checks reads its PRs, and the roster links a bare PR number into it.",
    schema: repo
  }
});
// packages/settings/src/gates.ts
var gateSettings = defineSettings({
  "gates.glmLoad5Max": {
    default: 30,
    description: "The load5 a GLM session starts under.",
    schema: number2().positive()
  },
  "gates.glmSwapinsMax": {
    default: 100,
    description: "The swap-ins a second a GLM session, and a fresh Claude worker, starts under.",
    schema: number2().int().positive()
  },
  "gates.memoryFreeMin": {
    default: 8,
    description: "The free memory share, in percent, a Claude session starts at or over.",
    schema: number2().int().min(0).max(100)
  },
  "gates.reviewReserve": {
    default: 0.125,
    description: "The share of the load gate's line a small worker keeps back for reviewers and testers, so a held review starts first; set it under gates.smallReserve, or a small worker's line falls below a medium one's.",
    schema: number2().min(0).lt(1)
  },
  "gates.smallReserve": {
    default: 0.25,
    description: "The share of the load gate's line kept for small items, so a big plan never blocks a small one.",
    schema: number2().min(0).lt(1)
  },
  "gates.startsWindow": {
    default: 300,
    description: "The seconds a start counts toward the load gate, since the load average lags a session's start.",
    schema: number2().int().positive()
  }
});
// packages/settings/src/harness-alpha.ts
var HARNESS_IDS = HARNESSES.map((harness) => harness.id);
var harnessSettings = defineSettings({
  "harness.alpha": {
    default: "claude-code",
    description: "The harness the first dispatcher starts on: claude-code or codex. First run's pick and Settings' Switch write it, and the Dashboard's Start runs spawn.sh --harness with it.",
    schema: _enum(HARNESS_IDS)
  }
});
// packages/settings/src/models.ts
var id = string2().regex(/^[a-z0-9][a-z0-9.-]*$/, "a model id, such as claude-opus-5-5");
var modelSettings = defineSettings({
  "models.checker": {
    default: "claude-opus-5-5",
    description: "The Claude model a reviewer or a tester runs on, and the one --model it takes, since its verdict gates a merge.",
    schema: id
  },
  "models.claude": {
    default: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"],
    description: "The Claude models spawn.sh and playground add take with --model.",
    schema: array(id).min(1)
  },
  "models.default": {
    default: "claude-opus-5-5",
    description: "The Claude model a session runs on when its start names no --model.",
    schema: id
  },
  "models.glm": {
    default: "glm-5.3-flash",
    description: "The GLM model a --backend glm session runs on, every model Claude Code asks for mapped to it.",
    schema: id
  },
  "models.glmKeychainService": {
    default: "playground-glm",
    description: "The Keychain service a --backend glm session's Z.ai key is kept under, one item a usage.accounts GLM row by its label.",
    schema: string2().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a Keychain service name, such as playground-glm")
  }
});
// packages/settings/src/owner.ts
var ownerSettings = defineSettings({
  "owner.names": {
    default: [],
    description: "The owner's first name and handles as chat writes them, lowercase: the inbox gate refuses a manager's stop on a line that addresses one of them and asks for an action, and never reads @<handle> as an agent.",
    schema: array(string2().regex(/^[a-z0-9][a-z0-9._-]*$/, "a name or handle, lowercase"))
  },
  "owner.voice": {
    default: "",
    description: "The voice a draft or a slack decision speaks in as the owner: singular has bun run ask refuse one that says we, us, our, ours or ourselves; empty checks none.",
    schema: _enum(["", "singular"])
  }
});
// packages/settings/src/paths.ts
var pathsSettings = defineSettings({
  "paths.codeRoot": {
    default: "",
    description: "The folder that holds your code, the folder that holds the checkout when unset: spawn.sh answers Claude's folder trust prompt there and moves a session off the Desktop into it.",
    schema: string2().regex(/^(?:\/.*)?$/, "an absolute path, or empty for unset")
  }
});
// packages/settings/src/sessions.ts
var name = string2().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a session name, lowercase words joined by hyphens");
var manager = _enum(["builder", "dispatcher", "ops", "planner"]);
var TEMPLATE_KINDS = [
  "assistant",
  "builder",
  "dispatcher",
  "ops",
  "optimizer",
  "orchestrator",
  "planner"
];
var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
var BRIEF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var sessionTemplate = strictObject({
  account: string2().email().optional(),
  brief: string2().regex(BRIEF_NAME, "a brief is a file name, with no /").refine((brief) => !brief.includes(".."), "a brief is a file name, with no .."),
  effort: _enum(EFFORTS).optional(),
  harness: literal("claude-code"),
  id: name,
  kind: _enum(TEMPLATE_KINDS),
  label: string2().min(1).max(40),
  model: string2().regex(/^[a-z0-9][a-z0-9.-]*$/, "a model id").optional()
}).refine((t) => t.model !== GLM_MODEL || t.account === undefined && t.effort === undefined, {
  message: "a GLM template runs on models.glm and its first GLM row, so it takes no account or effort"
});
var storedTemplates = (value) => Array.isArray(value) ? value.map((row) => {
  if (typeof row !== "object" || row === null || !("backend" in row) || "harness" in row)
    return row;
  const { backend, ...rest } = row;
  const { model, ...modelless } = rest;
  if (backend === "glm")
    return { ...rest, harness: "claude-code", model: GLM_MODEL };
  if (backend !== "claude")
    return { ...rest, backend, harness: "claude-code" };
  return { ...model === GLM_MODEL ? modelless : rest, harness: "claude-code" };
}) : value;
var sessionTemplates = array(sessionTemplate).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "each id is listed once");
var unknownAccounts = (templates, accounts) => {
  const known = new Set(accountsOf(accounts, "claude").map(accountKey));
  return templates.flatMap((template, at) => template.account && !known.has(template.account) ? [
    {
      message: `${template.account} is not in usage.accounts: add it in Settings > Accounts`,
      path: [at, "account"]
    }
  ] : []);
};
var sessionSettings = defineSettings({
  "sessions.aliases": {
    default: {},
    description: "Old names of the managers' sessions, each mapped to its kind, so a session or a stored row under one still reads as that kind.",
    schema: record2(name, manager)
  },
  "sessions.names": {
    default: { builder: "builder", dispatcher: "dispatcher", ops: "ops", planner: "planner" },
    description: "The session name each manager kind starts under; the second dispatcher takes the dispatcher's with -2.",
    schema: strictObject({ builder: name, dispatcher: name, ops: name, planner: name })
  },
  "sessions.templates": {
    against: (templates, read) => unknownAccounts(templates, read("usage.accounts")),
    default: [
      {
        brief: "assistant.md",
        harness: "claude-code",
        id: "assistant",
        kind: "assistant",
        label: "Assistant"
      },
      {
        brief: "orchestrator.md",
        harness: "claude-code",
        id: "orchestrator",
        kind: "orchestrator",
        label: "Orchestrator"
      },
      {
        brief: "dispatcher-2.md",
        harness: "claude-code",
        id: "second-dispatcher-claude",
        kind: "dispatcher",
        label: "Second dispatcher on Claude"
      },
      {
        brief: "dispatcher-2.md",
        harness: "claude-code",
        id: "second-dispatcher-glm",
        kind: "dispatcher",
        label: "Second dispatcher on GLM",
        model: GLM_MODEL
      }
    ],
    description: "The templates the sidebar's plus starts a dispatcher or an orchestrator from, A to Z by label: each one's kind, harness, model (a Claude id, or glm), effort, account (a Claude row of usage.accounts) and brief. A dispatcher template starts the second dispatcher; any other kind starts a new <id>-<kind> lead reporting to the dispatcher.",
    schema: sessionTemplates,
    stored: storedTemplates
  }
});
// packages/settings/src/slots.ts
var slotSettings = defineSettings({
  "slots.modelBound": {
    default: 2,
    description: "How many runs that mostly wait on a model (run-slot.sh <who> --model-bound -- <command>, such as a parity replay) hold a slot at once, counted apart from the CPU slots, so one never holds a CPU slot while its CPU idles.",
    schema: number2().int().min(1).max(16)
  },
  "slots.peers": {
    default: [],
    description: "The ops folders of other factories on this machine, each an absolute path: run-slot counts each live holder of their run slots against this factory's load units, and spawn.sh's load gate counts their starts beside its own, both reading only.",
    schema: array(string2().regex(/^\/.+/, "an absolute path"))
  }
});
// packages/settings/src/whatsapp.ts
var e1642 = string2().regex(/^(?:\+[1-9]\d{7,14})?$/, "a phone number is + and 8 to 15 digits, as +15550100001");
var whatsappSettings = defineSettings({
  "wa.device": {
    default: "",
    description: "The spare number ops-wa links to as a device, in E.164: its pairing code is for this number. Never the owner's own number; ops-wa does not run until it is set.",
    masked: true,
    schema: e1642
  },
  "wa.owner": {
    default: "",
    description: "The owner's WhatsApp number in E.164, the allowlist of one: ops-wa hands on only this number's 1:1 messages and sends only to it; ops-wa does not run until it is set.",
    masked: true,
    schema: e1642
  }
});
// packages/scripts/src/playground/setting.ts
import { resolve as resolve9 } from "path";
var CHECKOUT2 = resolve9(__CHECKOUT + "/packages/scripts/src/playground", "../../../..");
var origins = new Map;
var originRepo = (checkout = CHECKOUT2) => {
  if (!origins.has(checkout)) {
    const run = Bun.spawnSync(["git", "-C", checkout, "remote", "get-url", "origin"], {
      stderr: "ignore"
    });
    const url = run.stdout.toString().trim();
    const slug = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url)?.[1] ?? "";
    origins.set(checkout, slug.toLowerCase());
  }
  return origins.get(checkout);
};
if (false)
  ;

// packages/scripts/src/trace-count/kinds.ts
var reposOf = (settings, checkout) => {
  const archive = factorySettings.get(settings, "factory.archiveRepo").toLowerCase();
  const archiveOwner = archive ? [archive.split("/")[0]] : [];
  const set = [factorySettings.get(settings, "factory.publicRepo")].flat().filter(Boolean);
  return {
    archive,
    owner: [...new Set([...ownerSettings.get(settings, "owner.names"), ...archiveOwner])],
    public: set.length ? set.map((repo) => repo.toLowerCase()) : [originRepo(checkout)].filter(Boolean)
  };
};
var UNSET_REPOS = reposOf({ schemaVersion: 1, values: {} });
var LIST_KEYS = ["companies", "handles", "linearKeys", "names", "slackIds"];
var EMPTY_LIST = {
  companies: [],
  handles: [],
  linearKeys: [],
  names: [],
  slackIds: []
};
var isPublicList = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && LIST_KEYS.every((key) => {
  const items = value[key];
  return Array.isArray(items) && items.every((item) => typeof item === "string");
});
var escape2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var anyOf = (items, tail = "") => items.length ? new RegExp(`(?<![a-z\\d])(?:${items.map(escape2).join("|")})${tail}(?![a-z\\d])`, "gi") : undefined;
var ownerWord = (name) => {
  const cased = [...name].map((c) => /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escape2(c));
  return `(?<![a-zA-Z\\d])(?<![\\w.+-]@[\\w.-]*)${cased.join("")}(?![a-zA-Z\\d])(?!/[\\w-])(?![\\w.+-]*@)`;
};
var ownerName = (repos) => {
  if (!repos.owner.length)
    return;
  const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  return new RegExp([
    ...repos.owner.map(ownerWord),
    `\\b[Tt]he owner(?:,[^:"\\n]{0,40})?:\\s*["\u201C]`,
    "\\b[Tt]he owner (?:said|wrote)\\b",
    `\\b[A-Z][a-z]+, \\d{1,2} ${MONTH}\\b[^"\\n]{0,30}: *["\u201C]`
  ].join("|"), "g");
};
var LIGHT_SUFFIXES = "man|kid|boy|plan|review|board|day|ask|check|db|pass|emplates|setup";
function patterns(list, repos) {
  const all = [
    [
      "archiveLinks",
      repos.archive ? new RegExp(`(?<![\\w.-])${escape2(repos.archive)}(?![\\w.-])`, "gi") : undefined
    ],
    ["emails", /[a-z\d._%+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}/gi],
    ["names", anyOf(list.names)],
    ["handles", anyOf(list.handles)],
    ["companies", anyOf(list.companies)],
    ["slackIds", anyOf(list.slackIds)],
    ["linearKeys", anyOf(list.linearKeys, "-\\d+")],
    ["issueRefs", /(?<![\w&/])#[1-9]\d+(?![\w-])/g],
    ["oldNames", /(?<![a-z\d])(?:lightboy|lightkid|lightman|lightplan)(?![a-z\d])/gi],
    [
      "oldSkillNames",
      /(?<![a-z\d])(?:lightask|lightboard|lightcheck|lightday|lightdb|lightemplates|lightpass|lightreview|lightsetup)(?![a-z\d])/gi
    ],
    ["ownerName", ownerName(repos)],
    ["companyName", /(?<![a-z\d])(?:light[ -]?work|newgen)(?![a-z\d])/gi],
    [
      "lightWords",
      new RegExp(`(?<![a-z\\d])light(?:${LIGHT_SUFFIXES})[a-z\\d]+|(?<=[a-z\\d])light(?:${LIGHT_SUFFIXES}|quill)|(?<![a-z\\d])lightquill`, "gi")
    ]
  ];
  return all.filter((kind) => kind[1] !== undefined);
}
var readPast = (text, repos) => text.replace(new RegExp(`(?<![\\w.-])(?:${repos.public.map(escape2).join("|")})(?![\\w.-])`, "gi"), "");

// scripts/hooks/no-public-leak.ts
var PERSON = "Say the role (the owner, a reviewer, a worker) in place of the person.";
var SAID = {
  archiveLinks: {
    detail: "an archive link",
    fix: "Describe what it points to, or link this repository's own copy."
  },
  companies: { detail: "a company term", fix: "Name the work in plain words, not whose it is." },
  emails: { detail: "an email address", fix: "Leave the address out." },
  handles: { detail: "a handle", fix: PERSON },
  linearKeys: { detail: "a Linear key", fix: "Describe the ticket in plain words." },
  names: { detail: "a person's name", fix: PERSON },
  slackIds: {
    detail: "a Slack id",
    fix: "Leave the id out, and say what the conversation settled."
  }
};
var SHIP = /^\s*gh release (?:create|edit)\b[^`$();&|<>\n]*$/;
var CONTRIBUTOR = /^- ((?:\S+ )*)@([\w-]+)\s*$/;
function ownLinesPast(text, owner) {
  let contributors = false;
  return text.split(`
`).map((line) => {
    if (line.replace(/\r$/, "") === CONTRIBUTORS_HEADING) {
      contributors = true;
      return line;
    }
    const m = CONTRIBUTOR.exec(line);
    if (!m && line.trim() !== "")
      contributors = false;
    const names = m?.[1].trim() ?? "";
    const login = m?.[2] ?? "";
    const mine = contributors && owner.some((word) => word.toLowerCase() === login.toLowerCase()) && ownerWords(names, login, owner).join(" ") === names.split(/\s+/).filter(Boolean).join(" ");
    return mine ? "" : line;
  }).join(`
`);
}
function finder2(list, repos, owner) {
  const kinds = patterns(list, repos).filter(([kind]) => SAID[kind]);
  return (text) => {
    const said = readPast(owner ? ownLinesPast(text, owner) : text, repos);
    const found = kinds.find(([, re]) => said.search(re) !== -1);
    return found && SAID[found[0]];
  };
}
var policy2 = (list, repos, owner) => ({
  find: finder2(list, repos, owner),
  git: false,
  guard: "no-public-leak",
  guarded: (repo) => repos.public.includes(`${repo.owner}/${repo.repo}`.toLowerCase()),
  hosts: false,
  place: "a public repository",
  what: "private text",
  why: `Everything written to ${repos.public.join(" or ")} is public once the repository is, and stays cached after, so it names no person, company or private record.`
});
var shipWrite = (raw) => {
  try {
    const { tool_input: input, tool_name: tool } = JSON.parse(raw);
    return tool === "Bash" && typeof input?.command === "string" && SHIP.test(input.command);
  } catch {
    return false;
  }
};
async function check16(raw, environment = process.env) {
  const loaded = await guardList("no-public-leak", "no-public-leak", isPublicList, EMPTY_LIST, environment);
  if (loaded.refusal)
    return refusedList(raw, `${loaded.refusal} The list is a JSON object with an array of strings under each of ${LIST_KEYS.join(", ")}.`);
  const read = await readPolicy(dataDir(environment));
  if (read.refusal !== undefined)
    return refusedList(raw, `no-public-leak hook refused this call: ${read.refusal}, then run the call again.`);
  return inspectAs(policy2(loaded.list ?? EMPTY_LIST, reposOf(read.settings), shipWrite(raw) ? ownerSettings.get(read.settings, "owner.names") : undefined), raw, environment);
}
if (false) {}

// scripts/hooks/no-raw-delete.ts
import { realpathSync as realpathSync5 } from "fs";
import { basename as basename7, dirname as dirname8, resolve as resolve10, sep as sep4 } from "path";
var INSTEAD4 = "Move it to the 7-day trash with playground rm <path> (a worktree: playground rm --worktree <path>), which takes up to 5,000 files or 2 GB; leave a bigger tree or a scratch folder in place for your lead's cleanup, and let bun install rebuild a node_modules in place. A plain rm of a file inside your own worktree or scratchpad, with no -r, still runs.";
var WORKTREE = "Remove a worktree with playground rm --worktree <path>, which moves it to the 7-day trash once no live session holds it, it holds no uncommitted change and its work has landed on canary.";
var refuse11 = (what, why = "a recursive delete is final, and one aimed wrong takes a whole tree", instead = INSTEAD4) => `no-raw-delete hook refuses ${what}: ${why}. ${instead}`;
var shown2 = (word) => word.variable ? `$${word.variable}` : visible(word.value);
var DATA = new Set([
  ...PRINTERS,
  "awk",
  "bun",
  "cat",
  "deno",
  "egrep",
  "fgrep",
  "gawk",
  "gh",
  "grep",
  "jq",
  "node",
  "perl",
  "rg",
  "ruby",
  "sed"
]);
var isData = (name) => DATA.has(name) || /^python[\d.]*$/.test(name);
var scriptStaysText = (cmd, args, browserOnly) => browserOnly.has(cmd) && args[0]?.value === "eval";
var STARTERS = new Set(["screen", "tmux"]);
var RM = new Set(["grm", "rm"]);
var DEL = new Set(["del", "del-cli"]);
var DELETER_PROGRAMS = new Set([...DEL, "rimraf"]);
var RUNNERS5 = new Map([
  ["bun", ["x"]],
  ["bunx", []],
  ["npm", ["exec", "x"]],
  ["npx", []],
  ["pnpm", ["dlx", "exec"]],
  ["pnpx", []],
  ["yarn", ["dlx", "exec"]]
]);
var SHRED = new Set(["gshred", "shred"]);
var TAR = new Set(["gtar", "tar"]);
var JUDGED = new Set([
  ...RM,
  ...SHRED,
  ...TAR,
  "chflags",
  "chmod",
  "fd",
  "find",
  "gfind",
  "git",
  "rimraf",
  "rsync"
]);
function packageOf(name, args) {
  const subs = RUNNERS5.get(name);
  if (!subs)
    return;
  const words = args.filter((a) => !a.value.startsWith("-"));
  if (subs.length === 0)
    return words[0];
  return words[0] && subs.includes(words[0].value) ? words[1] : undefined;
}
var READERS3 = new Set([...PRINTERS, "egrep", "fgrep", "grep", "rg"]);
var APPENDS = new Set(["gxargs", "parallel"]);
var RUNS = {
  fd: new Set(["--exec", "--exec-batch", "-X", "-x"]),
  find: new Set(["-exec", "-execdir", "-ok", "-okdir"]),
  gfind: new Set(["-exec", "-execdir", "-ok", "-okdir"])
};
var QUEUES = new Set(["at", "batch"]);
var unversioned = (name) => name.replace(/(?<=.)@[^@/]*$/, "");
var ATTACHED = /^(?:--exec(?:-batch)?=|-[01FHILVaghilpqsu]*[xX]=?)(.*)$/s;
var recursive2 = (v) => v.startsWith("--") ? v.length >= 3 && "--recursive".startsWith(v) : /^-[A-Za-z]*[rR]/.test(v);
var spellsRecursive = (v) => v.split(/[\s,{}]+/).some((part) => part.startsWith("-") && recursive2(part));
var hidden = (word) => unreadable(word) || !!word.glob && /[*?]|\[[^\]]*\]/.test(word.value);
var prefixOf = (v, option, shortest) => v.length >= shortest && option.startsWith(v);
function real3(path) {
  try {
    return realpathSync5(path);
  } catch {
    const parent = dirname8(path);
    return parent === path ? path : resolve10(real3(parent), basename7(path));
  }
}
function rootsOf(cwd, session) {
  const at = cwd ? real3(cwd) : "";
  const worktree = /^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/.exec(at)?.[1];
  const id = typeof session === "string" && /^[\w-]+$/.test(session) ? session : undefined;
  const scratch = id ? new RegExp(`^(?:/private)?/tmp/claude-\\d+/[^/]+/${id}/scratchpad/`) : undefined;
  return { scratch, worktree };
}
var inside = (path, { scratch, worktree }) => {
  const at = real3(path);
  return !!worktree && at.startsWith(worktree + sep4) || !!scratch && scratch.test(at);
};
var OWN = { appends: false, nested: false };
function judgeRm(args, xargs, env, roots, { nested }) {
  if (xargs)
    return refuse11("rm under xargs", "the hook cannot read the paths xargs hands it");
  let options = true;
  const targets = [];
  for (const a of args) {
    if (options && a.value === "--") {
      options = false;
      continue;
    }
    const option = options && a.value.startsWith("-") && a.value !== "-";
    if (option && recursive2(a.value))
      return refuse11(`a recursive rm (${a.value})`);
    const spread = marked(a.value) && (!nested || !a.quoted);
    if (spread || options && spellsRecursive(a.value) || option && hidden(a))
      return refuse11(`an rm with a word the hook cannot read (${shown2(a)})`, "it may be -r or any path");
    if (!option)
      targets.push(a);
  }
  if (nested)
    return;
  const outside = targets.find((t) => {
    const path = pathOf(t, env);
    return !path || !inside(path, roots);
  });
  if (outside)
    return refuse11(`an rm of ${visible(outside.value)}`, "it is outside your own worktree and scratchpad, where a plain rm runs");
}
function judgeGit3(args) {
  const { rest, sub } = gitCommand(args);
  const words = rest.map((w) => w.value);
  const cluster = (letter) => words.some((v) => new RegExp(`^-[A-Za-z]*${letter}`).test(v));
  const force = cluster("f") || words.some((v) => prefixOf(v, "--force", 3));
  if (sub?.value === "clean") {
    if (cluster("n") || words.some((v) => prefixOf(v, "--dry-run", 3)))
      return;
    if (cluster("d") || cluster("x") || cluster("X"))
      return refuse11("git clean with -d or -x", "it deletes untracked folders or ignored files for good");
  }
  if (sub?.value === "worktree" && words[0] === "remove" && force)
    return refuse11("git worktree remove --force", "it deletes a worktree's uncommitted work for good", WORKTREE);
}
async function inspect13(raw, environment) {
  const payload = JSON.parse(raw);
  const { cwd, session_id: session, tool_input: input, tool_name: tool } = payload;
  if (tool !== "Bash")
    return;
  const command = input?.command;
  if (typeof command !== "string" || !CANDIDATE.test(bare(command)))
    return;
  const directory = typeof cwd === "string" ? cwd : undefined;
  const roots = rootsOf(directory, session);
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map
  };
  const lexed = lex(command, env.known);
  const browserOnly = new Set(lexed.commands.every((c) => c.words[0]?.source === "agent-browser") ? lexed.commands : []);
  const line = (text, at) => run(lex(text, at.known), { ...at, vars: new Map(at.vars) }, visit);
  const visitAs = (reach) => async (cmd, parsed, at) => {
    const { args, name } = parsed;
    const verdict = await judge(cmd, parsed, at, reach);
    if (verdict)
      return verdict;
    if (rootFed(cmd)) {
      for (const script of await scriptStdin(cmd, at)) {
        const found = await line(known(script), at);
        if (found)
          return found;
      }
    }
    const pkg = packageOf(name, args);
    if (!READERS3.has(name) && !JUDGED.has(name))
      for (const [k, a] of args.entries()) {
        if (hidden(a)) {
          if (!isData(name) && args.slice(k).some((w) => spellsRecursive(w.value)))
            return refuse11(`a program the hook cannot read (${shown2(a)}) given -r`, "it may be rm");
          continue;
        }
        const named = unversioned(program(a.value));
        if (!JUDGED.has(named) && !(a === pkg && DEL.has(named)))
          continue;
        const found = await examine({ ...cmd, words: args.slice(k) }, at, visitAs({ appends: APPENDS.has(name), nested: true }), false);
        if (found)
          return found;
      }
    if (isData(name) || scriptStaysText(cmd, args, browserOnly))
      return;
    const words = name === "git" ? gitCommand(args).aliases.flatMap((w) => /^alias\.[^=]*=!(.*)$/s.exec(w)?.[1] ?? []) : args.flatMap(({ value }) => [value, value.slice(value.indexOf("=") + 1)]);
    for (const text of new Set(words.map((w) => w.replace(/^!/, "")))) {
      if (!/\s/.test(text))
        continue;
      const found = await line(text, at);
      if (found)
        return found;
    }
  };
  const visit = visitAs(OWN);
  const judge = async (cmd, parsed, at, reach) => {
    const { args, first, xargs } = parsed;
    const name = unversioned(parsed.name);
    const end = args.findIndex((a) => !a.value.startsWith("-") && !hidden(a));
    const lead = end < 0 ? args : args.slice(0, end);
    if (first && hidden(first) && (spellsRecursive(first.value) || args.some((a) => spellsRecursive(a.value)) || lead.some((a) => hidden(a) && !a.quoted)))
      return refuse11(`a program the hook cannot read (${shown2(first)}) given -r`, "it may be rm");
    const held = first && !first.quoted && first.value === UNKNOWN && first.variable ? at.vars.get(first.variable) : undefined;
    if (held && !held.unknown && /\s/.test(held.value.trim())) {
      const split = held.value.trim().split(/\s+/).map((value) => ({ quoted: false, value }));
      const found = await examine({ ...cmd, words: [...split, ...args] }, at, visitAs(reach), false);
      if (found)
        return found;
    }
    const slot = slotWords(parsed);
    if (slot)
      return examine({ ...cmd, words: slot }, at, visitAs(reach), false);
    if (RM.has(name))
      return judgeRm(args, xargs !== undefined || reach.appends, at, roots, reach);
    if (name === "git")
      return judgeGit3(args);
    if (DELETER_PROGRAMS.has(name))
      return refuse11(name);
    if (name === "rsync" && args.some(({ value }) => value === "--del" || value.startsWith("--delete")))
      return refuse11("rsync --delete", "it deletes every file its source lacks, for good");
    if (name === "rsync" && args.some(({ value }) => /^--remove-s(?:ent|ource)-files$/.test(value)))
      return refuse11("rsync --remove-source-files", "it deletes every source file it sends");
    if (SHRED.has(name) && args.some(({ value }) => /^-[a-z]*u/.test(value) || prefixOf(value.split("=")[0], "--remove", 4)))
      return refuse11(`${name} -u`, "it overwrites each file and then deletes it, past any recovery");
    if (TAR.has(name) && args.some(({ value }) => prefixOf(value, "--remove-files", 5)))
      return refuse11(`${name} --remove-files`, "it deletes every file it adds to the archive");
    if (name === "chflags")
      return refuse11("chflags", "it lifts the flags that keep a file from deletion");
    if (name === "chmod" && args.some((a) => /^-[A-Za-z]*[aN]/.test(a.value)))
      return refuse11("chmod -a or -N", "it strips the access entries that keep a file from deletion");
    const runs = Object.hasOwn(RUNS, name) ? RUNS[name] : undefined;
    if (runs) {
      if (args.some((a) => a.value === "-delete"))
        return refuse11(`${name} -delete`);
      for (const [k, a] of args.entries()) {
        const attached = name === "fd" ? ATTACHED.exec(a.value) : null;
        if (!runs.has(a.value) && !attached)
          continue;
        const value = attached?.[1] || undefined;
        const end = args.findIndex((w, j) => j > k && (w.value === ";" || w.value === "+"));
        const words = [
          ...value === undefined ? [] : [{ ...a, value }],
          ...args.slice(k + 1, end === -1 ? undefined : end)
        ];
        if (RM.has(parse({ ...cmd, words }).name))
          return refuse11(value === undefined ? `${name} ${a.value} rm` : `${name} ${a.value}`, `it deletes every path ${name} reaches`);
        const found = await examine({ ...cmd, words }, at, visitAs({ appends: true, nested: true }), false);
        if (found)
          return found;
      }
    }
    if (QUEUES.has(name)) {
      const file = args.findIndex((a) => a.value === "-f");
      const fed = file !== -1 || cmd.stdin !== undefined || cmd.redirects.some((r) => (r.fd === "" || r.fd === "0") && r.op.startsWith("<")) || stdinFed(cmd);
      if (fed) {
        const script = await (file === -1 ? stdinOf(cmd, at) : readPath(args[file + 1] ?? { value: "" }, at)).catch((error) => ({ unknown: `a read that failed: ${error}`, value: "" }));
        if (script.unknown)
          return refuse11(`${name} given a job it cannot read (${script.unknown})`, "it may queue a recursive delete");
        return line(script.value, at);
      }
    }
    if (STARTERS.has(name))
      for (const [k, a] of args.entries()) {
        if (a.value.startsWith("-") || marked(a.value))
          continue;
        const found = await examine({ ...cmd, redirects: [], words: args.slice(k) }, at, visit, false);
        if (found)
          return found;
      }
  };
  return run(lexed, env, visit);
}
var bare = (command) => command.replace(/[\\'"]/g, "");
var CANDIDATE = /rm|del|chflags|chmod|clean|worktree|rimraf|rsync|shred|\bg?tar\b|screen|tmux|\bat\b|batch|\$|`|[{*?[]/i;
var DELETES = /\bg?rm\b|-delete\b|\bchflags\b|\bchmod\b|\bclean\b|\bworktree\b|\brimraf\b|\bdel-cli\b|\bg?shred\b|--del|--rem/i;
function commandOf2(raw) {
  try {
    const command = JSON.parse(raw).tool_input?.command;
    return typeof command === "string" ? command : undefined;
  } catch {
    return;
  }
}
async function check17(raw, environment = process.env) {
  try {
    return await withDeadline(1e4, async () => inspect13(raw, environment));
  } catch (error) {
    if (!DELETES.test(bare(commandOf2(raw) ?? raw)))
      return;
    return refuse11(`a call it could not read (${error})`, "it reads as a delete").concat(" Split it into plain commands and run them again.");
  }
}
if (false) {}

// scripts/hooks/no-raw-spawn.ts
import { join as join16, resolve as resolve11, sep as sep5 } from "path";
var SPAWN = join16(__CHECKOUT + "/scripts/hooks", "..", "spawn.sh");
var HEADS = new Set([
  "agent",
  "agent-hibernation",
  "claude-teams",
  "fork",
  "local-tmux",
  "local-zellij",
  "new-pane",
  "new-split",
  "new-surface",
  "new-workspace",
  "omc",
  "recover",
  "respawn-pane",
  "restore",
  "restore-session",
  "session",
  "surface",
  "tmux",
  "vault"
]);
var GLOBAL_TAKES = new Set(["--id-format", "--password", "--socket", "--window"]);
var REOPENS = new Set(["-c", "-r", "--continue", "--resume"]);
var TERMINAL = /^cmux$/i;
var CMUX_READS = new Set(["--help", "-h", "--version", "version"]);
var HERDR_HEADS = new Set([
  "agent",
  "api",
  "channel",
  "config",
  "integration",
  "machine",
  "notification",
  "pane",
  "plugin",
  "server",
  "session",
  "tab",
  "terminal",
  "workspace",
  "worktree"
]);
var HERDR_GLOBALS = new Set(["--machine", "--remote", "--remote-keybindings", "--session"]);
var HERDR_READ_VERBS = new Set([
  "current",
  "edges",
  "get",
  "layout",
  "list",
  "neighbor",
  "process-info",
  "read",
  "status"
]);
var HERDR_READS = new Set([
  "agent explain",
  "agent wait",
  "api schema",
  "api snapshot",
  "channel show",
  "integration status",
  "pane wait-output",
  "plugin action list",
  "plugin log list",
  "server agent-manifests",
  "status",
  "terminal session observe"
]);
var HERDR_SOCKET = /herdr[^\s'"]*\.sock\b/;
var CONNECTS = /^(?:bun|curl|deno|nc|ncat|netcat|node|perl|php|python[\d.]*|ruby|socat)$/;
var UNIX = /\b(?:curl|nc|ncat|netcat|socat)\b/i;
function unixTarget(name, args) {
  const positional = args.filter((a) => !a.value.startsWith("-") || a.value === "-");
  const unix = (v) => /^-[A-Za-z0-9]*U/.test(v) || v === "--unixsock";
  if (/^(?:nc|ncat|netcat)$/.test(name) && args.some((a) => unix(a.value)))
    return positional.at(-1);
  if (name === "socat")
    return positional.find((a) => a.unknown || a.reads?.length);
  if (name === "curl") {
    const k = args.findIndex((a) => ["--abstract-unix-socket", "--unix-socket"].includes(a.value));
    return k >= 0 ? args[k + 1] : undefined;
  }
}
var EXPORTS4 = new Set(["declare", "export", "local", "readonly", "typeset"]);
var refuse12 = (what) => `no-raw-spawn hook refuses ${what}: a factory session starts another only through ${SPAWN}, which refuses unless the machine has room, its gate naming the reading that failed. Run it instead (worker, runner, column, manager, resume or restore; with no arguments it prints how).`;
var refuseHerdr = (what) => `no-raw-spawn hook refuses ${what}: herdr's socket has no access control, so a factory session runs only herdr's reads (current, edges, get, layout, list, neighbor, process-info, read and status, agent explain, agent wait, api snapshot, pane wait-output and the like) on herdr's own socket. Talk to another session with SendMessage; start, resume or restore one only through ${SPAWN} (with no arguments it prints how).`;
var beforeDashes = (args) => {
  const dashes = args.findIndex((a) => a.value === "--");
  return dashes === -1 ? args : args.slice(0, dashes);
};
var reopens = (args) => beforeDashes(args).some((a) => REOPENS.has(a.value) || /^--(?:resume|continue)=/.test(a.value));
function positionals3(words) {
  const found = [];
  for (let k = 0;k < words.length; k++) {
    const v = words[k].value;
    if (GLOBAL_TAKES.has(v))
      k++;
    else if (!v.startsWith("-"))
      found.push(v);
  }
  return found;
}
function judgeCmux(args) {
  if (args.length === 1 && CMUX_READS.has(args[0].value))
    return;
  const [head] = positionals3(beforeDashes(args));
  return refuse12(`a cmux ${head ?? "call"}, since every session runs in herdr and no factory session calls cmux (only \`cmux --help\`, \`-h\`, \`--version\` and \`version\` run)`);
}
function herdrArgs(args) {
  const found = [];
  const words = beforeDashes(args);
  for (let k = 0;k < words.length; k++) {
    if (HERDR_GLOBALS.has(words[k].value))
      k++;
    else
      found.push(words[k].value);
  }
  return found;
}
var herdrWords = (args) => herdrArgs(args).filter((v) => !v.startsWith("-"));
var HELP = new Set(["--help", "-h"]);
var SCRATCH_GROUPS = new Set([
  "agent",
  "api",
  "notification",
  "pane",
  "server",
  "status",
  "tab",
  "workspace",
  "worktree"
]);
var MOVES = /^--(?:machine|remote|session)(?:=|$)/;
var STARTS_CLAUDE = /(?<![.\w])claude(?!\w)/i;
function scratchWorld(args, local, env) {
  const session = local.get("HERDR_SESSION");
  const socket = local.get("HERDR_SOCKET_PATH");
  if (!session || !socket)
    return;
  const tmp = env.process.TMPDIR;
  const path = socket.value;
  if (!tmp?.startsWith("/") || unreadable(socket) || !path.startsWith("/") || !resolve11(path).startsWith(resolve11(tmp) + sep5))
    return `a scratch herdr call whose HERDR_SOCKET_PATH is not a literal path under your TMPDIR (${tmp ?? "unset"}), where a scratch server's socket goes`;
  const servers = (env.process.PLAYGROUND_HERDR_SESSIONS ?? "").split(",");
  if (unreadable(session) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(session.value) || ["default", "factory", "playground", "playground-probes", "probes", ...servers].includes(session.value))
    return "a scratch herdr call whose HERDR_SESSION is not a word of its own: herdr keeps a server's state under ~/.config/herdr/sessions/<name>, so default, Playground's servers (playground, playground-probes) and the factory's (factory, probes) stay theirs";
  if (args.some((a) => MOVES.test(a.value)))
    return "a scratch herdr call with --session, --machine or --remote, which moves it off the scratch socket";
  const [head] = herdrWords(args);
  if (!SCRATCH_GROUPS.has(head ?? ""))
    return `a scratch herdr ${head ?? "call with no command"}, which is not one of the groups that only talk to its server (${[...SCRATCH_GROUPS].join(", ")})`;
  if (args.some((a) => unreadable(a) || STARTS_CLAUDE.test(a.value)))
    return "a scratch herdr call that may start claude, which only spawn.sh starts";
  return true;
}
var HC_NAMES = new Set(["hc", "herdr-core"]);
var HC_HEADS = new Set(["exec", "file", "keys", "send"]);
var refuseHc = (what) => `no-raw-spawn hook refuses ${what}: herdr-core's socket has no access control and gives a caller exec, file and keys, and the factory runs its sessions in herdr, so a factory session runs only hc's --help and --version.`;
function judgeHc(args) {
  const given = args.map((a) => a.value);
  const options = given.filter((v) => v.startsWith("-"));
  if (options.length && options.every((v) => HELP.has(v)) && given.length - options.length <= 1)
    return;
  if (given.length === 1 && (given[0] === "--version" || given[0] === "-V"))
    return;
  const [head] = given.filter((v) => !v.startsWith("-"));
  return refuseHc(`an hc ${head ?? "call with no command, which attaches"}`);
}
function judgeHerdr(args, local, env, program) {
  const given = herdrArgs(args);
  const options = given.filter((v) => v.startsWith("-"));
  if (options.length && options.every((v) => HELP.has(v)) && given.length - options.length <= 2)
    return;
  if (given.length === 1 && (given[0] === "--version" || given[0] === "-V"))
    return;
  const scratch = program ? undefined : scratchWorld(args, local, env);
  if (scratch === true)
    return;
  if (scratch)
    return refuseHerdr(scratch);
  const carried = ["HERDR_SESSION", "HERDR_SOCKET_PATH"].find((v) => local.has(v));
  if (carried)
    return refuseHerdr(`a herdr call carrying ${carried}, which moves it off its own socket`);
  const command = herdrWords(args);
  const [head, second] = command;
  if (!head)
    return refuseHerdr("a bare herdr, which starts or attaches to a server");
  if (HERDR_HEADS.has(head) && head !== "server" && HERDR_READ_VERBS.has(second))
    return;
  if (command.some((_, k) => HERDR_READS.has(command.slice(0, k + 1).join(" "))))
    return;
  const verb = command.slice(0, 2).join(" ");
  if (program)
    return refuseHerdr(`\`${verb}\` whose program is ${program.unknown ?? "a word it cannot read"}, which it cannot tell from herdr; type the program by its literal name, such as \`agent-browser\` or \`herdr\`, so the hook can read it`);
  return refuseHerdr(`a herdr ${verb}, which is not one of its reads`);
}
var visit7 = async (cmd, { args, first, local, name }, env) => {
  const texts = [...args, ...cmd.redirects.flatMap((r) => [r.target ?? [], r.body ?? []].flat())];
  const socket = (t) => {
    if (HERDR_SOCKET.test(t.value) || t.variable === "HERDR_SOCKET_PATH")
      return true;
    const path = t.value.replace(/^[A-Za-z-]+:/, "");
    if (!path.includes(".sock") || path.startsWith("/"))
      return false;
    const full = pathOf({ ...t, value: path }, env);
    return !full || HERDR_SOCKET.test(full);
  };
  if ((CONNECTS.test(name) || first?.unknown) && texts.some(socket))
    return refuseHerdr(`a ${name || "program"} that names a herdr socket`);
  const target = unixTarget(name, args);
  if (target?.unknown || target?.reads?.length)
    return refuseHerdr(`a ${name} to a Unix socket the hook cannot read, which may be herdr's`);
  if (name === "" && (local.has("HERDR_SESSION") || local.has("HERDR_SOCKET_PATH")))
    return refuseHerdr("an assignment of HERDR_SESSION or HERDR_SOCKET_PATH, which points herdr at another session");
  if (EXPORTS4.has(name) && args.some((a) => /^HERDR_(?:SESSION|SOCKET_PATH)=/.test(a.value)))
    return refuseHerdr(`a ${name} of HERDR_SESSION or HERDR_SOCKET_PATH, which points herdr at another session`);
  if (args.some((a) => a.value === "herdrdev/herdr"))
    return refuseHerdr("herdr's agent skill, which teaches typing into other panes");
  if (TERMINAL.test(name))
    return judgeCmux(args);
  if (HC_NAMES.has(name))
    return judgeHc(args);
  if (SHELLS.has(name) || name === "." || name === "source") {
    const { inline, operand } = SHELLS.has(name) ? shellOperand(args, name) : { inline: false, operand: args[0] };
    if (operand && !inline && HC_NAMES.has(program(operand.value)))
      return judgeHc(args.slice(args.indexOf(operand) + 1));
  }
  if (name === "herdr" || first?.variable === "HERDR_BIN_PATH")
    return judgeHerdr(args, local, env);
  if (first && (first.unknown || marked(first.value))) {
    if (HERDR_HEADS.has(herdrWords(args)[0] ?? ""))
      return judgeHerdr(args, local, env, first);
    if (HC_HEADS.has(herdrWords(args)[0] ?? ""))
      return refuseHc(`an ${herdrWords(args)[0]} whose program is ${first.unknown ?? "a word it cannot read"}, which it cannot tell from hc`);
    const [head] = positionals3(beforeDashes(args));
    return head && HEADS.has(head) ? judgeCmux(args) : undefined;
  }
  if (name === "claude" && reopens(args))
    return refuse12("a claude --resume or --continue");
};
var BARE4 = (command) => command.replace(/[\\'"]/g, "");
var OPENS3 = new RegExp(`\\b(?:cmux|hc|herdr|HERDR_BIN_PATH|HERDR_SESSION|HERDR_SOCKET_PATH|${[...HEADS, ...HERDR_HEADS, ...HC_HEADS].join("|")})\\b`, "i");
var REOPEN = /\bclaude\b[\s\S]*(?:\s-[cr]\b|--resume|--continue)/i;
var candidate6 = (command) => command.includes("$'") || OPENS3.test(BARE4(command)) || /\bcmux\b/i.test(BARE4(command)) || REOPEN.test(BARE4(command)) || UNIX.test(BARE4(command));
var spawnCall = (command) => /\b(?:hc|herdr|HERDR_BIN_PATH|HERDR_SESSION|HERDR_SOCKET_PATH)/i.test(BARE4(command)) || /\bcmux\b/i.test(BARE4(command)) && /\b(?:claude|claude-teams|omc|recover|wake|restore|restore-session|fork)\b/.test(BARE4(command)) || REOPEN.test(BARE4(command));
function commandOf3(raw) {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
    return tool === "Bash" && typeof toolInput?.command === "string" ? toolInput.command : undefined;
  } catch {
    return;
  }
}
async function inspect14(raw, environment) {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool
  } = JSON.parse(raw);
  if (tool !== "Bash" || typeof toolInput?.command !== "string")
    return;
  const { command } = toolInput;
  if (!candidate6(command))
    return;
  const directory = typeof cwd === "string" ? cwd : undefined;
  const env = {
    cwd: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map,
    visitShells: true
  };
  return run(lex(command, env.known), env, visit7, true);
}
async function check18(raw, environment = process.env) {
  try {
    return await inspect14(raw, environment);
  } catch (error) {
    const command = commandOf3(raw);
    if (!command || !spawnCall(command))
      return;
    return `no-raw-spawn hook could not read this call (${error}), which reads as a session spawn, so it refuses it. ${refuse12("it")}`;
  }
}
if (false) {}

// scripts/hooks/no-raw-wa.ts
import { realpathSync as realpathSync6 } from "fs";
import { homedir as homedir4 } from "os";
import { resolve as resolve12 } from "path";
var refuse13 = (what) => `no-raw-wa hook refuses ${what}: the data folder's whatsapp/ holds ops-wa's linked device, its auth state, its socket and the owner's messages, which no session reads or writes. To write to the owner on WhatsApp, run playground wa send <absolute file>; to see ops-wa's state, read its row on the System page.`;
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
  const typed = resolve12(dataDirOf(environment), "whatsapp");
  let real = typed;
  try {
    real = resolve12(realpathSync6(dataDirOf(environment)), "whatsapp");
  } catch {}
  return [...new Set([typed, real].map((p) => p.toLowerCase()))];
};
var segments = (path) => resolve12(path).toLowerCase().split("/").filter(Boolean);
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
var recursive3 = (name, args) => RECURSIVE.has(name) || args.some((a) => RECURSIVE_WITH[name]?.test(a.value));
async function judgeBash(command, cwd, environment) {
  const targets = targetsOf(environment);
  if (namesTarget(command, targets))
    return refuse13("a command naming whatsapp/ in the data folder");
  const env = {
    cwd,
    files: new Map,
    known: knownVariables(command, environment, cwd),
    process: environment,
    vars: new Map
  };
  const visit = async (cmd, { args, first, name }, at) => {
    const words = [
      ...first ? [first] : [],
      ...args,
      ...cmd.redirects.flatMap((r) => r.target ? [r.target] : [])
    ];
    for (const place of places(at)) {
      if (place.cwd && worst(place.cwd, targets) === "inside")
        return refuse13(`a command run inside whatsapp/ in the data folder`);
      for (const typed of words) {
        const word = readOf(typed, at);
        if (!word?.value)
          continue;
        for (const raw of [word.value, word.value.slice(word.value.indexOf("=") + 1)]) {
          const value = /^~(?:\/|$)/.test(raw) ? `${homedir4()}${raw.slice(1)}` : raw;
          const path = value.startsWith("/") ? value : place.cwd && resolve12(place.cwd, value);
          if (!path)
            continue;
          const stands = worst(path, targets, !!word.glob);
          if (stands === "inside")
            return refuse13(`${visible(word.value)}, which reaches whatsapp/ in the data folder`);
          if (stands === "above" && recursive3(program(name), args))
            return refuse13(`${name} through ${visible(word.value)}, which reads whatsapp/ in the data folder on its way down`);
        }
      }
    }
  };
  return run(lex(command, env.known), env, visit, true);
}
var FILE_TOOLS3 = new Set(["Edit", "MultiEdit", "NotebookEdit", "Read", "Write"]);
async function inspect15(raw, environment) {
  const {
    cwd,
    tool_input: input,
    tool_name: tool
  } = JSON.parse(raw);
  const folder = typeof cwd === "string" ? cwd : undefined;
  const targets = targetsOf(environment);
  if (tool === "Bash" && typeof input?.command === "string")
    return judgeBash(input.command, folder, environment);
  if (typeof tool === "string" && FILE_TOOLS3.has(tool)) {
    const path = input?.file_path ?? input?.notebook_path;
    if (typeof path === "string" && worst(path, targets) === "inside")
      return refuse13(`a ${tool} of ${path}`);
    return;
  }
  if (tool === "Grep" || tool === "Glob") {
    const path = typeof input?.path === "string" ? input.path : folder;
    if (!path)
      return;
    const at = worst(path, targets);
    if (at === "inside" || tool === "Grep" && at === "above")
      return refuse13(`a ${tool} through ${path}, which reads whatsapp/ in the data folder`);
    const pattern = input?.pattern;
    if (tool === "Glob" && typeof pattern === "string" && worst(resolve12(path, pattern), targets, true) === "inside")
      return refuse13(`a Glob of ${pattern}, which reaches whatsapp/ in the data folder`);
  }
}
async function check19(raw, environment = process.env) {
  try {
    return await eachInput(raw, "no-raw-wa", (one) => inspect15(one, environment));
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/no-release-comment.ts
import { join as join17 } from "path";
var guardedOwners = new Set;
var WORD2 = /release/i;
var UNRESOLVED = "a repository the hook cannot resolve";
var GROUPS = new Set(["api", "issue", "pr"]);
var spec2 = (texts, files, others = []) => ({
  files,
  takes: new Set([...files, ...others, ...texts, "-R", "--repo"]),
  texts
});
var COMMENT = spec2(["--attach", "-b", "--body"], ["-F", "--body-file"]);
var CLOSING2 = spec2(["-c", "--comment"], []);
var SPECS2 = new Map([
  ["issue close", spec2(["-c", "--comment"], [], ["--duplicate-of", "-r", "--reason"])],
  ["issue comment", COMMENT],
  ["issue reopen", CLOSING2],
  ["pr close", CLOSING2],
  ["pr comment", COMMENT],
  ["pr reopen", CLOSING2],
  ["pr review", spec2(["-b", "--body"], ["-F", "--body-file"])]
]);
var PR_URL2 = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/i;
var API_URL = /api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/([^\s?#]+)/i;
var COMMENT_PATH = /(?:^|\/)(?:comments|replies|reviews)(?:\/|$)/;
var COMMENT_MUTATION = /\b(?:addComment|addPullRequestReview(?:Comment|Thread|ThreadReply)?|submitPullRequestReview|updateIssueComment|updatePullRequestReview(?:Comment)?)\b/;
var MCP_COMMENT = /^mcp__.+__(?:add_comment_to_pending_review|add_issue_comment|add_reply_to_pull_request_comment|pull_request_review_write|update_issue_comment)$/;
var BODY_KEY = /body/i;
var GH2 = /\bgh\b|github/i;
var MAYBE_COMMENT = /\b(?:api|close|comment|reopen|review)/i;
var COMMENT_CALL = /(?:\b|_)(?:close|comment|reopen|review)(?:\b|_)|\bapi\b[\s\S]*(?:comments|graphql|replies|reviews)/i;
var comment = async (cmd, { args, first, local, name, xargs }, env) => {
  if (name === "gh")
    return gh4(args, cmd, env, local, xargs);
  if (first?.unknown && GROUPS.has(args[0]?.value ?? ""))
    return gh4(args, cmd, env, local, xargs);
  if (name === "curl")
    return curl3(args, cmd, env);
  const nested = args.findIndex((a, j) => program(a.value) === "gh" && GROUPS.has(args[j + 1]?.value ?? ""));
  if (nested !== -1 && !PRINTERS.has(name)) {
    return gh4(args.slice(nested + 1), cmd, env, local, xargs);
  }
};
async function gh4(args, cmd, env, local, xargs) {
  const { head, repos, rest } = ghCommand(args);
  if (head[0] === "api")
    return api4(rest, cmd, env, local, xargs);
  const key = head.join(" ");
  const found = SPECS2.get(key);
  if (!found)
    return;
  const { flags, positionals } = parseFlags(rest, found.takes);
  const bodies = [];
  for (const { name, value } of flags) {
    const body = found.texts.includes(name) || found.files.includes(name);
    if (!value) {
      if (body)
        bodies.push(unknown(`${name} with no value`));
    } else if (name === "--attach")
      bodies.push(altText(value));
    else if (found.texts.includes(name))
      bodies.push(value);
    else if (found.files.includes(name)) {
      bodies.push(value.value === "-" && !value.unknown ? await stdinOf(cmd, env) : await readPath(value, env));
    } else if (name === "-R" || name === "--repo")
      repos.push(value);
  }
  if (xargs && !xargs.replace)
    bodies.push(unknown("the arguments xargs appends"));
  if (rest.some((a) => flagFromXargs(a, xargs))) {
    bodies.push(unknown(`what xargs puts in place of ${xargs?.replace}`));
  }
  if (bodies.length === 0)
    return;
  const named = [
    ...repos.map((r) => fromXargs(r, xargs) ? undefined : repoOf(r)),
    ...positionals.flatMap((p) => {
      if (unreadable(p) || fromXargs(p, xargs))
        return [undefined];
      return PR_URL2.test(p.value) ? [repoOf(p)] : [];
    }),
    ...xargs && !xargs.replace ? [undefined] : []
  ];
  const target = decide2(named.length > 0 ? named : implicitRepos(env, local));
  return judge6(`gh ${key}`, target, bodies.map((b) => viaXargs(b, xargs)), env);
}
function altText(value) {
  const tail = Math.max(value.value.lastIndexOf(UNKNOWN), value.value.lastIndexOf(READ)) + 1;
  const hash = value.value.indexOf("#");
  const from = hash === -1 ? value.value.lastIndexOf("/") + 1 : hash + 1;
  const alt = slice(value, from);
  return tail > 0 && from > tail ? { reads: alt.reads, value: alt.value } : alt;
}
async function api4(args, cmd, env, local, xargs) {
  const request = await ghApi(args, cmd, env, xargs);
  if (!request || ["DELETE", "GET", "HEAD"].includes(request.method))
    return;
  const { endpoint, fields, inputs } = request;
  if (endpoint.value === "graphql") {
    const documents = [...fields.filter((f) => f.key === "query").map((f) => f.text), ...inputs];
    const resolved = await Promise.all(documents.map((d) => resolveText(d, env)));
    if (!resolved.some((d) => d.unknown || COMMENT_MUTATION.test(d.value)))
      return;
    return judge6("gh api graphql", { guarded: true, label: "a repository named only by a GraphQL node id" }, [...fields.map((f) => f.text), ...inputs], env, INLINE_QUERY);
  }
  const path = endpoint.value.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "").replace(/^api\/v3\//, "").split("?")[0];
  const match = /^repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
  const rest = match?.[3] ?? /^repositories\/[^/]+\/(.+)$/.exec(path)?.[1];
  const open = marked(path) || fromXargs(endpoint, xargs);
  if (rest !== undefined ? !COMMENT_PATH.test(rest) && !open : !open)
    return;
  let candidates = [undefined];
  if (match?.[1] === "{owner}")
    candidates = implicitRepos(env, local);
  else if (match && !marked(match[1]) && !fromXargs({ value: `${match[1]}/${match[2]}` }, xargs)) {
    candidates = [{ owner: match[1], repo: match[2] }];
  }
  const bodies = [
    ...fields.filter((f) => marked(f.key) || BODY_KEY.test(f.key)).map((f) => f.text),
    ...await Promise.all(inputs.map((i) => bodyOf2(i, env)))
  ];
  return judge6(`gh api ${path.replaceAll(UNKNOWN, "*").replaceAll(READ, "*")}`, decide2(candidates), bodies, env);
}
async function bodyOf2(payload, env) {
  const text = await resolveText(payload, env);
  if (text.unknown)
    return text;
  let parsed;
  try {
    parsed = JSON.parse(text.value);
  } catch {
    return text;
  }
  const found = [];
  const visit = (node, inBody) => {
    if (typeof node === "string" && inBody)
      found.push(node);
    else if (Array.isArray(node))
      for (const item of node)
        visit(item, inBody);
    else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node))
        visit(value, inBody || BODY_KEY.test(key));
    }
  };
  visit(parsed, false);
  return { value: found.join(`
`) };
}
async function curl3(args, cmd, env) {
  const { flags, positionals } = parseFlags(args, CURL_TAKES);
  const url = curlUrls(flags, positionals).map((u) => API_URL.exec(u.value)).find((m) => m !== null);
  if (!url || !COMMENT_PATH.test(url[3]))
    return;
  const data = await curlData(flags, cmd, env);
  if (data.length === 0)
    return;
  const owner = marked(url[1]) ? undefined : { owner: url[1], repo: url[2] };
  return judge6(`curl to api.github.com/repos/${url[1]}/${url[2]}`, decide2([owner]), await Promise.all(data.map((d) => bodyOf2(d, env))), env);
}
function decide2(candidates) {
  if (candidates.length === 0)
    return { guarded: true, label: UNRESOLVED };
  const hit = candidates.findIndex((c) => !c || guardedOwners.has(c.owner.toLowerCase()));
  if (hit === -1)
    return { guarded: false, label: "" };
  const repo = candidates[hit];
  return { guarded: true, label: repo ? `${repo.owner}/${repo.repo}` : UNRESOLVED };
}
function refuse14(what, target, detail, fix) {
  return `no-release-comment hook refused ${what} on ${target.label}: ${detail}. On a guarded owner's repos an owner comment containing "release" in any case publishes to npm, and gh and the GitHub MCP post as that owner. ${fix}`;
}
var READABLE2 = "Put the text in the command itself, or write the text to a file with the Write tool first, then run the command again in a call of its own that names that file by its literal absolute path (--body-file /abs/body.md).";
var INLINE_QUERY = "Write the query and each of its fields in the command itself, not in a variable: gh api graphql -f query='query { viewer { login } }'. For a long one, write it to a file with the Write tool first and pass it by its literal absolute path (-F query=@/abs/query.graphql, -F body=@/abs/body.md).";
var REWORD = 'Write "ship" or "publish step" instead, or leave the comment out. For a file or rule whose name holds the word, name it by what it is, such as "the ship rule" or "the comment hook", with its line number; for a patch that holds it, write the patch to a file in your scratchpad, send its absolute path to the PR\'s worker by SendMessage, and say in the comment that a patch went to the author, since gh\'s `--attach` uploads only images and video.';
async function judge6(what, target, bodies, env, fix = READABLE2) {
  if (!target.guarded)
    return;
  const texts = await Promise.all(bodies.map((b) => resolveText(b, env)));
  if (texts.some((t) => WORD2.test(visible(t.value))))
    return refuse14(what, target, 'its text contains "release"', REWORD);
  const hidden = texts.find((t) => t.unknown);
  if (hidden) {
    return refuse14(what, target, `the hook cannot read its text before the command runs (it comes from ${hidden.unknown})`, fix);
  }
}
function mcp4(tool, input) {
  const what = tool.replace(/^mcp__/, "");
  if (!input)
    return refuse14(what, { guarded: true, label: UNRESOLVED }, "its input is not an object", REWORD);
  const { body, owner, repo } = input;
  if (body === undefined || body === null)
    return;
  const named = typeof owner === "string" && owner !== "" ? { owner, repo: typeof repo === "string" ? repo : "?" } : undefined;
  const target = decide2([named]);
  if (!target.guarded)
    return;
  if (typeof body !== "string")
    return refuse14(what, target, "its body is not text the hook can read", REWORD);
  if (WORD2.test(body))
    return refuse14(what, target, 'its text contains "release"', REWORD);
}
var commentCall = (raw) => GH2.test(raw) && COMMENT_CALL.test(raw);
function candidate7(command) {
  const bare = command.replace(/[\\'"]/g, "");
  return command.includes("$'") || GH2.test(bare) && MAYBE_COMMENT.test(bare);
}
async function check20(raw, environment = process.env, lists = join17(coreDir(), "lists")) {
  const owners = await guardList("no-release-comment", "release-owners", isStrings, [], environment, join17(lists, "release-owners.json"));
  if (owners.refusal)
    return commentCall(subjectOf3(raw)) ? owners.refusal : undefined;
  guardedOwners = new Set((owners.list ?? []).map((owner) => owner.toLowerCase()));
  try {
    return await inspect16(raw, environment);
  } catch (error) {
    if (!commentCall(subjectOf3(raw)))
      return;
    return `no-release-comment hook could not read this call (${error}), which reads as a GitHub comment, so it refuses it. Split it into plain commands and run them again.`;
  }
}
function subjectOf3(raw) {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
    if (tool === "Bash" && typeof toolInput?.command === "string")
      return toolInput.command;
    return typeof tool === "string" ? tool : raw;
  } catch {
    return raw;
  }
}
async function inspect16(raw, environment) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return commentCall(raw) ? "no-release-comment hook could not parse its input, which reads as a GitHub comment, so it refuses the call." : undefined;
  }
  const { cwd, tool_input: toolInput, tool_name: tool } = payload;
  const input = typeof toolInput === "object" && toolInput !== null ? toolInput : undefined;
  if (tool === "Bash") {
    const command = input?.command;
    if (typeof command !== "string" || !candidate7(command))
      return;
    const directory = typeof cwd === "string" ? cwd : undefined;
    const env = {
      cwd: directory,
      files: new Map,
      known: knownVariables(command, environment, directory),
      process: environment,
      vars: new Map
    };
    return run(lex(command, env.known), env, comment);
  }
  if (typeof tool === "string" && MCP_COMMENT.test(tool))
    return mcp4(tool, input);
}
if (false) {}

// scripts/hooks/no-unslotted-run.ts
import { existsSync as existsSync9, mkdtempSync, rmdirSync as rmdirSync2, rmSync as rmSync2 } from "fs";
import { tmpdir } from "os";
import { join as join18, resolve as resolve13, sep as sep6 } from "path";
var refuse15 = (what, cd, command) => `no-unslotted-run hook refuses ${what} in a worktree outside run-slot: every heavy run goes through it (playbook's **slots**), so the machine runs a few at a time. Run it as ${cd}~/.playground/ops/run-slot.sh <your name> -- ${command}`;
var refuseDocker = (what, cd, command, fix) => fix ? `no-unslotted-run hook refuses ${what} from any folder, which run-slot refuses too: ${fix}` : `no-unslotted-run hook refuses ${what} outside run-slot, from any folder: a build fills the Docker VM the live dashboard's Postgres shares (6 Nov: a parallel compose build got it killed), so run-slot runs one docker build at a time, a compose build one service at a time. Run it as ${cd}~/.playground/ops/run-slot.sh <your name> -- ${command}`;
var COMMIT_TAKES3 = new Set([
  "--author",
  "-c",
  "-C",
  "--cleanup",
  "--date",
  "-F",
  "--file",
  "--fixup",
  "-m",
  "--message",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "-t",
  "--template",
  "--trailer"
]);
var REUSED = new Set(["-c", "-C", "--fixup", "--reedit-message", "--reuse-message", "--squash"]);
var LINT_BUDGET = 8000;
var NO_WRITE = new Set(["add", "diff", "fetch", "log", "show", "status"]);
var QUIET = new Set([":", "cd", "export", "popd", "pushd", "set", "true", "unset"]);
var mayWrite = (cmd, name, args) => cmd.redirects.some((r) => r.op.includes(">")) || name !== "cat" && !QUIET.has(name) && (name !== "git" || !NO_WRITE.has(args.find((a) => !a.value.startsWith("-"))?.value ?? ""));
async function message2(cmd, rest, env, wrote) {
  const { flags } = parseFlags(rest, COMMIT_TAKES3);
  const last = (names) => flags.findLast((f) => names.includes(f.name))?.name;
  if (["-n", "--no-verify"].includes(last(["-n", "--no-verify", "--verify"]) ?? ""))
    return;
  if (["-e", "--edit"].includes(last(["-e", "--edit", "--no-edit"]) ?? ""))
    return;
  if (flags.some((f) => REUSED.has(f.name)))
    return;
  const notes = flags.filter((f) => f.name === "-m" || f.name === "--message");
  const files = flags.filter((f) => f.name === "-F" || f.name === "--file");
  if (notes.length > 0 === files.length > 0)
    return;
  const texts = [];
  for (const { value } of [...notes, ...files.slice(-1)]) {
    if (!value)
      return;
    const literal = files.length ? value.value === "-" && !cmd.stdin && Boolean(cmd.redirects.findLast((r) => r.op.startsWith("<"))?.op.startsWith("<<")) : !value.reads?.length;
    if (wrote && !literal)
      return;
    const text = files.length ? value.value === "-" && !value.unknown ? await stdinOf(cmd, env) : await readPath(value, env) : await resolveText(value, env);
    if (unreadable(text))
      return;
    texts.push(text);
  }
  return texts.map((t) => t.value).join(`

`);
}
async function commitLint(cmd, args, env, wrote) {
  let dir = env.cwd;
  let k = 0;
  for (;k < args.length; k++) {
    const v = args[k].value;
    if (v === "-C") {
      const next = args[++k];
      dir = next ? pathOf(next, { ...env, cwd: dir }) : undefined;
    } else if (GIT_TAKES.has(v))
      k++;
    else if (!v.startsWith("-"))
      break;
  }
  if (args[k]?.value !== "commit" || !dir)
    return;
  const text = await message2(cmd, args.slice(k + 1), { ...env, cwd: dir }, wrote);
  if (text === undefined)
    return;
  const top = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stderr: "ignore"
  });
  const root = top.success ? top.stdout.toString().trim() : "";
  const lint = join18(root, "node_modules", ".bin", "commitlint");
  if (!root || !existsSync9(lint))
    return;
  const folder = mkdtempSync(join18(tmpdir(), "commit-msg-"));
  const file = join18(folder, "COMMIT_EDITMSG");
  let out = "";
  let err = "";
  let code;
  let signal;
  try {
    await Bun.write(file, text);
    const proc = Bun.spawn([process.execPath, lint, "--edit", file], {
      cwd: root,
      env: env.process,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      timeout: LINT_BUDGET
    });
    [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    signal = proc.signalCode;
  } finally {
    rmSync2(file, { force: true });
    rmdirSync2(folder);
  }
  if (code === 0 || signal)
    return;
  const problems = `${out}
${err}`.split(`
`).filter((l) => /^\s*[\u2716\u26A0]/.test(l));
  if (problems.length === 0)
    return;
  return `no-unslotted-run hook refuses this git commit: commitlint, which commit-msg runs only after pre-commit's build has waited for its slot, refuses its message:
${problems.join(`
`)}
Fix the message by the gh-commit skill's Commit step, then commit again.`;
}
var anywhere = (what, command) => `no-unslotted-run hook refuses ${what} on a line that names more folders than the hook carries, since it cannot rule out a worktree: every heavy run goes through run-slot (playbook's **slots**). Run it as ~/.playground/ops/run-slot.sh <your name> -- ${command}, or as a line of its own after a cd to a literal path.`;
var BUN_SCRIPTS2 = new Set(["build", "check-types", "test"]);
var RUNNERS6 = new Set(["bunx", "npx"]);
var TEST_TAKES = new Set([
  "--conditions",
  "--console-depth",
  "--coverage-dir",
  "--coverage-reporter",
  "--define",
  "--disable-warning",
  "--dns-result-order",
  "--drop",
  "--env-file",
  "--extension-order",
  "--feature",
  "--fetch-preconnect",
  "--import",
  "--install",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--loader",
  "--main-fields",
  "--max-concurrency",
  "--max-http-header-size",
  "--parallel-delay",
  "--path-ignore-patterns",
  "--port",
  "--preload",
  "--redirect-warnings",
  "--reporter",
  "--reporter-outfile",
  "--require",
  "--rerun-each",
  "--retry",
  "--seed",
  "--shard",
  "--test-name-pattern",
  "--timeout",
  "--timings",
  "--title",
  "--tsconfig-override",
  "--unhandled-rejections",
  "--user-agent",
  "-d",
  "-l",
  "-r",
  "-t"
]);
var TURBO_TASKS = new Set(["build", "check-types", "lint", "test"]);
var TURBO_LIGHT = /^(?:--help|-h|--version|--dry(?:-run)?(?:=.*)?)$/;
var lineWords = (values) => values.flatMap((v) => lex(v).commands.flatMap((c) => c.words.map((w) => w.value)));
var nextBuild = (values) => lineWords(values).some((v, k, all) => program(v) === "next" && all[k + 1] === "build");
var nextDir = (args, env) => {
  const dir = args.find((a) => !a.value.startsWith("-"));
  return dir ? [pathOf(dir, env)] : [];
};
function turboTask(words) {
  const values = words.map((w) => w.value);
  const beside = values[0] !== undefined && !values[0].startsWith("-") && values[0] !== "run" && !TURBO_TASKS.has(values[0]);
  if (!beside && values.some((v) => TURBO_LIGHT.test(v)))
    return;
  const tasks = (beside ? lineWords(values) : values).filter((v) => v !== "" && !v.startsWith("-"));
  return (tasks[0] === "run" ? tasks.slice(1) : tasks).find((t) => TURBO_TASKS.has(t));
}
var recursive4 = (args) => args.some((a) => /^-[a-zA-Z]*[Rra]/.test(a.value) || ["--archive", "--recursive"].includes(a.value));
function heavy2(name, args, env) {
  const compose = portlessCompose(name, args);
  if (DOCKERS.has(name) || compose) {
    const build = compose ? dockerBuild(compose, true) : dockerBuild(args, name === "docker-compose");
    return build && { anywhere: true, dir: env.cwd, fix: atOnce(build), what: buildName(build) };
  }
  if (name === "cp") {
    const paths = args.filter((a) => !a.value.startsWith("-"));
    const from = paths.slice(0, -1);
    if (recursive4(args) && from.some((a) => program(a.value.replace(/\/+$/, "")) === "node_modules"))
      return {
        dir: paths.at(-1) && pathOf(paths.at(-1), env),
        what: "a node_modules clone"
      };
    return;
  }
  if (name === "next")
    return args[0]?.value === "build" ? { also: nextDir(args.slice(1), env), dir: env.cwd, what: "next build" } : undefined;
  const turbo = turboWords(name, args, env);
  if (turbo) {
    const task = turboTask(turbo);
    return task ? {
      also: runnerFolders(name, args, env, turbo),
      dir: cwdFlag(turbo, env),
      what: `turbo run ${task}`
    } : undefined;
  }
  if (RUNNERS6.has(name)) {
    const words = args.filter((a, k) => !a.value.startsWith("-") && !RUNNER_TAKES.has(args[k - 1]?.value ?? ""));
    const values = words.map((w) => w.value);
    const base = name === "bunx" ? bunCall([X, ...args], env).chained : env.cwd;
    if (program(values[0] ?? "") === "next" && values[1] === "build")
      return {
        also: [
          ...runnerFolders(name, args, env, []) ?? [],
          ...nextDir(words.slice(2), { ...env, cwd: base })
        ],
        dir: env.cwd,
        what: `${name} next build`
      };
    if (packagedTools(args).includes("next") && nextBuild(values))
      return { also: runnerFolders(name, args, env, []), dir: env.cwd, what: `${name} next build` };
    return name === "bunx" ? heavy2("bun", [X, ...args], env) : undefined;
  }
  if (name !== "bun")
    return;
  const { at, chained, cwd, filtered, sub, words } = bunCall(args, env);
  const rest = args.slice(at + 1);
  if (words[0] === "install" || words[0] === "i") {
    if (rest.some((a) => ["--dry-run", "--help", "-h"].includes(a.value)))
      return;
    return { dir: cwdFlag(rest, { ...env, cwd }), what: "bun install" };
  }
  if (words[0] === "x" && program(words[1] ?? "") === "next" && rest[0]?.value === "build")
    return {
      also: [
        ...runnerFolders(name, args, env, []) ?? [],
        ...nextDir(rest.slice(1), { ...env, cwd: chained })
      ],
      dir: cwd,
      what: "bun x next build"
    };
  if (words[0] === "x" && packagedTools(args.slice(sub + 1)).includes("next") && nextBuild([words[1] ?? "", ...rest.map((a) => a.value)]))
    return { also: runnerFolders(name, args, env, []), dir: cwd, what: "bun x next build" };
  if (words[0] === "x" && words[1] && args[at]?.value === words[1]) {
    const ran = heavy2(toolName(words[1]), rest, {
      ...env,
      cwd: chained
    });
    if (ran) {
      return { ...ran, also: withChained(ran.also, chained), what: `bun x ${ran.what}` };
    }
  }
  const testFile = words[0] === "run" && words[1] === "test:file";
  if (words[0] === "test" || testFile) {
    if (rest.some((a) => a.value === "--help" || a.value === "-h"))
      return;
    let files = 0;
    for (let k = 0;k < rest.length; k++) {
      if (TEST_TAKES.has(rest[k].value) || rest[k].value === "--cwd")
        k++;
      else if (!rest[k].value.startsWith("-"))
        files++;
    }
    if (files > 0)
      return;
    return testFile ? { dir: cwd, what: "bun run test:file" } : { dir: cwdFlag(rest, { ...env, cwd }), what: "bun test" };
  }
  const target = words[0] === "run" ? words[1] : words[0];
  if (target && BUN_SCRIPTS2.has(target) && (words[0] === "run" || filtered || target !== "build"))
    return { dir: cwd, what: `bun ${words.join(" ")}` };
}
var shown3 = (word) => {
  const value = visible(word.value);
  return word.quoted ? `'${value.replaceAll("'", "'\\''")}'` : value;
};
var quotedDir = (dir) => /^[\w@%+=:,./~-]+$/.test(dir) ? dir : `'${dir.replaceAll("'", "'\\''")}'`;
function inspect17(raw, environment, main) {
  const { cwd, tool_input: toolInput, tool_name: tool } = JSON.parse(raw);
  if (tool !== "Bash")
    return;
  const command = toolInput?.command;
  if (typeof command !== "string")
    return;
  const worktrees = [
    join18(main, ".claude", "worktrees"),
    real(join18(main, ".claude", "worktrees"))
  ].map((w) => w + sep6);
  const inWorktree = (dir) => dir !== undefined && [resolve13(dir), real(resolve13(dir))].some((d) => worktrees.some((w) => d.startsWith(w)));
  const directory = typeof cwd === "string" ? cwd : undefined;
  let line = [];
  let wrote = false;
  let outer;
  const before = (cmd) => {
    const at = line.indexOf(line.includes(cmd) ? cmd : outer ?? cmd);
    return line.slice(0, Math.max(at, 0)).some((earlier) => {
      const { args, name } = parse(earlier);
      return mayWrite(earlier, name, args);
    });
  };
  const commits = async (cmd, { args, name }, env) => {
    const refused = name === "git" ? await commitLint(cmd, args, env, wrote || before(cmd)) : undefined;
    wrote ||= mayWrite(cmd, name, args);
    return refused;
  };
  const visit = async (cmd, parsed, env) => {
    const { args, first, name } = parsed;
    const slot = slotWords(parsed);
    outer = cmd;
    if (slot)
      return slot.length ? examine({ ...cmd, words: slot }, { ...env, files: new Map(env.files), vars: new Map(env.vars) }, commits, false) : undefined;
    const refused = await commits(cmd, parsed, env);
    if (refused)
      return refused;
    const words = () => {
      const at = first ? cmd.words.indexOf(first) : -1;
      if (at < 0)
        return;
      const assigns = cmd.words.slice(0, at).filter((w) => ASSIGN.test(w.value));
      return [
        ...assigns.length ? ["env", ...assigns.map(shown3)] : [],
        ...cmd.words.slice(at).map(shown3)
      ].join(" ");
    };
    if (env.cwdAnywhere) {
      const found = heavy2(name, args, { ...env, cwd: undefined });
      const line = words();
      if (found?.anywhere && line !== undefined)
        return refuseDocker(found.what, "", line, found.fix);
      if (found && line !== undefined && ranIn(found.dir, found.also).some((dir) => dir === undefined || inWorktree(dir)))
        return anywhere(found.what, line);
    }
    for (const here of places(env)) {
      const found = heavy2(name, args, here);
      if (!found || !(found.anywhere || unreadFolder(found.also) || ranIn(found.dir, found.also).some(inWorktree)))
        continue;
      const line = words();
      if (line === undefined)
        return;
      const moved = here.cwd !== undefined && (directory === undefined || resolve13(here.cwd) !== resolve13(directory));
      const cd = moved ? `cd ${quotedDir(here.cwd)} && ` : "";
      return found.anywhere ? refuseDocker(found.what, cd, line, found.fix) : refuse15(found.what, cd, line);
    }
  };
  const env = {
    cwd: directory,
    cwdSure: directory,
    files: new Map,
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map
  };
  const lexed = lex(command, env.known);
  line = lexed.commands;
  return run(lexed, env, visit);
}
async function check21(raw, environment = process.env, main = mainCheckout2(resolve13(__CHECKOUT + "/scripts/hooks", "..", ".."))) {
  try {
    return await inspect17(raw, environment, main);
  } catch {
    return;
  }
}
if (false) {}

// scripts/hooks/guards.ts
var GUARDS = [
  { factory: false, name: "no-desktop-owner-app", run: (raw, env) => check(raw, env) },
  { factory: true, name: "no-env-dump", run: (raw) => check2(raw) },
  {
    factory: true,
    name: "no-extension-repo-write",
    run: (raw, env) => check4(raw, env)
  },
  { factory: true, name: "no-extensions-write", run: (raw, env) => guarded(raw, env) },
  { factory: true, name: "no-false-green", run: (raw, env) => check6(raw, env.SHELL ?? "zsh") },
  { factory: true, name: "no-glm-heavy-path", run: (raw, env) => refusal(raw, env) },
  { factory: false, name: "no-headless-login", run: (raw, env) => check7(raw, env) },
  { factory: true, name: "no-kill-by-name", run: (raw) => check9(raw) },
  { factory: false, name: "no-linear-ticket", run: (raw, env) => check10(raw, env) },
  { factory: true, name: "no-mac-web-build", run: (raw, env) => check11(raw, env) },
  { factory: true, name: "no-main-checkout", run: (raw, env) => check5(raw, env) },
  { factory: false, name: "no-off-palette-label", run: (raw) => check12(raw) },
  { factory: true, name: "no-ours-merge", run: (raw, env) => check14(raw, env) },
  { factory: true, name: "no-playground-leak", run: (raw, env) => check3(raw, env) },
  { factory: true, name: "no-prompt-stop", run: (raw) => check15(raw) },
  { factory: true, name: "no-public-leak", run: (raw, env) => check16(raw, env) },
  { factory: false, name: "no-raw-delete", run: (raw, env) => check17(raw, env) },
  { factory: true, name: "no-raw-spawn", run: (raw, env) => check18(raw, env) },
  { factory: true, name: "no-raw-wa", run: (raw, env) => check19(raw, env) },
  { factory: false, name: "no-release-comment", run: (raw, env) => check20(raw, env) },
  { factory: true, name: "no-stash", run: (raw, env) => check13(raw, env) },
  { factory: true, name: "no-unslotted-run", run: (raw, env) => check21(raw, env) }
];
var threw = (name, error) => `guards hook: ${name} threw (${error instanceof Error ? error.message : String(error)}), so the call is refused until it runs; report it to your lead.`;
async function check22(raw, environment = process.env, guards = GUARDS) {
  let factory;
  const reasons = await Promise.all(guards.map(async ({ factory: gated, name, run }) => {
    try {
      if (gated && !await (factory ??= fromFactory(raw, environment)))
        return;
      return await run(raw, environment);
    } catch (error) {
      return threw(name, error);
    }
  }));
  return reasons.filter(Boolean).join(`

`) || undefined;
}
async function hook() {
  const reason = await check22(await Bun.stdin.text());
  if (!reason)
    return 0;
  console.error(reason);
  return 2;
}
if (import.meta.main)
  process.exit(await hook());
export {
  GUARDS,
  check22 as check,
  hook
};
