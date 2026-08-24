import NodeTransport from "snapreq/transports/node-transport"

/**
 * @typedef {(options: object, oncreate?: (error: Error | null, socket?: import("node:net").Socket) => void) => import("node:net").Socket} CreateConnection
 */

/**
 * @typedef {object} CustomNodeTransportOptions
 * @property {string} [socketPath] - Unix socket path.
 * @property {{ca?: string | Buffer, cert?: string | Buffer, key?: string | Buffer, rejectUnauthorized?: boolean}} [tls] - TLS material for HTTPS connections.
 * @property {boolean} [keepAlive] - Reuse connections across requests. Defaults to true.
 * @property {import("node:http").Agent} [agent] - Custom HTTP agent.
 * @property {import("node:https").Agent} [httpsAgent] - Custom HTTPS agent.
 * @property {CreateConnection} [createConnection] - Custom socket factory for HTTP requests.
 * @property {CreateConnection} [createTlsConnection] - Custom socket factory for HTTPS requests.
 */

/** Node transport variant that lets callers inject HTTP agents or socket factories. */
class CustomNodeTransport extends NodeTransport {
  /**
   * @param {CustomNodeTransportOptions} [options]
   */
  constructor(options = {}) {
    super(options)

    this.customAgent = options.agent
    this.customHttpsAgent = options.httpsAgent
    this.createConnection = options.createConnection
    this.createTlsConnection = options.createTlsConnection
  }

  /**
   * @param {boolean} useTls - Whether the request uses TLS.
   * @returns {import("node:http").Agent | import("node:https").Agent} - The request agent for the protocol.
   */
  _agent(useTls) {
    if (useTls && this.customHttpsAgent) return this.customHttpsAgent
    if (!useTls && this.customAgent) return this.customAgent

    const {http, https} = /** @type {{http: typeof import("node:http"), https: typeof import("node:https")}} */ (this._modules)

    if (useTls) {
      this._httpsAgent ||= this.buildAgent(https.Agent, {
        keepAlive: this.keepAlive,
        ...(this.tls?.ca !== undefined ? {ca: this.tls.ca} : {}),
        ...(this.tls?.cert !== undefined ? {cert: this.tls.cert} : {}),
        ...(this.tls?.key !== undefined ? {key: this.tls.key} : {}),
        ...(this.tls?.rejectUnauthorized !== undefined ? {rejectUnauthorized: this.tls.rejectUnauthorized} : {})
      }, this.createTlsConnection)

      return this._httpsAgent
    }

    this._httpAgent ||= this.buildAgent(http.Agent, {keepAlive: this.keepAlive}, this.createConnection)

    return this._httpAgent
  }

  /**
   * @param {new (options: object) => import("node:http").Agent} AgentClass - Agent constructor.
   * @param {object} options - Agent options.
   * @param {CreateConnection | undefined} createConnection - Optional socket factory.
   * @returns {import("node:http").Agent} - Configured agent.
   */
  buildAgent(AgentClass, options, createConnection) {
    const agent = new AgentClass(options)

    if (createConnection) {
      agent.createConnection = createConnection
    }

    return agent
  }
}

export default CustomNodeTransport
