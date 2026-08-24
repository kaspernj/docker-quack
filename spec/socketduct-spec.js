import http from "node:http"
import {describe, expect, it} from "velocious/build/src/testing/test.js"

import {openDockerOverSeamline} from "../src/seamline.js"
import {openDockerOverSocketduct} from "../src/socketduct.js"

describe("Socketduct compatibility exports", () => {
  it("keeps the legacy Seamline helper path as a compatibility shim", () => {
    expect(openDockerOverSeamline).toEqual(openDockerOverSocketduct)
  })

  it("forwards explicit keep-alive configuration to the Socketduct and Docker transports", () => {
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super({keepAlive: options.keepAlive})
        this.receivedOptions = options
      }
    }
    const docker = openDockerOverSocketduct({
      SocketductHttpAgent: FakeSocketductHttpAgent,
      keepAlive: false,
      relay: {host: "relay.example.test", port: 3100, token: "test-token"},
      spoolDirectory: "/tmp/docker-quack-socketduct-spec",
      target: {host: "docker.example.test", port: 2375}
    })

    try {
      expect(docker.socketductAgent.receivedOptions.keepAlive).toEqual(false)
      expect(docker.connection.client._transportPreference.keepAlive).toEqual(false)
    } finally {
      docker.close()
    }
  })
})
