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

describe("DockerVolumes", () => {
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
})
