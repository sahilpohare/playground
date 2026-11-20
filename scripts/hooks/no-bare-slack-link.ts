// PreToolUse hook, acting for a factory session alone (role.ts): refuses a Slack MCP chat_post_message or chat_update that holds an http(s) URL (in text, markdown_text, a text field of its blocks, or any string of an attachment but a link, url or icon field) with no link chip for it in blocks (a link element whose text is its URL without the scheme, truncated), or a link element in blocks that is not such a chip, labelled or url-only, since a link sent as words shows as a raw URL.
import { input } from "./input"
import { fromFactory } from "./role"

const TOOL = /^mcp__(.+?)__(chat_post_message|chat_update)$/
const URL_IN_TEXT = /https?:\/\/[^\s<>|`]+/gi

// A URL as text holds it, without the punctuation after it and with Slack's escaped & read back.
const clean = (url: string) => url.replace(/&amp;/g, "&").replace(/[.,;:!?)\]}'"*_~]+$/, "")
// What two URLs match by: a trailing slash and the case of the scheme and host aside.
const key = (url: string) =>
  clean(url)
    .replace(/\/+$/, "")
    .replace(/^[a-z]+:\/\/[^/?#]*/i, (origin) => origin.toLowerCase())

const parsed = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value)

const schemeless = (url: string) => url.replace(/^https?:\/\//i, "")

// Every link element's URL, and whether it is a chip: one with only a url draws the raw URL, so it is a chip only with its URL less the scheme as text and truncated set.
function links(node: unknown): { chipped: boolean; url: string }[] {
  if (Array.isArray(node)) return node.flatMap(links)
  if (typeof node !== "object" || node === null) return []
  const { text, truncated, type, url } = node as Record<string, unknown>
  const own =
    type === "link" && typeof url === "string"
      ? [
          {
            chipped:
              typeof text === "string" &&
              truncated === true &&
              key(`https://${text}`) === key(`https://${schemeless(url)}`),
            url,
          },
        ]
      : []
  return [...own, ...Object.values(node).flatMap(links)]
}

// Every string a block or attachment shows as words, at any depth: each field whose name `shown` passes, a link element's own text aside.
function texts(node: unknown, shown: (name: string) => boolean): string[] {
  if (Array.isArray(node)) return node.flatMap((n) => texts(n, shown))
  if (typeof node !== "object" || node === null || (node as { type?: unknown }).type === "link")
    return []
  return Object.entries(node).flatMap(([name, value]) =>
    typeof value === "string" ? (shown(name) ? [value] : []) : texts(value, shown),
  )
}
// A block shows its text fields; an attachment shows every field but those Slack takes as a link or an image (title_link, image_url, footer_icon).
const blockShows = (name: string) => name === "text"
const attachmentShows = (name: string) => !/(?:link|url|icon)$/i.test(name)

const chip = (url: string) =>
  JSON.stringify({ type: "link", url, text: schemeless(url), truncated: true })

function inspect(raw: string): string | undefined {
  const { tool_input: input, tool_name: tool } = JSON.parse(raw) as {
    tool_input?: Record<string, unknown>
    tool_name?: unknown
  }
  const [, server = "", name = ""] = TOOL.exec(String(tool)) ?? []
  if (!/slack/i.test(server) || typeof input !== "object" || input === null) return
  const blocks = parsed(input.blocks)
  const words = [
    input.text,
    input.markdown_text,
    ...texts(blocks, blockShows),
    ...texts(parsed(input.attachments), attachmentShows),
  ]
  const elements = links(blocks)
  const chips = new Set(elements.filter((e) => e.chipped).map((e) => key(e.url)))
  const found = [
    ...words.flatMap((w) => (typeof w === "string" ? (w.match(URL_IN_TEXT) ?? []) : [])),
    ...elements.filter((e) => !e.chipped && /^https?:\/\//i.test(e.url)).map((e) => e.url),
  ]
  const loose = [...new Set(found.map(clean))].filter((u) => !chips.has(key(u)))
  if (!loose.length) return
  const markdown =
    typeof input.markdown_text === "string"
      ? " Put the words in text, not markdown_text, which Slack does not take beside blocks."
      : ""
  return `no-bare-slack-link hook refused ${name}: it holds ${loose.join(", ")} with no link chip in blocks, so each shows as a raw URL. Send each as a link chip, a rich_text block whose rich_text_section holds one link element per line, with its text and truncated exactly as shown (${loose.map(chip).join(", ")}), a {"type":"text","text":"\\n"} between them and any tag on the line after, and keep text as the plain fallback with the bare URLs, then run it again.${markdown}`
}

// Fails open: a call the hook cannot read runs, so a parser bug never blocks a Slack post.
export function check(raw: string): string | undefined {
  try {
    return inspect(raw)
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const raw = await input("no-bare-slack-link", "guard")
  const reason = (await fromFactory(raw)) ? check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
