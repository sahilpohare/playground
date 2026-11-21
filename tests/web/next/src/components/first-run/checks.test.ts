import { describe, expect, test } from "bun:test"

import { NO_API } from "../../../../../../web/next/src/components/first-run/checks"

// A browser that does not trust portless's CA fails every fetch to the API's host as one that never answered, so the words first run shows then name the certificate beside a restart.
describe("the words for an API that did not answer", () => {
  test("name an untrusted certificate and where to read the fix", () => {
    expect(NO_API).toContain("did not answer")
    expect(NO_API).toContain("certificate")
    expect(NO_API).toContain("Troubleshooting")
  })
})
