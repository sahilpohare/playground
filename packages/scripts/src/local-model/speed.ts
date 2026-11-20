// One /metrics read of a vLLM server: its running counters, the requests waiting, and when the beat read it.
export type Snapshot = {
  at: string
  firstTokenCount: number
  firstTokenSeconds: number
  generationTokens: number
  interTokenSeconds: number
  waiting: number
}

// A server's speed over the beat's window, from two snapshots: each session's decode speed while it generates and the mean wait for a first token, each null when the window holds no samples, and the requests waiting now.
export type Speed = {
  at: string
  decodeTps: number | null
  ttftMean: number | null
  waiting: number
}

// A metric's value summed over its label sets, or null when the text has none.
const sumOf = (text: string, name: string): number | null => {
  const found = [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, "gm"))].map(
    (line) => Number(line[1]),
  )
  return found.length && found.every(Number.isFinite) ? found.reduce((a, b) => a + b, 0) : null
}

// Pure: a snapshot from /metrics text read at <at>, or null when the text holds no vLLM reading, as a silent server's does; a counter reads with or without the _total Prometheus adds.
export const parseMetrics = (text: string, at: string): Snapshot | null => {
  const firstTokenCount = sumOf(text, "vllm:time_to_first_token_seconds_count")
  const firstTokenSeconds = sumOf(text, "vllm:time_to_first_token_seconds_sum")
  const generationTokens =
    sumOf(text, "vllm:generation_tokens_total") ?? sumOf(text, "vllm:generation_tokens")
  const interTokenSeconds = sumOf(text, "vllm:inter_token_latency_seconds_sum")
  const waiting = sumOf(text, "vllm:num_requests_waiting")
  if (
    firstTokenCount === null ||
    firstTokenSeconds === null ||
    generationTokens === null ||
    interTokenSeconds === null ||
    waiting === null
  )
    return null
  return { at, firstTokenCount, firstTokenSeconds, generationTokens, interTokenSeconds, waiting }
}

// Pure: the speed between two snapshots; a window with no generation or no first token, or one whose counters fell, as after a restart, holds no samples for that reading.
export const speedOf = (prev: Snapshot | undefined, now: Snapshot): Speed => {
  const delta = (key: Exclude<keyof Snapshot, "at" | "waiting">) =>
    prev ? now[key] - prev[key] : 0
  const tokens = delta("generationTokens")
  const decoding = delta("interTokenSeconds")
  const firsts = delta("firstTokenCount")
  const waited = delta("firstTokenSeconds")
  return {
    at: now.at,
    decodeTps: tokens > 0 && decoding > 0 ? tokens / decoding : null,
    ttftMean: firsts > 0 && waited >= 0 ? waited / firsts : null,
    waiting: now.waiting,
  }
}
