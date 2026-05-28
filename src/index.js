import DockerConnection from "./docker-connection.js"
import DockerContainers from "./containers.js"
import DockerImages from "./images.js"
import DockerNetworks from "./networks.js"
import DockerVolumes from "./volumes.js"

/**
 * @typedef {object} DockerOpenOptions
 * @property {string} host - Docker host
 * @property {number} port - Docker port
 * @property {string} [socketPath] - Unix socket path for local Docker daemons
 * @property {import("./docker-connection.js").TlsOptions} [tls] - TLS options for HTTPS connections
 * @property {number} [timeoutMs] - Per-request timeout for buffered Docker API requests
 */

/**
 * @typedef {object} CommandOptions
 * @property {number} [timeoutMs] - Optional per-request timeout for the command request.
 */

/** Docker Engine API client with HTTP keep-alive connections. */
class Docker {
  /**
   * @param {DockerConnection} connection
   */
  constructor(connection) {
    this.connection = connection
    this.containers = new DockerContainers(connection)
    this.images = new DockerImages(connection)
    this.networks = new DockerNetworks(connection)
    this.volumes = new DockerVolumes(connection)
  }

  /**
   * Open a new Docker client connection.
   * @param {DockerOpenOptions} options
   * @returns {Docker}
   */
  static open(options) {
    const connection = new DockerConnection(options)

    return new Docker(connection)
  }

  /**
   * Get Docker version information.
   * @param {CommandOptions} [options]
   * @returns {Promise<object>}
   */
  async version(options = {}) {
    return await this.connection.request({
      method: "GET",
      path: "/version",
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Get Docker system information.
   * @param {CommandOptions} [options]
   * @returns {Promise<object>}
   */
  async info(options = {}) {
    return await this.connection.request({
      method: "GET",
      path: "/info",
      timeoutMs: options.timeoutMs
    })
  }

  /** Close all persistent connections to the Docker host. */
  close() {
    this.connection.close()
  }
}

export default Docker
