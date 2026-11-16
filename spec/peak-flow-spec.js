import {readFileSync} from "node:fs"
import {describe, expect, it} from "velocious/build/src/testing/test.js"

describe("peak_flow.yml", () => {
  it("preserves active build generations when newer commits are pushed", () => {
    const config = readFileSync(new URL("../peak_flow.yml", import.meta.url), "utf8")

    expect(config).toMatch(/^cancel_superseded_builds: false$/m)
  })

  it("uses the path-filtered builds schema for the single build lane", () => {
    const config = readFileSync(new URL("../peak_flow.yml", import.meta.url), "utf8")

    expect(config).toMatch(/^builds:\n[ ]{2}build_1:\n[ ]{4}paths:\n[ ]{6}- "\*\*"$/m)
    expect(config).not.toMatch(/^dependency_roots:/m)
    expect(config).not.toMatch(/^services:/m)
  })
})
