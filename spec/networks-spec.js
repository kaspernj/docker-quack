import http from "node:http"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import Docker from "../src/index.js"
import DockerNetworks from "../src/networks.js"
import FakeDockerConnection from "./support/fake-docker-connection.js"

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)

    server.listen(0, () => {
      resolve(server)
    })
  })
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, {"Content-Type": "application/json"})
  res.end(JSON.stringify(body))
}

function captureRequest(req, callback) {
  let body = ""

  req.on("data", (chunk) => { body += chunk })
  req.on("end", () => {
    callback({
      method: req.method,
      url: req.url,
      body,
      headers: req.headers
    })
  })
}

describe("DockerNetworks", () => {
  it("forwards timeoutMs to every network command request", async () => {
    const connection = new FakeDockerConnection()
    const networks = new DockerNetworks(connection)
    const timeoutMs = 45_000

    await networks.create({Name: "my-network", Driver: "bridge", timeoutMs})
    await networks.remove({id: "network-123", timeoutMs})
    await networks.inspect({id: "network-123", timeoutMs})
    await networks.list({timeoutMs})
    await networks.prune({timeoutMs})

    expect(connection.calls[0].body).toEqual({Name: "my-network", Driver: "bridge"})
    expect(connection.calls.map((call) => [call.method, call.path, call.timeoutMs])).toEqual([
      ["POST", "/networks/create", timeoutMs],
      ["DELETE", "/networks/network-123", timeoutMs],
      ["GET", "/networks/network-123", timeoutMs],
      ["GET", "/networks", timeoutMs],
      ["POST", "/networks/prune", timeoutMs]
    ])
  })

  it("create() sends POST /networks/create with body", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 201, {Id: "network-abc123"})
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.networks.create({Name: "my-network", Driver: "bridge"})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/networks/create")
      expect(JSON.parse(captured.body)).toEqual({Name: "my-network", Driver: "bridge"})
      expect(result.Id).toEqual("network-abc123")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("remove() sends DELETE /networks/{id}", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(204)
        res.end()
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.networks.remove({id: "network-abc123"})

      expect(captured.method).toEqual("DELETE")
      expect(captured.url).toEqual("/networks/network-abc123")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("inspect() sends GET /networks/{id}", async () => {
    let captured = null
    const networkData = {Id: "network-abc123", Name: "my-network", Driver: "bridge", Scope: "local"}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, networkData)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.networks.inspect({id: "network-abc123"})

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/networks/network-abc123")
      expect(result.Name).toEqual("my-network")
      expect(result.Driver).toEqual("bridge")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("list() sends GET /networks", async () => {
    let captured = null
    const networks = [
      {Id: "net1", Name: "bridge", Driver: "bridge"},
      {Id: "net2", Name: "host", Driver: "host"}
    ]

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, networks)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.networks.list()

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/networks")
      expect(result.length).toEqual(2)
      expect(result[0].Name).toEqual("bridge")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends POST /networks/prune", async () => {
    let captured = null
    const pruneResult = {
      NetworksDeleted: ["tensorbuzz-build-old"],
      SpaceReclaimed: 0
    }

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, pruneResult)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.networks.prune()

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/networks/prune")
      expect(result.NetworksDeleted).toEqual(["tensorbuzz-build-old"])
      expect(result.SpaceReclaimed).toEqual(0)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends filters to POST /networks/prune", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, {NetworksDeleted: []})
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.networks.prune({filters: {until: ["10m"]}})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/networks/prune?filters=%7B%22until%22%3A%5B%2210m%22%5D%7D")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() accepts a per-request timeout", async () => {
    const server = await createMockServer(() => {
      // Intentionally never respond so the prune request uses its override.
    })
    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port, timeoutMs: 120_000})

    try {
      await expect(async () => await docker.networks.prune({timeoutMs: 50}))
        .toThrow("Docker request timed out after 50ms: POST /networks/prune")
    } finally {
      docker.close()
      server.close()
    }
  })
})
