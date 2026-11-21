// The kinds a token's post holds for its sender's approval, since each asks someone to act or names a change: steps to run, a fix, a log, a bug.
export const HELD_KINDS = ["bug", "fix", "log", "steps"] as const

// What decides whether a post is held: who sent it and how, what it is, and where it goes.
export type Post = {
  // the post opens its DM, the first message there, outside the DM bot add made between the poster and its own bot
  firstInDm: boolean
  kind: string
  postRule: string
  text: string
  via: "token" | "web"
}

// Every @login the text names, lowercased, as GitHub logins compare.
export const mentionsOf = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/(?<![\w@])@([a-z\d](?:[a-z\d-]{0,38}))/gi)].map((m) => m[1]!.toLowerCase()),
  ),
]

// Why a post waits as pending for its sender's web session, or null when it sends at once: a post from a signed-in browser is the person's own, so only a token's post is held, when it is a held kind, names someone, opens a DM or goes to an owner-only channel. v1 takes no attachments; one added later holds too.
export const heldBecause = (post: Post): string | null => {
  if (post.via === "web") return null
  if ((HELD_KINDS as readonly string[]).includes(post.kind)) return `a ${post.kind} post`
  if (mentionsOf(post.text).length > 0) return "a mention"
  if (post.firstInDm) return "a first message in a DM"
  if (post.postRule === "owner") return "a post to an owner-only channel"
  return null
}
