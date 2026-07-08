import Docker from "./index.js"

/**
 * @typedef {object} SeamlineDockerOptions
 * @property {new (options: object) => import("node:http").Agent} SeamlineHttpAgent - Seamline HTTP Agent class. Injected so Seamline stays optional.
 * @property {{host: string, port: number, token: string}} relay - Seamline relay connection.
 * @property {{host: string, port: number}} target - Docker API target authorized by the relay.
 * @property {string} spoolDirectory - Seamline spool directory.
 * @property {string} [sessionNamePrefix] - Prefix for generated Seamline sessions.
 * @property {string} [sessionName] - Fixed Seamline session name.
 * @property {{initialDelayMs?: number}} [reconnect] - Seamline reconnect options.
 * @property {boolean} [keepAlive] - Keep HTTP sockets alive through Seamline.
 * @property {number} [maxSockets] - Maximum sockets for the Seamline agent.
 * @property {number} [maxFreeSockets] - Maximum free sockets for the Seamline agent.
 * @property {string} [dockerHost] - Logical Docker host used in HTTP Host headers. Defaults to target.host.
 * @property {number} [dockerPort] - Logical Docker port used in HTTP Host headers. Defaults to target.port.
 * @property {number} [timeoutMs] - Per-request timeout for buffered Docker API requests.
 */

/**
 * Open a Docker client whose HTTP sockets are created by Seamline.
 *
 * Seamline is deliberately injected instead of imported here. This keeps
 * docker-quack standalone while letting applications pass SeamlineHttpAgent
 * from the seamline package when they want resilient Docker transport.
 * @param {SeamlineDockerOptions & Record<string, unknown>} options - Seamline-backed Docker options.
 * @returns {Docker & {seamlineAgent: import("node:http").Agent}} - Docker client and the backing Seamline agent.
 */
export function openDockerOverSeamline(options) {
  const {
    SeamlineHttpAgent,
    target,
    dockerHost = target.host,
    dockerPort = target.port,
    timeoutMs,
    ...agentOptions
  } = options
  const seamlineAgent = new SeamlineHttpAgent({...agentOptions, target})
  const docker = Docker.open({host: dockerHost, port: dockerPort, agent: seamlineAgent, timeoutMs})
  const closeDocker = docker.close.bind(docker)

  const seamlineDocker = Object.assign(docker, {seamlineAgent})
  seamlineDocker.close = () => {
    try {
      closeDocker()
    } finally {
      seamlineAgent.destroy()
    }
  }

  return seamlineDocker
}
