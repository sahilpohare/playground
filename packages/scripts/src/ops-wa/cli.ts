import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"

import { managerOf } from "@packages/config/kinds"
import { configDirOf } from "@packages/env/data-dir"
import {
  DEFAULT_POLICY,
  extSettings,
  loginOf,
  readPolicy,
  readRendered,
  ruleSettings,
  setSetting,
  whatsappSettings,
} from "@packages/settings"
import makeWASocket, {
  Browsers,
  downloadMediaMessage,
  type SocketConfig,
  useMultiFileAuthState,
  type WAMessage,
} from "baileys"

import { assistantOf, busyOf, stuckOf } from "../ops-job/dispatcher"
import { engineData, REPO, run, sendAs } from "../ops-job/job"
import { beat, CYCLE_SECONDS } from "../ops-tick/tick"
import { dashboardCheckout } from "../playground/probe"
import { waiterSince } from "../stuck-alert"
import { EMPTY_LIST, isPublicList, reposOf } from "../trace-count/kinds"
import { alertSet } from "./alert-set"
import { bridge, type Inbox, type Sock, sender } from "./bridge"
import { type Card, termsOf } from "./cards"
import { runCheck } from "./escalate"
import { keepAlive, ownFolder, releaseLock, SOCKET, takeLock, writeOwn } from "./habits"
import { life, type LinkSock, pairingCard, unguarded } from "./life"
import { mediaDir, modelPath, stdoutRun, transcriber } from "./media"
import { outboxDir } from "./outbound"
import { seedAlert } from "./seed"
import { socketPath, serve } from "./server"
import { applyOwnerSetting, ownerSettings } from "./setting-set"
import { votedOptions } from "./votes"

// ops-wa: the WhatsApp link on the spare number, held by ops-wa's life; it beats ok while the linked device is connected, waiting while it connects or waits for its numbers or its pairing code, and, once stopped, why, idle, so up.py does not start it again and its row reads the reason.
process.umask(0o077)
const data = engineData("ops-wa")
const dir = join(data, "whatsapp")
const ops = join(data, "ops")
const startedAt = new Date()
const CONNECTING = "waiting: connecting to WhatsApp"
let result = CONNECTING
const pulse = () =>
  beat(join(ops, "ops-wa.json"), startedAt, new Date(), result, "ops-wa").catch((e) =>
    console.error(e),
  )
void pulse()
setInterval(() => void pulse(), CYCLE_SECONDS * 1000)
const stop = (why: string, word = "stopped") => {
  result = `${word}: ${why}`
  console.error(`ops-wa: ${result}`)
  void pulse()
}

// One Inbox update under the ops manager's name, as ops-tick posts its alerts, answering its id; bun run ask runs in the Dashboard's checkout, whose .env names the Inbox's database.
const inbox = dashboardCheckout(REPO) ?? REPO
const ask = async (verb: string[], stdin?: string) =>
  run(["bun", "run", "--silent", "--cwd", inbox, "ask", ...verb], 120_000, stdin)
const by = async () =>
  managerOf(
    (
      (await Bun.file(join(data, "roster.json"))
        .json()
        .catch(() => null)) as { agents?: unknown } | null
    )?.agents,
    "ops",
  )
// The two outcomes ops-wa posts, both of the Inbox's OUTCOMES (api/hono/src/lib/dashboard/inbox.ts): a pairing code or a problem is an alert, the reminder a finding; spelled here since the scripts package cannot type-pull that file, and the life test pins the words against the real schema.
type Outcome = "alert" | "finding"
type UpdateCard = {
  from: string
  kind: "update"
  preview: { outcome: Outcome; text: string }
  title: string
}
// One ask new for a card, answered by the card's id, or why the Inbox refused it: a non-zero exit, or an exit that prints no id. A refusal raises one alert naming the card and the reason; only the refusal alert's own refusal is logged, so a refusal never loops.
const postCard = async (card: UpdateCard, refusalAlert = false): Promise<string | undefined> => {
  const posted = await ask(["new"], JSON.stringify(card))
  const id = posted.out
    .split("\n")
    .find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))
    ?.trim()
  if (posted.code === 0 && id !== undefined) return id
  const why = posted.code === 0 ? "ask printed no id" : lastLine(posted.out)
  if (refusalAlert) {
    console.error(`ops-wa: ${card.preview.text}, and the Inbox refused its alert too: ${why}`)
    return undefined
  }
  await postCard(
    {
      from: card.from,
      kind: "update",
      preview: { outcome: "alert", text: `The Inbox refused the card "${card.title}": ${why}` },
      title: "ops-wa: the Inbox refused a card",
    },
    true,
  )
  return undefined
}
const post = async (title: string, text: string, outcome: Outcome): Promise<string | undefined> =>
  postCard({ from: await by(), kind: "update", preview: { outcome, text }, title })

// The Inbox as ops-wa reaches it: the open items through ask open --json, no-public-leak's list as that guard reads it, failing closed, and an answer as a file in its own folder that ask whatsapp reads (ADR 0024).
const lastLine = (text: string) =>
  (text.trim().split("\n").at(-1) ?? "").replace(/^ask: /, "") || "ask gave no reason"
const inboxOf = (): Inbox => ({
  answer: async (id, answer) => {
    const answers = join(dir, "answers")
    await ownFolder(answers)
    const file = join(answers, `${crypto.randomUUID()}.json`)
    await writeOwn(file, { ...answer, id })
    const ran = await ask(["whatsapp", file])
    return ran.code === 0 ? undefined : lastLine(ran.out)
  },
  open: async () => {
    const ran = await ask(["open", "--json"])
    if (ran.code !== 0) throw new Error(`ask open: ${lastLine(ran.out)}`)
    return ran.out
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Card)
  },
  terms: async () => {
    const read = await readPolicy(data)
    const list = await readRendered(data, "hooks/no-public-leak.json")
    if (read.refusal !== undefined || list.refusal) return undefined
    const value: unknown = list.path
      ? await Bun.file(list.path)
          .json()
          .catch(() => null)
      : EMPTY_LIST
    return isPublicList(value) ? termsOf(value, reposOf(read.settings)) : undefined
  },
})

const main = async () => {
  const policy = await readPolicy(data)
  if (policy.refusal !== undefined) return stop(`the settings refuse: ${policy.refusal}`)
  const owner = whatsappSettings.get(policy.settings, "wa.owner")
  const device = whatsappSettings.get(policy.settings, "wa.device")
  // wa.alert is read afresh for each send and each message, so the owner's Approve reaches a running ops-wa
  const alert = async () => {
    const read = await readPolicy(data)
    return read.refusal === undefined ? whatsappSettings.get(read.settings, "wa.alert") : ""
  }
  if (!owner || !device) return stop("wa.owner and wa.device must both be set", "waiting")
  // the minutes an urgent alert waits for the owner, and the checker that reads its source, each read afresh for each alert
  const waSetting = async <K extends "wa.alertCheck" | "wa.alertDelayMinutes">(key: K) => {
    const read = await readPolicy(data)
    return whatsappSettings.get(read.settings ?? { schemaVersion: 1, values: {} }, key)
  }
  const check = async (source: string, at: number) => {
    const name = await waSetting("wa.alertCheck")
    if (!name) return false
    const file = await readRendered(data, name)
    if (!file.path) {
      console.log(
        `ops-wa: the checker ${name} is not in the extensions: ${file.refusal ?? "absent"}`,
      )
      return false
    }
    return runCheck(file.path, source, at)
  }
  await ownFolder(dir)
  // ADR 0032's numbers.json, which kept.json replaced, goes at start, so no phone number outlives its 24 hours there (ADR 0035)
  await unlink(join(dir, "numbers.json")).catch(() => {})
  await ownFolder(outboxDir(data))
  const lock = join(dir, "lock")
  // a holder is a live ops-wa, so a pid the OS gave to another program frees the lock
  const holder = await takeLock(lock, process.pid, (pid) => {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
      .stdout.toString()
      .includes("ops-wa")
  })
  if (holder) return stop(holder)
  process.on("exit", () => releaseLock(lock, process.pid))
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
    process.on(signal, () => process.exit(0))
  const creds = await Bun.file(join(dir, "auth", "creds.json"))
    .json()
    .catch(() => ({}))
  if (!(creds as { registered?: boolean }).registered) {
    const refusal = await unguarded(join(REPO, "scripts", "factory-settings.json"))
    if (refusal) return stop(refusal)
  }
  const { saveCreds, state } = await useMultiFileAuthState(join(dir, "auth"))
  let current: Sock | undefined
  const send = sender({
    alert,
    delay: () => waSetting("wa.alertDelayMinutes"),
    device,
    dir,
    now: Date.now,
    owner,
    // the quiet window, read afresh for each send, so the owner's change reaches a running ops-wa
    quiet: async () => {
      const read = await readPolicy(data)
      const settings = read.settings ?? { schemaVersion: 1, values: {} }
      return {
        end: whatsappSettings.get(settings, "wa.quietEndHour"),
        start: whatsappSettings.get(settings, "wa.quietStartHour"),
        zone: ruleSettings.get(settings, "clock.ownerZone"),
      }
    },
    sleep: Bun.sleep,
    sock: {
      ev: { on: () => {} },
      sendMessage: (jid, content) => {
        if (!current)
          throw new Error("ops-wa is not connected to WhatsApp now; try again in a minute")
        return current.sendMessage(jid, content)
      },
    },
  })
  const path = socketPath(data)
  await unlink(path).catch(() => {})
  // the owner's own message, under ops-wa's link, is the owner's act: wa.alert is written as the Inbox's Approve writes it, with the seed, and the log keeps the id and what it held before
  const setAlert = async (number: string, id: string) => {
    const before = await alert()
    const set = setSetting(
      data,
      { key: "wa.alert", scope: loginOf(data), value: number },
      {
        actor: "ops-wa",
        author: "owner",
        inboxRef: null,
        reason: `the owner's WhatsApp message ${id} named it`,
      },
    )
    if (!set.ok) throw new Error(set.message)
    seedAlert(data, number, Date.now())
    const was = before ? `it was ...${before.slice(-4)}` : "it was unset"
    console.log(
      `ops-wa: wa.alert set to ...${number.slice(-4)} from the owner's message ${id}; ${was}`,
    )
    return was
  }
  // a setting from the owner's own message: its value must be in the message, and a key a guard reads waits for the owner's yes (ADR 0035); a session's proposal waits for it too, its question's id the reason (ADR 0041)
  const owned = {
    apply: (key: string, value: string, id: string, proposed?: boolean) =>
      applyOwnerSetting(data, key, value, id, proposed),
    dir,
    log: (line: string) => console.log(line),
    now: Date.now,
    question: (line: string) => send.card(line),
    tell: (line: string) => send.out(line, "reply").then((out) => out.ids),
  }
  const settings = ownerSettings(owned)
  serve(
    path,
    send.out,
    (id) => alertSet({ device, dir, now: Date.now, owner, set: setAlert }, id),
    send.react,
    settings.set,
    settings.propose,
  )
  const relay = sendAs("wa", true, true)
  // the alert number's lines go under their own tag, [ops-wa-data], so none reads as the owner's [ops-wa]
  const relayData = sendAs("wa-data", true, true)
  const seconds = () => Date.now() / 1000
  const config = configDirOf(process.env)
  const watched = bridge({
    alert,
    assistant: () => assistantOf(data),
    busy: () => busyOf("dispatcher", data, config, seconds()),
    card: send.card,
    catchUp: send.catchUp,
    check,
    confirm: settings.confirm,
    dir,
    draft: send.draft,
    escalate: (body) => send(body, "escalate"),
    inbox: inboxOf(),
    log: (line) => console.log(line),
    media: {
      dir: mediaDir(data),
      download: (m) => downloadMediaMessage(m as WAMessage, "buffer", {}),
      transcribe: transcriber(
        modelPath(data),
        (command) => Bun.which(command) !== null,
        existsSync,
        stdoutRun(300_000),
      ),
    },
    now: Date.now,
    // WhatsApp mode is the bundled whatsapp extension's switch, read afresh for each message
    on: async () => {
      const read = await readPolicy(data)
      return (
        read.refusal === undefined &&
        extSettings.get(read.settings, "ext.bundled").includes("whatsapp")
      )
    },
    owner,
    pin: send.pin,
    // the policy lines are read afresh for each message, so the owner's set reaches a running ops-wa; settings that refuse leave the default
    policy: async () => {
      const read = await readPolicy(data)
      return read.refusal === undefined
        ? {
            guest: whatsappSettings.get(read.settings, "wa.guestPolicy"),
            reply: whatsappSettings.get(read.settings, "wa.replyPolicy"),
          }
        : { guest: DEFAULT_POLICY, reply: DEFAULT_POLICY }
    },
    relay: (to, text, data) => (data ? relayData : relay)(to, text),
    poll: send.poll,
    remind: send.remind,
    reply: send,
    sleep: Bun.sleep,
    stuck: () => stuckOf("dispatcher", data, config, seconds()),
    votes: votedOptions,
    waiter: (name, since) => waiterSince(join(data, "ops", "outbox"), name, since),
  })
  const passes = setInterval(() => watched.pass(), 30_000)
  const reminder = setInterval(
    () =>
      void keepAlive(dir, Date.now(), () =>
        post(
          "Open WhatsApp on the spare phone",
          "A linked device drops after 14 days with its phone away: open WhatsApp on the spare phone once, with its SIM in, to keep the link.",
          "finding",
        ),
      ),
    3_600_000,
  )
  // Baileys logs messages it handles, so its logger stays silent and the owner's words stay out of every log
  const silent: SocketConfig["logger"] = {
    child: () => silent,
    debug() {},
    error() {},
    info() {},
    level: "silent",
    trace() {},
    warn() {},
  }
  const why = await life({
    alert: (text) => post("ops-wa needs a look", text, "alert"),
    alertNumber: await alert(),
    card: (code) => {
      result = "waiting: the pairing code waits to be typed on the spare phone"
      void pulse()
      return by().then((from) => postCard(pairingCard(code, from)))
    },
    connect: async () => {
      const sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS("Chrome"),
        logger: silent,
        ...SOCKET,
      })
      sock.ev.on("creds.update", saveCreds)
      return sock as unknown as LinkSock & Sock
    },
    device,
    dir,
    linked: async (id) => ask(["resolve", id, "--by", await by(), "--note", "linked"]),
    listen: (sock) => {
      current = sock
      watched.attach(sock)
    },
    now: Date.now,
    owner,
    sleep: Bun.sleep,
    up: (open) => {
      result = open ? "ok" : CONNECTING
      void pulse()
    },
  })
  current = undefined
  clearInterval(reminder)
  clearInterval(passes)
  stop(why)
}

await main().catch((error: Error) => stop(error.message))
