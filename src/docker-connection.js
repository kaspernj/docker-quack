import {Readable} from "node:stream"
import * as http from "node:http"
import * as https from "node:https"
import * as zlib from "node:zlib"

/**
 * @typedef {object} TlsOptions
 * @property {string | Buffer} ca - CA certificate
 * @property {string | Buffer} cert - Client certificate
 * @property {string | Buffer} key - Client key
 * @property {boolean} [rejectUnauthorized] - When false, accept the daemon's
 *   server certificate without verifying its CA chain or `serverAuth` purpose.
 *   Mirrors `tls.connect`'s option of the same name. Defaults to true. Set to
 *   false when talking to a Docker daemon whose TLS material does not satisfy
 *   strict server-cert checks (for example, daemons that present the CA cert
 *   itself as the server cert) but is still trusted because it lives behind
 *   client-certificate auth.
 */

/**
 * @typedef {object} ConnectionOptions
 * @property {string} host - Docker host
 * @property {number} port - Docker port
 * @property {string} [socketPath] - Unix socket path for local Docker daemons
 * @property {TlsOptions} [tls] - TLS options for HTTPS connections
 */

/**
 * @typedef {"identity" | "gzip" | "deflate" | "br" | "zstd"} CompressionEncoding
 */

/**
 * @typedef {object} RequestOptions
 * @property {string} method - HTTP method
 * @property {string} path - Request path
 * @property {object} [query] - Query parameters
 * @property {object | Buffer | import("node:stream").Readable} [body] - Request body
 * @property {CompressionEncoding} [bodyCompression] - Optional HTTP request body compression
 * @property {object} [headers] - Additional headers
 * @property {AbortSignal} [signal] - Optional abort signal for streaming requests
 * @property {boolean | RetryOptions} [retry] - Retry transient Docker API or connection failures
 */

/**
 * @typedef {object} RetryOptions
 * @property {number} [tries] - Maximum attempts. Defaults to 3.
 * @property {number} [waitMs] - Delay between attempts. Defaults to 500ms.
 */

const RETRYABLE_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOENT", "ETIMEDOUT", "EPIPE"])
const RETRYABLE_DOCKER_API_STATUS_CODES = new Set([502, 503, 504])
const DEFAULT_ACCEPT_ENCODING = ["gzip", "deflate", "br", ...(typeof zlib.createZstdDecompress === "function" ? ["zstd"] : [])].join(", ")

/** Docker Engine API error with status metadata. */
export class DockerApiError extends Error {
  /**
   * @param {{message: string, method: string, path: string, responseMessage: string, statusCode: number}} options
   */
  constructor(options) {
    super(options.message)
    this.name = "DockerApiError"
    this.method = options.method
    this.path = options.path
    this.responseMessage = options.responseMessage
    this.statusCode = options.statusCode
  }
}

/** Low-level HTTP/HTTPS client with keep-alive for the Docker Engine API. */
class DockerConnection {
  /**
   * @param {ConnectionOptions} options
   */
  constructor(options) {
    this.host = options.host
    this.port = options.port
    this.socketPath = options.socketPath
    this.useTls = !!options.tls

    if (this.useTls) {
      this.agent = new https.Agent({
        keepAlive: true,
        ca: options.tls.ca,
        cert: options.tls.cert,
        key: options.tls.key,
        ...(options.tls.rejectUnauthorized !== undefined ? {rejectUnauthorized: options.tls.rejectUnauthorized} : {})
      })
    } else {
      this.agent = new http.Agent({keepAlive: true})
    }

    this.httpModule = this.useTls ? https : http
  }

  /**
   * Build full request path including query parameters.
   * @param {string} path - Base path
   * @param {Record<string, string | number | boolean>} [query] - Query params
   * @returns {string}
   */
  buildPath(path, query) {
    if (!query) return path

    const params = new URLSearchParams()

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value))
      }
    }

    const queryString = params.toString()

    if (!queryString) return path

    return `${path}?${queryString}`
  }

  /**
   * Perform an HTTP request and return the parsed JSON response.
   * @param {RequestOptions} options
   * @returns {Promise<any>}
   */
  async request(options) {
    const buffer = await this.requestRaw(options)
    const text = buffer.toString("utf-8")

    if (!text) return null

    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * Perform an HTTP request and return the raw Buffer response.
   * @param {RequestOptions} options
   * @returns {Promise<Buffer>}
   */
  async requestRaw(options) {
    const retryOptions = this.normalizedRetryOptions(options.retry)
    const shouldRetry = retryOptions && !this.hasStreamingBody(options)
    const tries = shouldRetry ? retryOptions.tries : 1

    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        return await this.requestRawOnce(options)
      } catch (error) {
        if (
          attempt >= tries ||
          !this.retryableError(error)
        ) {
          throw error
        }

        await this.wait(retryOptions.waitMs)
      }
    }

    throw new Error("Docker request retry loop exited unexpectedly.")
  }

  /**
   * Perform one HTTP request attempt and return the raw Buffer response.
   * @param {RequestOptions} options
   * @returns {Promise<Buffer>}
   */
  requestRawOnce(options) {
    return new Promise((resolve, reject) => {
      const fullPath = this.buildPath(options.path, options.query)
      const headers = this.requestHeaders(options.headers)
      const requestBody = this.prepareRequestBody({
        body: options.body,
        bodyCompression: options.bodyCompression,
        headers,
        streamBody: true
      })

      const requestOptions = {
        path: fullPath,
        method: options.method,
        agent: this.agent,
        headers
      }

      if (this.socketPath) {
        requestOptions.socketPath = this.socketPath
      } else {
        requestOptions.hostname = this.host
        requestOptions.port = this.port
      }

      const req = this.httpModule.request(requestOptions, (res) => {
        let responseStream

        try {
          responseStream = this.decodedResponseStream(res)
        } catch (error) {
          reject(error)
          return
        }

        const chunks = []

        responseStream.on("data", (chunk) => {
          chunks.push(chunk)
        })

        responseStream.on("end", () => {
          const buffer = Buffer.concat(chunks)

          if (res.statusCode >= 400) {
            let message

            try {
              const parsed = JSON.parse(buffer.toString("utf-8"))
              message = parsed.message || buffer.toString("utf-8")
            } catch {
              message = buffer.toString("utf-8")
            }

            reject(new DockerApiError({
              message: `Docker API error ${res.statusCode} ${options.method} ${fullPath}: ${message}`,
              method: options.method,
              path: fullPath,
              responseMessage: message,
              statusCode: res.statusCode
            }))
            return
          }

          resolve(buffer)
        })

        responseStream.on("error", reject)
      })

      req.on("error", reject)

      if (requestBody.stream) {
        requestBody.stream.pipe(req)
      } else {
        if (requestBody.buffer) {
          req.write(requestBody.buffer)
        }

        req.end()
      }
    })
  }

  /**
   * @param {object | undefined} headers
   * @returns {Record<string, string>}
   */
  requestHeaders(headers) {
    const requestHeaders = {...headers}

    if (!Object.keys(requestHeaders).some((key) => key.toLowerCase() === "accept-encoding")) {
      requestHeaders["Accept-Encoding"] = DEFAULT_ACCEPT_ENCODING
    }

    return requestHeaders
  }

  /**
   * @param {{body: object | Buffer | import("node:stream").Readable | undefined, bodyCompression: CompressionEncoding | undefined, headers: Record<string, string>, streamBody: boolean}} args
   * @returns {{buffer: Buffer | null, stream: import("node:stream").Readable | null}}
   */
  prepareRequestBody({body, bodyCompression = "identity", headers, streamBody}) {
    if (body === undefined || body === null) {
      return {buffer: null, stream: null}
    }

    /** @type {Buffer | null} */
    let buffer = null
    /** @type {import("node:stream").Readable | null} */
    let stream = null

    if (Buffer.isBuffer(body)) {
      buffer = body
      headers["Content-Type"] = headers["Content-Type"] || "application/octet-stream"
    } else if (streamBody && typeof body === "object" && typeof body.pipe === "function") {
      stream = body
      headers["Content-Type"] = headers["Content-Type"] || "application/octet-stream"
    } else if (typeof body === "object") {
      buffer = Buffer.from(JSON.stringify(body))
      headers["Content-Type"] = headers["Content-Type"] || "application/json"
    }

    if (bodyCompression === "identity") {
      if (buffer) {
        headers["Content-Length"] = String(buffer.length)
      }

      return {buffer, stream}
    }

    if (this.hasRequestHeader(headers, "content-encoding")) {
      throw new Error("Cannot combine bodyCompression with an explicit Content-Encoding header.")
    }

    headers["Content-Encoding"] = bodyCompression

    const compressor = this.requestBodyCompressor(bodyCompression)

    if (stream) {
      stream.on("error", (error) => {
        compressor.destroy(error)
      })
      stream.pipe(compressor)

      return {buffer: null, stream: compressor}
    }

    const bodyStream = Readable.from(/** @type {Buffer} */ (buffer))

    bodyStream.on("error", (error) => {
      compressor.destroy(error)
    })
    bodyStream.pipe(compressor)

    return {buffer: null, stream: compressor}
  }

  /**
   * @param {CompressionEncoding} encoding
   * @returns {import("node:stream").Transform}
   */
  requestBodyCompressor(encoding) {
    if (encoding === "gzip") {
      return zlib.createGzip()
    }

    if (encoding === "deflate") {
      return zlib.createDeflate()
    }

    if (encoding === "br") {
      return zlib.createBrotliCompress()
    }

    if (encoding === "zstd" && typeof zlib.createZstdCompress === "function") {
      return zlib.createZstdCompress()
    }

    throw new Error(`Unsupported Docker request body compression: ${encoding}`)
  }

  /**
   * @param {Record<string, string>} headers
   * @param {string} headerName
   * @returns {boolean}
   */
  hasRequestHeader(headers, headerName) {
    return Object.keys(headers).some((key) => key.toLowerCase() === headerName)
  }

  /**
   * @param {import("node:http").IncomingMessage} response
   * @returns {import("node:stream").Readable}
   */
  decodedResponseStream(response) {
    const encodings = this.responseContentEncodings(response.headers["content-encoding"])
    /** @type {import("node:stream").Readable} */
    let stream = response

    for (let index = encodings.length - 1; index >= 0; index -= 1) {
      stream = stream.pipe(this.responseDecoder(encodings[index]))
    }

    return stream
  }

  /**
   * @param {string | string[] | undefined} header
   * @returns {string[]}
   */
  responseContentEncodings(header) {
    if (!header) {
      return []
    }

    const headerValue = Array.isArray(header) ? header.join(",") : header

    return headerValue
      .split(",")
      .map((encoding) => encoding.trim().toLowerCase())
      .filter((encoding) => encoding && encoding !== "identity")
  }

  /**
   * @param {string} encoding
   * @returns {import("node:stream").Transform}
   */
  responseDecoder(encoding) {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return zlib.createGunzip()
    }

    if (encoding === "deflate") {
      return zlib.createInflate()
    }

    if (encoding === "br") {
      return zlib.createBrotliDecompress()
    }

    if (encoding === "zstd" && typeof zlib.createZstdDecompress === "function") {
      return zlib.createZstdDecompress()
    }

    throw new Error(`Unsupported Docker response content encoding: ${encoding}`)
  }

  /**
   * @param {boolean | RetryOptions | undefined} retry
   * @returns {{tries: number, waitMs: number} | null}
   */
  normalizedRetryOptions(retry) {
    if (!retry) {
      return null
    }

    if (retry === true) {
      return {tries: 3, waitMs: 500}
    }

    return {
      tries: retry.tries ?? 3,
      waitMs: retry.waitMs ?? 500
    }
  }

  /**
   * @param {RequestOptions} options
   * @returns {boolean}
   */
  hasStreamingBody(options) {
    return Boolean(options.body && typeof options.body === "object" && typeof options.body.pipe === "function")
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  retryableError(error) {
    if (error instanceof DockerApiError) {
      return this.retryableDockerApiError(error)
    }

    if (!error || typeof error !== "object") {
      return false
    }

    if ("code" in error && typeof error.code === "string" && RETRYABLE_ERROR_CODES.has(error.code)) {
      return true
    }

    return error instanceof Error && error.message === "socket hang up"
  }

  /**
   * @param {DockerApiError} error
   * @returns {boolean}
   */
  retryableDockerApiError(error) {
    if (RETRYABLE_DOCKER_API_STATUS_CODES.has(error.statusCode)) {
      return true
    }

    if (error.statusCode !== 500) {
      return false
    }

    const responseMessage = error.responseMessage.toLowerCase()

    return (
      responseMessage.includes("failed to export layer") ||
      responseMessage.includes("failed to prepare extraction snapshot") ||
      (responseMessage.includes("failed to commit") && responseMessage.includes("no such file or directory")) ||
      (responseMessage.includes("parent snapshot") && responseMessage.includes("does not exist")) ||
      (responseMessage.includes("io.containerd.content.v1.content/ingest") && responseMessage.includes("no such file or directory"))
    )
  }

  /**
   * @param {number} waitMs
   * @returns {Promise<void>}
   */
  async wait(waitMs) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  /**
   * Perform an HTTP request and return the raw response stream.
   * Used for endpoints that stream data (logs, pull progress, exec output).
   * @param {RequestOptions} options
   * @returns {Promise<{stream: import("node:stream").Readable, statusCode: number}>}
   */
  requestStream(options) {
    return new Promise((resolve, reject) => {
      const fullPath = this.buildPath(options.path, options.query)
      const headers = this.requestHeaders(options.headers)
      const requestBody = this.prepareRequestBody({
        body: options.body,
        bodyCompression: options.bodyCompression,
        headers,
        streamBody: true
      })
      let settled = false

      if (options.signal?.aborted) {
        reject(new Error("Docker request aborted."))
        return
      }

      const requestOptions = {
        path: fullPath,
        method: options.method,
        agent: this.agent,
        headers
      }

      if (this.socketPath) {
        requestOptions.socketPath = this.socketPath
      } else {
        requestOptions.hostname = this.host
        requestOptions.port = this.port
      }

      const removeAbortListener = () => {
        options.signal?.removeEventListener("abort", abortRequest)
      }
      const abortRequest = () => {
        req.destroy(new Error("Docker request aborted."))
      }
      const req = this.httpModule.request(requestOptions, (res) => {
        let responseStream

        try {
          responseStream = this.decodedResponseStream(res)
        } catch (error) {
          if (!settled) {
            settled = true
            reject(error)
          }

          return
        }

        const abortStream = () => {
          responseStream.destroy(new Error("Docker request aborted."))
        }

        removeAbortListener()
        options.signal?.addEventListener("abort", abortStream, {once: true})
        responseStream.on("close", () => {
          options.signal?.removeEventListener("abort", abortStream)
        })

        if (res.statusCode >= 400) {
          const chunks = []

          responseStream.on("data", (chunk) => chunks.push(chunk))
          responseStream.on("end", () => {
            const buffer = Buffer.concat(chunks)
            let message

            try {
              const parsed = JSON.parse(buffer.toString("utf-8"))
              message = parsed.message || buffer.toString("utf-8")
            } catch {
              message = buffer.toString("utf-8")
            }

            if (!settled) {
              settled = true
              reject(new Error(`Docker API error ${res.statusCode} ${options.method} ${fullPath}: ${message}`))
            }
          })
          responseStream.on("error", (error) => {
            if (!settled) {
              settled = true
              reject(error)
            }
          })

          return
        }

        settled = true
        resolve({stream: responseStream, statusCode: res.statusCode})
      })

      options.signal?.addEventListener("abort", abortRequest, {once: true})
      req.on("error", (error) => {
        removeAbortListener()

        if (!settled) {
          settled = true
          reject(error)
        }
      })

      if (requestBody.stream) {
        requestBody.stream.pipe(req)
      } else {
        if (requestBody.buffer) {
          req.write(requestBody.buffer)
        }

        req.end()
      }
    })
  }

  /** Destroy the keep-alive agent, closing all persistent connections. */
  close() {
    this.agent.destroy()
  }
}

export default DockerConnection
