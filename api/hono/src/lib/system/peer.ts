// The System view's fixed read of a peer, shared with spawn.sh's gate for an --ssh start (packages/scripts/src/spawn/peer-gate.ts), so both read a machine the same way; it imports nothing, so a script can import it by its relative path.
export const peerArgv = (target: string, key?: string): string[] => [
  "ssh",
  // a key is the only identity tried, so an agent holding many keys never spends the server's MaxAuthTries before it
  ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []),
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=3",
  target,
  // df runs first, so the exit is cat's: a df that fails leaves out the peer's disk, never the peer
  "df",
  "-kP",
  "~",
  ";",
  "cat",
  "/proc/loadavg",
  "/proc/meminfo",
  "/proc/stat",
]
