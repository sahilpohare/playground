// Shapes a secret value takes, so the store refuses one: a secret lives in the Keychain or the environment, and the store keeps only its name. The CLI's own token (pgcli_) is one, so it never reaches a row or an export.
const SECRET_SHAPES: [string, RegExp][] = [
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["a GitHub token", /\b(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["a Linear key", /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/],
  ["a Playground CLI token", /\bpgcli_[0-9a-f]{64}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}/],
  ["a URL with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i],
  ["an OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
]

// What a value holds that looks like a secret, named, or undefined; every string inside it is read, keys included.
export const secretIn = (value: unknown): string | undefined => {
  if (typeof value === "string") return SECRET_SHAPES.find(([, shape]) => shape.test(value))?.[0]
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = secretIn(item)
      if (found) return found
    }
    return
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      const found = secretIn(key) ?? secretIn(item)
      if (found) return found
    }
}

// A private key's whole block, to its end line or the text's end, since its header alone marks one.
const PRIVATE_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

// Pure: the text with every secret shape in it, a private key's whole block included, replaced by hidden.
export const hideSecrets = (text: string, hidden = "[hidden]"): string =>
  SECRET_SHAPES.reduce(
    (said, [, shape]) => said.replace(new RegExp(shape.source, `${shape.flags}g`), hidden),
    text.replace(PRIVATE_BLOCK, hidden),
  )
