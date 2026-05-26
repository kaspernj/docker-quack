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
   * @param {{Name: string, Driver?: string, IPAM?: object}} options
   * @returns {Promise<{Id: string}>}
   */
  async create(options) {
    return await this.connection.request({
      method: "POST",
      path: "/networks/create",
      body: options
    })
  }

  /**
   * Remove a network.
   * @param {{id: string}} options
   * @returns {Promise<void>}
   */
  async remove(options) {
    await this.connection.requestRaw({
      method: "DELETE",
      path: `/networks/${options.id}`
    })
  }

  /**
   * Inspect a network.
   * @param {{id: string}} options
   * @returns {Promise<object>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/networks/${options.id}`
    })
  }

  /**
   * List networks.
   * @param {{filters?: object}} [options]
   * @returns {Promise<object[]>}
   */
  async list(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/networks",
      query
    })
  }

  /**
   * Prune unused networks.
   * @param {{filters?: object}} [options]
   * @returns {Promise<{NetworksDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/networks/prune",
      query
    })
  }
}

export default DockerNetworks
