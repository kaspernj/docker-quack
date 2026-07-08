import Docker from "./index.js"

/**
 * @typedef {object} SocketductDockerOptions
 * @property {new (options: object) => import("node:http").Agent} SocketductHttpAgent - Socketduct HTTP Agent class. Injected so Socketduct stays optional.
 * @property {{host: string, port: number, token: string}} relay - Socketduct relay connection.
 * @property {{host: string, port: number}} target - Docker API target authorized by the relay.
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
 * docker-quack standalone while letting applications pass SocketductHttpAgent
 * from the socketduct package when they want resilient Docker transport.
 * @param {SocketductDockerOptions & Record<string, unknown>} options - Socketduct-backed Docker options.
 * @returns {Docker & {socketductAgent: import("node:http").Agent}} - Docker client and the backing Socketduct agent.
 */
export function openDockerOverSocketduct(options) {
  const {
    SocketductHttpAgent,
    target,
    dockerHost = target.host,
    dockerPort = target.port,
    timeoutMs,
    ...agentOptions
  } = options
  const socketductAgent = new SocketductHttpAgent({...agentOptions, target})
  const docker = Docker.open({host: dockerHost, port: dockerPort, agent: socketductAgent, timeoutMs})
  const closeDocker = docker.close.bind(docker)

  const socketductDocker = Object.assign(docker, {socketductAgent})
  socketductDocker.close = () => {
    try {
      closeDocker()
    } finally {
      socketductAgent.destroy()
    }
  }

  return socketductDocker
}
