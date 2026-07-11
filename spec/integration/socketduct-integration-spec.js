import {mkdtemp, rm} from "node:fs/promises"
import http from "node:http"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {setTimeout as delay} from "node:timers/promises"
import {pathToFileURL} from "node:url"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerOverSocketduct} from "../../src/socketduct.js"

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
  const [socketduct, auth, relay, session] = await Promise.all([
    import(socketductUrl),
    import(authUrl),
    import(relayUrl),
    import(sessionUrl)
  ])

  return {socketduct, auth, relay, session}
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

async function createDockerOverSocketduct(targetServer) {
  const targetPort = await listen(targetServer)
  const {socketduct, auth, relay, session} = await loadSocketduct(process.env.SOCKETDUCT_REPO)
  const spoolDirectory = await mkdtemp(join(tmpdir(), "docker-quack-socketduct-"))
  const users = new auth.InMemoryUserStore()
  const tokens = new auth.TokenStore({now: () => 1000, tokenTtlMs: 60_000})
  await users.createUser({username: "docker-quack", password: "test-password"})
  const token = await auth.login(users, tokens, {username: "docker-quack", password: "test-password"})
  const relayHandle = await relay.startTcpRelay({
    authorizeTarget: ({target}) => target.host === "127.0.0.1" && target.port === targetPort,
    tokens,
    sessions: new session.SessionStore({now: () => 1000})
  })
  const docker = openDockerOverSocketduct({
    SocketductHttpAgent: socketduct.SocketductHttpAgent,
    relay: {host: "127.0.0.1", port: relayHandle.port, token: token.value},
    target: {host: "127.0.0.1", port: targetPort},
    dockerHost: "docker",
    dockerPort: 2375,
    spoolDirectory,
    sessionNamePrefix: "docker-quack-integration"
  })

  return {
    docker,
    async close() {
      docker.close()
      await relayHandle.close()
      await closeServer(targetServer)
      await rm(spoolDirectory, {recursive: true, force: true})
    }
  }
}

if (process.env.SOCKETDUCT_REPO) {
  describe("docker-quack over Socketduct", () => {
    it("requests /_ping and /version through a Socketduct relay", async () => {
      const requests = []
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
      const harness = await createDockerOverSocketduct(targetServer)

      try {
        expect(await harness.docker.ping()).toEqual("OK")
        const version = await harness.docker.version()
        expect(version.ApiVersion).toEqual("1.46")
        expect(requests.map((request) => [request.method, request.url, request.host])).toEqual([
          ["GET", "/_ping", "docker:2375"],
          ["GET", "/version", "docker:2375"]
        ])
      } finally {
        await harness.close()
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
  })
}
