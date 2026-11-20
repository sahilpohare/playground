import type { Group, Row } from "./_shared"

// #2372: a portless proxy stop with no port, or a port flag that carries no number, which portless 0.15.11 answers by probing 443, 80 and 1355 and stopping whichever proxy answers (cli.js:2121), the live one every worktree routes through; rows are data, as refused-forms.ts says.
const held = (): Row[] => [
  ["a proxy stop by portless with no port", "portless proxy stop"],
  ["a proxy stop by bunx with no port", "bunx portless proxy stop"],
  ["a proxy stop by npx with its own flag and no port", "npx -y portless proxy stop"],
  ["a proxy stop by bun x with no port", "bun x portless proxy stop"],
  ["a proxy stop by a path to portless with no port", "./node_modules/.bin/portless proxy stop"],
  ["a proxy stop whose -p carries no number", "portless proxy stop -p"],
  [
    "a proxy stop whose --port is joined by an =, which portless does not read",
    "portless proxy stop --port=14155",
  ],
  ["a proxy stop with --help, which portless still runs as a stop", "portless proxy stop --help"],
  ["a proxy stop after a cd in a chain", "cd /tmp && bunx portless proxy stop"],
  ["a proxy stop in a shell's script", "sh -c 'bunx portless proxy stop'"],
  [
    "a proxy stop as run-slot's command",
    "~/.playground/ops/run-slot.sh w -- bunx portless proxy stop",
  ],
  // round 1: portless strips its global flags before it reads the subcommand (cli.js:8188-8226), and clean stops the proxy discoverState finds with no port to give (cli.js:6326-6330)
  ["a proxy stop behind a global flag", "portless --lan proxy stop"],
  ["a proxy stop by bunx behind a global flag", "bunx portless --lan proxy stop"],
  ["a proxy stop behind --tailscale", "portless --tailscale proxy stop"],
  ["a proxy stop behind --script and its value", "portless --script dev proxy stop"],
  ["a clean, which stops whichever proxy it finds", "portless clean"],
  ["a clean by bunx", "bunx portless clean"],
  ["a proxy stop by npx -p", "npx -p portless portless proxy stop"],
  ["a proxy stop by npx --package", "npx --package portless portless proxy stop"],
  ["a proxy stop by pnpm exec", "pnpm exec portless proxy stop"],
  ["a proxy stop by pnpm dlx", "pnpm dlx portless proxy stop"],
  ["a proxy stop by npm exec", "npm exec portless proxy stop"],
  ["a proxy stop by yarn", "yarn portless proxy stop"],
  [
    "a proxy stop by node on portless's cli.js",
    "node node_modules/portless/dist/cli.js proxy stop",
  ],
  ["a proxy stop by bun on a path to portless", "bun node_modules/.bin/portless proxy stop"],
  // round 2: a package name with its version or tag names the same portless
  ["a proxy stop by npx on a versioned name", "npx portless@0.15.11 proxy stop"],
  ["a proxy stop by bunx on a tagged name", "bunx portless@latest proxy stop"],
  ["a clean by npx -y on a versioned name", "npx -y portless@0.15.11 clean"],
  ["a proxy stop by pnpm dlx on a tagged name", "pnpm dlx portless@latest proxy stop"],
  ["a proxy stop by bun x on a versioned name", "bun x portless@0.15.11 proxy stop"],
]

const controls = (): Row[] => [
  ["a proxy stop by portless on its own port", "portless proxy stop -p 14155"],
  ["a proxy stop by bunx on its own port, by --port", "bunx portless proxy stop --port 14155"],
  ["a proxy start on its own port", "portless proxy start -p 14155 --no-tls"],
  ["a URL read by portless", "bunx portless get api.playground"],
  ["a proxy stop as text", "echo 'portless proxy stop'"],
  ["a search for a proxy stop", 'git grep -n "portless proxy stop"'],
  ["a proxy stop behind a global flag on its own port", "portless --lan proxy stop -p 14155"],
  ["a proxy stop by npx -p on its own port", "npx -p portless portless proxy stop -p 14155"],
  [
    "a proxy stop by node on its own port",
    "node node_modules/portless/dist/cli.js proxy stop -p 14155",
  ],
  ["a clean's help, which portless answers and exits", "portless clean --help"],
  ["portless added as a package", "bun add portless"],
  ["portless added at a version", "pnpm add portless@0.15.11"],
  ["a proxy stop on a versioned name on its own port", "npx portless@0.15.11 proxy stop -p 14155"],
]

export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-kill-by-name"],
    rows: () => [...held(), ...controls()],
  },
]

export const allowed: string[] = controls().map(([what]) => what)
