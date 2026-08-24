import {StringDecoder} from "node:string_decoder"
import DockerImageTagger from "./image-tagging.js"

const PULL_SUCCESS_STATUS_PREFIXES = [
  "Status: Downloaded newer image for ",
  "Status: Image is up to date for "
]

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
 * @property {{code?: number, message?: string}} [errorDetail] - Structured Docker pull error.
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
   * Pull an image from a registry. Resolves only after Docker reports a terminal success result.
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
   * with progress info. Docker errors and invalid or incomplete streams reject the pull.
   * When onProgress is provided, each parsed JSON object is forwarded live.
   * @param {import("node:stream").Readable} stream
   * @param {(progress: DockerImagePullProgress) => void} [onProgress] - Called with each progress object as it arrives
   * @returns {Promise<void>}
   */
  async consumePullStream(stream, onProgress) {
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    let observedTerminalSuccess = false

    const consumeLine = (line) => {
      if (!line) return

      let progress

      try {
        progress = JSON.parse(line)
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ""
        const malformedJsonError = new Error(`Docker pull response contained malformed JSON${detail}`)

        Object.defineProperty(malformedJsonError, "cause", {configurable: true, value: error})
        throw malformedJsonError
      }

      const errorMessage = progress.errorDetail?.message || progress.error

      if (errorMessage) {
        throw new Error(`Docker pull error: ${errorMessage}`)
      }

      if (onProgress) onProgress(progress)

      if (
        typeof progress.status === "string" &&
        PULL_SUCCESS_STATUS_PREFIXES.some((prefix) => progress.status.startsWith(prefix) && progress.status.length > prefix.length)
      ) {
        observedTerminalSuccess = true
      }
    }

    for await (const chunk of stream) {
      buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk)

      let newlineIndex

      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        consumeLine(buffer.slice(0, newlineIndex).trim())
        buffer = buffer.slice(newlineIndex + 1)
      }
    }

    buffer += decoder.end()
    consumeLine(buffer.trim())

    if (!observedTerminalSuccess) {
      throw new Error("Docker pull response ended before Docker reported pull completion.")
    }
  }
}

export default DockerImages
