import * as zlib from "node:zlib"
import SnapReq from "snapreq"
import {SnapReqTimeoutError} from "snapreq/errors"

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
 * @property {number} [timeoutMs] - Per-request timeout for buffered (non-streaming) requests. An unreachable host that accepts the connection but never responds would otherwise hang forever. Defaults to 120000ms. Set to 0 to disable.
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
 * @property {number} [timeoutMs] - Overrides the connection's default per-request timeout for this buffered request. Set to 0 to disable.
 */

/**
 * @typedef {object} RetryOptions
 * @property {number} [tries] - Maximum attempts. Defaults to 3.
 * @property {number} [waitMs] - Delay between attempts. Defaults to 500ms.
 */

const RETRYABLE_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOENT", "ETIMEDOUT", "EPIPE"])
const RETRYABLE_DOCKER_API_STATUS_CODES = new Set([502, 503, 504])
const DEFAULT_ACCEPT_ENCODING = ["gzip", "deflate", "br", ...(typeof zlib.createZstdDecompress === "function" ? ["zstd"] : [])].join(", ")
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

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

/** Thrown when a buffered Docker request exceeds its configured timeout. */
export class DockerConnectionTimeoutError extends Error {
  /**
   * @param {{message: string, method: string, path: string, timeoutMs: number}} options
   */
  constructor(options) {
    super(options.message)
    this.name = "DockerConnectionTimeoutError"
    this.method = options.method
    this.path = options.path
    this.timeoutMs = options.timeoutMs
  }
}

/**
 * Low-level Docker Engine API client. The cross-platform HTTP plumbing
 * (keep-alive, Unix sockets, client TLS, request/response compression and
 * streaming) is provided by `snapreq`; this class layers the Docker-specific
 * policy on top: the default `Accept-Encoding`, JSON/text response parsing,
 * `DockerApiError`, and retrying transient Docker API / connection failures.
 */
class DockerConnection {
  /**
   * @param {ConnectionOptions} options
   */
  constructor(options) {
    this.host = options.host
    this.port = options.port
    this.socketPath = options.socketPath
    this.tls = options.tls
    this.useTls = !!options.tls
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    const protocol = this.useTls ? "https" : "http"
    // Bracket IPv6 literals (for example `::1`) so the composed URL is valid;
    // Node's HTTP client used to receive hostname/port separately and handled
    // this for us.
    const urlHost = this.host && this.host.includes(":") && !this.host.startsWith("[") ? `[${this.host}]` : this.host
    const baseUrl = this.socketPath ? `${protocol}://localhost` : `${protocol}://${urlHost}:${this.port}`

    this.client = new SnapReq({
      baseUrl,
      socketPath: this.socketPath,
      tls: options.tls,
      keepAlive: true
    })
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
  async requestRawOnce(options) {
    const fullPath = this.buildPath(options.path, options.query)
    const timeoutMs = options.timeoutMs ?? this.timeoutMs

    try {
      const response = await this.client.request({
        method: options.method,
        path: fullPath,
        body: options.body,
        bodyCompression: options.bodyCompression,
        headers: this.requestHeaders(options.headers),
        signal: options.signal,
        timeoutMs
      })

      if (response.status >= 400) {
        throw this.apiError(response, options.method, fullPath, await response.buffer())
      }

      return await response.buffer()
    } catch (error) {
      if (error instanceof SnapReqTimeoutError) {
        throw new DockerConnectionTimeoutError({
          message: `Docker request timed out after ${timeoutMs}ms: ${options.method} ${fullPath}`,
          method: options.method,
          path: fullPath,
          timeoutMs
        })
      }

      throw error
    }
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
   * @param {import("snapreq/response").default} response - Failed response.
   * @param {string} method - HTTP method.
   * @param {string} fullPath - Resolved request path.
   * @param {Buffer} buffer - Response body.
   * @returns {DockerApiError}
   */
  apiError(response, method, fullPath, buffer) {
    let message

    try {
      const parsed = JSON.parse(buffer.toString("utf-8"))

      message = parsed.message || buffer.toString("utf-8")
    } catch {
      message = buffer.toString("utf-8")
    }

    return new DockerApiError({
      message: `Docker API error ${response.status} ${method} ${fullPath}: ${message}`,
      method,
      path: fullPath,
      responseMessage: message,
      statusCode: response.status
    })
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

    // A timed-out buffered request is a stalled connection in practice, so when
    // the caller opted into retries it should be retried like other transient
    // connection failures rather than failing outright on the first stall.
    if (error instanceof DockerConnectionTimeoutError) {
      return true
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
  async requestStream(options) {
    const fullPath = this.buildPath(options.path, options.query)
    const response = await this.client.requestStream({
      method: options.method,
      path: fullPath,
      body: options.body,
      bodyCompression: options.bodyCompression,
      headers: this.requestHeaders(options.headers),
      signal: options.signal
    })

    if (response.status >= 400) {
      const buffer = await response.buffer()
      let message

      try {
        const parsed = JSON.parse(buffer.toString("utf-8"))

        message = parsed.message || buffer.toString("utf-8")
      } catch {
        message = buffer.toString("utf-8")
      }

      throw new Error(`Docker API error ${response.status} ${options.method} ${fullPath}: ${message}`)
    }

    if (!response.nodeStream) {
      throw new Error("Docker streaming requires the Node transport, which exposes a raw stream.")
    }

    return {stream: response.nodeStream, statusCode: response.status}
  }

  /** Destroy the keep-alive agent, closing all persistent connections. */
  close() {
    this.client.close()
  }
}

export default DockerConnection
