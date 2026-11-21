import { unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { ownFolder } from "./habits"

// The owner's photos, voice notes, videos and documents: outside the whatsapp/ folder no-raw-wa keeps every session out of, so the dispatcher opens the path its line names, and never the attachments folder (ADR 0023).
export const mediaDir = (data: string) => join(data, "wa", "media")
// whisper.cpp's model, which the owner puts here to have voice notes read as text
export const modelPath = (data: string) => join(data, "wa", "whisper-model.bin")

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
}
// A file's extension: a document's own name's, when it is a plain one, else its type's.
export const extensionOf = (mime: string | undefined, name?: string): string =>
  name?.match(/\.([a-z0-9]{1,8})$/i)?.[1]!.toLowerCase() ??
  EXTENSIONS[(mime ?? "").split(";")[0]!.trim()] ??
  "bin"

// Writes a message's bytes to a new file of the owner's alone, named by when it came, and returns its path.
export async function keep(
  dir: string,
  at: number,
  mime: string | undefined,
  bytes: Uint8Array,
  name?: string,
): Promise<string> {
  await ownFolder(dir)
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-")
  const path = join(dir, `${stamp}-${crypto.randomUUID().slice(0, 8)}.${extensionOf(mime, name)}`)
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  return path
}

export type Run = (argv: string[]) => Promise<{ code: number; out: string }>

// A run that answers with stdout alone, since whisper-cli logs its model load to stderr and the note's words are stdout's.
export const stdoutRun =
  (timeoutMs: number): Run =>
  async (argv) => {
    const proc = Bun.spawn(argv, {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
      timeout: timeoutMs,
    })
    const out = await new Response(proc.stdout).text()
    return { code: await proc.exited, out }
  }

// A voice note's or a video's words through whisper.cpp on this Mac, after ffmpeg turns it into the 16 kHz wav whisper-cli reads; undefined while ffmpeg, whisper-cli or the model is missing, or either run fails, so the note goes on not transcribed.
export const transcriber =
  (model: string, has: (command: string) => boolean, exists: (path: string) => boolean, run: Run) =>
  async (path: string): Promise<string | undefined> => {
    if (!has("ffmpeg") || !has("whisper-cli") || !exists(model)) return undefined
    const wav = `${path}.wav`
    try {
      const made = await run([
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        "-ar",
        "16000",
        "-ac",
        "1",
        wav,
      ])
      if (made.code !== 0) return undefined
      const heard = await run(["whisper-cli", "-m", model, "-nt", "-np", "-f", wav])
      const words = heard.out.trim()
      return heard.code === 0 && words ? words : undefined
    } finally {
      await unlink(wav).catch(() => {})
    }
  }
