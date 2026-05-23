import http from "node:http"
import * as https from "node:https"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import DockerConnection from "../src/docker-connection.js"

describe("DockerConnection", () => {
  it("creates an HTTP connection with keep-alive", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375})

    try {
      expect(connection.host).toEqual("127.0.0.1")
      expect(connection.port).toEqual(2375)
      expect(connection.useTls).toEqual(false)
      expect(connection.agent).toBeInstanceOf(http.Agent)
      expect(connection.agent.keepAlive).toEqual(true)
    } finally {
      connection.close()
    }
  })

  it("creates a Unix-socket connection with keep-alive", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375, socketPath: "/var/run/docker.sock"})

    try {
      expect(connection.socketPath).toEqual("/var/run/docker.sock")
      expect(connection.useTls).toEqual(false)
      expect(connection.agent).toBeInstanceOf(http.Agent)
      expect(connection.agent.keepAlive).toEqual(true)
    } finally {
      connection.close()
    }
  })

  it("creates an HTTPS connection with TLS options", () => {
    const tlsOptions = {
      ca: "fake-ca-cert",
      cert: "fake-client-cert",
      key: "fake-client-key"
    }
    const connection = new DockerConnection({host: "127.0.0.1", port: 2376, tls: tlsOptions})

    try {
      expect(connection.useTls).toEqual(true)
      expect(connection.agent.keepAlive).toEqual(true)
      expect(connection.agent.constructor.name).toEqual("Agent")
      expect(connection.httpModule.request).toEqual(https.request)
      expect(connection.agent.options.rejectUnauthorized).toEqual(undefined)
    } finally {
      connection.close()
    }
  })

  it("forwards rejectUnauthorized=false to the https.Agent so untrusted server certs are accepted", () => {
    const connection = new DockerConnection({
      host: "127.0.0.1",
      port: 2376,
      tls: {
        ca: "fake-ca-cert",
        cert: "fake-client-cert",
        key: "fake-client-key",
        rejectUnauthorized: false
      }
    })

    try {
      expect(connection.useTls).toEqual(true)
      expect(connection.agent.options.rejectUnauthorized).toEqual(false)
    } finally {
      connection.close()
    }
  })

  it("forwards rejectUnauthorized=true to the https.Agent when explicitly requested", () => {
    const connection = new DockerConnection({
      host: "127.0.0.1",
      port: 2376,
      tls: {
        ca: "fake-ca-cert",
        cert: "fake-client-cert",
        key: "fake-client-key",
        rejectUnauthorized: true
      }
    })

    try {
      expect(connection.agent.options.rejectUnauthorized).toEqual(true)
    } finally {
      connection.close()
    }
  })

  it("makes a GET request and parses JSON response", async () => {
    let capturedRequest = null

    const server = http.createServer((req, res) => {
      capturedRequest = {method: req.method, url: req.url}
      res.writeHead(200, {"Content-Type": "application/json"})
      res.end(JSON.stringify({ApiVersion: "1.45"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      const result = await connection.request({method: "GET", path: "/version"})

      expect(capturedRequest.method).toEqual("GET")
      expect(capturedRequest.url).toEqual("/version")
      expect(result.ApiVersion).toEqual("1.45")
    } finally {
      connection.close()
      server.close()
    }
  })

  it("makes a POST request with JSON body", async () => {
    let capturedRequest = null

    const server = http.createServer((req, res) => {
      let body = ""

      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        capturedRequest = {
          method: req.method,
          url: req.url,
          body,
          contentType: req.headers["content-type"]
        }
        res.writeHead(201, {"Content-Type": "application/json"})
        res.end(JSON.stringify({Id: "abc123"}))
      })
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      const result = await connection.request({
        method: "POST",
        path: "/containers/create",
        query: {name: "test-container"},
        body: {Image: "ubuntu:24.04"}
      })

      expect(capturedRequest.method).toEqual("POST")
      expect(capturedRequest.url).toEqual("/containers/create?name=test-container")
      expect(capturedRequest.contentType).toEqual("application/json")
      expect(JSON.parse(capturedRequest.body)).toEqual({Image: "ubuntu:24.04"})
      expect(result.Id).toEqual("abc123")
    } finally {
      connection.close()
      server.close()
    }
  })

  it("handles 404 error responses by throwing with status and message", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, {"Content-Type": "application/json"})
      res.end(JSON.stringify({message: "No such container"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      let thrownError = null

      try {
        await connection.request({method: "GET", path: "/containers/missing/json"})
      } catch (error) {
        thrownError = error
      }

      expect(thrownError).not.toEqual(null)
      expect(thrownError.message).toMatch(/404/)
      expect(thrownError.message).toMatch(/No such container/)
    } finally {
      connection.close()
      server.close()
    }
  })

  it("handles 500 error responses by throwing with status and message", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, {"Content-Type": "application/json"})
      res.end(JSON.stringify({message: "server error"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      let thrownError = null

      try {
        await connection.request({method: "DELETE", path: "/containers/abc123"})
      } catch (error) {
        thrownError = error
      }

      expect(thrownError).not.toEqual(null)
      expect(thrownError.message).toMatch(/500/)
      expect(thrownError.message).toMatch(/server error/)
    } finally {
      connection.close()
      server.close()
    }
  })

  it("retries retryable Docker API errors when retry is enabled", async () => {
    let attempts = 0

    const server = http.createServer((_req, res) => {
      attempts += 1

      if (attempts === 1) {
        res.writeHead(500, {"Content-Type": "application/json"})
        res.end(JSON.stringify({message: "failed to export layer: CreateDiff: failed to commit: no such file or directory"}))
      } else {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({Id: "sha256:retry-success"}))
      }
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      const result = await connection.request({
        method: "POST",
        path: "/commit",
        retry: {tries: 2, waitMs: 1}
      })

      expect(attempts).toEqual(2)
      expect(result.Id).toEqual("sha256:retry-success")
    } finally {
      connection.close()
      server.close()
    }
  })

  it("does not retry Docker API errors when retry is disabled", async () => {
    let attempts = 0

    const server = http.createServer((_req, res) => {
      attempts += 1
      res.writeHead(500, {"Content-Type": "application/json"})
      res.end(JSON.stringify({message: "server error"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      let thrownError = null

      try {
        await connection.request({method: "POST", path: "/commit"})
      } catch (error) {
        thrownError = error
      }

      expect(attempts).toEqual(1)
      expect(thrownError).not.toEqual(null)
      expect(thrownError.message).toMatch(/server error/)
    } finally {
      connection.close()
      server.close()
    }
  })

  it("close() destroys the agent", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375})
    let destroyCalled = false
    const originalDestroy = connection.agent.destroy.bind(connection.agent)

    connection.agent.destroy = () => {
      destroyCalled = true
      originalDestroy()
    }

    connection.close()

    expect(destroyCalled).toEqual(true)
  })
})
