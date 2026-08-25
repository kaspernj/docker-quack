import http from "node:http"
import https from "node:https"
import {describe, expect, it} from "velocious/build/src/testing/test.js"

import Docker, * as DockerQuack from "../src/index.js"
import {openDockerOverSeamline} from "../src/seamline.js"
import {openDockerOverSocketduct} from "../src/socketduct.js"

describe("Socketduct compatibility exports", () => {
  it("keeps the legacy Seamline helper path as a compatibility shim", () => {
    expect(openDockerOverSeamline).toEqual(openDockerOverSocketduct)
  })

  it("forwards explicit keep-alive configuration to the Socketduct and Docker transports", () => {
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super({keepAlive: options.keepAlive})
        this.receivedOptions = options
      }
    }
    const docker = openDockerOverSocketduct({
      SocketductHttpAgent: FakeSocketductHttpAgent,
      keepAlive: false,
      relay: {host: "relay.example.test", port: 3100, token: "test-token"},
      spoolDirectory: "/tmp/docker-quack-socketduct-spec",
      target: {host: "docker.example.test", port: 2375}
    })

    try {
      const transport = docker.connection.client._transportPreference

      expect(docker.socketductAgent.receivedOptions.keepAlive).toEqual(false)
      expect(docker.connection.client._transportPreference.keepAlive).toEqual(false)
      expect(transport.customAgent).toBe(docker.socketductAgent)
      expect(transport.customHttpsAgent).toEqual(undefined)
      expect(transport.createTlsConnection).toEqual(undefined)
    } finally {
      docker.close()
    }
  })

  it("defaults omitted keepAlive to true for HTTP and HTTPS Socketduct transports without mutating options", () => {
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super({keepAlive: options.keepAlive})
        this.receivedOptions = options
      }
    }
    class FakeSocketductHttpsAgent extends https.Agent {
      constructor(options) {
        super({keepAlive: options.keepAlive})
        this.receivedOptions = options
      }
    }
    const baseOptions = {
      SocketductHttpAgent: FakeSocketductHttpAgent,
      SocketductHttpsAgent: FakeSocketductHttpsAgent,
      relay: {host: "relay.example.test", port: 3100, token: "test-token"},
      spoolDirectory: "/tmp/docker-quack-socketduct-default-keepalive",
      target: {host: "docker.example.test", port: 2375}
    }
    const httpOptions = {...baseOptions}
    const targetTls = {ca: "target-ca"}
    const httpsOptions = {...baseOptions, target: {host: "docker.example.test", port: 2376}, targetTls}
    const httpSnapshot = {...httpOptions}
    const httpsSnapshot = {...httpsOptions}
    const httpDocker = DockerQuack.openDockerTransport({type: "socketduct", ...httpOptions})
    const httpsDocker = DockerQuack.openDockerTransport({type: "socketduct", ...httpsOptions})

    try {
      expect(httpDocker.socketductAgent.receivedOptions.keepAlive).toEqual(true)
      expect(httpDocker.socketductAgent.keepAlive).toEqual(true)
      expect(httpDocker.connection.client._transportPreference.keepAlive).toEqual(true)
      expect(httpsDocker.socketductAgent.receivedOptions.keepAlive).toEqual(true)
      expect(httpsDocker.socketductAgent.keepAlive).toEqual(true)
      expect(httpsDocker.connection.client._transportPreference.keepAlive).toEqual(true)
      expect(httpOptions).toEqual(httpSnapshot)
      expect(httpsOptions).toEqual(httpsSnapshot)
      expect(targetTls.servername).toEqual(undefined)
    } finally {
      httpDocker.close()
      httpsDocker.close()
    }
  })

  it("maps public relayTls to the legacy HTTP agent tls option without mutating it", () => {
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super({keepAlive: false})
        this.receivedOptions = options
      }
    }
    const relayTls = {
      caFile: "/relay/ca.pem",
      certFile: "/relay/client.pem",
      keyFile: "/relay/client-key.pem",
      servername: "relay.example"
    }
    const originalRelayTls = {...relayTls}
    const docker = DockerQuack.openDockerTransport({
      type: "socketduct",
      SocketductHttpAgent: FakeSocketductHttpAgent,
      relay: {host: "relay.example", port: 3100, token: "test-token"},
      relayTls,
      target: {host: "docker-target.example", port: 2375},
      spoolDirectory: "/tmp/docker-quack-http-relay-tls"
    })

    try {
      const received = docker.socketductAgent.receivedOptions

      expect(received.tls).toBe(relayTls)
      expect("relayTls" in received).toEqual(false)
      expect("targetTls" in received).toEqual(false)
      expect(relayTls).toEqual(originalRelayTls)
    } finally {
      docker.close()
    }
  })

  it("opens unix, HTTP, HTTPS, and Socketduct through the discriminated selector", () => {
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super({keepAlive: options.keepAlive})
        this.receivedOptions = options
      }
    }
    const unix = DockerQuack.openDockerTransport({type: "unix", socketPath: "/var/run/docker.sock"})
    const plain = DockerQuack.openDockerTransport({type: "http", host: "docker-http.example", port: 2375})
    const secure = DockerQuack.openDockerTransport({
      type: "https",
      host: "docker-https.example",
      port: 2376,
      tls: {ca: "ca", cert: "cert", key: "key"}
    })
    const socketduct = DockerQuack.openDockerTransport({
      type: "socketduct",
      SocketductHttpAgent: FakeSocketductHttpAgent,
      relay: {host: "relay.example", port: 3100, token: "test-token"},
      target: {host: "docker-target.example", port: 2375},
      dockerHost: "docker-logical.example",
      dockerPort: 1234,
      spoolDirectory: "/tmp/docker-quack-selector"
    })

    try {
      expect(unix).toBeInstanceOf(Docker)
      expect(unix.connection.socketPath).toEqual("/var/run/docker.sock")
      expect(unix.connection.host).toEqual(undefined)
      expect(unix.connection.port).toEqual(undefined)
      expect(unix.connection.keepAlive).toEqual(true)
      expect(unix.connection.client.baseUrl).toEqual("http://localhost")
      expect(plain.connection.client.baseUrl).toEqual("http://docker-http.example:2375")
      expect(secure.connection.client.baseUrl).toEqual("https://docker-https.example:2376")
      expect(socketduct.connection.client.baseUrl).toEqual("http://docker-logical.example:1234")
      expect(socketduct.socketductAgent).toBeInstanceOf(FakeSocketductHttpAgent)
    } finally {
      unix.close()
      plain.close()
      secure.close()
      socketduct.close()
    }
  })

  it("forwards only effective Unix selector options and preserves Unix defaults", () => {
    const selector = {
      type: "unix",
      socketPath: "/var/run/docker-selector.sock",
      keepAlive: false,
      timeoutMs: 4_321
    }
    const snapshot = {...selector}
    const docker = DockerQuack.openDockerTransport(selector)

    try {
      expect(docker.connection.host).toEqual(undefined)
      expect(docker.connection.port).toEqual(undefined)
      expect(docker.connection.socketPath).toEqual("/var/run/docker-selector.sock")
      expect(docker.connection.keepAlive).toEqual(false)
      expect(docker.connection.timeoutMs).toEqual(4_321)
      expect(docker.connection.client.baseUrl).toEqual("http://localhost")
      expect(selector).toEqual(snapshot)
    } finally {
      docker.close()
    }
  })

  it("rejects invalid selectors before opening resources", () => {
    expect(() => DockerQuack.openDockerTransport({type: "tcp", host: "docker", port: 2375}))
      .toThrow("Unknown Docker transport type: tcp")
    expect(() => DockerQuack.openDockerTransport({type: "unix"}))
      .toThrow("Unix Docker transport requires socketPath")
    expect(() => DockerQuack.openDockerTransport({type: "http", host: "docker"}))
      .toThrow("HTTP Docker transport requires host and port")
    expect(() => DockerQuack.openDockerTransport({type: "https", host: "docker", port: 2376}))
      .toThrow("HTTPS Docker transport requires tls options")
    expect(() => DockerQuack.openDockerTransport({type: "socketduct"}))
      .toThrow("Socketduct transport requires relay, target, and spoolDirectory")
  })

  it("selects the HTTPS Socketduct agent without nesting TLS and keeps relay TLS separate", () => {
    let httpConstructions = 0
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super(options)
        httpConstructions += 1
      }
    }
    class FakeSocketductHttpsAgent extends https.Agent {
      constructor(options) {
        super({keepAlive: options.keepAlive})
        this.receivedOptions = options
      }
    }
    const relayTls = {caFile: "/relay/ca.pem", servername: "relay.example"}
    const targetTls = {ca: "target-ca", cert: "target-cert", key: "target-key"}
    const docker = openDockerOverSocketduct({
      SocketductHttpAgent: FakeSocketductHttpAgent,
      SocketductHttpsAgent: FakeSocketductHttpsAgent,
      relay: {host: "relay.example", port: 3100, token: "test-token"},
      relayTls,
      target: {host: "10.0.0.20", port: 2376},
      targetTls,
      dockerHost: "docker.internal.example",
      dockerPort: 8443,
      spoolDirectory: "/tmp/docker-quack-socketduct-https",
      keepAlive: false
    })

    try {
      const transport = docker.connection.client._transportPreference

      expect(httpConstructions).toEqual(0)
      expect(docker.socketductAgent).toBeInstanceOf(FakeSocketductHttpsAgent)
      expect(docker.socketductAgent.receivedOptions.keepAlive).toEqual(false)
      expect(transport.keepAlive).toEqual(false)
      expect(docker.socketductAgent.receivedOptions.relayTls).toBe(relayTls)
      expect("tls" in docker.socketductAgent.receivedOptions).toEqual(false)
      expect("createTlsConnection" in docker.socketductAgent.receivedOptions).toEqual(false)
      expect(docker.socketductAgent.receivedOptions.target).toEqual({host: "10.0.0.20", port: 2376})
      expect(docker.socketductAgent.receivedOptions.targetTls).toEqual({
        ca: "target-ca",
        cert: "target-cert",
        key: "target-key",
        servername: "docker.internal.example"
      })
      expect(targetTls.servername).toEqual(undefined)
      expect(docker.connection.client.baseUrl).toEqual("https://docker.internal.example:8443")
      expect(transport.customAgent).toEqual(undefined)
      expect(transport.customHttpsAgent).toBe(docker.socketductAgent)
      expect(transport.createTlsConnection).toEqual(undefined)
    } finally {
      docker.close()
    }
  })

  it("fails before agent allocation when target TLS lacks an injected HTTPS class", () => {
    let constructions = 0
    class FakeSocketductHttpAgent extends http.Agent {
      constructor(options) {
        super(options)
        constructions += 1
      }
    }

    expect(() => openDockerOverSocketduct({
      SocketductHttpAgent: FakeSocketductHttpAgent,
      relay: {host: "relay.example", port: 3100, token: "test-token"},
      target: {host: "docker.example", port: 2376},
      targetTls: {ca: "target-ca"},
      spoolDirectory: "/tmp/docker-quack-missing-https"
    })).toThrow("SocketductHttpsAgent is required when targetTls is configured")
    expect(constructions).toEqual(0)
  })

  it("owns and destroys the selected Socketduct agent exactly once", () => {
    class FakeSocketductHttpAgent extends http.Agent {
      destroyCount = 0

      destroy() {
        this.destroyCount += 1
        super.destroy()
      }
    }
    const docker = openDockerOverSocketduct({
      SocketductHttpAgent: FakeSocketductHttpAgent,
      relay: {host: "relay.example", port: 3100, token: "test-token"},
      target: {host: "docker.example", port: 2375},
      spoolDirectory: "/tmp/docker-quack-owned-agent"
    })
    let connectionCloseCount = 0
    const originalClose = docker.connection.close.bind(docker.connection)
    docker.connection.close = () => {
      connectionCloseCount += 1
      originalClose()
    }

    docker.close()
    docker.close()

    expect(connectionCloseCount).toEqual(1)
    expect(docker.socketductAgent.destroyCount).toEqual(1)
  })
})
