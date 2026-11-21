import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extensionOf,
  keep,
  mediaDir,
  modelPath,
  type Run,
  stdoutRun,
  transcriber,
} from "../../../../../packages/scripts/src/ops-wa/media"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-wa-media-"))
  dirs.push(dir)
  return dir
}

describe("where a photo or voice note is kept", () => {
  test("beside whatsapp/, never inside it, so the dispatcher opens the path", () => {
    expect(mediaDir("/data")).toBe("/data/wa/media")
    expect(modelPath("/data")).toBe("/data/wa/whisper-model.bin")
  })

  test.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["audio/ogg; codecs=opus", "ogg"],
    [undefined, "bin"],
    ["application/x-made-up", "bin"],
  ])("%s is kept as .%s", (mime, extension) => {
    expect(extensionOf(mime)).toBe(extension)
  })

  test.each([
    ["application/pdf", "Report.PDF", "pdf"],
    ["application/x-made-up", "plan.docx", "docx"],
    ["application/pdf", "no extension", "pdf"],
    [undefined, "no extension", "bin"],
  ])(
    "%s named %s is kept as .%s: the name's own extension wins, lowercased",
    (mime, name, extension) => {
      expect(extensionOf(mime, name)).toBe(extension)
    },
  )

  test("each one is a new file, mode 600, in a folder of mode 700", async () => {
    const dir = join(scratch(), "wa", "media")
    const at = Date.parse("2026-11-11T19:00:00Z")
    const a = await keep(dir, at, "image/jpeg", new TextEncoder().encode("one"))
    const b = await keep(dir, at, "image/jpeg", new TextEncoder().encode("two"))
    expect(a).not.toBe(b)
    expect(a).toStartWith(join(dir, "2026-11-11T19-00-00-000Z-"))
    expect(await Bun.file(a).text()).toBe("one")
    expect(statSync(a).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe("reading a voice note on this Mac", () => {
  const MODEL = "/data/wa/whisper-model.bin"
  const fake = (codes: { ffmpeg?: number; whisper?: number } = {}, words = " ship it \n") => {
    const argvs: string[][] = []
    const run: Run = async (argv) => {
      argvs.push(argv)
      if (argv[0] === "ffmpeg") {
        await Bun.write(argv.at(-1)!, "wav")
        return { code: codes.ffmpeg ?? 0, out: "" }
      }
      return { code: codes.whisper ?? 0, out: words }
    }
    return { argvs, run }
  }

  test.each(["ffmpeg", "whisper-cli"])(
    "with %s missing it runs nothing and the note goes on not transcribed",
    async (gone) => {
      const { argvs, run } = fake()
      const read = transcriber(
        MODEL,
        (c) => c !== gone,
        () => true,
        run,
      )
      expect(await read("/x/note.ogg")).toBeUndefined()
      expect(argvs).toEqual([])
    },
  )

  test("with no model it runs nothing", async () => {
    const { argvs, run } = fake()
    expect(
      await transcriber(
        MODEL,
        () => true,
        () => false,
        run,
      )("/x/note.ogg"),
    ).toBeUndefined()
    expect(argvs).toEqual([])
  })

  test("ffmpeg makes a 16 kHz wav, whisper-cli reads it with the model, and the wav is removed", async () => {
    const note = join(scratch(), "note.ogg")
    const { argvs, run } = fake()
    expect(
      await transcriber(
        MODEL,
        () => true,
        () => true,
        run,
      )(note),
    ).toBe("ship it")
    expect(argvs).toEqual([
      [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        note,
        "-ar",
        "16000",
        "-ac",
        "1",
        `${note}.wav`,
      ],
      ["whisper-cli", "-m", MODEL, "-nt", "-np", "-f", `${note}.wav`],
    ])
    expect(existsSync(`${note}.wav`)).toBe(false)
  })

  test.each([
    ["ffmpeg fails", { ffmpeg: 1 }, "words"],
    ["whisper-cli fails", { whisper: 1 }, "words"],
    ["whisper-cli hears nothing", {}, "  \n"],
  ])("%s: the note goes on not transcribed", async (_, codes, words) => {
    const note = join(scratch(), "note.ogg")
    const { run } = fake(codes, words)
    expect(
      await transcriber(
        MODEL,
        () => true,
        () => true,
        run,
      )(note),
    ).toBeUndefined()
    expect(existsSync(`${note}.wav`)).toBe(false)
  })
})

describe("whisper-cli's run", () => {
  test("keeps stdout's words alone, so the model-load log whisper-cli writes to stderr never reaches the note's line", async () => {
    const heard = await stdoutRun(10_000)([
      "sh",
      "-c",
      "echo 'whisper_init_from_file: loading model' >&2; printf ' ship it'; echo 'system_info: n_threads = 4' >&2",
    ])
    expect(heard).toEqual({ code: 0, out: " ship it" })
  })
})
