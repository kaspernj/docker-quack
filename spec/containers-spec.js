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

  it("commit() sends POST /commit with container, repo, tag query params", async () => {
    let captured = null

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        jsonResponse(res, 201, {Id: "sha256:newimage123"})
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.containers.commit({id: "abc123", repo: "my-repo", tag: "latest"})

      expect(captured.method).toEqual("POST")
      expect(captured.url).toEqual("/commit?container=abc123&repo=my-repo&tag=latest")
      expect(result.Id).toEqual("sha256:newimage123")
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
})
