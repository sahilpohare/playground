// The harnesses a session runs in: each one's id and the backends it takes, a backend being a model setting of its harness (GLM is Claude Code on Z.ai's models.glm), its default first. Codex runs the first dispatcher alone (spawn.sh --harness codex).
export const HARNESSES = [
  { backends: ["claude", "glm"], id: "claude-code" },
  { backends: ["openai"], id: "codex" },
] as const

export type Harness = (typeof HARNESSES)[number]
export type HarnessId = Harness["id"]
export type Backend = Harness["backends"][number]

// The model a template names for GLM, which spawn.sh's --backend glm runs on models.glm.
export const GLM_MODEL = "glm"

// A session's backend pin as spawn.sh writes it under backends/<name>: its harness, then its backend.
export const pinText = (harness: HarnessId, backend: Backend) => `${harness} ${backend}`

// Pure: the harness and backend a pin names, in the old shape (a backend alone, which ran on Claude Code) or the new; null for any other text.
export const readPin = (text: string): { backend: Backend; harness: HarnessId } | null => {
  const words = text.trim().split(/\s+/)
  const [harnessId, backend] = words.length === 1 ? ["claude-code", words[0]] : words
  if (words.length > 2) return null
  const harness = HARNESSES.find((h) => h.id === harnessId)
  const found = harness?.backends.find((b) => b === backend)
  return harness && found ? { backend: found, harness: harness.id } : null
}
