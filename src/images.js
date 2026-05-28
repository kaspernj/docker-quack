import DockerImageTagger from "./image-tagging.js"

/**
 * @typedef {object} PullOptions
 * @property {string} image - Image name with optional tag (e.g. "postgres:16")
 * @property {{username: string, password: string, serveraddress?: string}} [auth] - Registry authentication
 * @property {(progress: object) => void} [onProgress] - Called with each progress object as it arrives
 */

/**
 * @typedef {object} TagOptions
 * @property {string} source - Existing image name, tag, ID, or digest to tag
 * @property {string} repo - Target image repository
 * @property {string} [tag] - Target image tag. Defaults to `latest`.
 */

/** Docker images API. */
class DockerImages {
  /**
   * @param {import("./docker-connection.js").default} connection
   */
  constructor(connection) {
    this.connection = connection
    this.imageTagger = new DockerImageTagger(connection)
  }

  /**
   * Pull an image from a registry. Consumes the entire streaming response before resolving.
   * When auth is provided, it is sent as a base64-encoded JSON X-Registry-Auth header.
   * @param {PullOptions} options
   * @returns {Promise<void>}
   */
  async pull(options) {
    const headers = {}

    if (options.auth) {
      const authPayload = Buffer.from(JSON.stringify(options.auth)).toString("base64")
      headers["X-Registry-Auth"] = authPayload
    }

    // Parse image name and tag for the fromImage query parameter
    const query = {fromImage: options.image}

    const {stream} = await this.connection.requestStream({
      method: "POST",
      path: "/images/create",
      query,
      headers
    })

    // Consume the pull progress stream to completion
    await this.consumePullStream(stream, options.onProgress)
  }

  /**
   * Inspect an image.
   * @param {{name: string}} options
   * @returns {Promise<object>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/images/${options.name}/json`
    })
  }

  /**
   * Remove an image.
   * @param {{name: string, force?: boolean}} options
   * @returns {Promise<object[]>}
   */
  async remove(options) {
    const query = options.force ? {force: true} : undefined

    return await this.connection.request({
      method: "DELETE",
      path: `/images/${options.name}`,
      query
    })
  }

  /**
   * Tag an image. If Docker reports the target already exists, this verifies
   * whether it already points at the source image and otherwise retags it.
   * @param {TagOptions} options
   * @returns {Promise<void>}
   */
  async tag(options) {
    await this.imageTagger.tag({
      source: options.source,
      repo: options.repo,
      tag: options.tag
    })
  }

  /**
   * List images.
   * @param {{filters?: object}} [options]
   * @returns {Promise<object[]>}
   */
  async list(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/images/json",
      query
    })
  }

  /**
   * Prune unused images.
   * @param {{filters?: object, timeoutMs?: number}} [options]
   * @returns {Promise<{ImagesDeleted?: Array<{Deleted?: string, Untagged?: string}>, SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/images/prune",
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Consume the pull progress stream. Docker streams newline-delimited JSON objects
   * with progress info. If any object contains an error field, throw it.
   * When onProgress is provided, each parsed JSON object is forwarded live.
   * @param {import("node:stream").Readable} stream
   * @param {(progress: object) => void} [onProgress] - Called with each progress object as it arrives
   * @returns {Promise<void>}
   */
  consumePullStream(stream, onProgress) {
    return new Promise((resolve, reject) => {
      let buffer = ""

      stream.on("data", (chunk) => {
        buffer += chunk.toString("utf-8")

        // Parse complete newline-delimited JSON lines
        let newlineIndex

        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim()

          buffer = buffer.slice(newlineIndex + 1)

          if (!line) continue

          try {
            const parsed = JSON.parse(line)

            if (parsed.error) {
              reject(new Error(`Docker pull error: ${parsed.error}`))
              return
            }

            if (onProgress) onProgress(parsed)
          } catch {
            // Non-JSON lines are ignored
          }
        }
      })
      stream.on("error", reject)
      stream.on("end", () => {
        // Parse any remaining buffered content
        const remaining = buffer.trim()

        if (remaining) {
          try {
            const parsed = JSON.parse(remaining)

            if (parsed.error) {
              reject(new Error(`Docker pull error: ${parsed.error}`))
              return
            }

            if (onProgress) onProgress(parsed)
          } catch {
            // Non-JSON lines are ignored
          }
        }

        resolve()
      })
    })
  }
}

export default DockerImages
