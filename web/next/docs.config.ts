import type { DocsConfig } from "./src/lib/docs"

const docsConfig = {
  docs: {
    "Getting started": [
      {
        "/docs": {
          title: "Overview",
          description: "What Playground is, what you need and where to start.",
        },
      },
      {
        "/docs/install": {
          title: "Install",
          description:
            "Install Playground on a Mac with one command, and run it again to repair it.",
        },
      },
    ],
    Dashboard: [
      {
        "/docs/dashboard": {
          title: "Dashboard",
          description: "Your chat with the dispatcher, the sidebar and the apps.",
        },
      },
      {
        "/docs/inbox": {
          title: "Inbox",
          description: "Decisions, drafts and updates, and how to answer them.",
        },
      },
      {
        "/docs/agents": {
          title: "Agents",
          description: "What each agent is doing: its status icon and pages.",
        },
      },
    ],
    Factory: [
      {
        "/docs/factory": {
          title: "The factory",
          description:
            "The sessions Playground runs, what each one does and how work moves between them.",
        },
      },
      {
        "/docs/skills": {
          title: "Skills and orgs",
          description:
            "Which skills a session gets, where they come from, and how an org adds its own.",
        },
      },
    ],
    CLI: [
      {
        "/docs/cli": {
          title: "The playground command",
          description:
            "Start, view, check, update, add to and remove Playground from your terminal.",
        },
      },
      {
        "/docs/parity": {
          title: "The parity check",
          description: "See what a change takes away from your sessions before it lands.",
        },
      },
    ],
    Settings: [
      {
        "/docs/settings": {
          title: "Settings",
          description: "The user menu, the Settings page and how to take an update.",
        },
      },
      {
        "/docs/extensions": {
          title: "Settings and extensions",
          description:
            "Where your own values, rules and skills live, and how to change them with one command.",
        },
      },
      {
        "/docs/backup": {
          title: "Export, import and backup",
          description:
            "Take your settings and extensions to a new machine, and keep each scope in sync with a private repo on GitHub.",
        },
      },
      {
        "/docs/jobs": {
          title: "Ops jobs",
          description:
            "The background jobs Playground runs, how to turn each one on, and where their launchd files go.",
        },
      },
      {
        "/docs/versions": {
          title: "Versions",
          description:
            "How Playground keeps the old version of a change, reads the latest, and takes the code back to a release.",
        },
      },
    ],
    Yard: [
      {
        "/docs/yard-bot": {
          title: "Connect a bot",
          description: "How a bot reads and sends messages in its own DM with you on Yard.",
        },
      },
    ],
    Help: [
      {
        "/docs/troubleshooting": {
          title: "Troubleshooting",
          description: "What to do when something does not start or stops.",
        },
      },
    ],
  },
  console: {
    "Getting Started": [
      {
        "/console/docs": {
          title: "Introduction",
          description: "Internal documentation.",
        },
      },
    ],
  },
} satisfies DocsConfig

export default docsConfig
