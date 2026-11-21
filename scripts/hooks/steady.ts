// The steady variables of a line, the one way a writer or a cd holds a variable's value: each named once, by a plain assignment the hook reads whole at the line's top level, so a later word that reads it can be lexed again with its value
import {
  ASSIGN,
  type Command,
  type Env,
  lex,
  marked,
  NAME_SETTERS,
  parse,
  type Parsed,
  PRINTS,
  RUNS_TEXT,
  type Word,
} from "./shell"

// the line's text as a shell it runs reads it: backslash-newlines, a $ before a quote, and every quote and backslash removed
export const unquoted = (text: string) => text.replace(/\\\n|\$(?=["'])|["'\\]/g, "")

type Namings = { blind: boolean; counts: Map<string, number>; plain: Set<string> }

// The operators after ${K that only read K; any other (`=`, `:=`, zsh's `::=`, a subscript, a modifier) may set it, so it counts as a naming
const READS_ONLY = /^(?:\}|:?[-+?]|[#%/])/

// Text the shell evaluates, where an assignment sets a name the hook never reads: arithmetic naming a variable, whose value it evaluates as an expression (`V=XY=0; (( V ))` sets XY), in `(( ))`, `$(( ))`, `$[ ]`, a `[[ ]]` comparison or a substring offset; and bash's prompt transformation (`${V@P}`)
const EVALUATES = [
  /\(\([^)]*[A-Za-z_]/,
  /\$\[[^\]]*[A-Za-z_]/,
  /\[\[[\s\S]*\s-(?:eq|ge|gt|le|lt|ne)\s/,
  /\$\{[#!]?\w+:(?![-+=?:])[^}]*[A-Za-z_]/,
  /@P\}/,
]

// A subscript, which both shells evaluate as arithmetic naming a variable, but an empty one, `@`, `*`, digits with only `-`, `:`, `,` and spaces among them, or one that starts with `^`, where both shells stop on a math error before reading a name (`a[]`, `a[@]`, `a[-1]`, `a[0:9]`, `a[1,5]`, `a[^;]`); read on the line with its single-quoted spans put as one letter, as written and with its quotes and backslashes removed, since the shell removes a quote or a backslash between a name and its `[` (`${a[V]}`, zsh's `$a[V]`, `a[V]=`); a quoted name a setter or a test reads (`read 'a[V]'`, `printf -v 'a[V]'`, `[[ -v 'a[V]' ]]`) is steadyNames' own word-by-word check
const SUBSCRIPT = /\w\[(?!(?:[@*]|[-\d:,\s]*)\]|\^)/

// bash's indirection, `${!…}` through any parameter, a positional or special one included, which assigns (`${!N:=…}`) or evaluates any subscript the parameter's value holds; only the name list and an array's keys closed right after (`${!N*}`, `${!N[@]}`) and `${!}`, the last background job's pid, are no indirection
const INDIRECTS = /\$\{!(?!\}|[A-Za-z_]\w*(?:[*@]|\[[*@]\])\})/

// zsh's glob qualifiers that run code, an e with its code up to its separator's match (`[`, `{` and `<` pair with their closers, any other character with itself) or a `+` with a function's name, closed at a word's end (`*(e:…:)`, `*(.e{…})`, `*(+f)`); read on singleQuotesOut's text, since a qualifier acts only on unquoted text
export const QUALIFIER =
  /[^\s(|&;<>$=]\((?:#q)?[^()\s|]*?(?:e(?:\[[^]*?\]|\{[^]*?\}|<[^]*?>|([^\s[{<])[^]*?\1)|\+\w+)[^()\s]*\)(?=$|[\s;&|)<>`}])/

// The line with each single-quoted span outside double quotes, comments, backslash escapes and heredoc bodies put as one letter, so a jq filter's `select(…)` reads as no qualifier while `'f1'(e:…:)` still does; a heredoc's body is kept as written, and the line as written when a quote or a heredoc is left open or the line holds `$'…'`, whose quoting this scan does not read
export function singleQuotesOut(command: string): string {
  if (command.includes("$'")) return command
  let out = ""
  let double = false
  const docs: { delim: string; strip: boolean }[] = []
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "\\") {
      out += command.slice(i, i + 2)
      i++
    } else if (double) {
      if (c === '"') double = false
      out += c
    } else if (c === '"') {
      double = true
      out += c
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i)
      const stop = end === -1 ? command.length : end
      out += command.slice(i, stop)
      i = stop - 1
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return command
      out += "x"
      i = end
    } else if (command.startsWith("<<<", i)) {
      out += "<<<"
      i += 2
    } else if (command.startsWith("<<", i)) {
      const doc = command.slice(i).match(/^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w.-]+))/)
      if (!doc) return command
      docs.push({ delim: doc[2] ?? doc[3] ?? doc[4], strip: doc[1] === "-" })
      out += doc[0]
      i += doc[0].length - 1
    } else if (c === "\n" && docs.length) {
      out += c
      let at = i + 1
      for (const { delim, strip } of docs) {
        for (;;) {
          if (at > command.length) return command
          const end = command.indexOf("\n", at)
          const stop = end === -1 ? command.length : end
          const line = command.slice(at, stop)
          out += command.slice(at, Math.min(stop + 1, command.length))
          at = stop + 1
          if ((strip ? line.replace(/^\t+/, "") : line) === delim) break
          if (end === -1) return command
        }
      }
      docs.length = 0
      i = at - 1
    } else out += c
  }
  return double || docs.length ? command : out
}

// a plain read of a variable: `$name` or `${name}`, never one zsh subscripts with a `[` after it
const READ = /\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})(?!\[)/.source
// a character double quotes hold as text
const TEXT = /[^"$`\\]/.source
// a part of a plain word: word characters and reads, a single quote, or a double quote holding nothing but text and reads
const WORD = new RegExp(String.raw`^(?:(?:[\w./:=@%+,~-]|${READ})+|'[^']*'|"(?:${TEXT}|${READ})*")`)
// a redirection whose target is the next word, or one that carries its own (`2>&1`, `>&-`)
const REDIRECT = /^(?:[<>]&(?:\d+|-)|<<<|&>>?|>>?\|?|<>?)/
// the reserved words and precommand modifiers after which the next word is still a program word
const KEEPS_PROGRAM =
  /^(?:-|builtin|command|do|elif|else|exec|if|nocorrect|noglob|then|time|until|while)$/
// the prompt parameters zsh expands (under promptsubst for the PS/RPROMPT family), so a line that sets one, by assignment or as a `read` or `print -v` target, can run a captured body's text as a prompt, as `print -P` runs its argument; the name is matched as a bare word, so a mere mention reads the line whole too
const PROMPT_PARAM = /^(?:PS[0-4]|PROMPT[2-4]?|RPROMPT2?|RPS[12]|SPROMPT)(?!\w)/
// a heredoc operator whose delimiter is quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`), its word ending where a word does
const QUOTED_DOC =
  /^<<(-?)[ \t]*((?:[\w.-]*(?:'[^'\n]*'|"[^"\n$`\\]*"|\\[\w.-])[\w.-]*)+)(?=[\s;&|<>]|$)/

// The line with each body of a heredoc whose delimiter is quoted put as an empty line, since the shell expands nothing in it, so its text reads as no evaluation, subscript or qualifier; only a line whose text outside the bodies is blanks, WORD's parts, `;`, `&&`, `||`, `|`, REDIRECT's and QUOTED_DOC's is scanned, so the bodies start and end where the shell's do, and any other line, one whose step's program word holds a read among them, comes back as written
export function quotedBodiesOut(command: string): string {
  let out = ""
  const docs: { delim: string; strip: boolean }[] = []
  // the next word is a step's program word, unless it is an assignment or a redirection's target
  let program = true
  let target = false
  let word = ""
  const endWord = () => {
    if (word && target) target = false
    else if (word && !/^[A-Za-z_]\w*=/.test(word) && !KEEPS_PROGRAM.test(word)) program = false
    word = ""
  }
  for (let i = 0; i < command.length;) {
    const rest = command.slice(i)
    let token: string | undefined
    let doc: RegExpMatchArray | null = null
    if (rest[0] === "\n") {
      endWord()
      out += "\n"
      i++
      for (const { delim, strip } of docs)
        for (;;) {
          if (i >= command.length) return command
          const end = command.indexOf("\n", i)
          const stop = end === -1 ? command.length : end
          const line = command.slice(i, stop)
          const last = (strip ? line.replace(/^\t+/, "") : line) === delim
          out += (last ? line : "") + (end === -1 ? "" : "\n")
          i = stop + 1
          if (last) break
        }
      docs.length = 0
      program = true
      continue
    } else if ((token = rest.match(/^[ \t]+/)?.[0])) endWord()
    else if ((token = rest.match(/^(?:&&|\|\||[;|])/)?.[0])) {
      endWord()
      program = true
    } else if (rest.startsWith("<<") && !rest.startsWith("<<<")) {
      doc = rest.match(QUOTED_DOC)
      if (!doc) return command
      if (/^\d+$/.test(word)) word = ""
      endWord()
      token = doc[0]
      docs.push({
        delim: doc[2].replace(/\\(.)/g, "$1").replace(/["']/g, ""),
        strip: doc[1] === "-",
      })
    } else if ((token = rest.match(REDIRECT)?.[0])) {
      // a file descriptor's number belongs to the redirection it leads
      if (/^\d+$/.test(word)) word = ""
      endWord()
      target = !/&(?:\d+|-)$/.test(token)
    } else if ((token = rest.match(WORD)?.[0])) {
      word += token
      // a read as a step's program word runs a command the scan cannot name
      if (program && !target && token.includes("$") && !/^[A-Za-z_]\w*=/.test(word)) return command
      // a prompt parameter set on the line can expand a captured body's text as a prompt, running it
      if (PROMPT_PARAM.test(word)) return command
    }
    // a quote that spans a newline while a body is pending moves where the shell starts reading it
    if (!token || (docs.length && token.includes("\n"))) return command
    out += token
    i += token.length
  }
  return docs.length ? command : out
}

// How many times the line names each variable other than by reading it ($K, ${K}, ${K:-…} and the other READS_ONLY forms): every other spelling of the name counts, an assignment, an append, a bare word (read's, a for loop's, arithmetic's) and a name spelled across a quote or a backslash (`X\Y`, `X"Y"`, which the shell reads as XY) included, as does one attached after an option cluster's a or v (`printf -vK`), a lone flag (`-K`) aside; and the names an unquoted plain assignment sets (`K=`, where a quoted `"K=a"` is a command), read in one pass
export function namings(command: string): Namings {
  const counts = new Map<string, number>()
  const plain = new Set<string>()
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  // a name indirection sets or evaluates a variable whose name the hook cannot read: an assignment sets it, and a read evaluates any subscript the name's value holds (`N=a; N+=[V]; : ${!N}`), so zsh's P flag holds nothing, nor does a flag with a delimited argument (`${(j:…:)…}`), since its argument can hide a `)` and a P, nor do the e, % and # flags, which evaluate a value as shell text, a prompt or arithmetic
  const text = quotedBodiesOut(command)
  // a single-quoted span is text no command evaluates, but a setter's or a test's name, which steadyNames reads word by word
  const singleQuotedOut = singleQuotesOut(text)
  let blind =
    EVALUATES.some((evaluates) => evaluates.test(text)) ||
    SUBSCRIPT.test(singleQuotedOut) ||
    SUBSCRIPT.test(unquoted(singleQuotedOut)) ||
    QUALIFIER.test(singleQuotedOut) ||
    INDIRECTS.test(text)
  for (const [, flags, closed] of text.matchAll(/\$\{\(([^)]*)(\)?)/g))
    if (!closed || !/^[\w@~^=!*-]*$/.test(flags) || /[eP]/.test(flags)) blind = true
  for (const m of command.matchAll(/(\$\{[#!]?)?(?<![\w$])([A-Za-z_]\w*)/g)) {
    const [whole, expanded, key] = m
    const next = command.slice(m.index + whole.length)
    if (expanded && READS_ONLY.test(next)) continue
    const assigns = next[0] === "=" ? "=" : undefined
    const at = m.index + (expanded?.length ?? 0)
    if (!expanded && command[at - 1] === "-" && (at < 2 || /\s/.test(command[at - 2]))) {
      for (let k = 0; k < key.length - 1; k++)
        if (key[k] === "a" || key[k] === "v") add(key.slice(k + 1))
      continue
    }
    add(key)
    if (!expanded && assigns === "=" && (at === 0 || /[\s;&|(]/.test(command[at - 1])))
      plain.add(key)
  }
  const from: number[] = []
  let joined = ""
  for (let i = 0; i < command.length; i++)
    if (!"\\'\"".includes(command[i])) {
      from.push(i)
      joined += command[i]
    }
  for (const m of joined.matchAll(/(?<![\w$])[A-Za-z_]\w*/g)) {
    const end = m.index + m[0].length - 1
    if (from[end] - from[m.index] !== end - m.index) add(m[0])
  }
  return { blind, counts, plain }
}

// The parameters the shell sets itself, whose value a later word reads is the shell's and not an assignment's: bash 5.3's bash(1), PARAMETERS, Shell Variables ("The shell sets following variables"); zsh 5.9's zshparam(1), PARAMETERS SET BY THE SHELL, and each module's Parameters in its zshmodules(1), zsh/zftp's ZFTP_ family by prefix; and the names a builtin or a match writes with no name among its words (read's and select's REPLY and reply, `=~`'s and the glob flags' MATCH, MBEGIN, MEND, match, mbegin and mend, pcre_match's ZPCRE_OP, and bash's COLUMNS and LINES under checkwinsize)
const SHELL_SETS = new Set([
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
  "zgdbm_tied",
])
// the families of those the manuals list by prefix (BASH_ARGV, COMP_WORDS, READLINE_LINE, ZSH_SUBSHELL, zsh_eval_context)
const SHELL_SETS_PREFIX = /^(?:BASH_|COMP_|READLINE_|ZFTP_|ZSH_|zsh_)/
// zsh's tied parameters, where a write to either side rewrites the other: each array and its colon-joined scalar, and the aliases, from zsh 5.9's zshparam(1), PARAMETERS USED BY THE SHELL, and zsh/watch's watch and WATCH in zshmodules(1)
const TIED = new Set([
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
  "watch",
])

// The allow-list, the one way a writer or a cd holds a variable's value: a name the shell neither sets itself nor ties to another, which a plain NAME=value the hook reads whole names once on a line that names no IFS (the rest of steadyNames places that assignment)
function holdable(key: string, named: Namings, counts: Map<string, number>): boolean {
  return (
    counts.get(key) === 1 &&
    named.plain.has(key) &&
    !SHELL_SETS.has(key) &&
    !SHELL_SETS_PREFIX.test(key) &&
    !TIED.has(key)
  )
}

// has: whether the call holds a steady value for a key; exported: the same for a key a bare `export K=value` sets, which a redirect alone reads; loop: the literal words a for loop around the command gives a key that nothing else on the line names; past: a key a cd's && chain sets to a literal, held past that chain where the session's environment does not set it (steadyNames' past)
export type Steady = {
  exported?: (key: string) => boolean
  has: (key: string) => boolean
  loop?: (key: string) => string[] | undefined
  past?: (key: string) => boolean
}
export const NONE: Steady = { has: () => false }

// zsh's builtins that make a name integer or float, so every later assignment to it is an arithmetic evaluation, as let's words are
const NUMERIC = new Set(["float", "integer"])
// the builtins that give a name an attribute: n makes a bash nameref, a name whose every later write sets the variable its value names, and i (zsh's E and F too) makes every later assignment to it an arithmetic evaluation
const TYPESETS = new Set(["declare", "export", "local", "readonly", "typeset"])
// the tests whose -v reads its operand as a name, evaluating any subscript it holds; test and [ take their operators after expansion, so a word that expands may be a -v or split into one and its operand, while [[ reads its operators as written
const TESTS = new Set(["[", "[[", "test"])
// the -v operand that names no subscript: a plain unquoted name, as written
const PLAIN_NAME = /^[A-Za-z_]\w*$/
// a word written with any expansion but a plain `$name` or `${name}`: a command substitution, a backtick, a process substitution, arithmetic, an ANSI-C string, a positional or special parameter, a parameter with an operator
const EXPANDS = /\$(?![A-Za-z_]\w*|\{[A-Za-z_]\w*\})|`|[<>]\(/
// the operators of test and [ that take a value after them, so a quoted word ahead of one, or of the closing ], is an operand
const BINARY = new Set([
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
  ">",
])
const testsAName = (args: Parsed["args"], expands: boolean): boolean =>
  args.some((w, k) => {
    const next = args[k + 1]
    if (w.value === "-v") return next !== undefined && !PLAIN_NAME.test(next.source ?? "")
    if (!expands) return false
    if (EXPANDS.test(w.source ?? "$")) return true
    if (!marked(w.value)) return false
    return !w.quoted || (next !== undefined && next.value !== "]" && !BINARY.has(next.value))
  })
// the words that open and close a compound body or group, and the other reserved words a command may lead with
const OPENS = new Set(["case", "for", "if", "select", "until", "while", "{"])
const CLOSES = new Set(["done", "esac", "fi", "}"])
const LEADS = new Set(["!", "coproc", "do", "elif", "else", "then", "time"])

// Each name the line names but by reading it, with a setter's name words counted again, or undefined when no variable holds steady on it: a line that runs text or loads code in its own shell (a RUNS_TEXT builtin, or a command whose name the hook cannot read, which may be any of them or a builtin that sets a variable), sets a variable by a name the hook cannot read whole (a name-indirection assignment, a bash nameref, an integer attribute or text the shell evaluates among them), or names IFS
function setterCounts(
  named: Namings,
  commands: Command[],
  parses: Parsed[],
): Map<string, number> | undefined {
  if (named.blind || named.counts.has("IFS")) return undefined
  const counts = new Map(named.counts)
  for (const [at, cmd] of commands.entries()) {
    const { name } = parses[at]
    if (RUNS_TEXT.has(name) || marked(name)) return undefined
    const flagged = (letters: RegExp) =>
      cmd.words.some((w, k) => k > 0 && /^-[^-\s]/.test(w.value) && letters.test(w.value))
    if (NUMERIC.has(name) || (TYPESETS.has(name) && flagged(/[EFin]/))) return undefined
    // let evaluates each word as arithmetic, which evaluates a variable's value as an expression
    if (name === "let" && cmd.words.some((w, k) => k > 0 && /[A-Za-z_]/.test(w.value)))
      return undefined
    // zsh's print -P expands its words as a prompt, which with PROMPT_SUBST set runs their expansions
    if (name === "print" && flagged(/P/)) return undefined
    // a -v operand holds only as a PLAIN_NAME, since any other may name a subscript, and in test and [ a word that EXPANDS holds nothing, nor does a plain `$name` the hook cannot read but as a quoted operand
    if (TESTS.has(name) && testsAName(parses[at].args, name !== "[[")) return undefined
    const loop = cmd.words.findIndex(
      (w) => !w.quoted && (w.value === "for" || w.value === "select"),
    )
    if (!NAME_SETTERS.has(name) && loop === -1) continue
    if (bareExport(parses[at])) continue
    // print and printf name one only by a v in an option cluster (`-v N`, `-vN`, `-rv N`), the last one given winning: every cluster's rest and the word after it count, since any may be the name
    const vNames = cmd.words.flatMap((w, k) =>
      k > 0 && /^-[^-\s]*v/.test(w.value)
        ? [{ ...w, value: w.value.slice(w.value.indexOf("v") + 1) }, cmd.words[k + 1]]
        : [],
    )
    const names = loop !== -1 ? [cmd.words[loop + 1]] : PRINTS.has(name) ? vNames : cmd.words
    // a name the shell reads after quote removal (`read X\Y` sets XY) counts as written, and one the hook cannot read could be any; a name word with a quote or a backslash and a `[` reads as subscripted whatever the subscript, so no quoted or escaped subscript in a setter's name passes
    for (const word of names) {
      if (!word) continue
      if (marked(word.value.split("=")[0])) return undefined
      if (word.quoted && word.value.includes("[")) return undefined
      for (const key of word.value.match(/[A-Za-z_]\w*/g) ?? [])
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

// For each command of the line, the variables whose value the shell has when it runs: each named once, by an unquoted plain assignment that is its command's first word, at the line's top level (outside any function, compound body, group or subshell) and not piped or sent to the background; one the shell always runs (first, or after `;` or `&`) holds for every later command, and one after `&&` only along that `&&` chain, since the shell skips the rest of the chain with it. A line that runs text or loads code in its own shell (a RUNS_TEXT builtin, or a command whose name the hook cannot read, which may be any of them or a builtin that sets a variable), sets a variable by a name the hook cannot read whole (a name-indirection assignment, a bash nameref, an integer attribute or text the shell evaluates among them), or names IFS, holds none, and holdable() is the rest of the allow-list
// With past, an assignment of one absolute literal word (LITERAL) on an `&&` chain whose every command before it is a cd or a pushd is held past that chain too, as a writer's file alone (a hook holds a folder with past left out): when the cd fails the shell skips it, and the name, set nowhere else on the line, is then empty or the session's own, which the hook's process holds
export function steadyNames(
  named: Namings,
  commands: Command[],
  past = false,
): (cmd: Command) => Steady {
  const parses = commands.map((cmd) => parse(cmd))
  const counts = setterCounts(named, commands, parses)
  if (!counts) return () => NONE
  const set = new Map<string, { at: number; chain?: number }>()
  const pasts = new Map<string, number>()
  // whether every command of the current && chain so far is a cd or a pushd at the top level, or an assignment after one
  let moves = false
  const exports = new Map<string, { at: number; chain?: number }>()
  const where = new Map<Command, { at: number; chain: number }>()
  // the for loops whose body the walk is in, each with the depth its body sits at, and the loop values each body command takes
  const open: { depth: number; key: string; values: string[] }[] = []
  const loops = new Map<Command, Map<string, string[]>>()
  let chain = 0
  let depth = 0
  for (const [at, cmd] of commands.entries()) {
    if (cmd.follows !== "&&") chain++
    where.set(cmd, { at, chain })
    const top = depth === 0 && cmd.scope === 0
    for (let k = 0; k < cmd.words.length; k++) {
      const { quoted, value } = cmd.words[k]
      if (quoted) break
      if (value === "function") k++
      else if (OPENS.has(value)) depth++
      else if (CLOSES.has(value)) depth--
      else if (!LEADS.has(value)) break
    }
    if (depth < 0) return () => NONE
    while (open.length > 0 && depth < open.at(-1)!.depth) open.pop()
    if (open.length > 0) loops.set(cmd, new Map(open.map((o) => [o.key, o.values])))
    const head = forList(cmd, named)
    if (head) open.push({ depth, ...head })
    const always = !cmd.follows || cmd.follows === ";" || cmd.follows === "&"
    const moved: boolean = moves && cmd.follows === "&&"
    const isMove = top && !cmd.detached && ["cd", "pushd"].includes(parses[at].name)
    moves = (always || moved) && (isMove || (moved && parses[at].name === ""))
    if (!top || cmd.detached || (!always && cmd.follows !== "&&")) continue
    if (bareExport(parses[at])) {
      for (const w of parses[at].args) {
        const key = w.value.slice(0, w.value.indexOf("="))
        if (holdable(key, named, counts)) exports.set(key, always ? { at } : { at, chain })
      }
      continue
    }
    const [first] = cmd.words
    // an array assignment (`a=(…)`) makes several words of its name, never one value
    if (!first || !ASSIGN.test(first.value) || parses[at].name !== "") continue
    if (/^[A-Za-z_]\w*\+?=\(/.test(first.value)) continue
    for (const key of parses[at].local.keys())
      if (holdable(key, named, counts)) set.set(key, always ? { at } : { at, chain })
    const literal = first.source?.slice(first.source.indexOf("=") + 1) ?? ""
    if (
      past &&
      moved &&
      cmd.words.length === 1 &&
      LITERAL.test(literal) &&
      /^["']?\//.test(literal)
    )
      for (const key of parses[at].local.keys())
        if (holdable(key, named, counts)) pasts.set(key, at)
  }
  return (cmd) => {
    const here = where.get(cmd)
    if (!here) return NONE
    const before = (from?: { at: number; chain?: number }) =>
      !!from && from.at < here.at && (from.chain === undefined || from.chain === here.chain)
    return {
      exported: (key) => before(exports.get(key)),
      has: (key) => before(set.get(key)),
      loop: (key) => loops.get(cmd)?.get(key),
      past: (key) => (pasts.get(key) ?? here.at) < here.at,
    }
  }
}

// The variables of the session's starting environment, the hook's own, that hold their value for every command of a line, beside known (the line's HOME, TMPDIR and PWD), so a cd or a -C through one (`cd "${PLAYGROUND_REPO:?}"`, `git -C "$W"`) is judged by the folder it names: an uppercase name (zsh keeps its lowercase parameters apart from the environment) that the line names nowhere but by reading it, on a line setterCounts holds something on, and none the shell sets or ties to another, nor IFS or ZDOTDIR, which the shell takes from no environment as is, nor one led by CLAUDE (CLAUDECODE, CLAUDE_*), some of which Claude Code sets in a hook's environment alone (CLAUDE_PROJECT_DIR)
export function startingVariables(
  command: string,
  environment: Record<string, string | undefined>,
  known: Record<string, string>,
): Record<string, string> {
  const commands = lex(command, known).commands
  const counts = setterCounts(
    namings(command),
    commands,
    commands.map((cmd) => parse(cmd)),
  )
  const starting: Record<string, string> = {}
  if (!counts) return starting
  for (const [key, value] of Object.entries(environment)) {
    if (!value || key in known || !/^[A-Z_][A-Z0-9_]*$/.test(key) || counts.has(key)) continue
    if (SHELL_SETS.has(key) || SHELL_SETS_PREFIX.test(key) || TIED.has(key)) continue
    if (key === "IFS" || key === "ZDOTDIR" || key.startsWith("CLAUDE")) continue
    starting[key] = value
  }
  return starting
}

// One literal word as an assignment writes its value: plain characters, or a quoted span holding no expansion, with no glob, ~ or blank; past holds an absolute one alone, since a relative one names a file in each folder the shell may be in, the starting one too
const LITERAL = /^(?:[\w./:@%+,-]|'[^'\s]*'|"[^"$`\\\s]*")+$/

// An export with no option whose every word is a plain unquoted NAME=value, so each name it sets is counted once, by its own spelling
const bareExport = ({ args, name }: Parsed): boolean =>
  name === "export" &&
  args.length > 0 &&
  args.every(
    (w) =>
      !w.quoted && ASSIGN.test(w.value) && PLAIN_NAME.test(w.value.slice(0, w.value.indexOf("="))),
  )

// A for loop's variable and the words of its list, when each is a literal with no glob and nothing else on the line names the variable, so in the loop's body it holds one of them: `for id in 1 2; do`, never zsh's `for id (1 2)`, a list that expands, or a select, whose value is typed
function forList(cmd: Command, named: Namings): { key: string; values: string[] } | undefined {
  // the command's leading reserved word, after any LEADS word or `{`, the same `for` the depth walk counts
  const at = cmd.words.findIndex((w) => w.quoted || !(LEADS.has(w.value) || w.value === "{"))
  if (at === -1 || cmd.words[at].quoted || cmd.words[at].value !== "for") return undefined
  const [key, word, ...values] = cmd.words.slice(at + 1)
  if (!key || key.quoted || !PLAIN_NAME.test(key.value) || named.counts.get(key.value) !== 1)
    return undefined
  if (!word || word.quoted || word.value !== "in" || values.length === 0) return undefined
  if (values.some((w) => marked(w.value) || /[*?[\]{}]/.test(w.value))) return undefined
  return { key: key.value, values: values.map((w) => w.value) }
}

// Every reading of a word over the values the for loops around it give its variables, the steady ones held too; undefined when one still holds a value the hook cannot read, or the readings pass LOOP_READINGS
export function heldReadings(word: Word, env: Env, steady: Steady): Word[] | undefined {
  if (!word.raw || !marked(word.value)) return undefined
  const known = heldVars(
    env,
    { has: (key) => steady.has(key) || !!steady.exported?.(key), past: steady.past },
    word.raw,
  )
  let sets: Record<string, string>[] = [known]
  for (const key of new Set(word.raw.match(/[A-Za-z_]\w*/g) ?? [])) {
    const values = steady.loop?.(key)
    if (!values) continue
    sets = sets.flatMap((s) => values.map((v) => ({ ...s, [key]: v })))
    if (sets.length > LOOP_READINGS) return undefined
  }
  const words = sets.map((s) => relexed(word.raw!, s))
  return words.every(Boolean) ? (words as Word[]) : undefined
}
const LOOP_READINGS = 64

// A word with a value the lexer could not read, lexed again with the steady variables the call has set by now; undefined when it holds none, or still holds one the hook cannot read
export function heldWord(word: Word, env: Env, steady: Steady): Word | undefined {
  return word.raw && marked(word.value)
    ? relexed(word.raw, heldVars(env, steady, word.raw))
    : undefined
}

// A raw word lexed with known variables: the one word it makes, or undefined when it still holds a value the hook cannot read
function relexed(raw: string, known: Record<string, string>): Word | undefined {
  // a substitution's commands come first, so the word's own command is the last
  const words = lex(raw, known).commands.at(-1)?.words ?? []
  return words.length === 1 && !marked(words[0].value) ? words[0] : undefined
}

// The steady variables the call has set by now whose values the hook holds, an assignment that names an earlier one (`T="$S/x"`) lexed again with it, in the order they were set
// A key held past its chain (Steady.past) reads only in a word that is its quoted read alone (`"$f"`, `"${f}"`), since the empty value a failed cd leaves turns any other word into the rest of it (`$S/c` into `/c`) and an unquoted read into no word, which hands its place to the word before it (`cp a sub $f` copies to `sub`)
function heldVars(env: Env, steady: Steady, raw?: string): Record<string, string> {
  const alone = raw?.match(/^"\$\{?([A-Za-z_]\w*)\}?"$/)?.[1]
  const known = { ...env.known }
  for (const [key, text] of env.vars) {
    // a TMPDIR the call sets steers mktemp, so mktemp's path stays unheld
    const held =
      steady.has(key) || (key === alone && !!steady.past?.(key) && env.process[key] === undefined)
    if (key === "TMPDIR" || !held) continue
    if (!text.unknown && !marked(text.value)) known[key] = text.value
    else if ("raw" in text && typeof text.raw === "string") {
      const again = relexed(text.raw, known)?.value
      if (again?.startsWith(`${key}=`)) known[key] = again.slice(key.length + 1)
    }
  }
  return known
}

// Whether the hook holds a word's whole value
export const held = (word: Word, env: Env, steady: Steady): boolean =>
  !marked(word.value) || !!heldWord(word, env, steady)
