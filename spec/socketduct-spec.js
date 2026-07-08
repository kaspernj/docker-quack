import http from "node:http"
import net from "node:net"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerOverSocketduct} from "../src/socketduct.js"

class FakeSocketductHttpAgent extends http.Agent {
  constructor(options) {
    super({keepAlive: options.keepAlive, maxSockets: options.maxSockets, maxFreeSockets: options.maxFreeSockets})
    this.options = options
    this.destroyedByClose = false
  }

  createConnection(_options, callback) {
    return net.connect({host: this.options.fakeTargetHost, port: this.options.fakeTargetPort}, callback)
  }

  destroy() {
    this.destroyedByClose = true
    super.destroy()
  }
}

function createDockerApiServer() {
  return new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      requests.push({method: req.method, url: req.url, host: req.headers.host})
      if (req.url === "/_ping") {
        res.writeHead(200, {"Content-Type": "text/plain"})
        res.end("OK")
        return
      }

      if (req.url === "/version") {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({Version: "27.1.0", ApiVersion: "1.46"}))
        return
      }

      res.writeHead(404)
      res.end("missing")
    })

    server.listen(0, "127.0.0.1", () => resolve({server, requests}))
  })
}

describe("Socketduct Docker transport", () => {
  it("opens a Docker client over a Socketduct HTTP agent", async () => {
    const {server, requests} = await createDockerApiServer()
    const fakeTargetPort = server.address().port
    const docker = openDockerOverSocketduct({
      SocketductHttpAgent: FakeSocketductHttpAgent,
      relay: {host: "127.0.0.1", port: 3100, token: "relay-token"},
      target: {host: "docker-socket-shim", port: 2375},
      spoolDirectory: "/tmp/docker-quack-socketduct-test",
      sessionNamePrefix: "docker-quack-test",
      fakeTargetHost: "127.0.0.1",
      fakeTargetPort
    })

    try {
      const ping = await docker.ping()
      const version = await docker.version()

      expect(ping).toEqual("OK")
      expect(version.ApiVersion).toEqual("1.46")
      expect(docker.connection.host).toEqual("docker-socket-shim")
      expect(docker.connection.port).toEqual(2375)
      expect(docker.connection.useTls).toEqual(false)
      expect(docker.connection.client.baseUrl).toEqual("http://docker-socket-shim:2375")
      expect(docker.socketductAgent.options.relay).toEqual({host: "127.0.0.1", port: 3100, token: "relay-token"})
      expect(docker.socketductAgent.options.target).toEqual({host: "docker-socket-shim", port: 2375})
      expect(requests.map((request) => [request.method, request.url, request.host])).toEqual([
        ["GET", "/_ping", "docker-socket-shim:2375"],
        ["GET", "/version", "docker-socket-shim:2375"]
      ])
    } finally {
      docker.close()
      expect(docker.socketductAgent.destroyedByClose).toEqual(true)
      server.close()
    }
  })
})
