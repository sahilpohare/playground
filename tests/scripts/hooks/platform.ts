import { afterAll, beforeAll } from "bun:test"

const set = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { configurable: true, value: platform })

// Stubs the platform no-extensions-write reads for one call and restores it after, whatever the call does
export async function as<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const was = process.platform
  set(platform)
  try {
    return await run()
  } finally {
    set(was)
  }
}

// Pins the platform for a file's tests and restores it after them, since CI runs on Linux while a file's rows hold macOS's readings
export function pinPlatform(platform: NodeJS.Platform) {
  const was = process.platform
  beforeAll(() => set(platform))
  afterAll(() => set(was))
}
