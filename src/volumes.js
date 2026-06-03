/**
 * @typedef {object} DockerVolumeCreateOptions
 * @property {string} Name - Volume name.
 * @property {Record<string, string>} [Labels] - Volume labels.
 * @property {number} [timeoutMs] - Optional per-request timeout for volume creation.
 */

/**
 * @typedef {object} DockerVolumeResponse
 * @property {string} [Name] - Volume name.
 * @property {string} [Driver] - Volume driver.
 * @property {string} [Mountpoint] - Host mountpoint.
 * @property {string} [Scope] - Volume scope.
 * @property {Record<string, string>} [Labels] - Volume labels.
 */

/**
 * @typedef {object} DockerVolumeListResponse
 * @property {DockerVolumeResponse[]} Volumes - Volumes returned by Docker.
 * @property {string[]} Warnings - Docker warnings from the list request.
 */

/** Docker volumes API. */
class DockerVolumes {
  /**
   * @param {import("./docker-connection.js").default} connection
   */
  constructor(connection) {
    this.connection = connection
  }

  /**
   * Create a volume.
   * @param {DockerVolumeCreateOptions} options
   * @returns {Promise<DockerVolumeResponse>}
   */
  async create(options) {
    const {timeoutMs, ...body} = options

    return await this.connection.request({
      method: "POST",
      path: "/volumes/create",
      body,
      timeoutMs
    })
  }

  /**
   * Remove a volume.
   * @param {{name: string, force?: boolean, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async remove(options) {
    const query = options.force ? {force: true} : undefined

    await this.connection.requestRaw({
      method: "DELETE",
      path: `/volumes/${options.name}`,
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Inspect a volume.
   * @param {{name: string, timeoutMs?: number}} options
   * @returns {Promise<DockerVolumeResponse>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/volumes/${options.name}`,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * List volumes.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, timeoutMs?: number}} [options]
   * @returns {Promise<DockerVolumeListResponse>}
   */
  async list(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/volumes",
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Prune unused volumes.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, timeoutMs?: number}} [options]
   * @returns {Promise<{VolumesDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/volumes/prune",
      query,
      timeoutMs: options.timeoutMs
    })
  }
}

export default DockerVolumes
