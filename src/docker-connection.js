import * as http from "node:http"
import * as https from "node:https"

/**
 * @typedef {object} TlsOptions
 * @property {string | Buffer} ca - CA certificate
 * @property {string | Buffer} cert - Client certificate
 * @property {string | Buffer} key - Client key
 */

/**
 * @typedef {object} ConnectionOptions
 * @property {string} host - Docker host
 * @property {number} port - Docker port
 * @property {TlsOptions} [tls] - TLS options for HTTPS connections
 */

/**
 * @typedef {object} RequestOptions
 * @property {string} method - HTTP method
 * @property {string} path - Request path
 * @property {object} [query] - Query parameters
 * @property {object | Buffer | import("node:stream").Readable} [body] - Request body
 * @property {object} [headers] - Additional headers
 */

/** Low-level HTTP/HTTPS client with keep-alive for the Docker Engine API. */
class DockerConnection {
  /**
   * @param {ConnectionOptions} options
   */
  constructor(options) {
    this.host = options.host
    this.port = options.port
    this.useTls = !!options.tls

    if (this.useTls) {
      this.agent = new https.Agent({
        keepAlive: true,
        ca: options.tls.ca,
        cert: options.tls.cert,
        key: options.tls.key
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
  requestRaw(options) {
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
        hostname: this.host,
        port: this.port,
        path: fullPath,
        method: options.method,
        agent: this.agent,
        headers
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

            reject(new Error(`Docker API error ${res.statusCode} ${options.method} ${fullPath}: ${message}`))
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
   * Perform an HTTP request and return the raw response stream.
   * Used for endpoints that stream data (logs, pull progress, exec output).
   * @param {RequestOptions} options
   * @returns {Promise<{stream: import("node:http").IncomingMessage, statusCode: number}>}
   */
  requestStream(options) {
    return new Promise((resolve, reject) => {
      const fullPath = this.buildPath(options.path, options.query)
      const headers = {...options.headers}

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
        hostname: this.host,
        port: this.port,
        path: fullPath,
        method: options.method,
        agent: this.agent,
        headers
      }

      const req = this.httpModule.request(requestOptions, (res) => {
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

            reject(new Error(`Docker API error ${res.statusCode} ${options.method} ${fullPath}: ${message}`))
          })

          return
        }

        resolve({stream: res, statusCode: res.statusCode})
      })

      req.on("error", reject)

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
