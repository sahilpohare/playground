import { describe, expect, test } from "bun:test"

import {
  fillNow,
  futureNowTimes,
  ownerTime,
} from "../../../../../../api/hono/src/lib/dashboard/ask-clock"

// 21:43Z is 3:13 am IST the next day, so each zone's clock time is read against its own clock.
const NOW = new Date("2026-10-31T21:43:00.000Z")

describe("fillNow", () => {
  test("makes every {now} in an item the time it posts at, in the owner's zone", () => {
    const item = { preview: { bullets: ["measured {now}"], text: "Seen at {now}." }, title: "x" }
    expect(fillNow(item, NOW, "Asia/Kolkata")).toEqual({
      preview: { bullets: ["measured 3:13 am IST"], text: "Seen at 3:13 am IST." },
      title: "x",
    })
    expect(fillNow("{now}", NOW, "UTC")).toBe("9:43 pm UTC")
    expect(fillNow(5, NOW, "UTC")).toBe(5)
  })

  test("reads the hour as the owner does, 12 at noon and midnight", () => {
    expect(ownerTime(new Date("2026-10-31T00:05:00Z"), "UTC")).toBe("12:05 am UTC")
    expect(ownerTime(new Date("2026-10-31T12:05:00Z"), "UTC")).toBe("12:05 pm UTC")
  })
})

describe("futureNowTimes", () => {
  test("names a measured or now time ahead of the clock, as the 31 Oct card's 7:28 am IST at 7:13", () => {
    const at = new Date("2026-10-31T01:43:00Z")
    expect(futureNowTimes({ text: "now 7:28 am IST" }, at, "Asia/Kolkata")).toEqual([
      '"now 7:28 am IST": 15 min ahead',
    ])
    expect(futureNowTimes(["measured 01:57Z"], at, "Asia/Kolkata")).toEqual([
      '"measured 01:57Z": 14 min ahead',
    ])
    expect(futureNowTimes("measured at 2026-10-31T02:30:00Z", at, "UTC")).toEqual([
      '"measured at 2026-10-31T02:30:00Z": 47 min ahead',
    ])
  })

  // issue 1454: the zone's short name comes from clock.ownerZone, so an owner in New York writes EST, with no fixed alias
  test("reads the owner zone's own short name beside a clock time", () => {
    const at = new Date("2026-01-15T15:30:00Z")
    expect(futureNowTimes("measured 3:00 pm EST", at, "America/New_York")).toEqual([
      '"measured 3:00 pm EST": 270 min ahead',
    ])
  })

  test("a bare clock time reads in the owner's zone", () => {
    expect(futureNowTimes("now 3:40 am", NOW, "Asia/Kolkata")).toEqual([
      '"now 3:40 am": 27 min ahead',
    ])
    expect(futureNowTimes("now 3:40 am", NOW, "UTC")).toEqual(['"now 3:40 am": 357 min ahead'])
    expect(futureNowTimes("now 9:50 pm", NOW, "UTC")).toEqual(['"now 9:50 pm": 7 min ahead'])
    expect(futureNowTimes("now 9:50 pm", NOW, "Asia/Kolkata")).toEqual([])
    expect(futureNowTimes("now: 10:30 pm UTC, measured = 22:30Z", NOW, "UTC")).toEqual([
      '"now: 10:30 pm UTC": 47 min ahead',
      '"measured = 22:30Z": 47 min ahead',
    ])
  })

  test("passes an ETA, one after now included, a time within the slack, a past one, one 12 hours back and one just before midnight", () => {
    const eta = { text: "ETA 11:30 pm UTC, finish 2026-11-01T02:00:00Z" }
    expect(futureNowTimes(eta, NOW, "UTC")).toEqual([])
    expect(futureNowTimes("Merging now, ETA 11:30 pm UTC", NOW, "UTC")).toEqual([])
    expect(futureNowTimes("Done now, next run 11:00 pm UTC", NOW, "UTC")).toEqual([])
    expect(futureNowTimes("measured 9:43 am UTC", NOW, "UTC")).toEqual([])
    expect(futureNowTimes("measured 9:44 pm UTC", NOW, "UTC")).toEqual([])
    expect(futureNowTimes("measured 9:10 pm UTC", NOW, "UTC")).toEqual([])
    expect(
      futureNowTimes("measured 11:58 pm UTC", new Date("2026-11-01T00:05:00Z"), "UTC"),
    ).toEqual([])
  })
})
