import {readFileSync} from "node:fs"
import {describe, expect, it} from "velocious/build/src/testing/test.js"

describe("peak_flow.yml", () => {
  it("preserves active build generations when newer commits are pushed", () => {
    const config = readFileSync(new URL("../peak_flow.yml", import.meta.url), "utf8")

    expect(config).toMatch(/^cancel_superseded_builds: false$/m)
  })
})
