import { type Group } from "./_shared"

// A reviewer of an outside author's PR running a skill's script by its path whose shebang runs bun (or any runner but one that reads no folder's files, such as bun-canary or an env -S line read as another word), which reads files from the folder it runs in before the script: from any folder but the main checkout's own tree (the PR's clone at any depth, with or without a bunfig.toml or an env file, a scratch folder outside every work tree, a folder the hook cannot read), for the main checkout's extensions, and for the data folder's installed skills, which read mode runs from no folder since #1280.
const STATE = "code-review-loop/scripts/state"
const PYSCRIPT = "code-review-loop/scripts/script"
const scripts = (data: string, main: string) => ({
  core: `${main}/extensions/core/skills/${STATE}`,
  installed: `${data}/orgs/home/abc123/skills/${STATE}`,
  pyInstalled: `${data}/orgs/home/abc123/skills/${PYSCRIPT}`,
})

export const groups: Group[] = [
  {
    folders: [
      "outside clone",
      "outside clone subfolder",
      "outside clone subfolder with bunfig",
      "outside clone under a bunfig",
      "outside clone with an env file",
      "plain clone",
      "scratch folder",
      "unknown folder",
    ],
    guards: ["no-outside-pr-code"],
    rows: ({ DATA, MAIN }) => {
      const { core, installed } = scripts(DATA, MAIN)
      return [
        [
          "an installed skill's bun script by its path",
          `${installed}.ts pr acme-owner/widgets 501`,
        ],
        ["a core skill's bun script by its path", `${core}.ts pr acme-owner/widgets 501`],
      ]
    },
  },
  {
    folders: ["outside clone", "scratch folder"],
    guards: ["no-outside-pr-code"],
    rows: ({ DATA, MAIN }) => {
      const { core, installed } = scripts(DATA, MAIN)
      const folder = (script: string) => script.slice(0, script.lastIndexOf("/"))
      return [
        ["a bun-canary skill script by its path", `${folder(installed)}/canary.ts`],
        ["a skill script whose env -S glues an assignment before bun", `${folder(core)}/glued.ts`],
        ["a skill script whose env -S glues a quoted bun", `${folder(installed)}/quoted.ts`],
      ]
    },
  },
  {
    folders: ["main checkout", "main checkout subfolder"],
    guards: ["no-outside-pr-code"],
    rows: ({ DATA, MAIN }) => {
      const { core, installed } = scripts(DATA, MAIN)
      return [
        [
          "an installed skill's bun script from the main checkout's tree",
          `${installed}.ts pr acme-owner/widgets 501`,
        ],
        [
          "a core skill's bun script from the main checkout's tree",
          `${core}.ts pr acme-owner/widgets 501`,
        ],
      ]
    },
  },
  {
    folders: ["outside clone", "outside clone with an env file", "scratch folder"],
    guards: ["no-outside-pr-code"],
    rows: ({ DATA, MAIN }) => {
      const { core, pyInstalled } = scripts(DATA, MAIN)
      return [
        [
          "an installed skill's python script by its path",
          `${pyInstalled}.py pr acme-owner/widgets 501`,
        ],
        ["a core skill's node script by its path", `${core}.mjs pr acme-owner/widgets 501`],
      ]
    },
  },
]

// The forms the guard lets run: a core skill's bun script from the main checkout's own tree, whose bunfig.toml and env file are the factory's, and a core skill's script whose runner reads no file from the folder it runs in.
export const allowed = [
  "a core skill's bun script from the main checkout's tree",
  "a core skill's node script by its path",
]
