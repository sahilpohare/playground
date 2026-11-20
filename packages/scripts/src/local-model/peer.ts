import { clusterOf, envKeysOf } from "../ops-peer-relay/relay"

// Pure: the peer the model servers run on, from a .env's text: the one localModels.machine names, or the only one PLAYGROUND_PEERS names when it is empty; with the factory's key when PLAYGROUND_PEER_KEY is unset.
export const peerOf = (
  envText: string,
  home: string,
  machine: string,
): { key: string; name: string; target: string } | { why: string } => {
  const cluster = clusterOf(envKeysOf(envText), home)
  if ("why" in cluster) return cluster
  const { key, peers } = cluster
  if (!peers.length)
    return {
      why: "PLAYGROUND_PEERS names no machine: set localModels.machine and PLAYGROUND_PEERS",
    }
  const peer = machine ? peers.find((each) => each.name === machine) : peers[0]
  if (!peer) return { why: `PLAYGROUND_PEERS names no ${machine}` }
  if (!machine && peers.length > 1)
    return { why: "PLAYGROUND_PEERS names more than one machine: set localModels.machine to one" }
  return { key, name: peer.name, target: peer.target }
}
