import { z } from "zod"

// By relative path, as slack.ts imports, since the API's inbox, which the CLI runs from any shell, imports this file.
import { defineSettings } from "./settings"

// What every policy line holds until the owner sets one: factory status, with no secret and no customer's personal data.
export const DEFAULT_POLICY = "factory status; no secrets or customer personal data"
const policy = z.string().trim().min(1).max(400)
const hour = z.number().int().min(0).max(23)

const e164 = z
  .string()
  .regex(/^(?:\+[1-9]\d{7,14})?$/, "a phone number is + and 8 to 15 digits, as +15550100001")

// How the factory reaches WhatsApp: the spare number ops-wa links to, the owner's number, the allowlist of one that gives orders, and a second number that gets alerts and chats as a guest; ops-wa links and hands on nothing until the first two are set.
export const whatsappSettings = defineSettings({
  "wa.alert": {
    default: "",
    description:
      "A second WhatsApp number in E.164, a guest: each playground wa alert goes to it once the owner has not handled it within wa.alertDelayMinutes, or at once with --now-both, the dispatcher replies to it with playground wa send --to alert, and its messages reach the dispatcher as data, never an order or an Inbox answer. Empty sends alerts to the owner alone.",
    masked: true,
    schema: e164,
  },
  "wa.alertCheck": {
    default: "",
    description:
      "The checker ops-wa runs when an urgent alert's delay ends, a file in the extensions (such as scripts/<key>/check.ts) run with bun and given the alert's --source and its send time: exit 0 means handled, so the alert stays with the owner; any other exit, a crash or 20 s with no exit sends it on to wa.alert. Empty: only the owner's WhatsApp reaction on the alert handles it. A guard key, set by the owner alone.",
    schema: z.string().trim().max(300),
  },
  "wa.alertDelayMinutes": {
    default: 3,
    description:
      "The minutes an urgent alert waits with the owner before it goes on to wa.alert, unless the owner's reaction or wa.alertCheck says it was handled; read for each alert.",
    schema: z.number().int().positive(),
  },
  "wa.device": {
    default: "",
    description:
      "The spare number ops-wa links to as a device, in E.164: its pairing code is for this number. Never the owner's own number; ops-wa does not run until it is set. A guard key, set by the owner alone.",
    masked: true,
    schema: e164,
  },
  "wa.guestPolicy": {
    default: DEFAULT_POLICY,
    description:
      "What the dispatcher may answer the wa.alert number, a guest, with: the policy line ops-wa adds to each of its messages. A guard key, set by the owner alone.",
    schema: policy,
  },
  "wa.owner": {
    default: "",
    description:
      "The owner's WhatsApp number in E.164, the allowlist of one: ops-wa hands on only this number's 1:1 messages as the owner's and sends replies only to it; ops-wa does not run until it is set. A guard key, set by the owner alone.",
    masked: true,
    schema: e164,
  },
  "wa.quietEndHour": {
    default: 6,
    description:
      "The hour, 0 to 23 in clock.ownerZone, the quiet window ends at: ops-wa then sends the texts it held as one catch-up. Equal to wa.quietStartHour, there is no window.",
    schema: hour,
  },
  "wa.quietStartHour": {
    default: 0,
    description:
      "The hour, 0 to 23 in clock.ownerZone, the quiet window starts at: inside it, a reply to the owner goes out only within an hour of the owner's last read or message, and ops-wa holds it otherwise; an urgent alert goes at any hour.",
    schema: hour,
  },
  "wa.replyPolicy": {
    default: DEFAULT_POLICY,
    description:
      "What the dispatcher may answer the owner's WhatsApp with: the policy line ops-wa adds to each message it hands on and to each update it asks for. A guard key, set by the owner alone.",
    schema: policy,
  },
})
