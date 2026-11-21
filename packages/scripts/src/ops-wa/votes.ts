import { createHash } from "node:crypto"

import { decryptPollVote } from "baileys"

// An encrypted vote as a poll update carries it.
export type Vote = { encIv?: Uint8Array | null; encPayload?: Uint8Array | null }

const hashOf = (option: string) => createHash("sha256").update(option).digest("hex")

// A vote on ops-wa's poll read back as the places of the options it picks, decrypted with the poll's secret; it tries each chat id the poll's sender and the voter go by (a phone number's or a LID), since the voter's phone picks which one it signs with. Undefined when none decrypts it.
export function votedOptions(
  vote: Vote,
  poll: { id: string; secret: string },
  creators: string[],
  voters: string[],
  values: string[],
): number[] | undefined {
  const pollEncKey = Buffer.from(poll.secret, "base64")
  for (const pollCreatorJid of creators)
    for (const voterJid of voters) {
      let picked: string[]
      try {
        const read = decryptPollVote(vote, {
          pollCreatorJid,
          pollEncKey,
          pollMsgId: poll.id,
          voterJid,
        })
        picked = (read.selectedOptions ?? []).map((hash) => Buffer.from(hash).toString("hex"))
      } catch {
        continue
      }
      return values.flatMap((value, i) => (picked.includes(hashOf(value)) ? [i] : []))
    }
  return undefined
}
