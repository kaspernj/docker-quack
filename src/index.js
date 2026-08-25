import DockerConnection from "./docker-connection.js"
import DockerContainers from "./containers.js"
import DockerImages from "./images.js"
import DockerNetworks from "./networks.js"
import DockerVolumes from "./volumes.js"
import {openDockerOverSocketduct} from "./socketduct.js"

/**
 * @typedef {object} DockerVersionResponse
 * @property {string} [Version] - Docker Engine version.
 * @property {string} [ApiVersion] - Docker Engine API version.
 * @property {string} [MinAPIVersion] - Minimum supported Docker Engine API version.
 * @property {string} [GitCommit] - Docker Engine Git commit.
 * @property {string} [GoVersion] - Go runtime version used by Docker.
 * @property {string} [Os] - Docker Engine OS.
 * @property {string} [Arch] - Docker Engine architecture.
 * @property {string} [KernelVersion] - Host kernel version.
 */

/**
 * @typedef {object} DockerInfoResponse
 * @property {number} [Containers] - Total container count.
 * @property {number} [ContainersRunning] - Running container count.
 * @property {number} [ContainersPaused] - Paused container count.
 * @property {number} [ContainersStopped] - Stopped container count.
 * @property {number} [Images] - Image count.
 * @property {string} [Driver] - Storage driver name.
 * @property {string} [OperatingSystem] - Host operating system.
 * @property {string} [OSType] - Host OS type.
 * @property {string} [Architecture] - Host architecture.
 * @property {number} [NCPU] - Host CPU count.
 * @property {number} [MemTotal] - Host memory in bytes.
 */

/**
 * @typedef {import("./docker-connection.js").ConnectionOptions} DockerOpenOptions
 */

/**
 * @typedef {object} UnixDockerTransportSelector
 * @property {"unix"} type - Unix socket transport.
 * @property {string} socketPath - Docker Unix socket path.
 * @property {boolean} [keepAlive] - Reuse HTTP connections.
 * @property {number} [timeoutMs] - Buffered request timeout.
 * @typedef {object} HttpDockerTransportSelector
 * @property {"http"} type - Plain HTTP transport.
 * @property {string} host - Docker host.
 * @property {number} port - Docker port.
 * @property {boolean} [keepAlive] - Reuse HTTP connections.
 * @property {number} [timeoutMs] - Buffered request timeout.
 * @typedef {object} HttpsDockerTransportSelector
 * @property {"https"} type - HTTPS transport.
 * @property {string} host - Docker host.
 * @property {number} port - Docker port.
 * @property {import("./docker-connection.js").TlsOptions} tls - Docker TLS/mTLS options.
 * @property {boolean} [keepAlive] - Reuse HTTPS connections.
 * @property {number} [timeoutMs] - Buffered request timeout.
 * @typedef {import("./socketduct.js").SocketductDockerOptions & {type: "socketduct"}} SocketductDockerTransportSelector
 * @typedef {UnixDockerTransportSelector | HttpDockerTransportSelector | HttpsDockerTransportSelector | SocketductDockerTransportSelector} DockerTransportSelector
 */

/**
 * @typedef {object} CommandOptions
 * @property {number} [timeoutMs] - Optional per-request timeout for the command request.
 * @property {AbortSignal} [signal] - Optional abort signal to cancel the command request.
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
   * @returns {Promise<DockerVersionResponse>}
   */
  async version(options = {}) {
    return await this.connection.request({
      method: "GET",
      path: "/version",
      timeoutMs: options.timeoutMs,
      ...(options.signal ? {signal: options.signal} : {})
    })
  }

  /**
   * Ping the Docker daemon.
   * @param {CommandOptions} [options]
   * @returns {Promise<string>}
   */
  async ping(options = {}) {
    return await this.connection.request({
      method: "GET",
      path: "/_ping",
      timeoutMs: options.timeoutMs,
      ...(options.signal ? {signal: options.signal} : {})
    })
  }

  /**
   * Get Docker system information.
   * @param {CommandOptions} [options]
   * @returns {Promise<DockerInfoResponse>}
   */
  async info(options = {}) {
    return await this.connection.request({
      method: "GET",
      path: "/info",
      timeoutMs: options.timeoutMs,
      ...(options.signal ? {signal: options.signal} : {})
    })
  }

  /** Close all persistent connections to the Docker host. */
  close() {
    this.connection.close()
  }
}

/**
 * @overload
 * @param {SocketductDockerTransportSelector} selector - Socketduct transport configuration.
 * @returns {Docker & {socketductAgent: import("node:http").Agent | import("node:https").Agent}} Docker client and owned Socketduct agent.
 */
/**
 * @overload
 * @param {UnixDockerTransportSelector | HttpDockerTransportSelector | HttpsDockerTransportSelector} selector - Direct transport configuration.
 * @returns {Docker} Docker client.
 */
/**
 * Open Docker through a validated high-level transport selector. This API is
 * separate from the low-level `ConnectionOptions.transport` SnapReq override.
 * @param {DockerTransportSelector} selector - Discriminated Docker transport configuration.
 * @returns {Docker | (Docker & {socketductAgent: import("node:http").Agent | import("node:https").Agent})} Docker client.
 */
export function openDockerTransport(selector) {
  if (selector === null || typeof selector !== "object") {
    throw new TypeError("Docker transport selector must be an object")
  }

  if (selector.type === "unix") {
    if (typeof selector.socketPath !== "string" || selector.socketPath.length === 0) {
      throw new TypeError("Unix Docker transport requires socketPath")
    }
    const unixOptions = {
      socketPath: selector.socketPath,
      keepAlive: selector.keepAlive,
      timeoutMs: selector.timeoutMs
    }
    return Docker.open(unixOptions)
  }

  if (selector.type === "http") {
    validateHostPort(selector, "HTTP")
    return Docker.open({
      host: selector.host,
      port: selector.port,
      keepAlive: selector.keepAlive,
      timeoutMs: selector.timeoutMs
    })
  }

  if (selector.type === "https") {
    validateHostPort(selector, "HTTPS")
    if (selector.tls === null || typeof selector.tls !== "object") {
      throw new TypeError("HTTPS Docker transport requires tls options")
    }
    return Docker.open({
      host: selector.host,
      port: selector.port,
      tls: selector.tls,
      keepAlive: selector.keepAlive,
      timeoutMs: selector.timeoutMs
    })
  }

  if (selector.type === "socketduct") {
    const {type: _type, ...socketductOptions} = selector
    return openDockerOverSocketduct(socketductOptions)
  }

  const unknownType = /** @type {{type?: unknown}} */ (selector).type
  throw new TypeError(`Unknown Docker transport type: ${String(unknownType)}`)
}

/**
 * @param {{host?: unknown, port?: unknown}} selector - Host/port selector.
 * @param {string} label - Transport label.
 * @returns {void}
 */
function validateHostPort(selector, label) {
  const port = selector.port
  if (typeof selector.host !== "string" || selector.host.length === 0 ||
      typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError(`${label} Docker transport requires host and port`)
  }
}

export default Docker
