import Docker from "./index.js"

/**
 * @typedef {object} SocketductDockerOptions
 * @property {new (options: object) => import("node:http").Agent} [SocketductHttpAgent] - Socketduct HTTP Agent class. Required for plaintext targets.
 * @property {new (options: object) => import("node:https").Agent} [SocketductHttpsAgent] - Socketduct HTTPS Agent class. Required when targetTls is configured.
 * @property {{host: string, port: number, token: string}} relay - Socketduct relay connection.
 * @property {{caFile?: string, certFile?: string, keyFile?: string, servername?: string, rejectUnauthorized?: boolean}} [relayTls] - TLS for the edge-to-relay connection.
 * @property {{host: string, port: number}} target - Docker API target authorized by the relay.
 * @property {{ca?: string | Buffer | Array<string | Buffer>, cert?: string | Buffer | Array<string | Buffer>, key?: string | Buffer, rejectUnauthorized?: boolean, servername?: string}} [targetTls] - TLS/mTLS for the Docker target.
 * @property {string} spoolDirectory - Socketduct spool directory.
 * @property {string} [sessionNamePrefix] - Prefix for generated Socketduct sessions.
 * @property {string} [sessionName] - Fixed Socketduct session name.
 * @property {{initialDelayMs?: number}} [reconnect] - Socketduct reconnect options.
 * @property {boolean} [keepAlive] - Keep HTTP sockets alive through Socketduct.
 * @property {number} [maxSockets] - Maximum sockets for the Socketduct agent.
 * @property {number} [maxFreeSockets] - Maximum free sockets for the Socketduct agent.
 * @property {string} [dockerHost] - Logical Docker host used in HTTP Host headers. Defaults to target.host.
 * @property {number} [dockerPort] - Logical Docker port used in HTTP Host headers. Defaults to target.port.
 * @property {number} [timeoutMs] - Per-request timeout for buffered Docker API requests.
 */

/**
 * Open a Docker client whose HTTP sockets are created by Socketduct.
 *
 * Socketduct is deliberately injected instead of imported here. This keeps
 * docker-quack standalone while letting applications pass Socketduct agent
 * classes when they want resilient Docker transport.
 * @param {SocketductDockerOptions & Record<string, unknown>} options - Socketduct-backed Docker options.
 * @returns {Docker & {socketductAgent: import("node:http").Agent | import("node:https").Agent}} - Docker client and the backing Socketduct agent.
 */
export function openDockerOverSocketduct(options) {
  if (options === null || typeof options !== "object" ||
      !validRelay(options.relay) || !validEndpoint(options.target) ||
      typeof options.spoolDirectory !== "string" || options.spoolDirectory.length === 0) {
    throw new TypeError("Socketduct transport requires relay, target, and spoolDirectory")
  }
  if (options.targetTls !== undefined && (options.targetTls === null || typeof options.targetTls !== "object")) {
    throw new TypeError("Socketduct targetTls must be an object when configured")
  }
  const {
    SocketductHttpAgent,
    SocketductHttpsAgent,
    target,
    dockerHost = target.host,
    dockerPort = target.port,
    keepAlive,
    timeoutMs,
    relayTls,
    targetTls,
    tls: legacyRelayTls,
    ...agentOptions
  } = options
  if (typeof dockerHost !== "string" || dockerHost.length === 0 || !validPort(dockerPort)) {
    throw new TypeError("Socketduct transport requires a valid logical dockerHost and dockerPort")
  }

  const AgentClass = targetTls === undefined ? SocketductHttpAgent : SocketductHttpsAgent
  if (typeof AgentClass !== "function") {
    const name = targetTls === undefined ? "SocketductHttpAgent" : "SocketductHttpsAgent"
    const condition = targetTls === undefined ? "for plaintext targets" : "when targetTls is configured"
    throw new TypeError(`${name} is required ${condition}`)
  }

  const effectiveTargetTls = targetTls === undefined
    ? undefined
    : {...targetTls, ...(targetTls.servername === undefined ? {servername: dockerHost} : {})}
  const effectiveRelayTls = relayTls ?? legacyRelayTls
  const effectiveKeepAlive = keepAlive ?? true
  const socketductAgent = new AgentClass({
    ...agentOptions,
    target,
    ...(effectiveRelayTls === undefined
      ? {}
      : targetTls === undefined ? {tls: effectiveRelayTls} : {relayTls: effectiveRelayTls}),
    ...(effectiveTargetTls === undefined ? {} : {targetTls: effectiveTargetTls}),
    keepAlive: effectiveKeepAlive
  })
  let docker
  try {
    docker = Docker.open({
      host: dockerHost,
      port: dockerPort,
      ...(targetTls === undefined
        ? {agent: /** @type {import("node:http").Agent} */ (socketductAgent)}
        : {httpsAgent: /** @type {import("node:https").Agent} */ (socketductAgent)}),
      keepAlive: effectiveKeepAlive,
      timeoutMs
    })
  } catch (error) {
    socketductAgent.destroy()
    throw error
  }
  const closeDocker = docker.close.bind(docker)
  let closed = false

  const socketductDocker = Object.assign(docker, {socketductAgent})
  socketductDocker.close = () => {
    if (closed) return
    closed = true
    try {
      closeDocker()
    } finally {
      socketductAgent.destroy()
    }
  }

  return socketductDocker
}

/**
 * @param {unknown} value - Relay configuration.
 * @returns {boolean} Whether the relay configuration is complete.
 */
function validRelay(value) {
  return validEndpoint(value) && typeof /** @type {{token?: unknown}} */ (value).token === "string" &&
    /** @type {{token: string}} */ (value).token.length > 0
}

/**
 * @param {unknown} value - Host and port configuration.
 * @returns {boolean} Whether the endpoint is valid.
 */
function validEndpoint(value) {
  if (value === null || typeof value !== "object") return false
  const endpoint = /** @type {{host?: unknown, port?: unknown}} */ (value)
  return typeof endpoint.host === "string" && endpoint.host.length > 0 && validPort(endpoint.port)
}

/**
 * @param {unknown} value - Port candidate.
 * @returns {boolean} Whether the port is valid.
 */
function validPort(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535
}
