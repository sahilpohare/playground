#!/usr/bin/env -S bun --no-env-file
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import { dataDir } from "@packages/env/data-dir"

// macOS's `security` for Linux, which has no Keychain: the four forms the factory runs, each item a mode-600 file under the data folder's secrets/keychain/, and Claude Code's own login item its ~/.claude/.credentials.json; link-skills.sh links it first on PATH there.
const NOT_FOUND = 44
const DUPLICATE = 45
const LOGIN = "Claude Code-credentials"
const SERVED =
  "security on Linux serves find-generic-password, add-generic-password, delete-generic-password and -i alone"

class Refusal extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

// Each part one file name, its dots encoded too, so no service or account names a folder outside the store.
const part = (word: string) => encodeURIComponent(word).replaceAll(".", "%2E")

const fileOf = (service: string, account: string) =>
  service === LOGIN
    ? join(process.env.HOME || homedir(), ".claude", ".credentials.json")
    : join(dataDir(), "secrets", "keychain", part(service), part(account))

const missing = () =>
  new Refusal("The specified item could not be found in the keychain.", NOT_FOUND)

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

// The file is made at mode 600 beside its place and renamed onto it, so no reader ever finds it wider or half written.
const save = (file: string, value: string) => {
  mkdirSync(dirname(file), { mode: 0o700, recursive: true })
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  const fd = openSync(temp, "wx", 0o600)
  try {
    try {
      writeSync(fd, value)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
}

type Flags = { account: string; replace: boolean; service: string; show: boolean; value?: string }

// -s and -a name the item, -U lets an add replace it, and -w prints a find's value or carries an add's, read from stdin when it is the last word.
const flagsOf = (words: string[], adding: boolean): Flags => {
  const flags: Flags = { account: "", replace: false, service: "", show: false }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === "-s" || word === "-a") {
      const named = words[++i]
      if (named === undefined) throw new Refusal(`${word} takes a value`, 2)
      if (word === "-s") flags.service = named
      else flags.account = named
    } else if (word === "-U") flags.replace = true
    else if (word === "-w") {
      flags.show = true
      if (adding) flags.value = words[++i]
    } else throw new Refusal("an option other than -s, -a, -w and -U", 2)
  }
  if (!flags.service || (flags.service !== LOGIN && !flags.account))
    throw new Refusal("an item is named by -s and -a", 2)
  return flags
}

const stdin = () => readFileSync(0, "utf8")

const command = (words: string[], input: () => string): void => {
  const [verb, ...rest] = words
  if (verb === "find-generic-password") {
    const { account, service, show } = flagsOf(rest, false)
    let value: string
    try {
      value = readFileSync(fileOf(service, account), "utf8")
    } catch (error) {
      if (absent(error)) throw missing()
      throw error
    }
    if (show) process.stdout.write(`${value}\n`)
  } else if (verb === "add-generic-password") {
    const { account, replace, service, value = input().replace(/\r?\n$/, "") } = flagsOf(rest, true)
    const file = fileOf(service, account)
    if (!replace && existsSync(file))
      throw new Refusal("The specified item already exists in the keychain.", DUPLICATE)
    save(file, value)
  } else if (verb === "delete-generic-password") {
    const { account, service } = flagsOf(rest, false)
    try {
      unlinkSync(fileOf(service, account))
    } catch (error) {
      if (absent(error)) throw missing()
      throw error
    }
  } else throw new Refusal(SERVED, 1)
}

// A line of -i's input in words, a double-quoted one taken whole.
const wordsOf = (line: string): string[] => {
  if ((line.match(/"/g) ?? []).length % 2) throw new Refusal("a line with an unclosed quote", 2)
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!)
}

const main = (argv: string[]): number => {
  const fail = (error: unknown) => {
    // a refusal's own words alone, never a word of the command, so no value reaches the output
    const known = error instanceof Refusal
    console.error(
      `security: ${known ? error.message : `the store refused it (${(error as NodeJS.ErrnoException).code ?? "error"})`}`,
    )
    return known ? error.code : 1
  }
  if (argv.length === 1 && argv[0] === "-i") {
    let code = 0
    for (const line of stdin().split("\n")) {
      if (!line.trim()) continue
      try {
        command(wordsOf(line), () => {
          throw new Refusal("-w takes a value on an -i line", 2)
        })
      } catch (error) {
        const failed = fail(error)
        code ||= failed
      }
    }
    return code
  }
  try {
    command(argv, stdin)
    return 0
  } catch (error) {
    return fail(error)
  }
}

process.exit(main(process.argv.slice(2)))
