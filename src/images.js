import DockerImageTagger from "./image-tagging.js"

/**
 * @typedef {object} DockerRegistryAuth
 * @property {string} username - Registry username.
 * @property {string} password - Registry password.
 * @property {string} [serveraddress] - Registry server URL.
 */

/**
 * @typedef {object} DockerImagePullProgress
 * @property {string} [status] - Pull status text.
 * @property {string} [id] - Layer or image identifier.
 * @property {string} [progress] - Human-readable progress text.
 * @property {{current?: number, total?: number}} [progressDetail] - Numeric pull progress details.
 * @property {string} [error] - Docker pull error text.
 */

/**
 * @typedef {object} DockerImageInspectResponse
 * @property {string} [Id] - Image ID.
 * @property {string[]} [RepoTags] - Repository tags pointing at the image.
 * @property {number} [Size] - Image size in bytes.
 * @property {Record<string, string>} [Labels] - Image labels.
 */

/**
 * @typedef {object} DockerImageDeleteResponse
 * @property {string} [Deleted] - Deleted image layer ID.
 * @property {string} [Untagged] - Removed image tag.
 */

/**
 * @typedef {object} DockerImageListItem
 * @property {string} [Id] - Image ID.
 * @property {string[]} [RepoTags] - Repository tags pointing at the image.
 * @property {string[]} [RepoDigests] - Repository digests pointing at the image.
 * @property {number} [Created] - Creation time as a Unix timestamp.
 * @property {number} [Size] - Image size in bytes.
 * @property {Record<string, string>} [Labels] - Image labels.
 */

/**
 * @typedef {object} PullOptions
 * @property {string} image - Image name with optional tag (e.g. "postgres:16")
 * @property {DockerRegistryAuth} [auth] - Registry authentication
 * @property {(progress: DockerImagePullProgress) => void} [onProgress] - Called with each progress object as it arrives
 * @property {AbortSignal} [signal] - Optional abort signal to cancel the pull stream.
 * @property {number} [timeoutMs] - Optional per-request timeout for the pull stream.
 */

/**
 * @typedef {object} TagOptions
 * @property {string} source - Existing image name, tag, ID, or digest to tag
 * @property {string} repo - Target image repository
 * @property {string} [tag] - Target image tag. Defaults to `latest`.
 * @property {AbortSignal} [signal] - Optional abort signal to cancel the tag operation.
 * @property {number} [timeoutMs] - Optional per-request timeout for the tag operation.
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
    /** @type {import("./docker-connection.js").DockerRequestHeaders} */
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
      headers,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })

    // Consume the pull progress stream to completion
    await this.consumePullStream(stream, options.onProgress)
  }

  /**
   * Inspect an image.
   * @param {{name: string, signal?: AbortSignal, timeoutMs?: number}} options
   * @returns {Promise<DockerImageInspectResponse>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/images/${options.name}/json`,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Remove an image.
   * @param {{name: string, force?: boolean, signal?: AbortSignal, timeoutMs?: number}} options
   * @returns {Promise<DockerImageDeleteResponse[]>}
   */
  async remove(options) {
    const query = options.force ? {force: true} : undefined

    return await this.connection.request({
      method: "DELETE",
      path: `/images/${options.name}`,
      query,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
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
      tag: options.tag,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * List images.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<DockerImageListItem[]>}
   */
  async list(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/images/json",
      query,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Prune unused images.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<{ImagesDeleted?: Array<{Deleted?: string, Untagged?: string}>, SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/images/prune",
      query,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Consume the pull progress stream. Docker streams newline-delimited JSON objects
   * with progress info. If any object contains an error field, throw it.
   * When onProgress is provided, each parsed JSON object is forwarded live.
   * @param {import("node:stream").Readable} stream
   * @param {(progress: DockerImagePullProgress) => void} [onProgress] - Called with each progress object as it arrives
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
