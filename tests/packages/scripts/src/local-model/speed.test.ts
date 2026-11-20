import { describe, expect, test } from "bun:test"

import { parseMetrics, speedOf } from "../../../../../packages/scripts/src/local-model/speed"

// /metrics text as vLLM writes it: a counter with Prometheus' _total, histograms' _sum and _count, a gauge, each under its labels.
const metrics = (
  tokens: number,
  itl: number,
  ttftSum: number,
  ttftCount: number,
  waiting = 0,
  total = "_total",
) => `# HELP vllm:generation_tokens Number of generation tokens processed.
# TYPE vllm:generation_tokens counter
vllm:generation_tokens${total}{engine="0",model_name="local"} ${tokens}
vllm:generation_tokens_created{engine="0",model_name="local"} 1.7e9
vllm:inter_token_latency_seconds_sum{engine="0",model_name="local"} ${itl}
vllm:inter_token_latency_seconds_count{engine="0",model_name="local"} 9
vllm:time_to_first_token_seconds_sum{engine="0",model_name="local"} ${ttftSum}
vllm:time_to_first_token_seconds_count{engine="0",model_name="local"} ${ttftCount}
vllm:num_requests_running{engine="0",model_name="local"} 2.0
vllm:num_requests_waiting{engine="0",model_name="local"} ${waiting}
`

describe("parseMetrics reads one vLLM /metrics snapshot", () => {
  test("each reading, summed over its labels, and the counter's _created line left out", () => {
    expect(parseMetrics(metrics(1000, 40, 12, 6, 1), "T")).toEqual({
      at: "T",
      firstTokenCount: 6,
      firstTokenSeconds: 12,
      generationTokens: 1000,
      interTokenSeconds: 40,
      waiting: 1,
    })
  })

  test("a counter written without _total reads the same", () => {
    expect(parseMetrics(metrics(1000, 40, 12, 6, 0, ""), "T")?.generationTokens).toBe(1000)
  })

  test.each([
    ["an empty answer, as a silent server gives", ""],
    ["a page that is not /metrics", "<html>busy</html>"],
    ["a reading missing", metrics(1000, 40, 12, 6).replace(/^vllm:num_requests_waiting.*$/m, "")],
  ])("%s reads as no snapshot", (_, text) => {
    expect(parseMetrics(text, "T")).toBeNull()
  })
})

describe("speedOf: each session's decode speed and the first-token wait between two snapshots", () => {
  const at = (text: string) => parseMetrics(text, "2026-11-17T10:05:00Z")!

  test("the deltas: generated tokens over decode seconds, and first-token seconds over first tokens", () => {
    const prev = at(metrics(1000, 40, 12, 6))
    expect(speedOf(prev, at(metrics(4000, 140, 42, 16, 2)))).toEqual({
      at: "2026-11-17T10:05:00Z",
      decodeTps: 30,
      ttftMean: 3,
      waiting: 2,
    })
  })

  test.each([
    ["no snapshot before", undefined, metrics(4000, 140, 42, 16)],
    ["no request in the window", metrics(4000, 140, 42, 16), metrics(4000, 140, 42, 16)],
    ["counters that fell, as after a restart", metrics(4000, 140, 42, 16), metrics(100, 4, 2, 1)],
  ])("%s holds no samples, and keeps the waiting count", (_, prev, now) => {
    expect(speedOf(prev ? at(prev) : undefined, at(now))).toEqual({
      at: "2026-11-17T10:05:00Z",
      decodeTps: null,
      ttftMean: null,
      waiting: 0,
    })
  })
})
