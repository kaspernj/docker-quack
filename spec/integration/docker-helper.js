/**
 * Parses DOCKER_HOST env var and opens a Docker client.
 * Skips integration tests when DOCKER_HOST is not set.
 */
import Docker from "../../src/index.js"

/**
 * Parse a DOCKER_HOST URL into connection options.
 * @param {string} dockerHost - e.g. "tcp://docker_server:2375"
 * @returns {{host: string, port: number}}
 */
function parseDockerHost(dockerHost) {
  const url = new URL(dockerHost.replace("tcp://", "http://"))

  return {
    host: url.hostname,
    port: Number(url.port)
  }
}

/** @returns {Docker | undefined} */
function openDockerFromEnv() {
  const dockerHost = process.env.DOCKER_HOST

  if (!dockerHost) return undefined

  const options = parseDockerHost(dockerHost)

  return Docker.open(options)
}

export {openDockerFromEnv}
