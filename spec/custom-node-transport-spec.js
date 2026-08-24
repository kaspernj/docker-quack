import {describe, expect, it} from "velocious/build/src/testing/test.js"
import CustomNodeTransport from "../src/custom-node-transport.js"

describe("CustomNodeTransport", () => {
  it("defaults HTTP and HTTPS agents to keep-alive", async () => {
    const transport = new CustomNodeTransport()

    try {
      await transport._load()

      expect(transport._agent(false).options.keepAlive).toEqual(true)
      expect(transport._agent(true).options.keepAlive).toEqual(true)
    } finally {
      transport.close()
    }
  })

  it("disables keep-alive for both internally-created agents", async () => {
    const transport = new CustomNodeTransport({keepAlive: false})

    try {
      await transport._load()

      expect(transport._agent(false).options.keepAlive).toEqual(false)
      expect(transport._agent(true).options.keepAlive).toEqual(false)
    } finally {
      transport.close()
    }
  })
})
