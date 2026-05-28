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

describe("DockerImages", () => {
  it("pull() sends POST /images/create with fromImage query param", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({status: "Pull complete"}) + "\n")
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

  it("pull() with auth sets X-Registry-Auth header", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({status: "Pull complete"}) + "\n")
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

    const server = await createMockServer((req, res) => {
      captureRequest(req, () => {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.write(JSON.stringify(progress1) + "\n")
        res.write(JSON.stringify(progress2) + "\n")
        res.write(JSON.stringify(progress3) + "\n")
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

      expect(received.length).toEqual(3)
      expect(received[0].status).toEqual("Pulling fs layer")
      expect(received[1].progressDetail.current).toEqual(1024)
      expect(received[2].status).toEqual("Pull complete")
    } finally {
      docker.close()
      server.close()
    }
  })
})
