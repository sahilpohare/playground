import type { Group } from "./_shared"

// #2118: a run-slot call's command starts after the -- that follows its session name and options, so a name spelled as that separator leaves the command where run-slot runs it, and run-slot's own options leave it after them; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-kill-by-name"],
    rows: () => [
      [
        "a kill by pattern through run-slot named as its separator",
        "~/.playground/ops/run-slot.sh -- -- pkill -f watcher",
      ],
      [
        "a kill by name through run-slot named as its separator, run by bash",
        "bash ~/.playground/ops/run-slot.sh -- -- killall node",
      ],
      [
        "a kill by pattern through run-slot named as its separator in single quotes",
        "~/.playground/ops/run-slot.sh '--' -- pkill -f watcher",
      ],
      [
        "a kill by pattern through run-slot named as its separator in double quotes",
        '~/.playground/ops/run-slot.sh "--" -- pkill -f watcher',
      ],
      [
        "a kill by pattern through run-slot named as its separator behind a backslash",
        "~/.playground/ops/run-slot.sh \\-- -- pkill -f watcher",
      ],
      [
        "a kill by pattern through run-slot named as its separator around an empty quote",
        '~/.playground/ops/run-slot.sh -""- -- pkill -f watcher',
      ],
      [
        "a kill by pattern through run-slot named as its separator before --model-bound",
        "~/.playground/ops/run-slot.sh -- --model-bound -- pkill -f watcher",
      ],
      [
        "a kill by pattern through run-slot named as its separator before --after",
        "~/.playground/ops/run-slot.sh -- --after 4242 -- pkill -f watcher",
      ],
      [
        "a kill by pattern through run-slot named as its separator behind env",
        "env ~/.playground/ops/run-slot.sh -- -- pkill -f watcher",
      ],
      [
        "a kill by pattern through run-slot named as its separator as xargs' command",
        "xargs ~/.playground/ops/run-slot.sh -- -- pkill -f <<< watcher",
      ],
      [
        "a kill by pattern through run-slot named as its separator in bash -c",
        "bash -c '~/.playground/ops/run-slot.sh -- -- pkill -f watcher'",
      ],
      [
        "a kill by pattern through run-slot after its --after option",
        "~/.playground/ops/run-slot.sh w --after 4242 -- pkill -f watcher",
      ],
      [
        "a kill by name through run-slot after its --model-bound option",
        "~/.playground/ops/run-slot.sh w --model-bound -- killall node",
      ],
    ],
  },
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: () => [
      [
        "a commit through run-slot named as its separator",
        "~/.playground/ops/run-slot.sh -- -- git commit --allow-empty -m x",
      ],
    ],
  },
]
