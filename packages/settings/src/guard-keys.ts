// The settings keys a guard reads to allow or deny a call, yard.logReaders, which lets a bot read the dispatcher's log, wa.alert, the number each alert reaches beside the owner's, wa.alertCheck, the checker ops-wa runs, wa.device and wa.owner, the number ops-wa links as and the one it takes orders from, and wa.guestPolicy and wa.replyPolicy, the policy lines ops-wa hands the dispatcher, A to Z: no-extensions-write refuses a session's write of each (its GUARD_KEYS, which its test holds equal to this list), and of every jobs.<name>, but the Ops lead's set of glm.readOnlyLoad5 or of a job's interval alone (its tunes()), and a guard decision's Approve in the Inbox is the owner's way to set one, beside the owner's own WhatsApp message and yes (ADR 0035).
export const GUARD_SETTING_KEYS = [
  "ext.links",
  "ext.order",
  "ext.repos",
  "factory.archiveRepo",
  "factory.publicRepo",
  "github.pollMinutes",
  "glm.readOnlyLoad5",
  "live.branch",
  "owner.names",
  "paths.codeRoot",
  "sessions.aliases",
  "sessions.names",
  "slack.gatedSends",
  "usage.keychainService",
  "wa.alert",
  "wa.alertCheck",
  "wa.device",
  "wa.guestPolicy",
  "wa.owner",
  "wa.replyPolicy",
  "yard.logReaders",
] as const

export type GuardSettingKey = (typeof GUARD_SETTING_KEYS)[number]
