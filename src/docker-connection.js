import * as http from "node:http"
import * as https from "node:https"

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
 * @typedef {object} RequestOptions
 * @property {string} method - HTTP method
 * @property {string} path - Request path
 * @property {object} [query] - Query parameters
 * @property {object | Buffer | import("node:stream").Readable} [body] - Request body
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
      const headers = {...options.headers}

      let bodyData = null

      if (options.body !== undefined && options.body !== null) {
        if (Buffer.isBuffer(options.body)) {
          bodyData = options.body
          headers["Content-Type"] = headers["Content-Type"] || "application/octet-stream"
          headers["Content-Length"] = String(bodyData.length)
        } else if (typeof options.body === "object" && typeof options.body.pipe === "function") {
          // Readable stream - handled below
          headers["Content-Type"] = headers["Content-Type"] || "application/octet-stream"
        } else if (typeof options.body === "object") {
          bodyData = Buffer.from(JSON.stringify(options.body))
          headers["Content-Type"] = headers["Content-Type"] || "application/json"
          headers["Content-Length"] = String(bodyData.length)
        }
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

      const req = this.httpModule.request(requestOptions, (res) => {
        const chunks = []

        res.on("data", (chunk) => {
          chunks.push(chunk)
        })

        res.on("end", () => {
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

        res.on("error", reject)
      })

      req.on("error", reject)

      // Handle streaming body (e.g. tar archive)
      if (options.body && typeof options.body.pipe === "function") {
        options.body.pipe(req)
      } else {
        if (bodyData) {
          req.write(bodyData)
        }

        req.end()
      }
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
      tries: retry.tries || 3,
      waitMs: retry.waitMs || 500
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
      return error.statusCode >= 500
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
   * @returns {Promise<{stream: import("node:http").IncomingMessage, statusCode: number}>}
   */
  requestStream(options) {
    return new Promise((resolve, reject) => {
      const fullPath = this.buildPath(options.path, options.query)
      const headers = {...options.headers}
      let settled = false

      if (options.signal?.aborted) {
        reject(new Error("Docker request aborted."))
        return
      }

      let bodyData = null

      if (options.body !== undefined && options.body !== null) {
        if (Buffer.isBuffer(options.body)) {
          bodyData = options.body
          headers["Content-Type"] = headers["Content-Type"] || "application/octet-stream"
          headers["Content-Length"] = String(bodyData.length)
        } else if (typeof options.body === "object") {
          bodyData = Buffer.from(JSON.stringify(options.body))
          headers["Content-Type"] = headers["Content-Type"] || "application/json"
          headers["Content-Length"] = String(bodyData.length)
        }
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
        const abortStream = () => {
          res.destroy(new Error("Docker request aborted."))
        }

        removeAbortListener()
        options.signal?.addEventListener("abort", abortStream, {once: true})
        res.on("close", () => {
          options.signal?.removeEventListener("abort", abortStream)
        })

        if (res.statusCode >= 400) {
          const chunks = []

          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () => {
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

          return
        }

        settled = true
        resolve({stream: res, statusCode: res.statusCode})
      })

      options.signal?.addEventListener("abort", abortRequest, {once: true})
      req.on("error", (error) => {
        removeAbortListener()

        if (!settled) {
          settled = true
          reject(error)
        }
      })

      if (bodyData) {
        req.write(bodyData)
      }

      req.end()
    })
  }

  /** Destroy the keep-alive agent, closing all persistent connections. */
  close() {
    this.agent.destroy()
  }
}

export default DockerConnection
