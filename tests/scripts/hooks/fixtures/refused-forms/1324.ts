import { type Group } from "./_shared"

// A command after a run-slot call whose words cd away runs in the shell's own folder, since run-slot runs those words in a process of its own, and a command inside those words runs where its own cd lands; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["main checkout"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      [
        "a commit after a run-slot call whose words cd away",
        "~/.playground/ops/run-slot.sh w -- cd /tmp; git commit -m x",
      ],
      [
        "a write after a run-slot call whose words pushd away",
        "~/.playground/ops/run-slot.sh w -- pushd /tmp; touch stray",
      ],
      [
        "a build inside run-slot's words, in the folder its own cd names",
        `~/.playground/ops/run-slot.sh w -- bash -c 'cd ${MAIN} && bun run build'`,
        "checkout",
      ],
    ],
  },
  {
    folders: ["glm org repo"],
    guards: ["no-glm-heavy-path"],
    rows: () => [
      [
        "a read of an org's file after a run-slot call whose words cd away",
        "~/.playground/ops/run-slot.sh w -- cd /tmp; head README.md",
      ],
      [
        "a read of an org's file after a run-slot call whose words pushd away",
        "~/.playground/ops/run-slot.sh w -- pushd /tmp; cat README.md",
      ],
      [
        "a read inside run-slot's words, in the org's checkout its own cd names",
        "~/.playground/ops/run-slot.sh w -- bash -c 'cd ../glm-org-repo && cat README.md'",
        "glm repo",
      ],
    ],
  },
  {
    folders: ["extensions root"],
    guards: ["no-extensions-write"],
    rows: ({ ROOT }) => [
      [
        "a write after a run-slot call whose words cd away",
        "~/.playground/ops/run-slot.sh w -- cd /tmp; touch stray",
      ],
      [
        "a write after a run-slot call whose words pushd away",
        "~/.playground/ops/run-slot.sh w -- pushd /tmp; echo x > stray",
      ],
      [
        "a write inside run-slot's words, in the root its own cd names",
        `~/.playground/ops/run-slot.sh w -- bash -c 'cd ${ROOT} && touch stray'`,
        "checkout",
      ],
    ],
  },
]
