import {mkdtemp, rm} from "node:fs/promises"
import http from "node:http"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {pathToFileURL} from "node:url"
import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerOverSeamline} from "../../src/seamline.js"

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

async function loadSeamline(repoPath) {
  const seamlineUrl = pathToFileURL(join(repoPath, "src/index.js")).href
  const authUrl = pathToFileURL(join(repoPath, "src/auth/user-store.js")).href
  const relayUrl = pathToFileURL(join(repoPath, "src/proxy/tcp-relay.js")).href
  const sessionUrl = pathToFileURL(join(repoPath, "src/sessions/session.js")).href
  const [seamline, auth, relay, session] = await Promise.all([
    import(seamlineUrl),
    import(authUrl),
    import(relayUrl),
    import(sessionUrl)
  ])

  return {seamline, auth, relay, session}
}

if (process.env.SEAMLINE_REPO) {
  describe("docker-quack over Seamline", () => {
    it("requests /_ping and /version through a Seamline relay", async () => {
      const spoolDirectory = await mkdtemp(join(tmpdir(), "docker-quack-seamline-"))
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
      const targetPort = await listen(targetServer)
      const {seamline, auth, relay, session} = await loadSeamline(process.env.SEAMLINE_REPO)
      const users = new auth.InMemoryUserStore()
      const tokens = new auth.TokenStore({now: () => 1000, tokenTtlMs: 60_000})
      await users.createUser({username: "docker-quack", password: "test-password"})
      const token = await auth.login(users, tokens, {username: "docker-quack", password: "test-password"})
      const relayHandle = await relay.startTcpRelay({
        authorizeTarget: ({target}) => target.host === "127.0.0.1" && target.port === targetPort,
        tokens,
        sessions: new session.SessionStore({now: () => 1000})
      })
      const docker = openDockerOverSeamline({
        SeamlineHttpAgent: seamline.SeamlineHttpAgent,
        relay: {host: "127.0.0.1", port: relayHandle.port, token: token.value},
        target: {host: "127.0.0.1", port: targetPort},
        dockerHost: "docker",
        dockerPort: 2375,
        spoolDirectory,
        sessionNamePrefix: "docker-quack-integration"
      })

      try {
        expect(await docker.ping()).toEqual("OK")
        const version = await docker.version()
        expect(version.ApiVersion).toEqual("1.46")
        expect(requests.map((request) => [request.method, request.url, request.host])).toEqual([
          ["GET", "/_ping", "docker:2375"],
          ["GET", "/version", "docker:2375"]
        ])
      } finally {
        docker.close()
        await relayHandle.close()
        await closeServer(targetServer)
        await rm(spoolDirectory, {recursive: true, force: true})
      }
    })
  })
}
