import {mkdtemp, open, readFile, rm} from "node:fs/promises"
import http from "node:http"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {setTimeout as delay} from "node:timers/promises"
import {pathToFileURL} from "node:url"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {createRecoverableSocketductTransport} from "../../src/recoverable-socketduct-transport.js"
import {generateTlsCertificates} from "../support/tls-certificates.js"

/**
 * @param {http.Server} server
 * @returns {Promise<number>} Bound TCP port.
 */
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(undefined)
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port")
  }
  return address.port
}

/**
 * @param {string} repoPath
 * @returns {Promise<{socketduct: object, auth: object}>}
 */
async function loadReverseSocketduct(repoPath) {
  const socketductUrl = pathToFileURL(join(repoPath, "src/index.js")).href
  const authUrl = pathToFileURL(join(repoPath, "src/auth/user-store.js")).href
  const [socketduct, auth] = await Promise.all([import(socketductUrl), import(authUrl)])

  return {socketduct, auth}
}

/**
 * @param {() => Promise<boolean>} predicate
 * @param {string} label
 * @returns {Promise<void>}
 */
async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return
    await delay(10)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

/**
 * In-memory durable operation journal implementing the journal adapter
 * contract: prepare before send, commitTerminal for a fully parsed
 * response, markAmbiguous when the operation cannot be resolved safely.
 */
class InMemoryJournal {
  /** @type {Map<string, {state: string, result?: unknown, reason?: unknown}>} */
  entries = new Map()

  /** @type {Array<string>} */
  events = []

  /** @type {Array<object>} */
  reasons = []

  /**
   * @param {object} context
   * @returns {Promise<void>}
   */
  async prepare(context) {
    this.entries.set(context.identifier, {state: "pending"})
    this.events.push("prepare")
  }

  /**
   * @param {object} context
   * @param {unknown} result
   * @returns {Promise<void>}
   */
  async commitTerminal(context, result) {
    const entry = this.entries.get(context.identifier)
    if (entry === undefined) throw new Error(`No prepared operation for ${context.identifier}`)
    entry.state = "completed"
    entry.result = result
    this.events.push("commitTerminal")
  }

  /**
   * @param {object} context
   * @param {unknown} reason
   * @returns {Promise<void>}
   */
  async markAmbiguous(context, reason) {
    const entry = this.entries.get(context.identifier) ?? {state: "unknown"}
    entry.state = "ambiguous"
    entry.reason = reason
    this.entries.set(context.identifier, entry)
    this.reasons.push(reason)
    this.events.push("markAmbiguous")
  }
}

/**
 * Minimal file-backed durable operation journal: each call appends one JSON
 * line to a temp file and fsyncs it, so `commitTerminal` is real I/O (not a
 * microtask) and the post-commit receive-ACK race is real.
 */
class FileJournal {
  /** @param {string} file */
  constructor(file) {
    this.file = file
  }

  /**
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async append(entry) {
    const handle = await open(this.file, "a")
    try {
      await handle.appendFile(JSON.stringify(entry) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * @param {object} context
   * @returns {Promise<void>}
   */
  async prepare(context) {
    await this.append({op: "prepare", identifier: context.identifier})
  }

  /**
   * @param {object} context
   * @param {unknown} result
   * @returns {Promise<void>}
   */
  async commitTerminal(context, result) {
    await this.append({op: "commitTerminal", identifier: context.identifier, result})
  }

  /**
   * @param {object} context
   * @param {unknown} reason
   * @returns {Promise<void>}
   */
  async markAmbiguous(context, reason) {
    const {code, message} = /** @type {{code: string, message: string}} */ (reason)
    await this.append({op: "markAmbiguous", identifier: context.identifier, reason: {code, message}})
  }
}

/**
 * Fake Docker target that counts connections, complete requests, and the
 * exact number of response bytes written per observed request.
 * @param {number} [responseDelayMs]
 * @returns {Promise<{server: http.Server, stats: {connections: number, requests: Array<{method: string, url: string}>, responseBytes: number}, port: number}>}
 */
async function createFakeDockerTarget(responseDelayMs = 0) {
  /** @type {{connections: number, requests: Array<{method: string, url: string}>, responseBytes: number}} */
  const stats = {connections: 0, requests: [], responseBytes: 0}
  const server = http.createServer((req, res) => {
    stats.requests.push({method: req.method, url: req.url})
    req.resume()
    if (req.url !== "/version") {
      res.writeHead(404)
      res.end()
      return
    }
    // Respond only after the complete request (including its end) arrived:
    // an earlier reply races the relay's stream state and corrupts recovery.
    req.on("end", () => {
      const socket = res.socket
      const originalWrite = socket.write.bind(socket)
      socket.write = (chunk, ...rest) => {
        stats.responseBytes += Buffer.byteLength(/** @type {Buffer | string} */ (chunk))
        return originalWrite(chunk, ...rest)
      }
      const respond = () => {
        res.writeHead(200, {"Content-Type": "application/json", Connection: "close"})
        res.end(JSON.stringify({Version: "27.1.0", ApiVersion: "1.46"}))
      }
      if (responseDelayMs > 0) setTimeout(respond, responseDelayMs)
      else respond()
    })
  })
  server.on("connection", () => {
    stats.connections += 1
  })

  const port = await listen(server)
  return {server, stats, port}
}

/**
 * Stand up the full Socketduct reverse stack (TLS hub, outbound gateway,
 * reverse transport set) against a fake Docker target. `close` is idempotent
 * and also closes any replacement set registered via `adopt`.
 * @param {http.Server} targetServer
 * @param {number} targetPort
 * @param {object} environment
 * @returns {Promise<{set: object, gateway: object, hub: object, root: string, clientConnectionId: string, spoolDirectory: string, makeClientSet: (spoolDirectory: string) => object, adopt: (replacement: object) => void, close: () => Promise<void>}>}
 */
async function createReverseRecoveryStack(targetServer, targetPort, environment) {
  const {socketduct, auth} = environment
  const root = await mkdtemp(join(tmpdir(), "docker-quack-recovery-"))
  const certs = generateTlsCertificates(join(root, "certs"))
  const tokens = new auth.TokenStore()
  const gatewayToken = tokens.issue({userId: "gw-1", username: "gateway"})
  const clientToken = tokens.issue({userId: "client-1", username: "tensorbuzz"})

  const hub = await socketduct.startReverseGatewayHub({
    host: "127.0.0.1",
    port: 0,
    tokens,
    tls: {certFile: certs.serverCertFile, keyFile: certs.serverKeyFile},
    authorizeGateway: ({principal, gatewayId}) => principal.username === "gateway" && gatewayId === "docker-gw-1",
    authorizeClientGateway: ({principal, gatewayId}) => principal.username === "tensorbuzz" && gatewayId === "docker-gw-1",
    authorizeOpen: ({principal, gatewayId, target}) => principal.username === "tensorbuzz" && gatewayId === "docker-gw-1" &&
      target.host === "127.0.0.1" && target.port === targetPort,
    knownGatewayIds: ["docker-gw-1"]
  })

  const gateway = new socketduct.OutboundReverseGateway({
    gatewayId: "docker-gw-1",
    connectionId: "recovery-spec-gw",
    hub: {host: "127.0.0.1", port: hub.port, token: gatewayToken.value},
    tls: {caFile: certs.caCertFile, servername: "localhost"},
    authorizeTarget: ({host, port}) => host === "127.0.0.1" && port === targetPort,
    spoolDirectory: join(root, "gw-spool"),
    reconnectDelayMs: 10,
    initialGeneration: 1_000
  })
  await gateway.start()

  const clientConnectionId = "recovery-spec-client"
  /** @param {string} spoolDirectory */
  const makeClientSet = (spoolDirectory) => new socketduct.MultiplexedSocketductTransportSet({
    connectionId: clientConnectionId,
    spoolDirectory,
    minimumReadyMembers: 1,
    gateways: [{
      gatewayId: "docker-gw-1",
      endpoint: {
        reverseHub: {host: "127.0.0.1", port: hub.port, token: clientToken.value},
        tls: {caFile: certs.caCertFile, servername: "localhost"}
      }
    }]
  })

  const spoolDirectory = join(root, "client-spool")
  const set = makeClientSet(spoolDirectory)
  await set.start()
  await waitUntil(async () => set.status().members.some((member) => member.state === "ready"), "reverse client readiness")

  /** @type {boolean} */
  let closed = false
  /** @type {Array<object>} */
  const replacements = []

  /** Register a replacement set so `close` also closes it at teardown. @param {object} replacement */
  const adopt = (replacement) => {
    replacements.push(replacement)
  }

  /** Idempotent teardown: original set, adopted replacements, relay, target server, root. @returns {Promise<void>} */
  const close = async () => {
    if (closed) return
    closed = true
    await set.close().catch(() => {})
    for (const replacement of replacements) {
      await replacement.close().catch(() => {})
    }
    await gateway.close().catch(() => {})
    await hub.close().catch(() => {})
    await new Promise((resolve) => {
      if (!targetServer.listening) return resolve(undefined)
      targetServer.closeAllConnections?.()
      targetServer.close(() => resolve(undefined))
    })
    await rm(root, {recursive: true, force: true})
  }

  return {set, gateway, hub, root, clientConnectionId, spoolDirectory, makeClientSet, adopt, close}
}

/**
 * Wrap a real transport set so the spec can observe the virtual socket the
 * recoverable transport opens.
 * @param {object} realSet
 * @returns {{lastSocket: object | undefined, createConnection: (options: object) => object, recoverConnection: (options: object) => object}}
 */
function makeRecordingSet(realSet) {
  /** @type {{lastSocket: object | undefined}} */
  const recording = {
    lastSocket: undefined,
    createConnection(options) {
      const socket = realSet.createConnection(options)
      recording.lastSocket = socket
      return socket
    },
    recoverConnection(options) {
      return realSet.recoverConnection(options)
    }
  }
  return recording
}

if (process.env.SOCKETDUCT_REPO) {
  const environment = loadReverseSocketduct(process.env.SOCKETDUCT_REPO)

  describe("docker-quack recoverable Socketduct transport (process recovery)", () => {
    it("completes a full round trip through the reverse stack with an in-memory journal", async () => {
      const loaded = await environment
      const {server, stats, port} = await createFakeDockerTarget()
      const stack = await createReverseRecoveryStack(server, port, loaded)

      try {
        const journal = new InMemoryJournal()
        const recording = makeRecordingSet(stack.set)
        const transport = createRecoverableSocketductTransport({
          transportSet: recording,
          journal,
          target: {host: "127.0.0.1", port}
        })

        const result = await transport.request({
          method: "GET",
          path: "/version",
          context: {identifier: "roundtrip-op-0001"}
        })

        expect(result.status).toEqual(200)
        expect(JSON.parse(result.body.toString())).toEqual({Version: "27.1.0", ApiVersion: "1.46"})
        expect(stats.connections).toEqual(1)
        expect(stats.requests).toEqual([{method: "GET", url: "/version"}])
        expect(journal.events).toEqual(["prepare", "commitTerminal"])
        const entry = journal.entries.get("roundtrip-op-0001")
        if (entry === undefined) throw new Error("Journal entry for roundtrip-op-0001 is missing")
        expect(entry.state).toEqual("completed")
        expect(entry.result).toMatchObject({status: 200, terminal: "completed"})
        const terminalResult = /** @type {{bodyBytes?: number, bodyDigest?: string}} */ (entry.result)
        expect(terminalResult.bodyBytes).toBeGreaterThan(0)
        expect(terminalResult.bodyDigest).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        await stack.close()
      }
    })

    it("completes a round trip with a file-backed fsync journal when the target closes the connection", async () => {
      const loaded = await environment
      const {server, stats, port} = await createFakeDockerTarget()
      const stack = await createReverseRecoveryStack(server, port, loaded)

      try {
        // The target answers Connection: close (as the transport forces), so
        // the relay closes the stream after the response; with a real
        // append+fsync commit, the post-commit receive-ACK can lose that
        // race. The request must still complete with the parsed result.
        const journalFile = join(stack.root, "journal.jsonl")
        const journal = new FileJournal(journalFile)
        const recording = makeRecordingSet(stack.set)
        const transport = createRecoverableSocketductTransport({
          transportSet: recording,
          journal,
          target: {host: "127.0.0.1", port}
        })

        const result = await transport.request({
          method: "GET",
          path: "/version",
          context: {identifier: "filejournal-op-001"}
        })

        expect(result.status).toEqual(200)
        expect(JSON.parse(result.body.toString())).toEqual({Version: "27.1.0", ApiVersion: "1.46"})
        expect(stats.connections).toEqual(1)
        expect(stats.requests).toEqual([{method: "GET", url: "/version"}])

        const lines = (await readFile(journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        expect(lines.map((line) => line.op)).toEqual(["prepare", "commitTerminal"])
        const terminals = lines.filter((line) => line.op === "commitTerminal")
        expect(terminals).toHaveLength(1)
        expect(terminals[0].identifier).toEqual("filejournal-op-001")
        expect(terminals[0].result).toMatchObject({status: 200, terminal: "completed"})
      } finally {
        await stack.close()
      }
    })

    it("kills the client mid-response and recovers the replayed response without re-contacting the target", async () => {
      const loaded = await environment
      const {server, stats, port} = await createFakeDockerTarget(400)
      const stack = await createReverseRecoveryStack(server, port, loaded)

      /** @type {object | undefined} */
      let replacement
      try {
        const journal = new InMemoryJournal()
        const recording = makeRecordingSet(stack.set)
        const transport = createRecoverableSocketductTransport({
          transportSet: recording,
          journal,
          target: {host: "127.0.0.1", port}
        })
        const identifier = "killrecover-op-001"

        const pending = transport.request({
          method: "GET",
          path: "/version",
          context: {identifier}
        }).catch((error) => /** @type {Error} */ (/** @type {unknown} */ (error)))

        await waitUntil(async () => stats.requests.length >= 1, "fake target to observe the request")
        expect(recording.lastSocket).toBeDefined()

        // Simulate a process kill: detach the durable stream and drop the
        // socket while the response is still un-ACKed.
        await stack.set.detach()
        const killedSocket = /** @type {object} */ (recording.lastSocket)
        killedSocket.destroy()
        const oldOutcome = await pending
        expect(oldOutcome).toBeInstanceOf(Error)

        replacement = stack.makeClientSet(stack.spoolDirectory)
        stack.adopt(replacement)
        const recoveredSocket = replacement.recoverConnection({identifier})
        const resultPromise = transport.recoverReattachment({
          socket: recoveredSocket,
          method: "GET",
          path: "/version",
          context: {identifier}
        })

        await replacement.start()
        await waitUntil(async () => replacement.status().members.some((member) => member.state === "ready"), "replacement readiness")

        /** @type {Array<number>} */
        const acks = []
        const originalAck = recoveredSocket.acknowledgeReceive.bind(recoveredSocket)
        recoveredSocket.acknowledgeReceive = (bytes) => {
          acks.push(bytes)
          return originalAck(bytes)
        }

        const result = await resultPromise

        expect(result.status).toEqual(200)
        expect(JSON.parse(result.body.toString())).toEqual({Version: "27.1.0", ApiVersion: "1.46"})
        expect(stats.connections).toEqual(1)
        expect(stats.requests).toEqual([{method: "GET", url: "/version"}])
        expect(acks.length).toEqual(1)
        expect(acks[0]).toEqual(stats.responseBytes)
        // The lost original stream marks the operation ambiguous (stream-lost);
        // the recovered re-attachment then commits the terminal result.
        expect(journal.events).toEqual(["prepare", "markAmbiguous", "commitTerminal"])
        expect(/** @type {{code?: string}} */ (journal.reasons[0]).code).toEqual("stream-lost")
        const entry = journal.entries.get(identifier)
        expect(entry?.state).toEqual("completed")
        expect(entry?.result).toMatchObject({status: 200, terminal: "completed"})
      } finally {
        await stack.close()
      }
    })

    it("reports session loss as a typed ambiguous failure without opening a target connection", async () => {
      const loaded = await environment
      const {server, stats, port} = await createFakeDockerTarget()
      const stack = await createReverseRecoveryStack(server, port, loaded)

      try {
        // Destroy the relay side: the durable owner is gone, so a replacement
        // client with no recovery state cannot find the stream.
        await stack.gateway.close().catch(() => {})
        await stack.hub.close().catch(() => {})

        const journal = new InMemoryJournal()
        await journal.prepare({identifier: "sessionloss-op-001"})
        const transport = createRecoverableSocketductTransport({
          transportSet: stack.set,
          journal,
          target: {host: "127.0.0.1", port}
        })
        const replacement = stack.makeClientSet(join(stack.root, "orphan-spool"))
        stack.adopt(replacement)

        let failure
        try {
          await transport.recoverOperation({
            transportSet: replacement,
            identifier: "sessionloss-op-001",
            method: "GET",
            path: "/version",
            context: {identifier: "sessionloss-op-001"}
          })
        } catch (error) {
          failure = /** @type {Error} */ (/** @type {unknown} */ (error))
        }

        expect(failure?.code).toEqual("RECOVERABLE_TRANSPORT_RECOVERY_FAILED")
        expect(/** @type {Error & {cause?: {code?: string}}} */ (failure).cause?.code).toEqual("SOCKETDUCT_RECOVERY_NOT_FOUND")
        expect(journal.entries.get("sessionloss-op-001")?.state).toEqual("ambiguous")
        expect(stats.connections).toEqual(0)
        expect(stats.requests).toEqual([])
      } finally {
        await stack.close()
      }
    })

    it("fails recovery of unknown and corrupt identifiers typed, without side effects", async () => {
      const loaded = await environment
      const {server, stats, port} = await createFakeDockerTarget()
      const stack = await createReverseRecoveryStack(server, port, loaded)

      try {
        const journal = new InMemoryJournal()
        await journal.prepare({identifier: "unknown-op-00001"})
        const transport = createRecoverableSocketductTransport({
          transportSet: stack.set,
          journal,
          target: {host: "127.0.0.1", port}
        })

        // (d1) Syntactically valid identifier with no durable owner anywhere.
        const unknownReplacement = stack.makeClientSet(join(stack.root, "unknown-spool"))
        stack.adopt(unknownReplacement)
        let unknownFailure
        try {
          await transport.recoverOperation({
            transportSet: unknownReplacement,
            identifier: "unknown-op-00001",
            method: "GET",
            path: "/version",
            context: {identifier: "unknown-op-00001"}
          })
        } catch (error) {
          unknownFailure = /** @type {Error} */ (/** @type {unknown} */ (error))
        }
        expect(unknownFailure?.code).toEqual("RECOVERABLE_TRANSPORT_RECOVERY_FAILED")
        expect(/** @type {Error & {cause?: {code?: string}}} */ (unknownFailure).cause?.code).toEqual("SOCKETDUCT_RECOVERY_NOT_FOUND")
        expect(journal.entries.get("unknown-op-00001")?.state).toEqual("ambiguous")

        // (d2) Corrupt identifier: rejected before any transport or journal
        // interaction.
        const eventsBefore = journal.events.length
        const corruptReplacement = stack.makeClientSet(join(stack.root, "corrupt-spool"))
        stack.adopt(corruptReplacement)
        let corruptFailure
        try {
          await transport.recoverOperation({
            transportSet: corruptReplacement,
            identifier: "corrupt id!",
            method: "GET",
            path: "/version",
            context: {identifier: "corrupt-id-0001"}
          })
        } catch (error) {
          corruptFailure = /** @type {Error} */ (/** @type {unknown} */ (error))
        }
        expect(corruptFailure?.code).toEqual("RECOVERABLE_TRANSPORT_INVALID_IDENTIFIER")
        expect(journal.events.length).toEqual(eventsBefore)

        expect(stats.connections).toEqual(0)
        expect(stats.requests).toEqual([])
      } finally {
        await stack.close()
      }
    })
  })
}
