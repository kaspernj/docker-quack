import http from "node:http"
import * as zlib from "node:zlib"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import DockerConnection from "../src/docker-connection.js"

const supportedResponseContentEncodings = () => [
  "gzip",
  "deflate",
  "br",
  ...(typeof zlib.createZstdDecompress === "function" ? ["zstd"] : [])
]
const supportedRequestBodyCompressionEncodings = () => [
  "gzip",
  "deflate",
  "br",
  ...(typeof zlib.createZstdCompress === "function" && typeof zlib.zstdDecompressSync === "function" ? ["zstd"] : [])
]

const decodeRequestBody = (body, encodingHeader) => {
  const encoding = Array.isArray(encodingHeader) ? encodingHeader.join(",") : encodingHeader

  if (!encoding || encoding === "identity") {
    return body
  }

  if (encoding === "gzip") {
    return zlib.gunzipSync(body)
  }

  if (encoding === "deflate") {
    return zlib.inflateSync(body)
  }

  if (encoding === "br") {
    return zlib.brotliDecompressSync(body)
  }

  if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(body)
  }

  throw new Error(`Unsupported request body encoding in spec: ${encoding}`)
}

describe("DockerConnection", () => {
  it("creates an HTTP connection", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375})

    try {
      expect(connection.host).toEqual("127.0.0.1")
      expect(connection.port).toEqual(2375)
      expect(connection.useTls).toEqual(false)
      expect(connection.socketPath).toEqual(undefined)
    } finally {
      connection.close()
    }
  })

  it("creates a Unix-socket connection", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375, socketPath: "/var/run/docker.sock"})

    try {
      expect(connection.socketPath).toEqual("/var/run/docker.sock")
      expect(connection.useTls).toEqual(false)
    } finally {
      connection.close()
    }
  })

  it("creates an HTTPS connection that forwards TLS options to the transport", () => {
    const tlsOptions = {
      ca: "fake-ca-cert",
      cert: "fake-client-cert",
      key: "fake-client-key"
    }
    const connection = new DockerConnection({host: "127.0.0.1", port: 2376, tls: tlsOptions})

    try {
      expect(connection.useTls).toEqual(true)
      expect(connection.tls).toEqual(tlsOptions)
    } finally {
      connection.close()
    }
  })

  it("forwards rejectUnauthorized=false to the transport so untrusted server certs are accepted", () => {
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
      expect(connection.tls.rejectUnauthorized).toEqual(false)
    } finally {
      connection.close()
    }
  })

  it("forwards rejectUnauthorized=true to the transport when explicitly requested", () => {
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
      expect(connection.tls.rejectUnauthorized).toEqual(true)
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

  it("requests supported response content encodings by default", async () => {
    let acceptEncoding = null

    const server = http.createServer((req, res) => {
      acceptEncoding = req.headers["accept-encoding"]
      res.writeHead(200, {"Content-Type": "application/json"})
      res.end(JSON.stringify({ApiVersion: "1.45"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      await connection.request({method: "GET", path: "/version"})

      expect(acceptEncoding).toEqual(supportedResponseContentEncodings().join(", "))
    } finally {
      connection.close()
      server.close()
    }
  })

  it("does not overwrite an explicit Accept-Encoding header", async () => {
    let acceptEncoding = null

    const server = http.createServer((req, res) => {
      acceptEncoding = req.headers["accept-encoding"]
      res.writeHead(200, {"Content-Type": "application/json"})
      res.end(JSON.stringify({ApiVersion: "1.45"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      await connection.request({
        method: "GET",
        path: "/version",
        headers: {"Accept-Encoding": "identity"}
      })

      expect(acceptEncoding).toEqual("identity")
    } finally {
      connection.close()
      server.close()
    }
  })

  it("decodes gzip and deflate buffered responses", async () => {
    let requestCount = 0
    const gzipBody = zlib.gzipSync(Buffer.from(JSON.stringify({encoding: "gzip"})))
    const deflateBody = zlib.deflateSync(Buffer.from(JSON.stringify({encoding: "deflate"})))

    const server = http.createServer((_req, res) => {
      requestCount += 1

      if (requestCount === 1) {
        res.writeHead(200, {"Content-Encoding": "gzip", "Content-Type": "application/json"})
        res.end(gzipBody)
      } else {
        res.writeHead(200, {"Content-Encoding": "deflate", "Content-Type": "application/json"})
        res.end(deflateBody)
      }
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      const gzipResult = await connection.request({method: "GET", path: "/gzip"})
      const deflateResult = await connection.request({method: "GET", path: "/deflate"})

      expect(gzipResult).toEqual({encoding: "gzip"})
      expect(deflateResult).toEqual({encoding: "deflate"})
    } finally {
      connection.close()
      server.close()
    }
  })

  it("decodes brotli and zstd buffered responses when Node supports them", async () => {
    const responseBodies = [
      {
        body: zlib.brotliCompressSync(Buffer.from(JSON.stringify({encoding: "br"}))),
        encoding: "br"
      }
    ]

    if (typeof zlib.zstdCompressSync === "function") {
      responseBodies.push({
        body: zlib.zstdCompressSync(Buffer.from(JSON.stringify({encoding: "zstd"}))),
        encoding: "zstd"
      })
    }

    let requestIndex = 0
    const server = http.createServer((_req, res) => {
      const responseBody = responseBodies[requestIndex]

      requestIndex += 1
      res.writeHead(200, {"Content-Encoding": responseBody.encoding, "Content-Type": "application/json"})
      res.end(responseBody.body)
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      for (const responseBody of responseBodies) {
        const result = await connection.request({method: "GET", path: `/${responseBody.encoding}`})

        expect(result).toEqual({encoding: responseBody.encoding})
      }
    } finally {
      connection.close()
      server.close()
    }
  })

  it("decodes gzip streaming responses before returning the stream", async () => {
    const payload = zlib.gzipSync(Buffer.from("compressed stream output"))

    const server = http.createServer((_req, res) => {
      res.writeHead(200, {"Content-Encoding": "gzip", "Content-Type": "application/vnd.docker.raw-stream"})
      res.end(payload)
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})

    try {
      const {stream} = await connection.requestStream({method: "GET", path: "/stream"})
      const chunks = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      expect(Buffer.concat(chunks).toString("utf8")).toEqual("compressed stream output")
    } finally {
      connection.close()
      server.close()
    }
  })

  it("fails clearly for unsupported response content encodings", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {"Content-Encoding": "compress", "Content-Type": "application/json"})
      res.end(JSON.stringify({ApiVersion: "1.45"}))
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})
    let thrownError = null

    try {
      await connection.request({method: "GET", path: "/version"})
    } catch (error) {
      thrownError = error
    } finally {
      connection.close()
      server.close()
    }

    expect(thrownError).not.toEqual(null)
    expect(thrownError.message).toMatch(/response content-encoding "compress"/)
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

  it("compresses request bodies when bodyCompression is set", async () => {
    const capturedRequests = []

    const server = http.createServer((req, res) => {
      const chunks = []

      req.on("data", (chunk) => {
        chunks.push(chunk)
      })
      req.on("end", () => {
        const decodedBody = decodeRequestBody(Buffer.concat(chunks), req.headers["content-encoding"])

        capturedRequests.push({
          contentEncoding: req.headers["content-encoding"],
          contentLength: req.headers["content-length"],
          parsedBody: JSON.parse(decodedBody.toString("utf-8"))
        })
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({ok: true}))
      })
    })

    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const connection = new DockerConnection({host: "127.0.0.1", port})
    const encodings = supportedRequestBodyCompressionEncodings()

    try {
      for (const encoding of encodings) {
        const result = await connection.request({
          method: "POST",
          path: `/containers/create/${encoding}`,
          body: {Image: `ubuntu:${encoding}`},
          bodyCompression: encoding
        })

        expect(result).toEqual({ok: true})
      }

      expect(capturedRequests.map((request) => request.contentEncoding)).toEqual(encodings)
      expect(capturedRequests.map((request) => request.contentLength)).toEqual(encodings.map(() => undefined))
      expect(capturedRequests.map((request) => request.parsedBody)).toEqual(encodings.map((encoding) => ({Image: `ubuntu:${encoding}`})))
    } finally {
      connection.close()
      server.close()
    }
  })

  it("does not combine bodyCompression with an explicit Content-Encoding header", async () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375})
    let thrownError = null

    try {
      await connection.request({
        method: "POST",
        path: "/containers/create",
        body: {Image: "ubuntu:24.04"},
        bodyCompression: "gzip",
        headers: {"Content-Encoding": "gzip"}
      })
    } catch (error) {
      thrownError = error
    } finally {
      connection.close()
    }

    expect(thrownError).not.toEqual(null)
    expect(thrownError.message).toMatch(/cannot combine bodyCompression with an explicit Content-Encoding header/i)
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

  it("preserves explicit zero retry options", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375})

    try {
      expect(connection.normalizedRetryOptions({tries: 0, waitMs: 0})).toEqual({tries: 0, waitMs: 0})
    } finally {
      connection.close()
    }
  })

  it("passes explicit zero retry wait through to the retry delay", async () => {
    let attempts = 0
    const retryWaits = []

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

    connection.wait = async (waitMs) => {
      retryWaits.push(waitMs)
    }

    try {
      const result = await connection.request({
        method: "POST",
        path: "/commit",
        retry: {tries: 2, waitMs: 0}
      })

      expect(attempts).toEqual(2)
      expect(retryWaits).toEqual([0])
      expect(result.Id).toEqual("sha256:retry-success")
    } finally {
      connection.close()
      server.close()
    }
  })

  it("does not retry persistent Docker API 500 errors when retry is enabled", async () => {
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
        await connection.request({
          method: "POST",
          path: "/commit",
          retry: {tries: 2, waitMs: 0}
        })
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

  it("close() closes the underlying transport", () => {
    const connection = new DockerConnection({host: "127.0.0.1", port: 2375})
    let closeCalled = false
    const originalClose = connection.client.close.bind(connection.client)

    connection.client.close = () => {
      closeCalled = true
      originalClose()
    }

    connection.close()

    expect(closeCalled).toEqual(true)
  })
})
