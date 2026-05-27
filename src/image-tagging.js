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
   * @param {{source: string, repo: string, tag?: string}} options
   * @returns {Promise<void>}
   */
  async tag(options) {
    const tag = options.tag || "latest"
    const targetImage = `${options.repo}:${tag}`
    const tagRequest = {
      method: "POST",
      path: `/images/${encodeURIComponent(options.source)}/tag`,
      query: {repo: options.repo, tag}
    }

    try {
      await this.connection.request(tagRequest)
      return
    } catch (error) {
      if (!this.isImageReferenceAlreadyExistsError(error)) {
        throw error
      }
    }

    const sourceImageId = this.imageIdFromResponse(await this.inspectImage(options.source), options.source)
    const targetImageId = this.imageIdFromResponse(await this.inspectImage(targetImage), targetImage)

    if (sourceImageId === targetImageId) {
      return
    }

    await this.removeImage(targetImage)
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
    return error instanceof Error && error.message.toLowerCase().includes("already exists")
  }

  /**
   * @param {string} name
   * @returns {Promise<object>}
   */
  async inspectImage(name) {
    return await this.connection.request({
      method: "GET",
      path: `/images/${name}/json`
    })
  }

  /**
   * @param {string} name
   * @returns {Promise<object[]>}
   */
  async removeImage(name) {
    return await this.connection.request({
      method: "DELETE",
      path: `/images/${name}`,
      query: {force: true}
    })
  }
}
