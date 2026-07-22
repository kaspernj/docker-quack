/**
 * @typedef {object} DockerNetworkIPAMConfig
 * @property {string} [Subnet] - Network subnet CIDR.
 * @property {string} [IPRange] - Allocatable IP range CIDR.
 * @property {string} [Gateway] - Gateway IP address.
 * @property {Record<string, string>} [AuxAddress] - Auxiliary address assignments.
 */

/**
 * @typedef {object} DockerNetworkIPAM
 * @property {string} [Driver] - IPAM driver name.
 * @property {DockerNetworkIPAMConfig[]} [Config] - IPAM configuration blocks.
 * @property {Record<string, string>} [Options] - IPAM driver options.
 */

/**
 * @typedef {object} DockerNetworkCreateOptions
 * @property {string} Name - Network name.
 * @property {string} [Driver] - Network driver name.
 * @property {DockerNetworkIPAM} [IPAM] - IPAM configuration.
 * @property {Record<string, string>} [Labels] - Network labels.
 * @property {AbortSignal} [signal] - Optional abort signal to cancel network creation.
 * @property {number} [timeoutMs] - Optional per-request timeout for network creation.
 */

/**
 * @typedef {object} DockerNetworkResponse
 * @property {string} [Id] - Network ID.
 * @property {string} [Name] - Network name.
 * @property {string} [Driver] - Network driver name.
 * @property {string} [Scope] - Network scope.
 * @property {Record<string, string>} [Labels] - Network labels.
 * @property {DockerNetworkIPAM} [IPAM] - IPAM configuration reported by Docker.
 */

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
   * @param {DockerNetworkCreateOptions} options
   * @returns {Promise<{Id: string}>}
   */
  async create(options) {
    const {timeoutMs, signal, ...body} = options

    return await this.connection.request({
      method: "POST",
      path: "/networks/create",
      body,
      ...(signal ? {signal} : {}),
      timeoutMs
    })
  }

  /**
   * Remove a network.
   * @param {{id: string, signal?: AbortSignal, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async remove(options) {
    await this.connection.requestRaw({
      method: "DELETE",
      path: `/networks/${options.id}`,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Inspect a network.
   * @param {{id: string, signal?: AbortSignal, timeoutMs?: number}} options
   * @returns {Promise<DockerNetworkResponse>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/networks/${options.id}`,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * List networks.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<DockerNetworkResponse[]>}
   */
  async list(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/networks",
      query,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Prune unused networks.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<{NetworksDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/networks/prune",
      query,
      ...(options.signal ? {signal: options.signal} : {}),
      timeoutMs: options.timeoutMs
    })
  }
}

export default DockerNetworks
