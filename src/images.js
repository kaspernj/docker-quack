import {TextDecoder} from "node:util"
import DockerImageTagger from "./image-tagging.js"

const PULL_SUCCESS_STATUS_PREFIXES = [
  "Status: Downloaded newer image for ",
  "Status: Image is up to date for "
]

/**
 * @param {"JSON" | "UTF-8"} format
 * @param {unknown} cause
 * @returns {Error}
 */
function malformedPullResponseError(format, cause) {
  const detail = cause instanceof Error ? `: ${cause.message}` : ""
  const error = new Error(`Docker pull response contained malformed ${format}${detail}`)

  Object.defineProperty(error, "cause", {configurable: true, value: cause})

  return error
}

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
    const decoder = new TextDecoder("utf-8", {fatal: true})
    let buffer = ""
    let finalFrameWasTerminalSuccess = false

    const decodeChunk = (chunk, streaming) => {
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk

        return decoder.decode(bytes, {stream: streaming})
      } catch (error) {
        throw malformedPullResponseError("UTF-8", error)
      }
    }

    const consumeLine = (line) => {
      if (!line) return

      let progress

      try {
        progress = JSON.parse(line)
      } catch (error) {
        throw malformedPullResponseError("JSON", error)
      }

      const errorMessage = progress.errorDetail?.message || progress.error

      if (errorMessage) {
        throw new Error(`Docker pull error: ${errorMessage}`)
      }

      finalFrameWasTerminalSuccess = (
        typeof progress.status === "string" &&
        PULL_SUCCESS_STATUS_PREFIXES.some((prefix) => progress.status.startsWith(prefix) && progress.status.length > prefix.length)
      )

      if (onProgress) onProgress(progress)
    }

    for await (const chunk of stream) {
      buffer += decodeChunk(chunk, true)

      let newlineIndex

      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        consumeLine(buffer.slice(0, newlineIndex).trim())
        buffer = buffer.slice(newlineIndex + 1)
      }
    }

    buffer += decodeChunk(undefined, false)
    consumeLine(buffer.trim())

    if (!finalFrameWasTerminalSuccess) {
      throw new Error("Docker pull response ended before Docker reported pull completion.")
    }
  }
}

export default DockerImages
