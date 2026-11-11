// @bun
const __CHECKOUT = import.meta.dir.slice(0, import.meta.dir.lastIndexOf("/scripts/hooks/bundled"));

// scripts/hooks/writing-first.ts
import { existsSync, readdirSync, realpathSync, unlinkSync } from "fs";
import { homedir as homedir4 } from "os";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute3, join as join4, relative, resolve as resolve3, sep } from "path";

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

// packages/safe-delete/src/index.ts
var LIMITS = { bytes: 2 * 1024 ** 3, files: 5000, perMinute: 3 };
var CARVE_OUTS = {
  "dashboard-supervisor": {
    bytes: 256 * 1024 ** 2,
    files: 4000,
    folder: "ops/dashboard/builds"
  },
  jobs: { bytes: 64 * 1024, files: 1, folder: "ops/launch-agents" }
};

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
    const name = await registryName(sessionId, environment) ?? "";
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

// packages/scripts/src/vendor-upstream/stage.ts
var licenseFor = (name, files) => (path) => files.includes(path) ? `upstream/${name}/${path}` : null;
var MATTPOCOCK_SKILLS = [
  "code-review",
  "codebase-design",
  "diagnosing-bugs",
  "domain-modeling",
  "handoff",
  "research",
  "tdd",
  "to-spec",
  "writing-for-agents"
];
var UPSTREAMS = [
  {
    coreFor: (path) => path === "graphify/skill.md" ? "skills/graphify/SKILL.md" : path.startsWith("graphify/skills/claude/references/") ? path.replace("graphify/skills/claude/", "skills/graphify/") : licenseFor("graphify", ["LICENSE", "LICENSE-MIT", "NOTICE"])(path),
    name: "graphify",
    ref: "v8",
    repo: "Graphify-Labs/graphify",
    skills: ["graphify"]
  },
  {
    coreFor: (path) => path.startsWith(".claude/skills/impeccable/") ? path.replace(".claude/", "") : licenseFor("impeccable", ["LICENSE", "NOTICE.md"])(path),
    name: "impeccable",
    ref: "main",
    repo: "pbakaus/impeccable",
    skills: ["impeccable"]
  },
  {
    coreFor: (path) => {
      const skill = /^skills\/[^/]+\/([^/]+)\//.exec(path)?.[1];
      return skill && MATTPOCOCK_SKILLS.includes(skill) ? path.replace(/^skills\/[^/]+\//, "skills/") : licenseFor("mattpocock", ["LICENSE"])(path);
    },
    name: "mattpocock",
    ref: "main",
    repo: "mattpocock/skills",
    skills: MATTPOCOCK_SKILLS
  }
];
var UPSTREAM_SKILLS = UPSTREAMS.flatMap(({ skills }) => skills).sort();

// node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/util.js
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
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
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
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
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
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
    return parse2(this, data, params, { callee: _parse });
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
    return decode(this, data, params, { callee: _decode });
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
function record(keyType, valueType, params) {
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
// packages/settings/src/rendered.ts
var CORE = "core";

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
var extLinksSchema = record(extScopeSchema, array(extLinkSchema));

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

// scripts/hooks/shell.ts
import { AsyncLocalStorage } from "async_hooks";
import { homedir as homedir3 } from "os";
import { basename, dirname, isAbsolute as isAbsolute2, resolve as resolve2 } from "path";
var UNKNOWN = "\x00";
var READ = "\x01";
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
var held2 = (text) => text.value.length > MAX_BYTES ? unknown(LARGE) : text;
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
  const parsed = parse3(cmd);
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
function decode2(raw) {
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
      if (depth === 0 && FREES.has(op))
        lx.token = freshToken();
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
  return { value: decode2(raw) };
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
function parse3(cmd) {
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
  unchain(cmd, env);
  if (cmd.opaque) {
    env.cwdAnywhere = true;
    env.cwdSure = undefined;
    env.cwdUnread = true;
  }
  const [primary, ...others] = readings(parse3(cmd));
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
    for (const parsed of readings(parse3(cmd))) {
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
    verdict = await visit(bare, parse3(bare), here);
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
  await record2(cmd, name, args, here);
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
  env.cwdChain = [];
  env.cwdChainToken = undefined;
  try {
    return await body();
  } finally {
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
  for (let dir = dirname(path);; dir = dirname(dir)) {
    tick();
    out.push(dir);
    if (dir === dirname(dir))
      return out;
  }
}
var tildeSign = (name, dir, env) => (name === "cd" || name === "pushd") && env.old && dir?.tilde && !dir.unknown && !dir.reads?.length ? dir.value[1] : undefined;
async function cdTarget(name, args, env) {
  const dir = args.find((a) => !(a.value.startsWith("-") && a.value.length > 1));
  if (!dir)
    return homedir3();
  const typed = dir.value === "-" ? undefined : await folder(pathOf(dir, env));
  const sign = typed ? undefined : tildeSign(name, dir, env);
  const base = sign && (sign === "-" ? env.old?.dir : env.cwd);
  return base ? await folder(base + dir.value.slice(2)) : typed;
}
async function folder(path) {
  if (!path)
    return;
  return await isFolder(path) ? path : undefined;
}
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
      paths.add(path);
      if (many && word.value.split("/").includes("..")) {
        for (const up of ancestors(path))
          paths.add(up);
      }
    }
  }
  return { back: dirs.length > 1, paths: [...paths], unread };
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
  if (sureToRun(cmd, parsed) && !unread && paths.length === 1 && (chained || await isFolder(paths[0]))) {
    env.cwdSure = paths[0];
    env.cwdMaybe = [];
    env.cwdUnread = false;
    if (env.old)
      env.oldFrom = bases;
    if (chained) {
      env.cwdChain = keep([...new Set([...env.cwdChain ?? [], ...from])], env);
      env.cwdChainToken = cmd.chain;
    }
    return;
  }
  env.cwdSure = undefined;
  const behind = onceOrMore(cmd, parsed) && !unread && !move.back && paths.length > 0 && (chained || (await Promise.all(paths.map(isFolder))).every(Boolean));
  env.cwdMaybe = keep([...new Set([...move.back ? back : behind ? [] : from, ...paths])], env);
  env.cwdUnread = env.cwdUnread || unread || from.length === 0 && paths.length === 0;
}
var negated = (cmd) => markers(cmd.words).filter((word) => word === "!").length % 2 === 1;
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
async function isFolder(path) {
  try {
    return (await Bun.file(path).stat()).isDirectory();
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
  return join3(await Promise.all(cmds.map((c) => outputOf(c, env))));
}
async function record2(cmd, name, args, env) {
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
  const { args, name } = parse3(cmd);
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
    return { value: printf(values.map((v) => v.value)) };
  let k = 0;
  while (k < values.length && /^-[neE]+$/.test(values[k].value))
    k++;
  return {
    value: `${values.slice(k).map((v) => decode2(v.value)).join(" ")}
`
  };
}
function printf([format = "", ...args]) {
  const conversion = /%(?:%|[-+ #0']*(?:[1-9]\d*)?(?:\.\d+)?([a-zA-Z]))/g;
  const pattern = decode2(format);
  let out = "";
  let k = 0;
  for (;; ) {
    tick();
    const before = k;
    out += pattern.replace(conversion, (_, kind) => {
      if (!kind)
        return "%";
      const value = args[k++] ?? "";
      return kind === "b" ? decode2(value) : value;
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

// scripts/hooks/steady.ts
var READ2 = /\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})(?!\[)/.source;
var TEXT = /[^"$`\\]/.source;
var WORD = new RegExp(String.raw`^(?:(?:[\w./:=@%+,~-]|${READ2})+|'[^']*'|"(?:${TEXT}|${READ2})*")`);
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
var OPENS2 = new Set(["case", "for", "if", "select", "until", "while", "{"]);
var CLOSES2 = new Set(["done", "esac", "fi", "}"]);
var LEADS = new Set(["!", "coproc", "do", "elif", "else", "then", "time"]);

// scripts/hooks/no-main-checkout.ts
var BUN_SCRIPTS = new Set(["build", "check-types", "test", "test:file"]);
var RUNNERS = new Set(["npx"]);
var TOOLS = new Set(["lefthook", "turbo"]);
var DUPLICATE = /^(?:\d+|-)$/;
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
function writeTargets(cmd, name, args) {
  const targets = [
    ...cmd.redirects.filter((r) => [">", ">>", ">|"].includes(r.op) || r.op === ">&" && !DUPLICATE.test(r.target?.value ?? "")).flatMap((r) => r.target ? [r.target] : []),
    ...writes(name, args)
  ];
  return targets.filter((t) => !["-", "/dev/null"].includes(t.value));
}
var EXPORTS2 = new Set(["declare", "export", "local", "readonly", "typeset"]);
if (false) {}

// scripts/hooks/writing-first.ts
var SKILL = "writing-for-agents";
var WRITES = new Set(["Edit", "MultiEdit", "Write"]);
var ID = /^[\w-]+$/;
var LOADS = new RegExp(`^(?:[\\w./-]+:)?${SKILL}$`);
var TYPED = new RegExp(`^\\s*/(?:[\\w./-]+:)?${SKILL}(?:\\s|$)`);
var FACTORY_MARKERS = [
  join4("extensions", "core", "skills", "playbook", "SKILL.md"),
  ...["playground", "engineering"].map((folder) => join4("skills", folder, "playground-factory", "SKILL.md"))
];
var configDir = (env) => env.CLAUDE_CONFIG_DIR || join4(env.HOME || homedir4(), ".claude");
var marks = (env) => join4(dataDirOf(env), "writing-first");
function markOf(input, env) {
  const session = typeof input.session_id === "string" ? input.session_id : "";
  const agent = typeof input.agent_id === "string" ? input.agent_id : "";
  if (!ID.test(session) || agent && !ID.test(agent))
    return;
  return join4(marks(env), agent ? `${session}.${agent}` : session);
}
function real(path) {
  let head = path;
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname2(head);
    if (parent === head)
      return path;
    tail.unshift(basename2(head));
    head = parent;
  }
  return join4(realpathSync(head), ...tail);
}
var inside = (path, dir) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute3(rel);
};
function repoOf(path) {
  for (let dir = dirname2(path);; dir = dirname2(dir)) {
    if (existsSync(join4(dir, ".git")))
      return dir;
    if (dirname2(dir) === dir)
      return;
  }
}
async function vendored(repo, name) {
  const file = Bun.file(join4(repo, "skills", "zerostarter", name, "SKILL.md"));
  if (!await file.exists())
    return false;
  const source = /^source:\s*(\S+)/m.exec(await file.text())?.[1];
  return source !== undefined && !source.startsWith("https://");
}
async function scoped(path, env) {
  const handoffs = real(join4(dataDirOf(env), "handoffs"));
  if (inside(path, handoffs))
    return true;
  const repo = repoOf(path);
  if (!repo || !FACTORY_MARKERS.some((marker) => existsSync(join4(repo, marker))))
    return false;
  const rel = relative(repo, path).split(sep).join("/");
  const upstream = /^extensions\/core\/skills\/([^/]+)\//.exec(rel)?.[1];
  if (upstream && UPSTREAM_SKILLS.includes(upstream))
    return false;
  const zerostarter = /^skills\/zerostarter\/([^/]+)\//.exec(rel)?.[1];
  if (zerostarter)
    return !await vendored(repo, zerostarter);
  return rel.startsWith("skills/") || /^extensions\/[^/]+\/(skills|rules)\//.test(rel) || rel.startsWith(".agents/dashboard/") || rel.startsWith("docs/") || /^\.agents\/[^/]+\.md$/.test(rel) || ["AGENTS.md", "CLAUDE.md", "scripts/README.md", "scripts/hooks/README.md"].includes(rel);
}
var plugins = async (env, cwd) => {
  const read = async (file) => {
    try {
      return await Bun.file(join4(configDir(env), file)).json();
    } catch {
      return;
    }
  };
  const listed = await read(join4("plugins", "installed_plugins.json"));
  const enabled = (await read("settings.json"))?.enabledPlugins;
  return Object.entries(listed?.plugins ?? {}).flatMap(([key, installs]) => (Array.isArray(installs) ? installs : []).flatMap((install) => {
    if (typeof install?.installPath !== "string")
      return [];
    const loads = install.scope === "user" ? enabled?.[key] === true : typeof install.projectPath === "string" && !!cwd && !relative(install.projectPath, cwd).startsWith("..");
    return loads ? [install.installPath] : [];
  }));
};
var installed = async (env, cwd) => [configDir(env), ...cwd ? [join4(cwd, ".claude")] : [], ...await plugins(env, cwd)].some((dir) => existsSync(join4(dir, "skills", SKILL, "SKILL.md")));
async function mark(input, env) {
  const file = markOf(input, env);
  if (file)
    await Bun.write(file, "");
}
function clear(input, env) {
  const session = typeof input.session_id === "string" ? input.session_id : "";
  if (!ID.test(session) || !existsSync(marks(env)))
    return;
  for (const name of readdirSync(marks(env)))
    if (name === session || name.startsWith(`${session}.`))
      unlinkSync(join4(marks(env), name));
}
async function refusal(input, env, target) {
  const file = markOf(input, env);
  if (!file || existsSync(file))
    return;
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  if (!await installed(env, cwd))
    return;
  const who = typeof input.agent_id === "string" && input.agent_id ? "this subagent" : "this session";
  return `writing-first hook refuses this ${String(input.tool_name)} to ${target}: it is an agent-facing doc, and ${who} has not loaded ${SKILL} since its last compaction. Call the Skill tool with skill "${SKILL}", or the scoped name your skill list shows for it (such as "ws-home:${SKILL}"), follow it, then retry this write (playbook's **writing** rule).`;
}
async function judge(input, env) {
  const target = input.tool_input?.file_path;
  if (typeof target !== "string" || !markOf(input, env))
    return;
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  if (!await scoped(real(resolve3(cwd ?? "/", target)), env))
    return;
  return refusal(input, env, target);
}
var FAMILIES2 = {
  bun: {
    code: "ep",
    takes: ["--cwd", "--env-file", "--preload", "--tsconfig-override"],
    values: "r"
  },
  deno: { code: "", takes: ["--config", "--import-map"], values: "c" },
  node: {
    code: "ep",
    takes: [
      "--conditions",
      "--env-file",
      "--import",
      "--input-type",
      "--loader",
      "--require",
      "--title"
    ],
    values: "Cr"
  },
  perl: { attached: true, code: "eE", rest: "iIlmMx0", takes: [], values: "" },
  python: {
    attached: true,
    code: "c",
    module: "m",
    takes: ["--check-hash-based-pycs"],
    values: "WX"
  },
  ruby: { attached: true, code: "e", rest: "ix0", takes: [], values: "CEIr" }
};
var FAMILY2 = /^(bun|deno|node|nodejs|perl|python|ruby)[\d.]*$/;
var PATHLIKE = /[^\s'"`()[\]{},;:=<>|&$*?!]+/g;
function inlineCode(family, args) {
  const code = [];
  let k = 0;
  for (;k < args.length; k++) {
    const v = args[k].value;
    if (v === "--")
      return { code, k: k + 1, module: false };
    if (/^--(?:eval|print)=/.test(v))
      code.push(v.slice(v.indexOf("=") + 1));
    else if (v === "--eval" || v === "--print") {
      if (args[k + 1])
        code.push(args[++k].value);
    } else if (v.startsWith("--")) {
      if (family.takes.includes(v))
        k++;
    } else if (v.startsWith("-") && v !== "-") {
      for (let c = 1;c < v.length; c++) {
        const letter = v[c];
        const attached = v.slice(c + 1);
        if (letter === family.module)
          return { code, k, module: true };
        if (family.code.includes(letter)) {
          if (attached && family.attached)
            code.push(attached);
          else if (args[k + 1])
            code.push(args[++k].value);
          break;
        }
        if (family.values.includes(letter)) {
          if (!attached)
            k++;
          break;
        }
        if (family.rest?.includes(letter))
          break;
      }
    } else
      break;
  }
  return { code, k, module: false };
}
async function inlineTargets(name, args, cmd, here) {
  const base = FAMILY2.exec(name)?.[1];
  if (!base)
    return [];
  const family = FAMILIES2[base === "nodejs" ? "node" : base];
  const evaled = base === "deno" && args[0]?.value === "eval";
  const { code, k, module } = evaled ? { code: args.slice(1, 2).map((a) => a.value), k: 2, module: false } : inlineCode(family, args);
  if (module)
    return [];
  const operand = args[k]?.value;
  if (code.length === 0) {
    if (operand !== undefined && operand !== "-")
      return [];
    const fed = await stdinOf(cmd, here);
    if (fed.unknown)
      return [];
    code.push(fed.value);
  }
  const words = [
    ...code.flatMap((text) => text.match(PATHLIKE) ?? []),
    ...args.slice(k).map((a) => a.value)
  ];
  return words.filter((w) => w.includes("/") || w.endsWith(".md"));
}
var COPY_VALUES = new Set(["-g", "-m", "-o", "-S"]);
function copiedInto(name, args) {
  if (name !== "cp" && name !== "mv" && name !== "install")
    return [];
  let folder;
  const operands = [];
  for (let k = 0;k < args.length; k++) {
    const v = args[k].value;
    if (v === "-t" || v === "--target-directory")
      folder = args[++k];
    else if (v.startsWith("--target-directory="))
      folder = { ...args[k], value: v.slice(19) };
    else if (/^-t./.test(v))
      folder = { ...args[k], value: v.slice(2) };
    else if (COPY_VALUES.has(v))
      k++;
    else if (!v.startsWith("-"))
      operands.push(args[k]);
  }
  const destination = folder ?? operands.pop();
  if (!destination)
    return [];
  return [
    ...name === "install" ? [destination] : [],
    ...operands.map((source) => ({
      ...destination,
      value: join4(destination.value, basename2(source.value))
    }))
  ];
}
async function bashTarget(input, env) {
  const command = input.tool_input?.command;
  if (typeof command !== "string")
    return;
  const directory = typeof input.cwd === "string" ? input.cwd : undefined;
  const home = env.HOME || homedir4();
  const known = knownVariables(command, env, directory);
  const visit = async (cmd, parsed, at) => {
    const { args, name } = parsed;
    for (const here of places(at, directory)) {
      const named = writeTargets(cmd, name, args);
      named.push(...copiedInto(name, args));
      for (const word of named) {
        const path = pathOf(word, here);
        if (path && await scoped(real(path), env))
          return word.value;
      }
      if (!here.cwd)
        continue;
      for (const word of await inlineTargets(name, args, cmd, here)) {
        const path = resolve3(here.cwd, word.replace(/^~(?=\/)/, home));
        if (await scoped(real(path), env))
          return word;
      }
    }
  };
  const at = {
    cwd: directory,
    cwdSure: directory,
    files: new Map,
    known,
    old: { dir: directory },
    process: env,
    vars: new Map
  };
  return run(lex(command, known), at, visit, true);
}
async function check(raw, env = process.env) {
  try {
    const input = JSON.parse(raw);
    if (typeof input !== "object" || input === null)
      return;
    const event = input.hook_event_name;
    if (event === "PreToolUse" && input.tool_name === "Skill") {
      const skill = input.tool_input?.skill;
      if (typeof skill === "string" && LOADS.test(skill))
        await mark(input, env);
      return;
    }
    if (event === "UserPromptSubmit") {
      if (typeof input.prompt === "string" && TYPED.test(input.prompt))
        await mark(input, env);
      return;
    }
    if (event === "SessionStart") {
      if (input.source === "compact")
        clear(input, env);
      return;
    }
    if (event === "PreToolUse" && WRITES.has(String(input.tool_name)))
      return await judge(input, env);
    if (event === "PreToolUse" && input.tool_name === "Bash") {
      const file = markOf(input, env);
      if (!file || existsSync(file))
        return;
      const target = await withDeadline(8000, () => bashTarget(input, env));
      return target === undefined ? undefined : await refusal(input, env, target);
    }
  } catch {
    return;
  }
}
if (import.meta.main) {
  const raw = await Bun.stdin.text();
  const reason = await fromFactory(raw) ? await check(raw) : undefined;
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}
export {
  SKILL,
  check
};
