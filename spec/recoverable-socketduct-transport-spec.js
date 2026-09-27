import {createHash} from "node:crypto"
import {Duplex, Readable} from "node:stream"
import {describe, expect, it} from "velocious/build/src/testing/test.js"

import {createRecoverableSocketductTransport, RecoverableSocketductTransportError} from "../src/recoverable-socketduct-transport.js"

const VERSION_BODY = JSON.stringify({Version: "27.1.0", ApiVersion: "1.46"})

/**
 * Serialize a complete HTTP/1.1 response the way a Docker target would send
 * it, including the exact byte count the transport must acknowledge.
 * @param {{status?: number, statusText?: string, headers?: Record<string, string>, body?: string | Buffer, contentLength?: boolean}} response
 * @returns {Buffer}
 */
function rawHttpResponse({status = 200, statusText = "OK", headers = {}, body = "", contentLength = true} = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8")
  const lines = [`HTTP/1.1 ${status} ${statusText}`]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  if (contentLength) lines.push(`Content-Length: ${payload.length}`)
  lines.push("")
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"), payload])
}

/**
 * @returns {Buffer} A 101 protocol-switch response without a body.
 */
function rawHttpUpgrade() {
  return Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: raw-stream\r\nConnection: upgrade\r\n\r\n", "utf8")
}

/**
 * Scripted stand-in for a Socketduct reverse gateway virtual socket. It
 * exposes the durable transport surface (`writeDurable`,
 * `acknowledgeReceive`, `manualReceiveAck`) and records every admission and
 * acknowledgement so the transport's whole-write and ACK discipline can be
 * asserted exactly.
 * @augments Duplex
 */
class FakeVirtualSocket extends Duplex {
  /** @type {Array<Buffer>} */
  durableWrites = []

  /** @type {Array<Buffer>} */
  plainWrites = []

  /** @type {Array<number>} */
  acks = []

  /** @type {boolean} */
  responseEmitted = false

  /**
   * @param {{manualReceiveAck?: boolean, encrypted?: boolean, response?: Buffer, respondOn?: "writeDurable" | "now", failWith?: {message: string, code: string}, omitWriteDurable?: boolean}} [options]
   */
  constructor(options = {}) {
    super({allowHalfOpen: true})
    this.manualReceiveAck = options.manualReceiveAck ?? true
    this.encrypted = options.encrypted ?? false
    this.remoteAddress = "127.0.0.1"
    this.remotePort = 2375
    /** @type {Buffer | undefined} */
    this.response = options.response
    /** @type {"writeDurable" | "now"} */
    this.respondOn = options.respondOn ?? "writeDurable"
    /** @type {{message: string, code: string} | undefined} */
    this.failWith = options.failWith
    if (options.omitWriteDurable === true) {
      // Simulates a Socketduct transport without durable whole-write support.
    } else {
      this.writeDurable = (/** @type {import("node:buffer").Buffer} */ (bytes) => {
        if (this.destroyed) return Promise.reject(Object.assign(new Error("Socketduct stream is destroyed"), {code: "ERR_STREAM_DESTROYED"}))
        this.durableWrites.push(Buffer.from(bytes))
        if (this.failWith !== undefined) {
          const failure = Object.assign(new Error(this.failWith.message), {code: this.failWith.code})
          setImmediate(() => this.destroy(failure))
          return Promise.resolve()
        }
        if (this.respondOn === "writeDurable") setImmediate(() => this.emitResponse())
        return Promise.resolve()
      })
    }
    this.acknowledgeReceive = (/** @type {number} */ (bytes) => {
      if (this.destroyed) return Promise.reject(Object.assign(new Error("Socketduct stream is destroyed"), {code: "ERR_STREAM_DESTROYED"}))
      this.acks.push(bytes)
      return Promise.resolve(this.acks.reduce((sum, count) => sum + count, 0))
    })
    if (this.respondOn === "now") setImmediate(() => this.emitResponse())
  }

  /** @returns {void} */
  _read() {
    // Inbound flow is driven by scripted response pushes.
  }

  /**
   * @param {Buffer | string} chunk
   * @param {BufferEncoding} encoding
   * @param {(error?: Error | null) => void} callback
   * @returns {void}
   */
  _write(chunk, encoding, callback) {
    this.plainWrites.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(/** @type {string} */ (chunk), encoding))
    callback()
  }

  /**
   * @param {(error?: Error | null) => void} callback
   * @returns {void}
   */
  _final(callback) {
    callback()
  }

  /**
   * @param {Error | null} error
   * @param {(error?: Error | null) => void} callback
   * @returns {void}
   */
  _destroy(error, callback) {
    callback(error ?? null)
  }

  /** Splits the scripted response into fragments, like a relay would. */
  emitResponse() {
    if (this.responseEmitted || this.response === undefined) return
    this.responseEmitted = true
    const first = Math.min(17, this.response.length)
    this.push(this.response.subarray(0, first))
    this.push(this.response.subarray(first))
    this.push(null)
  }
}

/**
 * @param {FakeVirtualSocket} socket
 * @returns {{created: Array<object>, recovered: Array<object>, createConnection: (options: object) => FakeVirtualSocket, recoverConnection: (options: object) => FakeVirtualSocket}}
 */
function makeTransportSet(socket) {
  /** @type {Array<object>} */
  const created = []
  /** @type {Array<object>} */
  const recovered = []
  return {
    created,
    recovered,
    createConnection(options) {
      created.push(options)
      return socket
    },
    recoverConnection(options) {
      recovered.push(options)
      return socket
    }
  }
}

/**
 * @returns {{calls: Array<{op: string, identifier: string, detail?: unknown}>, prepare: (context: object) => Promise<void>, commitTerminal: (context: object, result: unknown) => Promise<void>, markAmbiguous: (context: object, reason: unknown) => Promise<void>}}
 */
function makeJournal() {
  /** @type {Array<{op: string, identifier: string, detail?: unknown}>} */
  const calls = []
  return {
    calls,
    async prepare(context) {
      calls.push({op: "prepare", identifier: context.identifier})
    },
    async commitTerminal(context, result) {
      calls.push({op: "commitTerminal", identifier: context.identifier, detail: result})
    },
    async markAmbiguous(context, reason) {
      calls.push({op: "markAmbiguous", identifier: context.identifier, detail: reason})
    }
  }
}

/**
 * @param {Error} error
 * @param {string} code
 * @returns {Error}
 */
function typedError(error, code) {
  return Object.assign(error, {code})
}

describe("createRecoverableSocketductTransport", () => {
  it("rejects factory options without a complete journal or transport contract", () => {
    const socket = new FakeVirtualSocket()
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)

    expect(() => createRecoverableSocketductTransport({
      transportSet,
      target: {host: "127.0.0.1", port: 2375}
    })).toThrow("Recoverable Socketduct transport requires a journal adapter")

    const partial = {prepare: journal.prepare, commitTerminal: journal.commitTerminal}
    let partialFailure
    try {
      createRecoverableSocketductTransport({
        transportSet,
        journal: /** @type {any} */ (partial),
        target: {host: "127.0.0.1", port: 2375}
      })
    } catch (error) {
      partialFailure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }
    expect(partialFailure).toBeInstanceOf(RecoverableSocketductTransportError)
    expect(partialFailure?.code).toEqual("RECOVERABLE_TRANSPORT_JOURNAL_REQUIRED")

    expect(() => createRecoverableSocketductTransport({
      transportSet: /** @type {any} */ ({createConnection: transportSet.createConnection}),
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })).toThrow("Recoverable Socketduct transport requires an injected Socketduct transport set")

    expect(() => createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: /** @type {any} */ ({host: "127.0.0.1"})
    })).toThrow("Recoverable Socketduct transport requires a plaintext Docker target")

    expect(() => createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375},
      maxResponseBytes: 0
    })).toThrow("Recoverable Socketduct transport maxResponseBytes must be a positive safe integer")
  })

  it("sends one durable whole-write, commits before acknowledging, and ACKs exactly the delivered bytes", async () => {
    /** @type {Array<string>} */
    const events = []
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY, headers: {"Content-Type": "application/json"}})})
    const journal = makeJournal()
    const originalPrepare = journal.prepare
    journal.prepare = (context) => {
      events.push("prepare")
      return originalPrepare(context)
    }
    const originalCommit = journal.commitTerminal
    journal.commitTerminal = (context, result) => {
      events.push("commitTerminal")
      return originalCommit(context, result)
    }
    const originalAck = socket.acknowledgeReceive
    socket.acknowledgeReceive = (bytes) => {
      events.push("ack")
      return originalAck(bytes)
    }
    const originalWriteDurable = socket.writeDurable
    socket.writeDurable = (bytes) => {
      events.push("durableWrite")
      return originalWriteDurable(bytes)
    }

    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    const result = await transport.request({
      method: "GET",
      path: "/version",
      headers:{"X-Forwarded-By": "docker-quack", "Accept-Encoding": "gzip", Connection: "keep-alive"},
      context: {identifier: "spec-op-0001-abc", image: "alpine:3"}
    })

    expect(result.status).toEqual(200)
    expect(result.body.toString()).toEqual(VERSION_BODY)
    expect(socket.durableWrites).toHaveLength(1)
    expect(socket.plainWrites).toEqual([])

    const requestBytes = socket.durableWrites[0].toString()
    expect(requestBytes).toContain("GET /version HTTP/1.1")
    expect(requestBytes).toContain("Connection: close")
    expect(requestBytes).toContain("Accept-Encoding: identity")
    expect(requestBytes).toContain("X-Forwarded-By: docker-quack")
    expect(requestBytes).not.toContain("keep-alive")
    expect(requestBytes).not.toContain("gzip")

    expect(transportSet.created).toHaveLength(1)
    expect(transportSet.created[0]).toEqual({
      host: "127.0.0.1",
      port: 2375,
      identifier: "spec-op-0001-abc",
      sessionName: "docker-quack-recoverable-spec-op-0001-abc",
      manualReceiveAck: true
    })

    expect(events).toEqual(["prepare", "durableWrite", "commitTerminal", "ack"])

    const commit = journal.calls.find((call) => call.op === "commitTerminal")
    expect(commit?.identifier).toEqual("spec-op-0001-abc")
    expect(commit?.detail).toMatchObject({
      status: 200,
      bodyDigest: createHash("sha256").update(Buffer.from(VERSION_BODY, "utf8")).digest("hex"),
      bodyBytes: Buffer.byteLength(VERSION_BODY, "utf8"),
      terminal: "completed"
    })
    expect(commit?.detail?.headers["content-type"]).toEqual("application/json")

    expect(socket.acks).toEqual([rawHttpResponse({body: VERSION_BODY, headers: {"Content-Type": "application/json"}}).length])
    expect(socket.destroyed).toBe(true)
  })

  it("buffers a POST body into the same durable whole-write", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({status: 201, statusText: "Created"})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })
    const payload = "hello dock"

    const result = await transport.request({
      method: "POST",
      path: "/images/load",
      body: Buffer.from(payload, "utf8"),
      context: {identifier: "spec-op-0002-post"}
    })

    expect(result.status).toEqual(201)
    expect(socket.durableWrites).toHaveLength(1)
    expect(socket.plainWrites).toEqual([])
    const requestBytes = socket.durableWrites[0].toString()
    expect(requestBytes).toContain("POST /images/load HTTP/1.1")
    expect(requestBytes).toContain("Content-Length: 10")
    expect(requestBytes).toContain(payload)
  })

  it("sends nothing when the journal prepare rejects", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const prepareFailure = Object.assign(new Error("journal is full"), {code: "JOURNAL_FULL"})
    journal.prepare = () => Promise.reject(prepareFailure)
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0003-prep"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBe(prepareFailure)
    expect(transportSet.created).toEqual([])
    expect(socket.durableWrites).toEqual([])
    expect(journal.calls).toEqual([])
  })

  it("rejects an encrypted target socket before any durable write", async () => {
    const socket = new FakeVirtualSocket({encrypted: true, response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2376}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0004-tls"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBeInstanceOf(RecoverableSocketductTransportError)
    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_TLS_TARGET")
    expect(journal.calls.map((call) => call.op)).toEqual(["prepare"])
    expect(socket.durableWrites).toEqual([])
    expect(socket.acks).toEqual([])
    expect(socket.destroyed).toBe(true)
  })

  it("rejects a socket without durable whole-write support", async () => {
    const socket = new FakeVirtualSocket({omitWriteDurable: true, response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0005-nodur"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_DURABLE_WRITE_REQUIRED")
    expect(journal.calls.map((call) => call.op)).toEqual(["prepare"])
    expect(socket.acks).toEqual([])
  })

  it("rejects a socket without manual receive acknowledgement", async () => {
    const socket = new FakeVirtualSocket({manualReceiveAck: false, response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0006-noack"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_MANUAL_ACK_REQUIRED")
    expect(socket.durableWrites).toEqual([])
    expect(socket.acks).toEqual([])
  })

  it("rejects request compression before any journal interaction", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "POST",
        path: "/images/load",
        body: "payload",
        bodyCompression: {level: 6},
        context: {identifier: "spec-op-0007-comp"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_REQUEST_COMPRESSION")
    expect(journal.calls).toEqual([])
    expect(transportSet.created).toEqual([])
  })

  it("rejects streaming request bodies before any journal interaction", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "POST",
        path: "/images/load",
        body: /** @type {any} */ (Readable.from(["streamed"])),
        context: {identifier: "spec-op-0008-strt"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_STREAMING_BODY")
    expect(journal.calls).toEqual([])
    expect(transportSet.created).toEqual([])
  })

  it("rejects missing or invalid stable identifiers", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    /** @param {object} context */
    const expectInvalid = async (context) => {
      let failure
      try {
        await transport.request({method: "GET", path: "/version", context})
      } catch (error) {
        failure = /** @type {Error} */ (/** @type {unknown} */ (error))
      }
      expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_INVALID_IDENTIFIER")
    }

    await expectInvalid(/** @type {any} */ ({}))
    await expectInvalid({identifier: "short"})
    await expectInvalid({identifier: "bad id!"})
    await expectInvalid({identifier: "x".repeat(129)})

    expect(journal.calls).toEqual([])
    expect(transportSet.created).toEqual([])
    expect(socket.durableWrites).toEqual([])
  })

  it("rejects a response over the bound before completion and marks it ambiguous", async () => {
    const oversized = "x".repeat(64)
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: oversized})})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375},
      maxResponseBytes: 8
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0009-overs"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_RESPONSE_LIMIT_EXCEEDED")
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "response-limit-exceeded"})
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
    expect(socket.acks).toEqual([])
    expect(socket.destroyed).toBe(true)
  })

  it("rejects a 101 protocol switch as a streamed response", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpUpgrade()})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/ws/stream",
        context: {identifier: "spec-op-0010-upgr"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_STREAMED_RESPONSE")
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "streamed-response"})
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
    expect(socket.acks).toEqual([])
  })

  it("rejects a raw-stream content type as a hijacked response", async () => {
    const socket = new FakeVirtualSocket({
      response: rawHttpResponse({headers: {"Content-Type": "application/vnd.docker.raw-stream"}, body: "raw-bytes"})
    })
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "POST",
        path: "/containers/abc/attach",
        context: {identifier: "spec-op-0011-rawst"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_STREAMED_RESPONSE")
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "streamed-response"})
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
    expect(socket.acks).toEqual([])
  })

  it("marks a lost stream ambiguous without committing or acknowledging", async () => {
    const socket = new FakeVirtualSocket({failWith: {message: "read ECONNRESET", code: "ECONNRESET"}})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0012-lost"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBeInstanceOf(Error)
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "stream-lost"})
    expect(ambiguous?.detail?.cause).toBeInstanceOf(Error)
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
    expect(socket.acks).toEqual([])
  })

  it("classifies a lost Socketduct session distinctly from a lost stream", async () => {
    const socket = new FakeVirtualSocket({failWith: {message: "session lost", code: "SOCKETDUCT_SESSION_LOST"}})
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0013-sess"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBeInstanceOf(Error)
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "session-lost"})
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
  })

  it("surfaces a rejected durable write verbatim without retrying or marking ambiguous", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const unsupported = typedError(new Error("Durable write admission is unavailable for this Socketduct transport"), "SOCKETDUCT_DURABLE_WRITE_UNSUPPORTED")
    let writeAttempts = 0
    socket.writeDurable = () => {
      writeAttempts += 1
      return Promise.reject(unsupported)
    }
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0014-nodur"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBe(unsupported)
    expect(writeAttempts).toEqual(1)
    expect(journal.calls.some((call) => call.op === "markAmbiguous")).toBe(false)
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
    expect(socket.acks).toEqual([])
  })

  it("surfaces an acknowledgement failure after the commit without masking it", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const invalidAck = typedError(new Error("Receive acknowledgement exceeds bytes delivered to the application"), "SOCKETDUCT_INVALID_RECEIVE_ACK")
    socket.acknowledgeReceive = () => Promise.reject(invalidAck)
    const journal = makeJournal()
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0015-ackf"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBe(invalidAck)
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(true)
    expect(journal.calls.some((call) => call.op === "markAmbiguous")).toBe(false)
    expect(socket.destroyed).toBe(true)
  })

  it("marks the operation ambiguous when the journal commit fails", async () => {
    const socket = new FakeVirtualSocket({response: rawHttpResponse({body: VERSION_BODY})})
    const journal = makeJournal()
    const commitFailure = Object.assign(new Error("disk full"), {code: "JOURNAL_DISK_FULL"})
    journal.commitTerminal = () => Promise.reject(commitFailure)
    const transportSet = makeTransportSet(socket)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.request({
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0016-cmtf"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure).toBe(commitFailure)
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "commit-failed"})
    expect(ambiguous?.detail?.cause).toBe(commitFailure)
    expect(socket.acks).toEqual([])
  })

  it("re-attaches a fresh parser to a recovered socket without re-sending the request", async () => {
    const response = rawHttpResponse({body: VERSION_BODY, headers: {"Content-Type": "application/json"}})
    const recovered = new FakeVirtualSocket({response, respondOn: "now"})
    const journal = makeJournal()
    const primary = new FakeVirtualSocket({response})
    const transportSet = makeTransportSet(primary)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    const result = await transport.recoverReattachment({
      socket: recovered,
      method: "GET",
      path: "/version",
      context: {identifier: "spec-op-0017-reattach", originalRequest: true}
    })

    expect(result.status).toEqual(200)
    expect(result.body.toString()).toEqual(VERSION_BODY)
    expect(recovered.durableWrites).toEqual([])
    expect(recovered.plainWrites).toEqual([])
    expect(transportSet.created).toEqual([])
    const commit = journal.calls.find((call) => call.op === "commitTerminal")
    expect(commit?.identifier).toEqual("spec-op-0017-reattach")
    expect(commit?.detail).toMatchObject({status: 200, terminal: "completed"})
    expect(recovered.acks).toEqual([response.length])
    expect(recovered.destroyed).toBe(true)
  })

  it("recovers an operation by stable identifier on a replacement transport set", async () => {
    const response = rawHttpResponse({body: VERSION_BODY, headers: {"Content-Type": "application/json"}})
    const recovered = new FakeVirtualSocket({response, respondOn: "now"})
    const journal = makeJournal()
    const primary = new FakeVirtualSocket({response})
    const transportSet = makeTransportSet(primary)
    const replacementSet = makeTransportSet(recovered)
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    const result = await transport.recoverOperation({
      transportSet: replacementSet,
      identifier: "spec-op-0018-recover",
      method: "POST",
      path: "/containers/abc/start",
      context: {identifier: "spec-op-0018-recover"}
    })

    expect(result.status).toEqual(200)
    expect(replacementSet.recovered).toEqual([{identifier: "spec-op-0018-recover"}])
    expect(replacementSet.created).toEqual([])
    expect(recovered.durableWrites).toEqual([])
    expect(recovered.plainWrites).toEqual([])
    expect(journal.calls.find((call) => call.op === "commitTerminal")?.identifier).toEqual("spec-op-0018-recover")
    expect(recovered.acks).toEqual([response.length])
  })

  it("marks an unknown recovered identifier ambiguous and rejects with the lookup failure as cause", async () => {
    const journal = makeJournal()
    const primary = new FakeVirtualSocket()
    const transportSet = makeTransportSet(primary)
    const replacementSet = {
      recovered: [],
      createConnection: () => {
        throw new Error("unused")
      },
      recoverConnection(options) {
        replacementSet.recovered.push(options)
        throw typedError(new Error("No durable Socketduct stream matches the stable identifier"), "SOCKETDUCT_RECOVERY_NOT_FOUND")
      }
    }
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.recoverOperation({
        transportSet: /** @type {any} */ (replacementSet),
        identifier: "spec-op-0019-unknown",
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0019-unknown"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_RECOVERY_FAILED")
    expect(failure?.cause).toMatchObject({code: "SOCKETDUCT_RECOVERY_NOT_FOUND"})
    const ambiguous = journal.calls.find((call) => call.op === "markAmbiguous")
    expect(ambiguous?.detail).toMatchObject({code: "recovery-failed"})
    expect(journal.calls.some((call) => call.op === "commitTerminal")).toBe(false)
    expect(primary.durableWrites).toEqual([])
  })

  it("rejects malformed recovery identifiers before any journal interaction", async () => {
    const journal = makeJournal()
    const primary = new FakeVirtualSocket()
    const transportSet = makeTransportSet(primary)
    const replacementSet = {
      recovered: [],
      createConnection: () => {
        throw new Error("unused")
      },
      recoverConnection(options) {
        replacementSet.recovered.push(options)
        return primary
      }
    }
    const transport = createRecoverableSocketductTransport({
      transportSet,
      journal,
      target: {host: "127.0.0.1", port: 2375}
    })

    let failure
    try {
      await transport.recoverOperation({
        transportSet: /** @type {any} */ (replacementSet),
        identifier: "broken",
        method: "GET",
        path: "/version",
        context: {identifier: "spec-op-0020-badid"}
      })
    } catch (error) {
      failure = /** @type {Error} */ (/** @type {unknown} */ (error))
    }

    expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_INVALID_IDENTIFIER")
    expect(replacementSet.recovered).toEqual([])
    expect(journal.calls).toEqual([])
  })

  it("exposes a typed error class with a stable code", () => {
    const error = new RecoverableSocketductTransportError("boom", "RECOVERABLE_TRANSPORT_TLS_TARGET", {cause: new Error("inner")})

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toEqual("RecoverableSocketductTransportError")
    expect(error.code).toEqual("RECOVERABLE_TRANSPORT_TLS_TARGET")
    expect(error.cause).toBeInstanceOf(Error)
  })
})
