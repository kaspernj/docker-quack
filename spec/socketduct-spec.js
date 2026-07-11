import {describe, expect, it} from "velocious/build/src/testing/test.js"

import {openDockerOverSeamline} from "../src/seamline.js"
import {openDockerOverSocketduct} from "../src/socketduct.js"

describe("Socketduct compatibility exports", () => {
  it("keeps the legacy Seamline helper path as a compatibility shim", () => {
    expect(openDockerOverSeamline).toEqual(openDockerOverSocketduct)
  })
})
