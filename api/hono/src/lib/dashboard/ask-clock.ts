import { CLOCK_SLACK_MS } from "@/lib/clock"

// The placeholder `bun run ask new` and `edit` fill with the time they post at, so a "now" in an item is the clock's and never typed (clock.md).
export const NOW = "{now}"

// The zone's own short name, as the owner reads it (IST, UTC, EDT), over a GMT offset where one locale has the name.
const zoneName = (at: Date, zone: string): string => {
  const names = ["en-US", "en-IN"].map(
    (locale) =>
      new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value ?? zone,
  )
  return names.find((name) => !name.startsWith("GMT")) ?? names[0]!
}

// The hour and minute a zone's clock reads at a moment.
const wallClock = (at: Date, zone: string): { hour: number; minute: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    timeZone: zone,
  }).formatToParts(at)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { hour: value("hour"), minute: value("minute") }
}

// Pure: a moment as the owner reads it, `9:27 pm IST`.
export const ownerTime = (at: Date, zone: string): string => {
  const { hour, minute } = wallClock(at, zone)
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"} ${zoneName(at, zone)}`
}

// Pure: every string in an item with each {now} made the time it posts at, in the owner's zone.
export const fillNow = (value: unknown, now: Date, zone: string): unknown => {
  if (typeof value === "string") return value.replaceAll(NOW, ownerTime(now, zone))
  if (Array.isArray(value)) return value.map((entry) => fillNow(entry, now, zone))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fillNow(entry, now, zone)]),
    )
  return value
}

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : []

// The zone names a clock time may carry: UTC and Z, and the owner zone's own short name at that moment (IST for Asia/Kolkata, EST for America/New_York), taken from clock.ownerZone, so no owner's alias is fixed here; a regex alternation.
const zoneNames = (now: Date, zone: string): string =>
  [zoneName(now, zone), "UTC", "Z"]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")

// "measured" or "now", then a time right after it (or after an at, a colon, a comma or an equals sign), so an ETA later in the sentence passes: an ISO time, or a clock time with am/pm or a 24-hour one, each with an optional zone of those names.
const stamped = (zones: string) =>
  new RegExp(
    `\\b(?:measured|now)\\b(?:\\s*[:,=]|\\s+at)?\\s*(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})|\\b\\d{1,2}:\\d{2}(?:\\s?(?:am|pm))?(?:\\s?(?:${zones}))?)`,
    "gi",
  )

// How far a time in text runs ahead of now, in ms: an ISO time by its own moment, a clock time against its zone's clock now (UTC for UTC or Z, else the owner's), within 12 hours either way, so one just before midnight or exactly 12 hours back is a past one.
const aheadBy = (time: string, now: Date, zone: string, zones: string): number | null => {
  const iso = Date.parse(time)
  if (time.includes("-") && !Number.isNaN(iso)) return iso - now.getTime()
  const match = new RegExp(`^(\\d{1,2}):(\\d{2})(?:\\s?(am|pm))?(?:\\s?(${zones}))?$`, "i").exec(
    time,
  )
  if (!match) return null
  const [, h, m, half, named] = match
  let hour = Number(h)
  if (half) hour = (hour % 12) + (half.toLowerCase() === "pm" ? 12 : 0)
  if (hour > 23 || Number(m) > 59) return null
  const clock = wallClock(now, named && /^(?:utc|z)$/i.test(named) ? "UTC" : zone)
  let minutes = hour * 60 + Number(m) - (clock.hour * 60 + clock.minute)
  if (minutes > 12 * 60) minutes -= 24 * 60
  if (minutes < -12 * 60) minutes += 24 * 60
  return minutes * 60 * 1000
}

// Pure: each "measured" or "now" time in an item that runs ahead of the clock past the slack, as `<the words>: <minutes> min ahead`; an ETA or a finish, future by design, carries neither word and passes.
export const futureNowTimes = (value: unknown, now: Date, zone: string): string[] => {
  const zones = zoneNames(now, zone)
  return strings(value).flatMap((text) =>
    [...text.matchAll(stamped(zones))].flatMap((match) => {
      const ahead = aheadBy(match[1]!, now, zone, zones)
      return ahead !== null && ahead > CLOCK_SLACK_MS
        ? [`"${match[0]}": ${Math.round(ahead / 60_000)} min ahead`]
        : []
    }),
  )
}
