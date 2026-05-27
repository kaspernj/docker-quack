import http from "node:http"
import {gunzipSync} from "node:zlib"
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
  const chunks = []

  req.on("data", (chunk) => { chunks.push(chunk) })
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(chunks)

    callback({
      method: req.method,
      url: req.url,
      body: bodyBuffer.toString("utf8"),
      bodyBuffer,
      headers: req.headers
    })
  })
}

describe("DockerContainers", () => {
  it("create() sends POST /containers/create with query name and body", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 201, {Id: "container-123"})
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.create({name: "my-container", Image: "ubuntu:24.04", Cmd: ["/bin/bash"]})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/containers/create?name=my-container")
      expect(JSON.parse(captured.body)).toEqual({Image: "ubuntu:24.04", Cmd: ["/bin/bash"]})
      expect(result.Id).toEqual("container-123")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("start() sends POST /containers/{id}/start", async () => {
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
      await docker.containers.start({id: "abc123"})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/containers/abc123/start")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("stop() sends POST /containers/{id}/stop", async () => {
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
      await docker.containers.stop({id: "abc123"})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/containers/abc123/stop")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("stop() derives a per-request timeout with headroom above the grace period", () => {
    const docker = Docker.open({host: "127.0.0.1", port: 2375, timeoutMs: 120_000})

    try {
      // No grace period falls back to the connection's default timeout.
      expect(docker.containers.stopRequestTimeoutMs({})).toEqual(120_000)
      // A grace period longer than the default is not cut short: it gets the
      // grace period plus the default as headroom.
      expect(docker.containers.stopRequestTimeoutMs({t: 300})).toEqual(300 * 1000 + 120_000)
      // An explicit timeoutMs override wins.
      expect(docker.containers.stopRequestTimeoutMs({t: 300, timeoutMs: 5_000})).toEqual(5_000)
    } finally {
      docker.close()
    }
  })

  it("stop() keeps timeouts disabled when the connection disables them", () => {
    const docker = Docker.open({host: "127.0.0.1", port: 2375, timeoutMs: 0})

    try {
      expect(docker.containers.stopRequestTimeoutMs({t: 300})).toEqual(0)
    } finally {
      docker.close()
    }
  })

  it("remove() sends DELETE /containers/{id}", async () => {
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
      await docker.containers.remove({id: "abc123"})

      expect(captured.method).toEqual("DELETE")
      expect(captured.url).toEqual("/containers/abc123")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("remove({force: true}) sends DELETE /containers/{id}?force=true", async () => {
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
      await docker.containers.remove({id: "abc123", force: true})

      expect(captured.method).toEqual("DELETE")
      expect(captured.url).toEqual("/containers/abc123?force=true")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("inspect() sends GET /containers/{id}/json", async () => {
    let captured = null
    const inspectData = {Id: "abc123", Name: "/my-container", State: {Status: "running"}}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, inspectData)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.inspect({id: "abc123"})

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/containers/abc123/json")
      expect(result.Id).toEqual("abc123")
      expect(result.State.Status).toEqual("running")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("commit() commits anonymously and tags the returned image ID", async () => {
    const requests = []

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        requests.push(data)

        if (data.url === "/commit?container=abc123") {
          jsonResponse(res, 201, {Id: "sha256:newimage123"})
        } else {
          res.writeHead(201)
          res.end()
        }
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.commit({id: "abc123", repo: "my-repo", tag: "latest"})

      expect(requests.map((request) => [request.method, request.url])).toEqual([
        ["POST", "/commit?container=abc123"],
        ["POST", "/images/sha256%3Anewimage123/tag?repo=my-repo&tag=latest"]
      ])
      expect(result.Id).toEqual("sha256:newimage123")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("commit() retries transient Docker API failures", async () => {
    const requests = []

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        requests.push(data)

        if (data.url === "/commit?container=abc123" && requests.length === 1) {
          jsonResponse(res, 500, {message: "failed to export layer: CreateDiff: failed to commit: no such file or directory"})
        } else if (data.url === "/commit?container=abc123") {
          jsonResponse(res, 201, {Id: "sha256:committed-after-retry"})
        } else {
          res.writeHead(201)
          res.end()
        }
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.commit({id: "abc123", repo: "my-repo", tag: "latest"})

      expect(requests.map((request) => request.url)).toEqual([
        "/commit?container=abc123",
        "/commit?container=abc123",
        "/images/sha256%3Acommitted-after-retry/tag?repo=my-repo&tag=latest"
      ])
      expect(result.Id).toEqual("sha256:committed-after-retry")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("putArchive() gzips archive uploads by default", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200)
        res.end()
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.containers.putArchive({
        id: "abc123",
        path: "/tmp",
        archive: Buffer.from("tar payload")
      })

      expect(captured.method).toEqual("PUT")
      expect(captured.url).toEqual("/containers/abc123/archive?path=%2Ftmp")
      expect(captured.headers["content-type"]).toEqual("application/x-tar")
      expect(gunzipSync(captured.bodyBuffer).toString("utf8")).toEqual("tar payload")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("putArchive() supports identity archive uploads", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200)
        res.end()
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.containers.putArchive({
        id: "abc123",
        path: "/tmp",
        archive: Buffer.from("tar payload"),
        archiveCompression: "identity"
      })

      expect(captured.method).toEqual("PUT")
      expect(captured.url).toEqual("/containers/abc123/archive?path=%2Ftmp")
      expect(captured.headers["content-type"]).toEqual("application/x-tar")
      expect(captured.bodyBuffer.toString("utf8")).toEqual("tar payload")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("list() sends GET /containers/json", async () => {
    let captured = null
    const containers = [{Id: "abc123", Names: ["/container1"]}, {Id: "def456", Names: ["/container2"]}]

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, containers)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.list()

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/containers/json")
      expect(result.length).toEqual(2)
      expect(result[0].Id).toEqual("abc123")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends POST /containers/prune", async () => {
    let captured = null
    const pruneResult = {
      ContainersDeleted: ["container-abc123"],
      SpaceReclaimed: 2048
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
      const result = await docker.containers.prune()

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/containers/prune")
      expect(result.ContainersDeleted).toEqual(["container-abc123"])
      expect(result.SpaceReclaimed).toEqual(2048)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends filters to POST /containers/prune", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, {ContainersDeleted: []})
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.containers.prune({filters: {label: ["tensorbuzz=cleanup"]}})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/containers/prune?filters=%7B%22label%22%3A%5B%22tensorbuzz%3Dcleanup%22%5D%7D")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("stats() sends GET /containers/{id}/stats?stream=false", async () => {
    let captured = null
    const statsData = {cpu_stats: {cpu_usage: {total_usage: 1000}}, memory_stats: {usage: 2048}}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 200, statsData)
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.stats({id: "abc123"})

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/containers/abc123/stats?stream=false")
      expect(result.memory_stats.usage).toEqual(2048)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("exec() with onOutput streams frames without buffering", async () => {
    // Build a multiplexed exec response: stdout frame "hello\n", stderr frame "warn\n"
    const stdoutPayload = Buffer.from("hello\n")
    const stderrPayload = Buffer.from("warn\n")
    const frame1 = Buffer.alloc(8 + stdoutPayload.length)

    frame1.writeUInt8(1, 0)
    frame1.writeUInt32BE(stdoutPayload.length, 4)
    stdoutPayload.copy(frame1, 8)

    const frame2 = Buffer.alloc(8 + stderrPayload.length)

    frame2.writeUInt8(2, 0)
    frame2.writeUInt32BE(stderrPayload.length, 4)
    stderrPayload.copy(frame2, 8)

    const execId = "exec-stream-123"
    let requestCount = 0

    const server = await createMockServer((req, res) => {
      captureRequest(req, () => {
        requestCount++

        if (requestCount === 1) {
          // exec create
          jsonResponse(res, 201, {Id: execId})
        } else if (requestCount === 2) {
          // exec start - send multiplexed stream
          res.writeHead(200, {"Content-Type": "application/vnd.docker.raw-stream"})
          res.write(frame1)
          res.write(frame2)
          res.end()
        } else {
          // exec inspect
          jsonResponse(res, 200, {ExitCode: 0})
        }
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const chunks = []
      const result = await docker.containers.exec({
        id: "abc123",
        Cmd: ["echo", "hello"],
        onOutput: (output) => chunks.push(output)
      })

      expect(chunks.length).toEqual(2)
      expect(chunks[0].stream).toEqual("stdout")
      expect(chunks[0].data).toEqual("hello\n")
      expect(chunks[1].stream).toEqual("stderr")
      expect(chunks[1].data).toEqual("warn\n")

      // When onOutput is provided, stdout/stderr are not accumulated
      expect(result.stdout).toEqual("")
      expect(result.stderr).toEqual("")
      expect(result.exitCode).toEqual(0)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("logs() with onOutput streams frames without buffering", async () => {
    // Build multiplexed log frames
    const payload1 = Buffer.from("line1\n")
    const payload2 = Buffer.from("line2\n")
    const frame1 = Buffer.alloc(8 + payload1.length)

    frame1.writeUInt8(1, 0)
    frame1.writeUInt32BE(payload1.length, 4)
    payload1.copy(frame1, 8)

    const frame2 = Buffer.alloc(8 + payload2.length)

    frame2.writeUInt8(1, 0)
    frame2.writeUInt32BE(payload2.length, 4)
    payload2.copy(frame2, 8)

    const server = await createMockServer((req, res) => {
      captureRequest(req, () => {
        res.writeHead(200, {"Content-Type": "application/vnd.docker.raw-stream"})
        res.write(frame1)
        res.write(frame2)
        res.end()
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const chunks = []
      const result = await docker.containers.logs({
        id: "abc123",
        onOutput: (output) => chunks.push(output)
      })

      expect(chunks.length).toEqual(2)
      expect(chunks[0].data).toEqual("line1\n")
      expect(chunks[1].data).toEqual("line2\n")

      // When onOutput is provided, result is empty
      expect(result).toEqual("")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("logs() sends follow and since while aborting live streams without buffering", async () => {
    const payload = Buffer.from("live line\n")
    const frame = Buffer.alloc(8 + payload.length)
    let capturedUrl = null

    frame.writeUInt8(1, 0)
    frame.writeUInt32BE(payload.length, 4)
    payload.copy(frame, 8)

    const server = await createMockServer((req, res) => {
      capturedUrl = req.url
      res.writeHead(200, {"Content-Type": "application/vnd.docker.raw-stream"})
      res.write(frame)
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const abortController = new AbortController()
      const chunks = []
      let logsPromise
      const firstChunk = new Promise((resolve) => {
        logsPromise = docker.containers.logs({
          id: "abc123",
          follow: true,
          since: 12345,
          signal: abortController.signal,
          onOutput: (output) => {
            chunks.push(output)
            resolve()
          }
        })

        logsPromise.catch(() => {})
      })

      await firstChunk
      abortController.abort()

      let thrownError = null

      try {
        await logsPromise
      } catch (error) {
        thrownError = error
      }

      expect(capturedUrl).toEqual("/containers/abc123/logs?stdout=true&stderr=true&follow=true&since=12345")
      expect(chunks).toEqual([{stream: "stdout", data: "live line\n"}])
      expect(thrownError?.message).toContain("aborted")
    } finally {
      docker.close()
      server.close()
    }
  })
})
