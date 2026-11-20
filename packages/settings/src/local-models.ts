import { z } from "zod"

import { defineSettings } from "./settings"

const folder = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]*$/, "a model folder under ~/models, such as ornith-1.5-35b-a3b-nvfp4")

// What sizes one model's server: its working share cap, its weights, what vLLM takes beside weights and KV cache at that share, and its KV cache a token.
const figures = z.strictObject({
  cap: z.number().gt(0).max(0.95),
  kvKiBPerToken: z.number().positive(),
  overheadGiB: z.number().min(0),
  weightsGiB: z.number().positive(),
})

export type ModelFigures = z.infer<typeof figures>

// The local model servers playground model use runs: K kept up on this machine for the local workers and M on the peer for the Dashboard's chat, each sized from its machine's free memory as it starts. A change of mind is a settings write.
export const localModelSettings = defineSettings({
  "localModels.boxLanes": {
    default: 2,
    description:
      "How many box test runs the peer runs at once beside its model servers (the box suite's SLOTS); a peer server's share leaves room for this many runs of localModels.boxRunGiB.",
    schema: z.number().int().min(0).max(16),
  },
  "localModels.boxRunGiB": {
    default: 2.25,
    description:
      "Estimated: the memory one box test run takes, half the 4.5 GiB peak of a suite across both lanes, measured on the old runner box on 24 Oct, not on the peer.",
    schema: z.number().min(0).max(64),
  },
  "localModels.hereModel": {
    default: "",
    description:
      "The model this machine keeps up, such as K for the local workers; empty, the default, keeps none. Another model loads here on request, and this one comes back after localModels.idleMinutes.",
    schema: z.union([z.literal(""), folder]),
  },
  "localModels.hereReserveGiB": {
    default: 40,
    description:
      "Estimated: the memory a server on this machine leaves free for the factory's own sessions, stacks and test runs; its share is what is free above this.",
    schema: z.number().min(0).max(512),
  },
  "localModels.idleMinutes": {
    default: 30,
    description:
      "How long a model other than its machine's kept one (localModels.hereModel, localModels.peerModel) may sit with no request before it is stopped and the kept one comes back; 0 keeps whichever model was loaded last.",
    schema: z.number().int().min(0).max(1440),
  },
  "localModels.machine": {
    default: "",
    description:
      "The PLAYGROUND_PEERS machine that runs the model servers; empty means the only machine PLAYGROUND_PEERS names.",
    schema: z.union([
      z.literal(""),
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a peer's name"),
    ]),
  },
  "localModels.maxFirstTokenSeconds": {
    default: 10,
    description:
      "The first-token floor: a local worker starts only while its server's mean wait for a first token, over the last keep beat's window, stays under this many seconds.",
    schema: z.number().positive().max(600),
  },
  "localModels.minTps": {
    default: 15,
    description:
      "The speed floor: a local worker starts only while each session on its server would still decode at least this many tokens a second with one more beside it, the last keep beat's speed times n/(n+1).",
    schema: z.number().min(0).max(1000),
  },
  "localModels.models": {
    default: {
      // Measured in the local-model test of 2026-11-17: 72.38 GiB loaded; 908,567 KV tokens in 15.99 GiB at 0.75, 18.45 KiB a token (estimated from those two); overhead estimated as 0.75 of 121 GiB less weights and KV; capped at 0.75, since 0.80 logged an out-of-memory line once.
      "ornith-1.5-122b-nvfp4": {
        cap: 0.75,
        kvKiBPerToken: 18.45,
        overheadGiB: 2.38,
        weightsGiB: 72.38,
      },
      // Measured in the same test: 21.86 GiB loaded; 4,614,826 KV tokens in 56.19 GiB at 0.70, 12.77 KiB a token; overhead estimated as 0.70 of 121 GiB less weights and KV; its working share 0.70.
      "ornith-1.5-35b-a3b-nvfp4": {
        cap: 0.7,
        kvKiBPerToken: 12.77,
        overheadGiB: 6.65,
        weightsGiB: 21.86,
      },
    },
    description:
      "Each model folder's sizing figures: cap (its measured working share), weightsGiB, overheadGiB and kvKiBPerToken; a model with no row here is refused.",
    schema: z.record(folder, figures),
  },
  "localModels.peerModel": {
    default: "",
    description:
      "The model the peer keeps up, such as M for the Dashboard's chat; empty, the default, keeps none. Another model loads there on request, and this one comes back after localModels.idleMinutes.",
    schema: z.union([z.literal(""), folder]),
  },
})
