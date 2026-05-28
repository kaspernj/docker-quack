/** Docker networks API. */
class DockerNetworks {
  /**
   * @param {import("./docker-connection.js").default} connection
   */
  constructor(connection) {
    this.connection = connection
  }

  /**
   * Create a network.
   * @param {{Name: string, Driver?: string, IPAM?: object, timeoutMs?: number}} options
   * @returns {Promise<{Id: string}>}
   */
  async create(options) {
    const {timeoutMs, ...body} = options

    return await this.connection.request({
      method: "POST",
      path: "/networks/create",
      body,
      timeoutMs
    })
  }

  /**
   * Remove a network.
   * @param {{id: string, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async remove(options) {
    await this.connection.requestRaw({
      method: "DELETE",
      path: `/networks/${options.id}`,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Inspect a network.
   * @param {{id: string, timeoutMs?: number}} options
   * @returns {Promise<object>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/networks/${options.id}`,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * List networks.
   * @param {{filters?: object, timeoutMs?: number}} [options]
   * @returns {Promise<object[]>}
   */
  async list(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/networks",
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Prune unused networks.
   * @param {{filters?: object, timeoutMs?: number}} [options]
   * @returns {Promise<{NetworksDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/networks/prune",
      query,
      timeoutMs: options.timeoutMs
    })
  }
}

export default DockerNetworks
