// The settings keys a guard reads to allow or deny a call, A to Z: no-extensions-write refuses a session's write of each (its GUARD_KEYS, which its test holds equal to this list), and of every jobs.<name>, but the Ops lead's set of glm.readOnlyLoad5 or of a job's interval alone (its tunes()), and a guard decision's Approve in the Inbox is the owner's way to set one.
export const GUARD_SETTING_KEYS = [
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
  "usage.keychainService",
] as const

export type GuardSettingKey = (typeof GUARD_SETTING_KEYS)[number]
