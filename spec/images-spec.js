import http from "node:http"
import {Readable} from "node:stream"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import Docker from "../src/index.js"
import DockerImages from "../src/images.js"
import FakeDockerConnection from "./support/fake-docker-connection.js"

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)

    server.listen(0, () => {
      resolve(server)
    })
  })
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

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, {"Content-Type": "application/json"})
  res.end(JSON.stringify(body))
}

async function consumePullChunks(chunks, onProgress) {
  const images = new DockerImages(new FakeDockerConnection())

  await images.consumePullStream(Readable.from(chunks), onProgress)
}

describe("DockerImages", () => {
  class ExistingTargetFakeConnection extends FakeDockerConnection {
    constructor() {
      super()
      this.tagAttempts = 0
    }

    responseFor(options) {
      if (options.path === "/images/sha256%3Anew-image/tag") {
        this.tagAttempts += 1

        if (this.tagAttempts === 1) {
          throw new Error("image already exists")
        }

        return {}
      }

      if (options.path === "/images/sha256:new-image/json") {
        return {Id: "sha256:new-image"}
      }

      if (options.path === "/images/my-repo:latest/json") {
        return {Id: "sha256:old-image"}
      }

      if (options.path === "/images/my-repo:latest") {
        return [{Untagged: "my-repo:latest"}]
      }

      return super.responseFor(options)
    }
  }

  it("pull() sends POST /images/create with fromImage query param", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({status: "Status: Downloaded newer image for ubuntu:24.04"}) + "\n")
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.images.pull({image: "ubuntu:24.04"})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/images/create?fromImage=ubuntu%3A24.04")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("pull() defaults an untagged image to latest", async () => {
    const connection = new FakeDockerConnection()
    const images = new DockerImages(connection)

    await images.pull({image: "ubuntu"})

    expect(connection.calls[0].query).toEqual({fromImage: "ubuntu:latest"})
  })

  it("pull() does not treat a registry port as an image tag", async () => {
    const connection = new FakeDockerConnection()
    const images = new DockerImages(connection)

    await images.pull({image: "registry.example:5000/team/image"})

    expect(connection.calls[0].query).toEqual({fromImage: "registry.example:5000/team/image:latest"})
  })

  it("pull() preserves an image digest without adding latest", async () => {
    const connection = new FakeDockerConnection()
    const images = new DockerImages(connection)
    const image = `registry.example/team/image@sha256:${"a".repeat(64)}`

    await images.pull({image})

    expect(connection.calls[0].query).toEqual({fromImage: image})
  })

  it("forwards timeoutMs to every image command request", async () => {
    const connection = new FakeDockerConnection()
    const images = new DockerImages(connection)
    const timeoutMs = 45_000

    await images.pull({image: "ubuntu:24.04", timeoutMs})
    await images.inspect({name: "ubuntu:24.04", timeoutMs})
    await images.remove({name: "ubuntu:24.04", force: true, timeoutMs})
    await images.tag({source: "sha256:abc123", repo: "my-repo", tag: "latest", timeoutMs})
    await images.list({timeoutMs})
    await images.prune({timeoutMs})

    expect(connection.calls.map((call) => [call.method, call.path, call.timeoutMs])).toEqual([
      ["POST", "/images/create", timeoutMs],
      ["GET", "/images/ubuntu:24.04/json", timeoutMs],
      ["DELETE", "/images/ubuntu:24.04", timeoutMs],
      ["POST", "/images/sha256%3Aabc123/tag", timeoutMs],
      ["GET", "/images/json", timeoutMs],
      ["POST", "/images/prune", timeoutMs]
    ])
  })

  it("forwards signal to every image command request", async () => {
    const connection = new FakeDockerConnection()
    const images = new DockerImages(connection)
    const signal = new AbortController().signal

    await images.pull({image: "ubuntu:24.04", signal})
    await images.inspect({name: "ubuntu:24.04", signal})
    await images.remove({name: "ubuntu:24.04", force: true, signal})
    await images.tag({source: "sha256:abc123", repo: "my-repo", tag: "latest", signal})
    await images.list({signal})
    await images.prune({signal})

    expect(connection.calls.every((call) => call.signal === signal)).toEqual(true)
    expect(connection.calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/images/create"],
      ["GET", "/images/ubuntu:24.04/json"],
      ["DELETE", "/images/ubuntu:24.04"],
      ["POST", "/images/sha256%3Aabc123/tag"],
      ["GET", "/images/json"],
      ["POST", "/images/prune"]
    ])
  })

  it("tag() forwards signal through the existing-target replacement path", async () => {
    const connection = new ExistingTargetFakeConnection()
    const images = new DockerImages(connection)
    const signal = new AbortController().signal

    await images.tag({source: "sha256:new-image", repo: "my-repo", tag: "latest", signal})

    expect(connection.calls.every((call) => call.signal === signal)).toEqual(true)
    expect(connection.calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/images/sha256%3Anew-image/tag"],
      ["GET", "/images/sha256:new-image/json"],
      ["GET", "/images/my-repo:latest/json"],
      ["DELETE", "/images/my-repo:latest"],
      ["POST", "/images/sha256%3Anew-image/tag"]
    ])
  })

  it("pull() with auth sets X-Registry-Auth header", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({status: "Status: Downloaded newer image for private/image:latest"}) + "\n")
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const auth = {username: "user", password: "pass", serveraddress: "https://registry.example.com"}

      await docker.images.pull({image: "private/image:latest", auth})

      expect(captured.method).toEqual("POST")
      expect(captured.headers["x-registry-auth"]).not.toEqual(undefined)

      const decodedAuth = JSON.parse(Buffer.from(captured.headers["x-registry-auth"], "base64").toString("utf-8"))

      expect(decodedAuth.username).toEqual("user")
      expect(decodedAuth.password).toEqual("pass")
      expect(decodedAuth.serveraddress).toEqual("https://registry.example.com")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("inspect() sends GET /images/{name}/json", async () => {
    let captured = null
    const imageData = {Id: "sha256:abc123", RepoTags: ["ubuntu:24.04"], Size: 77800000}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(imageData))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.images.inspect({name: "ubuntu:24.04"})

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/images/ubuntu:24.04/json")
      expect(result.Id).toEqual("sha256:abc123")
      expect(result.Size).toEqual(77800000)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("remove() sends DELETE /images/{name}", async () => {
    let captured = null
    const deleteResult = [{Untagged: "ubuntu:24.04"}, {Deleted: "sha256:abc123"}]

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(deleteResult))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.images.remove({name: "ubuntu:24.04"})

      expect(captured.method).toEqual("DELETE")
      expect(captured.url).toEqual("/images/ubuntu:24.04")
      expect(result.length).toEqual(2)
      expect(result[0].Untagged).toEqual("ubuntu:24.04")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("tag() sends POST /images/{source}/tag with repo and tag query params", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(201)
        res.end()
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.images.tag({source: "sha256:abc123", repo: "my-repo", tag: "latest"})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/images/sha256%3Aabc123/tag?repo=my-repo&tag=latest")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("tag() treats an existing target tag as success when it already points at the source image", async () => {
    const requests = []

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        requests.push(data)

        if (data.method === "POST") {
          jsonResponse(res, 409, {message: "image already exists"})
        } else {
          jsonResponse(res, 200, {Id: "sha256:same-image"})
        }
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.images.tag({source: "sha256:same-image", repo: "my-repo", tag: "latest"})

      expect(requests.map((request) => [request.method, request.url])).toEqual([
        ["POST", "/images/sha256%3Asame-image/tag?repo=my-repo&tag=latest"],
        ["GET", "/images/sha256:same-image/json"],
        ["GET", "/images/my-repo:latest/json"]
      ])
    } finally {
      docker.close()
      server.close()
    }
  })

  it("tag() replaces an existing target tag when it points at a different image", async () => {
    const requests = []
    let tagAttempts = 0

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        requests.push(data)

        if (data.method === "POST" && data.url === "/images/sha256%3Anew-image/tag?repo=my-repo&tag=latest") {
          tagAttempts += 1

          if (tagAttempts === 1) {
            jsonResponse(res, 409, {message: "Tag my-repo:latest is already set to image sha256:old-image, if you want to replace it, please use -f option"})
          } else {
            res.writeHead(201)
            res.end()
          }

          return
        }

        if (data.url === "/images/sha256:new-image/json") {
          jsonResponse(res, 200, {Id: "sha256:new-image"})
        } else if (data.url === "/images/my-repo:latest/json") {
          jsonResponse(res, 200, {Id: "sha256:old-image"})
        } else if (data.url === "/images/my-repo:latest?force=true") {
          jsonResponse(res, 200, [{Untagged: "my-repo:latest"}])
        } else {
          jsonResponse(res, 500, {message: `Unexpected request: ${data.method} ${data.url}`})
        }
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.images.tag({source: "sha256:new-image", repo: "my-repo", tag: "latest"})

      expect(tagAttempts).toEqual(2)
      expect(requests.map((request) => [request.method, request.url])).toEqual([
        ["POST", "/images/sha256%3Anew-image/tag?repo=my-repo&tag=latest"],
        ["GET", "/images/sha256:new-image/json"],
        ["GET", "/images/my-repo:latest/json"],
        ["DELETE", "/images/my-repo:latest?force=true"],
        ["POST", "/images/sha256%3Anew-image/tag?repo=my-repo&tag=latest"]
      ])
    } finally {
      docker.close()
      server.close()
    }
  })

  it("tag() forwards timeoutMs through the existing-target replacement path", async () => {
    const connection = new ExistingTargetFakeConnection()
    const images = new DockerImages(connection)
    const timeoutMs = 45_000

    await images.tag({source: "sha256:new-image", repo: "my-repo", tag: "latest", timeoutMs})

    expect(connection.calls.map((call) => [call.method, call.path, call.timeoutMs])).toEqual([
      ["POST", "/images/sha256%3Anew-image/tag", timeoutMs],
      ["GET", "/images/sha256:new-image/json", timeoutMs],
      ["GET", "/images/my-repo:latest/json", timeoutMs],
      ["DELETE", "/images/my-repo:latest", timeoutMs],
      ["POST", "/images/sha256%3Anew-image/tag", timeoutMs]
    ])
  })

  it("list() sends GET /images/json", async () => {
    let captured = null
    const images = [{Id: "sha256:abc", RepoTags: ["ubuntu:24.04"]}, {Id: "sha256:def", RepoTags: ["nginx:latest"]}]

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(images))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.images.list()

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/images/json")
      expect(result.length).toEqual(2)
      expect(result[1].RepoTags[0]).toEqual("nginx:latest")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends POST /images/prune", async () => {
    let captured = null
    const pruneResult = {
      ImagesDeleted: [{Deleted: "sha256:abc"}],
      SpaceReclaimed: 4096
    }

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(pruneResult))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.images.prune()

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/images/prune")
      expect(result.ImagesDeleted).toEqual([{Deleted: "sha256:abc"}])
      expect(result.SpaceReclaimed).toEqual(4096)
    } finally {
      docker.close()
      server.close()
    }
  })

  it("prune() sends filters to POST /images/prune", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({ImagesDeleted: []}))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      await docker.images.prune({filters: {dangling: ["false"]}})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D")
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
      await expect(async () => await docker.images.prune({timeoutMs: 50}))
        .toThrow("Docker request timed out after 50ms: POST /images/prune")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("pull() with onProgress streams progress objects", async () => {
    const progress1 = {status: "Pulling fs layer", id: "abc123"}
    const progress2 = {status: "Downloading", progressDetail: {current: 1024, total: 4096}, id: "abc123"}
    const progress3 = {status: "Pull complete", id: "abc123"}
    const progress4 = {status: "Status: Downloaded newer image for alpine:3.21"}

    const server = await createMockServer((req, res) => {
      captureRequest(req, () => {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.write(JSON.stringify(progress1) + "\n")
        res.write(JSON.stringify(progress2) + "\n")
        res.write(JSON.stringify(progress3) + "\n")
        res.write(JSON.stringify(progress4) + "\n")
        res.end()
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const received = []

      await docker.images.pull({
        image: "alpine:3.21",
        onProgress: (progress) => received.push(progress)
      })

      expect(received.length).toEqual(4)
      expect(received[0].status).toEqual("Pulling fs layer")
      expect(received[1].progressDetail.current).toEqual(1024)
      expect(received[2].status).toEqual("Pull complete")
      expect(received[3].status).toEqual("Status: Downloaded newer image for alpine:3.21")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("pull stream accepts a newly-downloaded terminal result", async () => {
    await consumePullChunks([
      JSON.stringify({status: "Pull complete", id: "abc123"}) + "\n",
      JSON.stringify({status: "Status: Downloaded newer image for alpine:3.21"}) + "\n"
    ])
  })

  it("pull stream accepts an already-up-to-date terminal result", async () => {
    await consumePullChunks([
      JSON.stringify({status: "Status: Image is up to date for alpine:3.21"}) + "\n"
    ])
  })

  it("pull stream rejects progress after an earlier terminal result", async () => {
    await expect(async () => {
      await consumePullChunks([
        JSON.stringify({status: "Status: Image is up to date for alpine:3.20"}) + "\n",
        JSON.stringify({status: "Pulling fs layer", id: "abc123"}) + "\n"
      ])
    }).toThrow("Docker pull response ended before Docker reported pull completion.")
  })

  it("pull stream accepts multiple tags when the final frame is terminal", async () => {
    await consumePullChunks([
      JSON.stringify({status: "Status: Image is up to date for alpine:3.20"}) + "\n",
      JSON.stringify({status: "Pull complete", id: "abc123"}) + "\n",
      JSON.stringify({status: "Status: Downloaded newer image for alpine:3.21"}) + "\n"
    ])
  })

  it("pull stream completion is unaffected when onProgress deletes terminal status", async () => {
    await consumePullChunks([
      JSON.stringify({status: "Status: Image is up to date for alpine:3.21"}) + "\n"
    ], (progress) => {
      delete progress.status
    })
  })

  it("pull stream completion is unaffected when onProgress assigns terminal status", async () => {
    await expect(async () => {
      await consumePullChunks([
        JSON.stringify({status: "Pull complete", id: "abc123"}) + "\n"
      ], (progress) => {
        progress.status = "Status: Downloaded newer image for alpine:3.21"
      })
    }).toThrow("Docker pull response ended before Docker reported pull completion.")
  })

  it("pull stream rejects a top-level Docker error", async () => {
    await expect(async () => {
      await consumePullChunks([
        JSON.stringify({error: "manifest unknown", errorDetail: {message: "manifest unknown"}}) + "\n"
      ])
    }).toThrow("Docker pull error: manifest unknown")
  })

  it("pull stream rejects an errorDetail-only Docker error", async () => {
    await expect(async () => {
      await consumePullChunks([
        JSON.stringify({errorDetail: {message: "registry connection failed"}}) + "\n"
      ])
    }).toThrow("Docker pull error: registry connection failed")
  })

  it("pull stream decodes JSON split across arbitrary byte chunks", async () => {
    const received = []
    const payload = Buffer.from([
      JSON.stringify({status: "Pulling café layer", id: "abc123"}),
      JSON.stringify({status: "Status: Downloaded newer image for café/alpine:3.21"}),
      ""
    ].join("\n"))
    const splitIndex = payload.indexOf(Buffer.from("é")) + 1

    await consumePullChunks([payload.subarray(0, splitIndex), payload.subarray(splitIndex)], (progress) => received.push(progress))

    expect(received.map((progress) => progress.status)).toEqual([
      "Pulling café layer",
      "Status: Downloaded newer image for café/alpine:3.21"
    ])
  })

  it("pull stream parses multiple JSON frames from one chunk", async () => {
    const received = []
    const payload = [
      JSON.stringify({status: "Pulling fs layer", id: "abc123"}),
      JSON.stringify({status: "Status: Image is up to date for alpine:3.21"}),
      ""
    ].join("\n")

    await consumePullChunks([payload], (progress) => received.push(progress))

    expect(received.length).toEqual(2)
    expect(received[0].status).toEqual("Pulling fs layer")
    expect(received[1].status).toEqual("Status: Image is up to date for alpine:3.21")
  })

  it("pull stream rejects truncated terminal JSON", async () => {
    let thrownError = null

    try {
      await consumePullChunks(["{\"status\":\"Status: Downloaded newer image for alpine:3.21\""])
    } catch (error) {
      thrownError = error
    }

    expect(thrownError?.message).toContain("Docker pull response contained malformed JSON:")
  })

  it("pull stream rejects invalid UTF-8 in otherwise terminal JSON", async () => {
    const firstChunk = Buffer.concat([
      Buffer.from("{\"status\":\"Status: Downloaded newer image for alpine:"),
      Buffer.from([0xc3])
    ])
    const secondChunk = Buffer.concat([
      Buffer.from([0x28]),
      Buffer.from("\"}\n")
    ])
    let thrownError = null

    try {
      await consumePullChunks([firstChunk, secondChunk])
    } catch (error) {
      thrownError = error
    }

    expect(thrownError?.message).toContain("Docker pull response contained malformed UTF-8:")
    expect(thrownError?.cause instanceof Error).toEqual(true)
  })

  it("pull stream rejects empty EOF", async () => {
    await expect(async () => {
      await consumePullChunks([])
    }).toThrow("Docker pull response ended before Docker reported pull completion.")
  })

  it("pull stream rejects premature EOF after layer progress", async () => {
    await expect(async () => {
      await consumePullChunks([JSON.stringify({status: "Pull complete", id: "abc123"}) + "\n"])
    }).toThrow("Docker pull response ended before Docker reported pull completion.")
  })

  it("pull() preserves AbortSignal cancellation while consuming progress", async () => {
    const server = await createMockServer((_req, res) => {
      res.writeHead(200, {"Content-Type": "application/json"})
      res.write(JSON.stringify({status: "Pulling fs layer", id: "abc123"}) + "\n")
    })
    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const abortController = new AbortController()
      let pullPromise
      const firstProgress = new Promise((resolve) => {
        pullPromise = docker.images.pull({
          image: "alpine:3.21",
          signal: abortController.signal,
          onProgress: resolve
        })

        pullPromise.catch(() => {})
      })

      await firstProgress
      abortController.abort()

      await expect(async () => await pullPromise).toThrow("Request aborted.")
    } finally {
      docker.close()
      server.close()
    }
  })
})
