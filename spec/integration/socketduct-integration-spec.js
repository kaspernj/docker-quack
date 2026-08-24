import {mkdtemp, readdir, readFile, rm} from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {setTimeout as delay} from "node:timers/promises"
import {pathToFileURL} from "node:url"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import * as DockerQuack from "../../src/index.js"
import {openDockerOverSocketduct} from "../../src/socketduct.js"
import {generateTlsCertificates} from "../support/tls-certificates.js"

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
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

async function closeServer(server) {
  if (!server.listening) return

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve(undefined)
    })
  })
}

async function loadSocketduct(repoPath) {
  const socketductUrl = pathToFileURL(join(repoPath, "src/index.js")).href
  const authUrl = pathToFileURL(join(repoPath, "src/auth/user-store.js")).href
  const relayUrl = pathToFileURL(join(repoPath, "src/proxy/tcp-relay.js")).href
  const sessionUrl = pathToFileURL(join(repoPath, "src/sessions/session.js")).href
  const httpsAgentUrl = pathToFileURL(join(repoPath, "src/client/https-agent.js")).href
  const [socketduct, auth, relay, session, httpsAgent] = await Promise.all([
    import(socketductUrl),
    import(authUrl),
    import(relayUrl),
    import(sessionUrl),
    import(httpsAgentUrl)
  ])

  return {socketduct, auth, relay, session, httpsAgent}
}

function dockerFrame(streamType, data) {
  const payload = Buffer.from(data)
  const header = Buffer.alloc(8)
  header[0] = streamType
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

async function writeChunkedFrames(res, frames) {
  for (const frame of frames) {
    const splitAt = Math.min(5, frame.length)
    res.write(frame.subarray(0, splitAt))
    await delay(10)
    res.write(frame.subarray(splitAt))
    await delay(10)
  }
  res.end()
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await delay(10)
  }

  throw new Error("Timed out waiting for streaming callback")
}

async function waitUntilAsync(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await delay(10)
  }

  throw new Error("Timed out waiting for asynchronous resource cleanup")
}

function relayAtZero(relayHandle) {
  const status = relayHandle.status()
  return status.activeTunnels === 0 && status.activeTargets === 0 && status.sessions === 0 &&
    status.attachedSessions === 0 && status.detachedSessions === 0 &&
    status.bufferedTargetBytes === 0 && status.targetConnectionAttempts === 0 && status.targetRetryTimers === 0
}

function agentQueueSize(entries) {
  return Object.values(entries).reduce((total, values) => total + values.length, 0)
}

function listenerCount(emitter) {
  return emitter.eventNames().reduce((total, eventName) => total + emitter.listenerCount(eventName), 0)
}

function agentResources(agent, listenerBaseline) {
  return {
    activeSockets: agentQueueSize(agent.sockets),
    freeSockets: agentQueueSize(agent.freeSockets),
    pendingRequests: agentQueueSize(agent.requests),
    addedListeners: listenerCount(agent) - listenerBaseline
  }
}

async function directoryEntries(directory) {
  return await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return []
    throw error
  })
}

async function createDockerOverSocketduct(targetServer, options = {}) {
  const targetPort = options.targetPort ?? await listen(targetServer)
  const {socketduct, auth, relay, session, httpsAgent} = await loadSocketduct(process.env.SOCKETDUCT_REPO)
  const spoolDirectory = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-"))
  const users = new auth.InMemoryUserStore()
  const tokens = new auth.TokenStore({now: () => 1000, tokenTtlMs: 60_000})
  await users.createUser({username: "docker-quack", password: "test-password"})
  const token = await auth.login(users, tokens, {username: "docker-quack", password: "test-password"})
  const relayHandle = await relay.startTcpRelay({
    authorizeTarget: ({target}) => target.host === "127.0.0.1" && target.port === targetPort,
    initialTargetRetryDelayMs: 10,
    initialTargetRetryMaxDelayMs: 20,
    tokens,
    sessions: new session.SessionStore({now: () => 1000}),
    ...(options.relayServerTls === undefined ? {} : {tls: options.relayServerTls})
  })
  const socketductOptions = {
    SocketductHttpAgent: socketduct.SocketductHttpAgent,
    SocketductHttpsAgent: httpsAgent.SocketductHttpsAgent,
    relay: {host: "127.0.0.1", port: relayHandle.port, token: token.value},
    target: {host: "127.0.0.1", port: targetPort},
    ...(options.relayTls === undefined ? {} : {relayTls: options.relayTls}),
    ...(options.targetTls === undefined ? {} : {targetTls: options.targetTls}),
    dockerHost: options.dockerHost ?? "docker",
    dockerPort: options.dockerPort ?? (options.targetTls === undefined ? 2375 : 2376),
    spoolDirectory,
    sessionNamePrefix: "docker-quack-integration",
    keepAlive: options.keepAlive,
    timeoutMs: options.timeoutMs
  }
  const docker = options.selector
    ? DockerQuack.openDockerTransport({type: "socketduct", ...socketductOptions})
    : openDockerOverSocketduct(socketductOptions)
  const listenerBaseline = listenerCount(docker.socketductAgent)

  return {
    docker,
    relay: relayHandle,
    spoolDirectory,
    targetPort,
    async close() {
      docker.close()
      docker.close()
      try {
        await waitUntilAsync(async () => relayAtZero(relayHandle) &&
          Object.values(agentResources(docker.socketductAgent, listenerBaseline)).every((value) => value === 0) &&
          (await directoryEntries(spoolDirectory)).length === 0)
        expect(relayHandle.status()).toEqual({
          activeTunnels: 0,
          activeTargets: 0,
          sessions: 0,
          attachedSessions: 0,
          detachedSessions: 0,
          bufferedTargetBytes: 0,
          targetConnectionAttempts: 0,
          targetRetryTimers: 0
        })
        expect(agentResources(docker.socketductAgent, listenerBaseline)).toEqual({
          activeSockets: 0,
          freeSockets: 0,
          pendingRequests: 0,
          addedListeners: 0
        })
        expect(await directoryEntries(spoolDirectory)).toEqual([])
      } finally {
        await relayHandle.close()
        await closeServer(targetServer)
        await rm(spoolDirectory, {recursive: true, force: true})
      }
    }
  }
}

if (process.env.SOCKETDUCT_REPO) {
  describe("docker-quack over Socketduct", () => {
    it("requests /_ping and /version through a Socketduct relay", async () => {
      const requests = []
      let targetConnections = 0
      const targetServer = http.createServer((req, res) => {
        requests.push({method: req.method, url: req.url, host: req.headers.host})
        if (req.url === "/_ping") {
          res.writeHead(200, {"Content-Type": "text/plain"})
          res.end("OK")
          return
        }

        if (req.url === "/version") {
          res.writeHead(200, {"Content-Type": "application/json"})
          res.end(JSON.stringify({Version: "27.1.0", ApiVersion: "1.46"}))
          return
        }

        res.writeHead(404)
        res.end("missing")
      })
      targetServer.on("connection", () => { targetConnections += 1 })
      const harness = await createDockerOverSocketduct(targetServer)

      try {
        expect(await harness.docker.ping()).toEqual("OK")
        const version = await harness.docker.version()
        expect(version.ApiVersion).toEqual("1.46")
        expect(requests.map((request) => [request.method, request.url, request.host])).toEqual([
          ["GET", "/_ping", "docker:2375"],
          ["GET", "/version", "docker:2375"]
        ])
        expect(targetConnections).toEqual(1)
      } finally {
        await harness.close()
      }
    })

    it("uses SocketductHttpAgent through a strict TLS relay to a plaintext Docker target", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-tls-relay-"))
      const certs = generateTlsCertificates(join(root, "certs"))
      const requests = []
      const targetServer = http.createServer((req, res) => {
        requests.push(req.headers.host)
        res.setHeader("connection", "close")
        res.end("OK")
      })
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        relayServerTls: {certFile: certs.serverCertFile, keyFile: certs.serverKeyFile},
        relayTls: {caFile: certs.caCertFile, servername: "localhost", rejectUnauthorized: true},
        keepAlive: true
      })

      try {
        expect(await harness.docker.ping()).toEqual("OK")
        expect(requests).toEqual(["docker:2375"])
        expect(harness.docker.socketductAgent.constructor.name).toEqual("SocketductHttpAgent")
        expect(harness.docker.connection.client.baseUrl).toEqual("http://docker:2375")
      } finally {
        await harness.close()
        await rm(root, {recursive: true, force: true})
      }
    })

    it("rejects the wrong relay TLS identity without allocating a Docker target session", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-tls-relay-identity-"))
      const certs = generateTlsCertificates(join(root, "certs"))
      let requests = 0
      const targetServer = http.createServer((_req, res) => {
        requests += 1
        res.end("must-not-succeed")
      })
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        relayServerTls: {certFile: certs.serverCertFile, keyFile: certs.serverKeyFile},
        relayTls: {caFile: certs.caCertFile, servername: "wrong.example.test", rejectUnauthorized: true},
        keepAlive: true
      })

      try {
        let failure
        try {
          await harness.docker.ping()
        } catch (error) {
          failure = error
        }
        expect(failure?.code).toEqual("ERR_TLS_CERT_ALTNAME_INVALID")
        expect(requests).toEqual(0)
      } finally {
        await harness.close()
        await rm(root, {recursive: true, force: true})
      }
    })

    it("streams chunked Docker logs over Socketduct without buffering until response end", async () => {
      const events = []
      const targetServer = http.createServer((req, res) => {
        events.push(`request:${req.method}:${req.url}`)
        if (req.url === "/containers/container-1/logs?stdout=true&stderr=true&follow=true") {
          res.writeHead(200, {"Content-Type": "application/vnd.docker.raw-stream"})
          void (async () => {
            const firstFrame = dockerFrame(1, "stdout one\n")
            const splitAt = Math.min(5, firstFrame.length)
            res.write(firstFrame.subarray(0, splitAt))
            await delay(10)
            res.write(firstFrame.subarray(splitAt))
            await waitUntil(() => events.includes("stdout:stdout one"))
            res.write(dockerFrame(2, "stderr two\n"))
            await waitUntil(() => events.includes("stderr:stderr two"))
            events.push("server:end")
            res.end()
          })()
          return
        }

        res.writeHead(404)
        res.end("missing")
      })
      const harness = await createDockerOverSocketduct(targetServer)

      try {
        const result = await harness.docker.containers.logs({
          id: "container-1",
          follow: true,
          onOutput: (output) => events.push(`${output.stream}:${output.data.trim()}`)
        })

        expect(result).toEqual("")
        expect(events).toEqual([
          "request:GET:/containers/container-1/logs?stdout=true&stderr=true&follow=true",
          "stdout:stdout one",
          "stderr:stderr two",
          "server:end"
        ])
      } finally {
        await harness.close()
      }
    })

    it("streams exec raw multiplexed output over Socketduct and inspects the exit code", async () => {
      const requests = []
      const streamed = []
      const targetServer = http.createServer((req, res) => {
        requests.push({method: req.method, url: req.url})
        if (req.url === "/containers/container-1/exec") {
          res.writeHead(201, {"Content-Type": "application/json"})
          res.end(JSON.stringify({Id: "exec-1"}))
          return
        }

        if (req.url === "/exec/exec-1/start") {
          res.writeHead(200, {"Content-Type": "application/vnd.docker.raw-stream"})
          void writeChunkedFrames(res, [
            dockerFrame(1, "exec stdout\n"),
            dockerFrame(2, "exec stderr\n")
          ])
          return
        }

        if (req.url === "/exec/exec-1/json") {
          res.writeHead(200, {"Content-Type": "application/json"})
          res.end(JSON.stringify({ExitCode: 7, Running: false}))
          return
        }

        res.writeHead(404)
        res.end("missing")
      })
      const harness = await createDockerOverSocketduct(targetServer)

      try {
        const result = await harness.docker.containers.exec({
          id: "container-1",
          Cmd: ["sh", "-c", "printf test"],
          onOutput: (output) => streamed.push(`${output.stream}:${output.data.trim()}`)
        })

        expect(result).toEqual({exitCode: 7, stdout: "", stderr: ""})
        expect(streamed).toEqual(["stdout:exec stdout", "stderr:exec stderr"])
        expect(requests.map((request) => [request.method, request.url])).toEqual([
          ["POST", "/containers/container-1/exec"],
          ["POST", "/exec/exec-1/start"],
          ["GET", "/exec/exec-1/json"]
        ])
      } finally {
        await harness.close()
      }
    })

    it("requests Docker HTTPS with strict target identity through the first-class selector", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-https-"))
      const certs = generateTlsCertificates(join(root, "certs"))
      const requests = []
      const targetServer = https.createServer({
        cert: await readFile(certs.serverCertFile),
        key: await readFile(certs.serverKeyFile)
      }, (req, res) => {
        requests.push(req.headers.host)
        res.end("OK")
      })
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        targetTls: {ca: await readFile(certs.caCertFile)},
        dockerHost: "localhost",
        dockerPort: 2376,
        keepAlive: false
      })

      try {
        expect(await harness.docker.ping()).toEqual("OK")
        expect(requests).toEqual(["localhost:2376"])
      } finally {
        await harness.close()
        await rm(root, {recursive: true, force: true})
      }
    })

    it("authenticates to a Docker target that requires mTLS", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-mtls-"))
      const certs = generateTlsCertificates(join(root, "certs"))
      const ca = await readFile(certs.caCertFile)
      const targetServer = https.createServer({
        ca,
        cert: await readFile(certs.serverCertFile),
        key: await readFile(certs.serverKeyFile),
        requestCert: true,
        rejectUnauthorized: true
      }, (req, res) => res.end(req.socket.authorized ? "MTLS-OK" : "UNAUTHORIZED"))
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        targetTls: {
          ca,
          cert: await readFile(certs.clientCertFile),
          key: await readFile(certs.clientKeyFile)
        },
        dockerHost: "localhost",
        keepAlive: false
      })

      try {
        expect(await harness.docker.ping()).toEqual("MTLS-OK")
      } finally {
        await harness.close()
        await rm(root, {recursive: true, force: true})
      }
    })

    it("preserves strict target CA and hostname rejection", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-hostname-"))
      const certs = generateTlsCertificates(join(root, "certs"))
      const targetServer = https.createServer({
        cert: await readFile(certs.serverCertFile),
        key: await readFile(certs.serverKeyFile)
      }, (_req, res) => res.end("must-not-succeed"))
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        targetTls: {ca: await readFile(certs.caCertFile)},
        dockerHost: "wrong.example.test",
        keepAlive: false
      })

      try {
        let failure
        try {
          await harness.docker.ping()
        } catch (error) {
          failure = error
        }
        expect(failure?.code).toEqual("ERR_TLS_CERT_ALTNAME_INVALID")
        await waitUntil(() => relayAtZero(harness.relay))
      } finally {
        await harness.close()
        await rm(root, {recursive: true, force: true})
      }
    })

    it("rejects a target certificate outside the configured CA", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-ca-"))
      const certs = generateTlsCertificates(join(root, "server-certs"))
      const wrongCa = generateTlsCertificates(join(root, "wrong-ca"))
      const targetServer = https.createServer({
        cert: await readFile(certs.serverCertFile),
        key: await readFile(certs.serverKeyFile)
      }, (_req, res) => res.end("must-not-succeed"))
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        targetTls: {ca: await readFile(wrongCa.caCertFile)},
        dockerHost: "localhost",
        keepAlive: false
      })

      try {
        let failure
        try {
          await harness.docker.ping()
        } catch (error) {
          failure = error
        }
        expect(failure?.code).toEqual("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
        await waitUntil(() => relayAtZero(harness.relay))
      } finally {
        await harness.close()
        await rm(root, {recursive: true, force: true})
      }
    })

    it("keeps one pending Docker operation until an initially unavailable target starts", async () => {
      const reservation = net.createServer()
      const targetPort = await listen(reservation)
      await closeServer(reservation)
      let requests = 0
      const targetServer = http.createServer((_req, res) => {
        requests += 1
        res.end("OK")
      })
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        targetPort,
        timeoutMs: 2_000,
        keepAlive: false
      })

      try {
        const pendingPing = harness.docker.ping()
        await waitUntil(() => harness.relay.status().sessions === 1 && harness.relay.status().targetRetryTimers === 1)
        await listen(targetServer, targetPort)
        expect(await pendingPing).toEqual("OK")
        expect(requests).toEqual(1)
      } finally {
        await harness.close()
      }
    })

    it("aborts a pending target acquisition and closes with zero eventual resources", async () => {
      const reservation = net.createServer()
      const targetPort = await listen(reservation)
      await closeServer(reservation)
      const targetServer = http.createServer()
      const harness = await createDockerOverSocketduct(targetServer, {
        selector: true,
        targetPort,
        timeoutMs: 2_000,
        keepAlive: false
      })
      const controller = new AbortController()
      const pendingPing = harness.docker.ping({signal: controller.signal}).catch((error) => error)

      try {
        await waitUntil(() => harness.relay.status().sessions === 1)
        controller.abort()
        const error = await pendingPing
        expect(error.name).toEqual("SnapReqAbortError")
        harness.docker.close()
        await waitUntil(() => relayAtZero(harness.relay))
        expect(await directoryEntries(harness.spoolDirectory)).toEqual([])
      } finally {
        await harness.close()
      }
    })

    it("returns repeated HTTPS success and verification failure to bounded baselines", async () => {
      const root = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-bounded-"))
      const certs = generateTlsCertificates(join(root, "certs"))
      const ca = await readFile(certs.caCertFile)
      const successServer = https.createServer({
        cert: await readFile(certs.serverCertFile),
        key: await readFile(certs.serverKeyFile)
      }, (_req, res) => res.end("OK"))
      const success = await createDockerOverSocketduct(successServer, {
        selector: true,
        targetTls: {ca},
        dockerHost: "localhost",
        keepAlive: false
      })

      try {
        for (let index = 0; index < 3; index += 1) {
          expect(await success.docker.ping()).toEqual("OK")
          await waitUntil(() => relayAtZero(success.relay))
        }
        expect(await directoryEntries(success.spoolDirectory)).toEqual([])
      } finally {
        await success.close()
      }

      const failureServer = https.createServer({
        cert: await readFile(certs.serverCertFile),
        key: await readFile(certs.serverKeyFile)
      }, (_req, res) => res.end("must-not-succeed"))
      const failure = await createDockerOverSocketduct(failureServer, {
        selector: true,
        targetTls: {ca},
        dockerHost: "wrong.example.test",
        keepAlive: false
      })
      try {
        for (let index = 0; index < 3; index += 1) {
          let error
          try {
            await failure.docker.ping()
          } catch (caught) {
            error = caught
          }
          expect(error?.code).toEqual("ERR_TLS_CERT_ALTNAME_INVALID")
          await waitUntil(() => relayAtZero(failure.relay))
        }
        expect(await directoryEntries(failure.spoolDirectory)).toEqual([])
      } finally {
        await failure.close()
        await rm(root, {recursive: true, force: true})
      }
    })
  })
}
