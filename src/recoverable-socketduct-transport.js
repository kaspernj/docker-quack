import {createHash} from "node:crypto"
import http from "node:http"
import {Duplex, Readable} from "node:stream"

/**
 * @typedef {object} RecoverableOperationContext
 * @property {string} identifier - Stable 8-128 character URL-safe operation identifier; also used as the Socketduct stream identifier.
 *
 * Additional caller-owned fields may be persisted by the journal.
 */

/**
 * @typedef {object} RecoverableTerminalResult
 * @property {number} status - HTTP status code of the complete response.
 * @property {Record<string, string | string[] | undefined>} headers - Response headers as parsed by Node's HTTP parser.
 * @property {string} bodyDigest - Lowercase hex SHA-256 digest of the complete response body.
 * @property {number} bodyBytes - Response body length in bytes.
 * @property {"completed"} terminal - Terminal classification for a fully parsed response.
 */

/**
 * @typedef {object} RecoverableAmbiguousReason
 * @property {"response-limit-exceeded" | "streamed-response" | "stream-lost" | "session-lost" | "commit-failed" | "recovery-failed"} code - Stable reason classification.
 * @property {string} message - Safe description of the failure.
 * @property {Error} [cause] - Underlying failure.
 */

/**
 * Durable operation journal. TensorBuzz owns the implementation; the
 * transport treats it as the single source of truth for replay decisions and
 * stores no application state of its own.
 * @typedef {object} RecoverableJournal
 * @property {(context: RecoverableOperationContext) => Promise<void>} prepare - Called before the request is sent; must durably persist the pending operation. A rejection is a pre-send failure and the transport never writes the request.
 * @property {(context: RecoverableOperationContext, result: RecoverableTerminalResult) => Promise<void>} commitTerminal - Called after the full response is parsed; the transport ACKs and closes only after this resolves.
 * @property {(context: RecoverableOperationContext, reason: RecoverableAmbiguousReason) => Promise<void>} markAmbiguous - Called when the operation cannot be resolved safely; the transport neither ACKs nor retries.
 */

/**
 * @typedef {object} RecoverableVirtualSocket
 * @property {boolean} manualReceiveAck - Whether the socket opted into application-controlled receive acknowledgement.
 * @property {boolean} [encrypted] - Whether the socket carries TLS toward the target.
 * @property {boolean} [destroyed] - Whether the stream is destroyed.
 * @property {string} [remoteAddress] - Logical target host.
 * @property {number} [remotePort] - Logical target port.
 * @property {(bytes: string | ArrayBufferView, encoding?: BufferEncoding) => Promise<void>} [writeDurable] - Atomically admit one complete serialized operation.
 * @property {(bytes: number) => Promise<number>} [acknowledgeReceive] - Durably acknowledge application-consumed response bytes.
 * @property {(error?: Error | null) => void} destroy - Destroy the virtual stream.
 * @property {(...args: Array<unknown>) => RecoverableVirtualSocket} on - Subscribe to stream events.
 * @property {(...args: Array<unknown>) => RecoverableVirtualSocket} once - Subscribe to one stream event.
 */

/**
 * @typedef {object} RecoverableTransportSet
 * @property {(options: {host: string, port: number, identifier?: string, sessionName?: string, manualReceiveAck?: boolean}, callback?: (error: Error | null, socket: RecoverableVirtualSocket) => void) => RecoverableVirtualSocket} createConnection - Open a new virtual stream on a ready member.
 * @property {(options: {identifier: string}) => RecoverableVirtualSocket} recoverConnection - Register one durable stream by stable identifier before start().
 * @property {() => Promise<void>} [detach] - Preserve durable streams for process-replacement recovery.
 */

/**
 * @typedef {object} RecoverableSocketductTransportOptions
 * @property {RecoverableTransportSet} transportSet - Injected Socketduct transport set with reverse gateway members. Socketduct is deliberately injected instead of imported.
 * @property {RecoverableJournal} journal - Durable operation journal adapter.
 * @property {{host: string, port: number}} target - Plaintext Docker API target authorized by the relay.
 * @property {number} [maxResponseBytes] - Strict bound on a complete response body in bytes. Defaults to 10 MiB.
 * @property {string} [sessionNamePrefix] - Stream session name prefix. Defaults to `docker-quack-recoverable`.
 */

/**
 * @typedef {object} RecoverableRequestOptions
 * @property {string} method - HTTP method.
 * @property {string} path - Request path including any query string.
 * @property {Record<string, string | number | Array<string | number>>} [headers] - Additional request headers. `Connection: close` and `Accept-Encoding: identity` are forced.
 * @property {string | Buffer | Uint8Array} [body] - Complete buffered request body.
 * @property {RecoverableOperationContext} context - Operation context including the stable identifier.
 * @property {unknown} [bodyCompression] - Rejected: the transport never compresses requests.
 */

/**
 * @typedef {object} RecoverableRecoveryOptions
 * @property {RecoverableTransportSet} [transportSet] - Replacement transport set; required by `recoverOperation`.
 * @property {string} [identifier] - Stable operation identifier; required by `recoverOperation`.
 * @property {RecoverableVirtualSocket} [socket] - Recovered virtual socket; required by `recoverReattachment`.
 * @property {string} method - Original HTTP method.
 * @property {string} path - Original request path.
 * @property {Record<string, string | number | Array<string | number>>} [headers] - Original request headers; re-serialized only so the fresh parser can be discarded without re-sending.
 * @property {string | Buffer | Uint8Array} [body] - Original request body.
 * @property {RecoverableOperationContext} context - The same operation context as the original request.
 * @property {unknown} [bodyCompression] - Rejected: the transport never compresses requests.
 */

/**
 * @typedef {object} RecoverableResponseResult
 * @property {number} status - HTTP status code.
 * @property {Record<string, string | string[] | undefined>} headers - Response headers.
 * @property {Buffer} body - Complete response body.
 */

/**
 * @typedef {object} RecoverableSocketductTransport
 * @property {(options: RecoverableRequestOptions) => Promise<RecoverableResponseResult>} request - Send one Docker API request as a durable whole-write and resolve after the journal commits and the response is acknowledged.
 * @property {(options: RecoverableRecoveryOptions) => Promise<RecoverableResponseResult>} recoverOperation - Recover a prepared operation by stable identifier on a replacement transport set and re-attach a fresh response parser.
 * @property {(options: RecoverableRecoveryOptions) => Promise<RecoverableResponseResult>} recoverReattachment - Re-attach a fresh response parser to an already recovered virtual socket.
 */

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const DEFAULT_SESSION_NAME_PREFIX = "docker-quack-recoverable"
const STABLE_IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/
const HTTP_METHOD = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/
const RAW_STREAM_CONTENT_TYPE = "application/vnd.docker.raw-stream"

/**
 * Typed recoverable-transport failure with a stable code. Socketduct contract
 * errors (for example `SOCKETDUCT_DURABLE_WRITE_UNSUPPORTED`) are surfaced as
 * their original errors instead of being wrapped.
 */
export class RecoverableSocketductTransportError extends Error {
  /**
   * @param {string} message - Safe description.
   * @param {string} code - Stable code.
   * @param {{cause?: unknown}} [options] - Optional underlying failure.
   */
  constructor(message, code, options = {}) {
    super(message)
    this.name = "RecoverableSocketductTransportError"
    this.code = code
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {configurable: true, value: options.cause})
    }
  }
}

/**
 * Create a recovery-aware Docker API transport over an injected Socketduct
 * transport set. Each request is serialized with Node's HTTP machinery,
 * buffered fully, and sent as one `writeDurable` whole-write so recovery sees
 * zero or the complete request. Receive acknowledgements are withheld until
 * the complete bounded response is parsed and the journal has durably
 * committed the terminal result.
 * @param {RecoverableSocketductTransportOptions} options - Transport configuration.
 * @returns {RecoverableSocketductTransport} Request, recovery, and re-attachment surface.
 */
export function createRecoverableSocketductTransport(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Recoverable Socketduct transport requires options")
  }
  const {transportSet, journal, target, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, sessionNamePrefix = DEFAULT_SESSION_NAME_PREFIX} = options
  if (!validJournal(journal)) {
    throw new RecoverableSocketductTransportError(
      "Recoverable Socketduct transport requires a journal adapter",
      "RECOVERABLE_TRANSPORT_JOURNAL_REQUIRED"
    )
  }
  if (transportSet === null || typeof transportSet !== "object" ||
      typeof transportSet.createConnection !== "function" || typeof transportSet.recoverConnection !== "function") {
    throw new TypeError("Recoverable Socketduct transport requires an injected Socketduct transport set")
  }
  if (!validTarget(target)) {
    throw new TypeError("Recoverable Socketduct transport requires a plaintext Docker target")
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError("Recoverable Socketduct transport maxResponseBytes must be a positive safe integer")
  }
  if (typeof sessionNamePrefix !== "string" || sessionNamePrefix.length === 0) {
    throw new TypeError("Recoverable Socketduct transport sessionNamePrefix must be a non-empty string")
  }

  /**
   * @param {RecoverableRequestOptions} requestOptions
   * @returns {Promise<RecoverableResponseResult>}
   */
  async function request(requestOptions) {
    const validated = validateRequest(requestOptions)
    await journal.prepare(validated.context)
    const socket = openRequestSocket(validated, transportSet, target, sessionNamePrefix)

    try {
      verifySocketCapabilities(socket)
    } catch (error) {
      destroyQuietly(socket)
      throw error
    }

    return driveRecoverableRequest({
      journal,
      socket,
      mode: "send",
      maxResponseBytes,
      ...validated
    })
  }

  /**
   * @param {RecoverableRecoveryOptions} recoveryOptions
   * @returns {Promise<RecoverableResponseResult>}
   */
  function recoverOperation(recoveryOptions) {
    const validated = validateRequest(recoveryOptions)
    const {transportSet: replacement, identifier} = recoveryOptions
    if (replacement === null || typeof replacement !== "object" || typeof replacement.recoverConnection !== "function") {
      throw new TypeError("Recoverable Socketduct transport recovery requires a replacement transport set with recoverConnection")
    }
    if (!validIdentifier(identifier)) {
      throw new RecoverableSocketductTransportError(
        "Recoverable Socketduct transport recovery requires a stable 8-128 character identifier",
        "RECOVERABLE_TRANSPORT_INVALID_IDENTIFIER"
      )
    }
    /** @type {RecoverableVirtualSocket} */
    let socket
    try {
      socket = replacement.recoverConnection({identifier: /** @type {string} */ (identifier)})
    } catch (error) {
      return markAmbiguousThenReject(validated.context, journal, "recovery-failed", error)
    }

    try {
      verifySocketCapabilities(socket)
    } catch (error) {
      destroyQuietly(socket)
      return markAmbiguousThenReject(validated.context, journal, "recovery-failed", error)
    }

    return driveRecoverableRequest({
      journal,
      socket,
      mode: "discard",
      maxResponseBytes,
      ...validated
    })
  }

  /**
   * @param {RecoverableRecoveryOptions} recoveryOptions
   * @returns {Promise<RecoverableResponseResult>}
   */
  function recoverReattachment(recoveryOptions) {
    const validated = validateRequest(recoveryOptions)
    const {socket} = recoveryOptions
    if (socket === null || typeof socket !== "object" || typeof socket.destroy !== "function") {
      throw new TypeError("Recoverable Socketduct transport re-attachment requires a recovered virtual socket")
    }

    try {
      verifySocketCapabilities(socket)
    } catch (error) {
      destroyQuietly(socket)
      throw error
    }

    return driveRecoverableRequest({
      journal,
      socket,
      mode: "discard",
      maxResponseBytes,
      ...validated
    })
  }

  return {request, recoverOperation, recoverReattachment}
}

/**
 * @param {RecoverableRequestOptions | RecoverableRecoveryOptions} requestOptions
 * @returns {{method: string, path: string, headers: Record<string, string | number | Array<string | number>>, body: string | Buffer | Uint8Array | undefined, context: RecoverableOperationContext}}
 */
function validateRequest(requestOptions) {
  if (requestOptions === null || typeof requestOptions !== "object") {
    throw new TypeError("Recoverable Socketduct transport requires request options")
  }
  const {method, path, headers = {}, body, context, bodyCompression} = requestOptions
  if (typeof method !== "string" || !HTTP_METHOD.test(method)) {
    throw new TypeError("Recoverable Socketduct transport requires a valid HTTP method")
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("Recoverable Socketduct transport requires a request path beginning with /")
  }
  if (bodyCompression !== undefined) {
    throw new RecoverableSocketductTransportError(
      "Recoverable Socketduct transport rejects request compression",
      "RECOVERABLE_TRANSPORT_REQUEST_COMPRESSION"
    )
  }
  if (body instanceof Readable) {
    throw new RecoverableSocketductTransportError(
      "Recoverable Socketduct transport rejects streaming request bodies",
      "RECOVERABLE_TRANSPORT_STREAMING_BODY"
    )
  }
  if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError("Recoverable Socketduct transport request body must be a string, Buffer, or Uint8Array")
  }
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("Recoverable Socketduct transport request headers must be an object")
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string" && typeof value !== "number" && !(Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" || typeof entry === "number"))) {
      throw new TypeError(`Recoverable Socketduct transport header ${key} must be a string, number, or array of strings and numbers`)
    }
  }
  if (context === null || typeof context !== "object" || !validIdentifier(context.identifier)) {
    throw new RecoverableSocketductTransportError(
      "Recoverable Socketduct transport requires an operation context with a stable 8-128 character identifier",
      "RECOVERABLE_TRANSPORT_INVALID_IDENTIFIER"
    )
  }

  return {method, path, headers, body, context}
}

/**
 * @param {RecoverableOperationContext} context
 * @param {RecoverableJournal} journal
 * @param {RecoverableAmbiguousReason["code"]} code
 * @param {unknown} failure
 * @returns {Promise<never>}
 */
function markAmbiguousThenReject(context, journal, code, failure) {
  const error = asError(failure)
  const reason = {
    code,
    message: code === "recovery-failed"
      ? "Socketduct stream recovery failed"
      : "The Docker operation could not be resolved safely",
    cause: error
  }
  return journal.markAmbiguous(context, reason).then(
    () => {
      throw new RecoverableSocketductTransportError(
        "Socketduct stream recovery failed",
        "RECOVERABLE_TRANSPORT_RECOVERY_FAILED",
        {cause: error}
      )
    },
    (markError) => {
      throw markError
    }
  )
}

/**
 * Open the virtual socket for one durable request. Socketduct rejects a
 * missing member, limit, or selector violation here; a rejected `prepare`
 * never reaches this point.
 * @param {{context: RecoverableOperationContext}} validated
 * @param {RecoverableTransportSet} transportSet
 * @param {{host: string, port: number}} target
 * @param {string} sessionNamePrefix
 * @returns {RecoverableVirtualSocket}
 */
function openRequestSocket(validated, transportSet, target, sessionNamePrefix) {
  const socket = transportSet.createConnection({
    host: target.host,
    port: target.port,
    identifier: validated.context.identifier,
    sessionName: `${sessionNamePrefix}-${validated.context.identifier}`,
    manualReceiveAck: true
  })
  if (socket === null || typeof socket !== "object") {
    throw new TypeError("Socketduct transport set returned an invalid virtual socket")
  }
  return socket
}

/**
 * @param {RecoverableVirtualSocket} socket
 * @returns {void}
 */
function verifySocketCapabilities(socket) {
  if (socket.encrypted === true) {
    throw new RecoverableSocketductTransportError(
      "Recoverable Socketduct transport requires a plaintext Docker target socket",
      "RECOVERABLE_TRANSPORT_TLS_TARGET"
    )
  }
  if (typeof socket.writeDurable !== "function") {
    throw new RecoverableSocketductTransportError(
      "The Socketduct transport does not admit durable whole-writes",
      "RECOVERABLE_TRANSPORT_DURABLE_WRITE_REQUIRED"
    )
  }
  if (socket.manualReceiveAck !== true) {
    throw new RecoverableSocketductTransportError(
      "The Socketduct transport does not enable manual receive acknowledgement",
      "RECOVERABLE_TRANSPORT_MANUAL_ACK_REQUIRED"
    )
  }
}

/**
 * @param {RecoverableVirtualSocket} socket
 * @returns {void}
 */
function destroyQuietly(socket) {
  if (!socket.destroyed) {
    try {
      socket.destroy()
    } catch {
      // The stream may already be terminal; destruction is best-effort here.
    }
  }
}

/**
 * Drive one request or re-attachment over a virtual socket with Node's HTTP
 * machinery. In `send` mode the fully buffered request is admitted as one
 * `writeDurable` whole-write; in `discard` mode the fresh parser's outgoing
 * request bytes are dropped because the original durable write is
 * authoritative.
 * @param {{journal: RecoverableJournal, socket: RecoverableVirtualSocket, mode: "send" | "discard", maxResponseBytes: number, method: string, path: string, headers: Record<string, string | number | Array<string | number>>, body: string | Buffer | Uint8Array | undefined, context: RecoverableOperationContext}} params
 * @returns {Promise<RecoverableResponseResult>}
 */
function driveRecoverableRequest({journal, socket, mode, maxResponseBytes, method, path, headers, body, context}) {
  return new Promise((resolve, reject) => {
    /** @type {boolean} */
    let settled = false
    /** @type {Buffer[]} */
    const bodyChunks = []
    /** @type {number} */
    let bodyBytes = 0
    /** @type {RecoverableRequestProxy} */
    let proxy
    /** @type {Error | null} */
    let streamError = null

    /**
     * @param {Error | null} [error]
     * @returns {void}
     */
    const closeStream = (error = null) => {
      if (!proxy.destroyed) proxy.destroy(error)
    }

    /**
     * @param {Error} error
     * @param {RecoverableAmbiguousReason | undefined} [reason]
     * @returns {void}
     */
    const fail = (error, reason) => {
      if (settled) return
      settled = true
      closeStream(error)
      if (reason === undefined) {
        reject(error)
        return
      }
      journal.markAmbiguous(context, reason).then(
        () => reject(error),
        (markError) => reject(markError)
      )
    }

    /**
     * @param {number} status
     * @param {Record<string, string | string[] | undefined>} responseHeaders
     * @param {Buffer} responseBody
     * @returns {void}
     */
    const succeed = (status, responseHeaders, responseBody) => {
      if (settled) return
      settled = true
      /** @type {RecoverableTerminalResult} */
      const result = {
        status,
        headers: responseHeaders,
        bodyDigest: createHash("sha256").update(responseBody).digest("hex"),
        bodyBytes: responseBody.length,
        terminal: "completed"
      }
      journal.commitTerminal(context, result).then(async () => {
        try {
          await socket.acknowledgeReceive(proxy.deliveredBytes)
        } catch (error) {
          closeStream(asError(error))
          reject(asError(error))
          return
        }
        closeStream()
        resolve({status, headers: responseHeaders, body: responseBody})
      }, (error) => {
        closeStream(asError(error))
        journal.markAmbiguous(context, {
          code: "commit-failed",
          message: "The journal failed to commit the terminal result",
          cause: asError(error)
        }).then(
          () => reject(asError(error)),
          (markError) => reject(markError)
        )
      })
    }

    proxy = new RecoverableRequestProxy(socket)

    socket.on("error", (error) => {
      streamError = streamError ?? asError(/** @type {unknown} */ (error))
      if (!settled) fail(streamError, streamLossReason(streamError))
    })

    const request = http.request({
      host: typeof socket.remoteAddress === "string" && socket.remoteAddress.length > 0 ? socket.remoteAddress : "localhost",
      port: typeof socket.remotePort === "number" && socket.remotePort > 0 ? socket.remotePort : 80,
      method,
      path,
      headers: forcedRequestHeaders(headers),
      agent: new RecoverableRequestAgent(proxy)
    })

    request.on("upgrade", () => {
      fail(
        new RecoverableSocketductTransportError("Docker response switched protocols", "RECOVERABLE_TRANSPORT_STREAMED_RESPONSE"),
        {code: "streamed-response", message: "The Docker target switched protocols on the response"}
      )
    })

    request.on("response", (response) => {
      if (settled) return
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase()
      if (response.statusCode === 101 || contentType.startsWith(RAW_STREAM_CONTENT_TYPE)) {
        fail(
          new RecoverableSocketductTransportError("Docker response is streamed or hijacked", "RECOVERABLE_TRANSPORT_STREAMED_RESPONSE"),
          {code: "streamed-response", message: "The Docker target answered with a streamed or hijacked response"}
        )
        return
      }
      response.on("data", (chunk) => {
        const data = /** @type {Buffer} */ (Buffer.isBuffer(chunk) ? chunk : Buffer.from(/** @type {Uint8Array} */ (chunk)))
        bodyBytes += data.length
        if (bodyBytes > maxResponseBytes) {
          fail(
            new RecoverableSocketductTransportError(
              `Docker response body exceeds the ${maxResponseBytes} byte bound`,
              "RECOVERABLE_TRANSPORT_RESPONSE_LIMIT_EXCEEDED"
            ),
            {code: "response-limit-exceeded", message: `The Docker response body exceeded the ${maxResponseBytes} byte bound`}
          )
          return
        }
        bodyChunks.push(data)
      })
      response.on("end", () => {
        if (!settled) succeed(response.statusCode, response.headers, Buffer.concat(bodyChunks))
      })
      response.on("error", (error) => {
        if (!settled) fail(asError(/** @type {unknown} */ (error)), streamLossReason(asError(/** @type {unknown} */ (error))))
      })
    })

    request.on("finish", () => {
      if (settled) return
      if (mode === "discard") return
      const fullRequest = Buffer.concat(proxy.requestChunks)
      socket.writeDurable(fullRequest).catch((error) => {
        // A rejected durable write admits zero bytes, so nothing was executed;
        // surface the Socketduct error and close without marking ambiguous.
        fail(asError(/** @type {unknown} */ (error)))
      })
    })

    request.on("error", (error) => {
      if (settled) return
      const errorCause = streamError ?? asError(/** @type {unknown} */ (error))
      fail(errorCause, streamLossReason(errorCause))
    })

    if (body === undefined) request.end()
    else request.end(body)
  })
}

/**
 * @param {Error} error
 * @returns {RecoverableAmbiguousReason}
 */
function streamLossReason(error) {
  if (isSessionLoss(error)) {
    return {code: "session-lost", message: "The Socketduct session or transport was lost before the response completed", cause: error}
  }
  return {code: "stream-lost", message: "The Socketduct stream was lost before the response completed", cause: error}
}

/**
 * @param {Error} error
 * @returns {boolean}
 */
function isSessionLoss(error) {
  if (error === null || typeof error !== "object") return false
  const code = /** @type {Error & {code?: string}} */ (error).code
  if (code === "SOCKETDUCT_SESSION_LOST" || code === "SOCKETDUCT_CONNECTION_DETACHED" || code === "CONNECTION_DETACHED") return true
  return error.name === "SocketductSessionLostError"
}

/**
 * @param {Record<string, string | number | Array<string | number>>} headers
 * @returns {http.OutgoingHttpHeaders}
 */
function forcedRequestHeaders(headers) {
  const forced = {}
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    if (normalized === "connection" || normalized === "accept-encoding") continue
    forced[key] = value
  }
  forced["Connection"] = "close"
  forced["Accept-Encoding"] = "identity"
  return forced
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validJournal(value) {
  if (value === null || typeof value !== "object") return false
  const journal = /** @type {Record<string, unknown>} */ (value)
  return typeof journal.prepare === "function" && typeof journal.commitTerminal === "function" &&
    typeof journal.markAmbiguous === "function"
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validIdentifier(value) {
  return typeof value === "string" && STABLE_IDENTIFIER.test(value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validTarget(value) {
  if (value === null || typeof value !== "object") return false
  const endpoint = /** @type {{host?: unknown, port?: unknown}} */ (value)
  return typeof endpoint.host === "string" && endpoint.host.length > 0 &&
    typeof endpoint.port === "number" && Number.isSafeInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65_535
}

/**
 * @param {unknown} value
 * @returns {Error}
 */
function asError(value) {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Proxy between Node's HTTP client and one virtual socket. The writable side
 * fully buffers the serialized request; the readable side forwards virtual
 * socket bytes to the parser while counting delivered application bytes for
 * the eventual receive acknowledgement.
 * @augments Duplex
 */
class RecoverableRequestProxy extends Duplex {
  /** @type {RecoverableVirtualSocket} */
  virtual

  /** @type {Buffer[]} */
  requestChunks = []

  /** @type {number} */
  deliveredBytes = 0

  /**
   * @param {RecoverableVirtualSocket} virtual
   */
  constructor(virtual) {
    // autoDestroy must stay off: Node destroys the stream when the request's
    // writable side finishes, which would drop the virtual socket before the
    // journal commit and receive acknowledgement complete. Teardown is owned
    // by the transport.
    super({allowHalfOpen: true, autoDestroy: false})
    this.virtual = virtual
    virtual.on("data", (chunk) => {
      this.deliveredBytes += /** @type {Buffer} */ (chunk).length
      this.push(/** @type {Buffer} */ (chunk))
    })
    virtual.once("end", () => this.push(null))
    virtual.once("error", (error) => {
      if (!this.destroyed) this.destroy(/** @type {Error} */ (error))
    })
    virtual.once("close", () => {
      if (!this.destroyed) this.destroy()
    })
    virtual.once("connect", () => {
      if (!this.destroyed) this.emit("connect")
    })
  }

  /** @returns {void} */
  _read() {
    // Inbound flow is driven by virtual socket data events.
  }

  /**
   * @param {Buffer | string} chunk
   * @param {BufferEncoding} encoding
   * @param {(error?: Error | null) => void} callback
   * @returns {void}
   */
  _write(chunk, encoding, callback) {
    this.requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(/** @type {string} */ (chunk), encoding))
    callback()
  }

  /**
   * @param {(error?: Error | null) => void} callback
   * @returns {void}
   */
  _final(callback) {
    // The request was admitted durably on ClientRequest finish; the writable
    // side simply ends and the transport keeps the stream alive.
    callback()
  }

  /**
   * @param {Error | null} error
   * @param {(error?: Error | null) => void} callback
   * @returns {void}
   */
  _destroy(error, callback) {
    if (!this.virtual.destroyed) this.virtual.destroy(error ?? null)
    callback(error ?? null)
  }

  /**
   * Node calls this from responseOnEnd after a Connection: close response
   * ends and synchronously asserts the socket is no longer writable. End the
   * writable side only: the virtual socket must stay alive until the journal
   * commits the terminal result and the delivered bytes are acknowledged, so
   * the actual destruction is owned by the transport after the ACK.
   * @returns {this}
   */
  destroySoon() {
    if (this.writable) this.end()
    return this
  }

  /** @returns {this} */
  setTimeout() {
    return this
  }

  /** @returns {this} */
  setNoDelay() {
    return this
  }

  /** @returns {this} */
  setKeepAlive() {
    return this
  }
}

/**
 * HTTP agent whose sole job is to hand Node's ClientRequest the proxy socket.
 * @augments http.Agent
 */
class RecoverableRequestAgent extends http.Agent {
  /** @type {RecoverableRequestProxy} */
  proxy

  /**
   * @param {RecoverableRequestProxy} proxy
   */
  constructor(proxy) {
    super({keepAlive: false})
    this.proxy = proxy
  }

  /**
   * @param {import("node:http").ClientRequest} request
   * @param {object} _options
   * @returns {void}
   */
  addRequest(request, _options) {
    request.onSocket(/** @type {import("node:net").Socket} */ (/** @type {unknown} */ (this.proxy)))
  }
}
