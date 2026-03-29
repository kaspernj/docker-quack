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
   * @returns {Promise<object>}
   */
  async version() {
    return await this.connection.request({
      method: "GET",
      path: "/version"
    })
  }

  /**
   * Get Docker system information.
   * @returns {Promise<object>}
   */
  async info() {
    return await this.connection.request({
      method: "GET",
      path: "/info"
    })
  }

  /** Close all persistent connections to the Docker host. */
  close() {
    this.connection.close()
  }
}

export default Docker
