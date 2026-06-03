/** Handles Docker image tagging behavior shared by container commits and images. */
export default class DockerImageTagger {
  /**
   * @param {import("./docker-connection.js").default} connection
   */
  constructor(connection) {
    this.connection = connection
  }

  /**
   * Tags a Docker image, matching `docker tag` behavior when Docker reports that
   * the destination reference already exists.
   * @param {{source: string, repo: string, tag?: string, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async tag(options) {
    const tag = options.tag || "latest"
    const targetImage = `${options.repo}:${tag}`
    const tagRequest = {
      method: "POST",
      path: `/images/${encodeURIComponent(options.source)}/tag`,
      query: {repo: options.repo, tag},
      timeoutMs: options.timeoutMs
    }

    try {
      await this.connection.request(tagRequest)
      return
    } catch (error) {
      if (!this.isImageReferenceAlreadyExistsError(error)) {
        throw error
      }
    }

    const sourceImageId = this.imageIdFromResponse(await this.inspectImage(options.source, options.timeoutMs), options.source)
    const targetImageId = this.imageIdFromResponse(await this.inspectImage(targetImage, options.timeoutMs), targetImage)

    if (sourceImageId === targetImageId) {
      return
    }

    await this.removeImage(targetImage, options.timeoutMs)
    await this.connection.request(tagRequest)
  }

  /**
   * @param {unknown} value
   * @param {string} context
   * @returns {string}
   */
  imageIdFromResponse(value, context) {
    if (value && typeof value === "object" && "Id" in value && typeof value.Id === "string" && value.Id.trim()) {
      return value.Id
    }

    throw new Error(`Docker response returned no image digest for ${context}`)
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  isImageReferenceAlreadyExistsError(error) {
    if (!(error instanceof Error)) {
      return false
    }

    const message = error.message.toLowerCase()

    return message.includes("already exists") ||
      (message.includes("is already set to image") && message.includes("use -f option"))
  }

  /**
   * @param {string} name
   * @param {number} [timeoutMs]
   * @returns {Promise<import("./images.js").DockerImageInspectResponse>}
   */
  async inspectImage(name, timeoutMs) {
    return await this.connection.request({
      method: "GET",
      path: `/images/${name}/json`,
      timeoutMs
    })
  }

  /**
   * @param {string} name
   * @param {number} [timeoutMs]
   * @returns {Promise<import("./images.js").DockerImageDeleteResponse[]>}
   */
  async removeImage(name, timeoutMs) {
    return await this.connection.request({
      method: "DELETE",
      path: `/images/${name}`,
      query: {force: true},
      timeoutMs
    })
  }
}
