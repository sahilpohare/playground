// @bun
const __CHECKOUT = import.meta.dir.slice(0, import.meta.dir.lastIndexOf("/scripts/hooks/bundled"));

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

// scripts/hooks/no-bare-slack-link.ts
var TOOL = /^mcp__(.+?)__(chat_post_message|chat_update)$/;
var URL_IN_TEXT = /https?:\/\/[^\s<>|`]+/gi;
var clean = (url) => url.replace(/&amp;/g, "&").replace(/[.,;:!?)\]}'"*_~]+$/, "");
var key = (url) => clean(url).replace(/\/+$/, "").replace(/^[a-z]+:\/\/[^/?#]*/i, (origin) => origin.toLowerCase());
var parsed = (value) => typeof value === "string" ? JSON.parse(value) : value;
var schemeless = (url) => url.replace(/^https?:\/\//i, "");
function links(node) {
  if (Array.isArray(node))
    return node.flatMap(links);
  if (typeof node !== "object" || node === null)
    return [];
  const { text, truncated, type, url } = node;
  const own = type === "link" && typeof url === "string" ? [
    {
      chipped: typeof text === "string" && truncated === true && key(`https://${text}`) === key(`https://${schemeless(url)}`),
      url
    }
  ] : [];
  return [...own, ...Object.values(node).flatMap(links)];
}
function texts(node, shown) {
  if (Array.isArray(node))
    return node.flatMap((n) => texts(n, shown));
  if (typeof node !== "object" || node === null || node.type === "link")
    return [];
  return Object.entries(node).flatMap(([name, value]) => typeof value === "string" ? shown(name) ? [value] : [] : texts(value, shown));
}
var blockShows = (name) => name === "text";
var attachmentShows = (name) => !/(?:link|url|icon)$/i.test(name);
var chip = (url) => JSON.stringify({ type: "link", url, text: schemeless(url), truncated: true });
function inspect(raw) {
  const { tool_input: input, tool_name: tool } = JSON.parse(raw);
  const [, server = "", name = ""] = TOOL.exec(String(tool)) ?? [];
  if (!/slack/i.test(server) || typeof input !== "object" || input === null)
    return;
  const blocks = parsed(input.blocks);
  const words = [
    input.text,
    input.markdown_text,
    ...texts(blocks, blockShows),
    ...texts(parsed(input.attachments), attachmentShows)
  ];
  const elements = links(blocks);
  const chips = new Set(elements.filter((e) => e.chipped).map((e) => key(e.url)));
  const found = [
    ...words.flatMap((w) => typeof w === "string" ? w.match(URL_IN_TEXT) ?? [] : []),
    ...elements.filter((e) => !e.chipped && /^https?:\/\//i.test(e.url)).map((e) => e.url)
  ];
  const loose = [...new Set(found.map(clean))].filter((u) => !chips.has(key(u)));
  if (!loose.length)
    return;
  const markdown = typeof input.markdown_text === "string" ? " Put the words in text, not markdown_text, which Slack does not take beside blocks." : "";
  return `no-bare-slack-link hook refused ${name}: it holds ${loose.join(", ")} with no link chip in blocks, so each shows as a raw URL. Send each as a link chip, a rich_text block whose rich_text_section holds one link element per line, with its text and truncated exactly as shown (${loose.map(chip).join(", ")}), a {"type":"text","text":"\\n"} between them and any tag on the line after, and keep text as the plain fallback with the bare URLs, then run it again.${markdown}`;
}
function check(raw) {
  try {
    return inspect(raw);
  } catch {
    return;
  }
}
if (import.meta.main) {
  const raw = await Bun.stdin.text();
  const reason = await fromFactory(raw) ? check(raw) : undefined;
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}
export {
  check
};
