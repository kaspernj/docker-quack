import http from "node:http"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import Docker from "../src/index.js"
import DockerVolumes from "../src/volumes.js"
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

describe("DockerVolumes", () => {
  it("forwards timeoutMs to every volume command request", async () => {
    const connection = new FakeDockerConnection()
    const volumes = new DockerVolumes(connection)
    const timeoutMs = 45_000

    await volumes.create({Name: "my-volume", Labels: {env: "test"}, timeoutMs})
    await volumes.remove({name: "my-volume", force: true, timeoutMs})
    await volumes.inspect({name: "my-volume", timeoutMs})
    await volumes.list({timeoutMs})
    await volumes.prune({timeoutMs})

    expect(connection.calls[0].body).toEqual({Name: "my-volume", Labels: {env: "test"}})
    expect(connection.calls.map((call) => [call.method, call.path, call.timeoutMs])).toEqual([
      ["POST", "/volumes/create", timeoutMs],
      ["DELETE", "/volumes/my-volume", timeoutMs],
      ["GET", "/volumes/my-volume", timeoutMs],
      ["GET", "/volumes", timeoutMs],
      ["POST", "/volumes/prune", timeoutMs]
    ])
  })

  it("forwards signal to every volume command request without leaking it into the body", async () => {
    const connection = new FakeDockerConnection()
    const volumes = new DockerVolumes(connection)
    const signal = new AbortController().signal

    await volumes.create({Name: "my-volume", Labels: {env: "test"}, signal})
    await volumes.remove({name: "my-volume", force: true, signal})
    await volumes.inspect({name: "my-volume", signal})
    await volumes.list({signal})
    await volumes.prune({signal})

    expect(connection.calls[0].body).toEqual({Name: "my-volume", Labels: {env: "test"}})
    expect(connection.calls.every((call) => call.signal === signal)).toEqual(true)
    expect(connection.calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/volumes/create"],
      ["DELETE", "/volumes/my-volume"],
      ["GET", "/volumes/my-volume"],
      ["GET", "/volumes"],
      ["POST", "/volumes/prune"]
    ])
  })

  it("create() sends POST /volumes/create with body", async () => {
    let captured = null
    const volumeData = {Name: "my-volume", Driver: "local", Mountpoint: "/var/lib/docker/volumes/my-volume/_data"}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 201, volumeData)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.volumes.create({Name: "my-volume", Labels: {env: "test"}})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/volumes/create")
      expect(JSON.parse(captured.body)).toEqual({Name: "my-volume", Labels: {env: "test"}})
      expect(result.Name).toEqual("my-volume")
      expect(result.Mountpoint).toEqual("/var/lib/docker/volumes/my-volume/_data")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("remove() sends DELETE /volumes/{name}", async () => {
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
      await docker.volumes.remove({name: "my-volume"})

      expect(captured.method).toEqual("DELETE")
      expect(captured.url).toEqual("/volumes/my-volume")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("inspect() sends GET /volumes/{name}", async () => {
    let captured = null
    const volumeData = {Name: "my-volume", Driver: "local", Scope: "local"}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, volumeData)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.volumes.inspect({name: "my-volume"})

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/volumes/my-volume")
      expect(result.Name).toEqual("my-volume")
      expect(result.Driver).toEqual("local")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("list() sends GET /volumes", async () => {
    let captured = null
    const volumesData = {
      Volumes: [{Name: "vol1", Driver: "local"}, {Name: "vol2", Driver: "local"}],
      Warnings: []
    }

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, volumesData)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.volumes.list()

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/volumes")
      expect(result.Volumes.length).toEqual(2)
      expect(result.Volumes[0].Name).toEqual("vol1")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends POST /volumes/prune", async () => {
    let captured = null
    const pruneResult = {
      VolumesDeleted: ["volume-abc123"],
      SpaceReclaimed: 8192
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
      const result = await docker.volumes.prune()

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/volumes/prune")
      expect(result.VolumesDeleted).toEqual(["volume-abc123"])
      expect(result.SpaceReclaimed).toEqual(8192)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends filters to POST /volumes/prune", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, {VolumesDeleted: []})
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.volumes.prune({filters: {label: ["tensorbuzz=cleanup"]}})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/volumes/prune?filters=%7B%22label%22%3A%5B%22tensorbuzz%3Dcleanup%22%5D%7D")
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
      await expect(async () => await docker.volumes.prune({timeoutMs: 50}))
        .toThrow("Docker request timed out after 50ms: POST /volumes/prune")
    } finally {
      docker.close()
      server.close()
    }
  })
})
