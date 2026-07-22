import http from "node:http"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import Docker from "../src/index.js"
import DockerContainers from "../src/containers.js"
import DockerImages from "../src/images.js"
import DockerNetworks from "../src/networks.js"
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

function captureRequest(req, callback) {
  let body = ""

  req.on("data", (chunk) => { body += chunk })
  req.on("end", () => {
    callback({
      method: req.method,
      url: req.url,
      body
    })
  })
}

describe("Docker", () => {
  it("Docker.open() returns a Docker instance with containers, images, networks, volumes", () => {
    const docker = Docker.open({host: "127.0.0.1", port: 2375})

    try {
      expect(docker).toBeInstanceOf(Docker)
      expect(docker.containers).toBeInstanceOf(DockerContainers)
      expect(docker.images).toBeInstanceOf(DockerImages)
      expect(docker.networks).toBeInstanceOf(DockerNetworks)
      expect(docker.volumes).toBeInstanceOf(DockerVolumes)
    } finally {
      docker.close()
    }
  })

  it("Docker.open() accepts a Unix socket path", () => {
    const docker = Docker.open({host: "127.0.0.1", port: 2375, socketPath: "/var/run/docker.sock"})

    try {
      expect(docker).toBeInstanceOf(Docker)
      expect(docker.connection.socketPath).toEqual("/var/run/docker.sock")
    } finally {
      docker.close()
    }
  })

  it("forwards timeoutMs to root Docker commands", async () => {
    const connection = new FakeDockerConnection()
    const docker = new Docker(connection)
    const timeoutMs = 45_000

    await docker.ping({timeoutMs})
    await docker.version({timeoutMs})
    await docker.info({timeoutMs})

    expect(connection.calls.map((call) => [call.method, call.path, call.timeoutMs])).toEqual([
      ["GET", "/_ping", timeoutMs],
      ["GET", "/version", timeoutMs],
      ["GET", "/info", timeoutMs]
    ])
  })

  it("forwards the caller signal and timeoutMs to root Docker commands", async () => {
    const connection = new FakeDockerConnection()
    const docker = new Docker(connection)
    const controller = new AbortController()
    const signal = controller.signal
    const timeoutMs = 30_000

    await docker.ping({signal, timeoutMs})
    await docker.version({signal, timeoutMs})
    await docker.info({signal, timeoutMs})

    expect(connection.calls.map((call) => [call.method, call.path, call.signal, call.timeoutMs])).toEqual([
      ["GET", "/_ping", signal, timeoutMs],
      ["GET", "/version", signal, timeoutMs],
      ["GET", "/info", signal, timeoutMs]
    ])

    for (const call of connection.calls) {
      expect(call.signal).toBe(signal)
    }
  })

  it("omits signal from root Docker commands when none is provided", async () => {
    const connection = new FakeDockerConnection()
    const docker = new Docker(connection)

    await docker.ping()
    await docker.version()
    await docker.info()

    for (const call of connection.calls) {
      expect("signal" in call).toEqual(false)
    }
  })

  it("version() sends GET /version", async () => {
    let captured = null
    const versionData = {Version: "27.0.0", ApiVersion: "1.46", Os: "linux", Arch: "amd64"}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(versionData))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.version()

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/version")
      expect(result.Version).toEqual("27.0.0")
      expect(result.ApiVersion).toEqual("1.46")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("info() sends GET /info", async () => {
    let captured = null
    const infoData = {Containers: 5, Images: 12, OperatingSystem: "Ubuntu 24.04"}

    const server = await createMockServer((req, res) => {
      captureRequest(req, (data) => {
        captured = data
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(infoData))
      })
    })

    const port = server.address().port
    const docker = Docker.open({host: "127.0.0.1", port})

    try {
      const result = await docker.info()

      expect(captured.method).toEqual("GET")
      expect(captured.url).toEqual("/info")
      expect(result.Containers).toEqual(5)
      expect(result.OperatingSystem).toEqual("Ubuntu 24.04")
    } finally {
      docker.close()
      server.close()
    }
  })

  it("close() closes the connection", () => {
    const docker = Docker.open({host: "127.0.0.1", port: 2375})
    let closeCalled = false
    const originalClose = docker.connection.close.bind(docker.connection)

    docker.connection.close = () => {
      closeCalled = true
      originalClose()
    }

    docker.close()

    expect(closeCalled).toEqual(true)
  })
})
