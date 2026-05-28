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
   * @param {{Name: string, Labels?: Record<string, string>, timeoutMs?: number}} options
   * @returns {Promise<object>}
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
   * @returns {Promise<object>}
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
   * @param {{filters?: object, timeoutMs?: number}} [options]
   * @returns {Promise<{Volumes: object[], Warnings: string[]}>}
   */
  async list(options = {}) {
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
   * @param {{filters?: object, timeoutMs?: number}} [options]
   * @returns {Promise<{VolumesDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
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
