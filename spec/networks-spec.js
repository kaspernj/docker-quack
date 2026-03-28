import http from "node:http"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import Docker from "../src/index.js"

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
})
