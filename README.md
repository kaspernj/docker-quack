# docker-quack

Docker Engine API client with HTTP keep-alive for Node.js.

## Features

- HTTP and HTTPS connections with persistent keep-alive agents
- Unix socket connections for local Docker daemons
- Full Docker Engine API coverage: containers, images, networks, volumes
- Container exec with multiplexed stdout/stderr parsing
- Container log streaming with frame header parsing
- Container archive upload/download, with streaming downloads and gzip-compressed archive uploads by default
- HTTP response compression requested by default, with gzip, deflate, Brotli, and zstd decoding where supported by Node.js
- Optional HTTP request body compression for endpoints that accept compressed request bodies
- Container commit retries for transient Docker daemon/containerd failures
- Container commits retag returned image IDs instead of relying on Docker's direct commit-to-tag path
- Image pull with streaming progress and registry authentication
- Image tagging handles existing destination tags idempotently
- TLS client certificate support
- Configurable timeouts for Docker API requests and high-level commands
- Optional Socketduct HTTP agent helper for resilient Docker transports

## Installation

```sh
npm install docker-quack
```

## Usage

```js
import Docker from "docker-quack"

// Connect via TCP
const docker = Docker.open({host: "127.0.0.1", port: 2375})

// Connect via Unix socket
const docker = Docker.open({host: "127.0.0.1", port: 2375, socketPath: "/var/run/docker.sock"})

// Connect with TLS
const docker = Docker.open({
  host: "docker-host",
  port: 2376,
  tls: {ca: caCert, cert: clientCert, key: clientKey}
})

// Connect through a custom Node HTTP agent or socket factory
const dockerViaAgent = Docker.open({host: "docker-host", port: 2375, agent: customHttpAgent})
const dockerViaFactory = Docker.open({
  host: "docker-host",
  port: 2375,
  keepAlive: false,
  createConnection: (_options, callback) => customSocketFactory(callback)
})

// Connect through Socketduct without making Socketduct a hard docker-quack dependency
import {SocketductHttpAgent} from "socketduct/http"
import {openDockerOverSocketduct} from "docker-quack/src/socketduct.js"

const dockerViaSocketduct = openDockerOverSocketduct({
  SocketductHttpAgent,
  relay: {host: "relay.example.internal", port: 3100, token: process.env.SOCKETDUCT_TOKEN},
  target: {host: "docker-socket-shim", port: 2375},
  spoolDirectory: "/var/lib/my-app/socketduct-spool",
  sessionNamePrefix: "my-app-docker"
})
```

Docker connections reuse HTTP sockets by default. Set `keepAlive: false` when each completed request must release its connection, including connections created by `createConnection` or `createTlsConnection`. A caller-supplied `agent` or `httpsAgent` owns its own pooling policy and should be constructed with the matching setting.

### Timeouts

Buffered Docker API requests default to a 120000ms timeout. Override it on the connection or on a single request; use `0` to disable a timeout. Every high-level command accepts `timeoutMs`. Streaming commands (`pull`, `logs`, `exec`, and `getArchiveStream`) stay untimed by default so they can stay open, but an explicit `timeoutMs` on the command bounds that stream.

```js
const docker = Docker.open({host: "127.0.0.1", port: 2375, timeoutMs: 30000})
const version = await docker.connection.request({method: "GET", path: "/version", timeoutMs: 5000})
await docker.containers.logs({id: "container-id", follow: true, timeoutMs: 300000})
```

### System info

```js
const version = await docker.version({timeoutMs: 5000})
const info = await docker.info({timeoutMs: 5000})
```

### Containers

```js
// Create and start
const {Id} = await docker.containers.create({name: "my-app", Image: "alpine:3.21", Cmd: ["sleep", "30"]})
await docker.containers.start({id: Id})

// Inspect
const container = await docker.containers.inspect({id: Id})

// Execute a command
const result = await docker.containers.exec({id: Id, Cmd: ["echo", "hello"]})
console.log(result.stdout) // "hello\n"
console.log(result.exitCode) // 0

// Execute with streaming output (no buffering)
await docker.containers.exec({
  id: Id,
  Cmd: ["sh", "-c", "echo stdout; echo stderr >&2"],
  onOutput: ({stream, data}) => {
    process.stdout.write(`[${stream}] ${data}`)
  }
})

// Logs
const logs = await docker.containers.logs({id: Id})

// Logs with streaming output (no buffering)
await docker.containers.logs({
  id: Id,
  follow: true,
  onOutput: ({stream, data}) => {
    process.stdout.write(data)
  }
})

// Stats (one-shot)
const stats = await docker.containers.stats({id: Id})

// List
const containers = await docker.containers.list()
const allContainers = await docker.containers.list({all: true})

// Commit to image. timeoutMs overrides the timeout for this long-running command.
await docker.containers.commit({id: Id, repo: "my-repo", tag: "latest", timeoutMs: 300000})

// Archive upload/download. putArchive gzips the uploaded tar by default.
await docker.containers.putArchive({id: Id, path: "/tmp", archive: tarBuffer})
await docker.containers.putArchive({id: Id, path: "/tmp", archive: tarBuffer, archiveCompression: "identity"})
const tar = await docker.containers.getArchive({id: Id, path: "/etc/hostname"})

// Stream an archive with native backpressure instead of buffering it.
// The promise resolves when the response stream is available, before the full archive arrives.
const tarStream = await docker.containers.getArchiveStream({id: Id, path: "/var/lib/my-app"})

for await (const chunk of tarStream) {
  // Write each Buffer chunk to the destination.
}

// Stop and remove
await docker.containers.stop({id: Id})
await docker.containers.remove({id: Id})
await docker.containers.remove({id: Id, force: true})

// Prune stopped containers. timeoutMs overrides the timeout for long-running prune requests.
await docker.containers.prune({timeoutMs: 300000})
```

### Images

```js
// Pull a specific tag
await docker.images.pull({image: "alpine:3.21"})

// Untagged image names default to latest; they do not request every registry tag.
await docker.images.pull({image: "alpine"})

// The promise resolves only when Docker's final nonblank progress frame reports
// that a newer image was downloaded or the requested image is already up to
// date. Docker stream errors, malformed output, and premature end-of-stream
// reject the promise.

// Pull with authentication
await docker.images.pull({
  image: "private-registry.example.com/my-image:latest",
  auth: {username: "user", password: "pass", serveraddress: "https://private-registry.example.com"}
})

// Pull with streaming progress
await docker.images.pull({
  image: "postgres:16",
  onProgress: (progress) => {
    console.log(`${progress.status} ${progress.id || ""}`)
  }
})

// Inspect
const image = await docker.images.inspect({name: "alpine:3.21"})

// Tag
await docker.images.tag({source: image.Id, repo: "my-repo", tag: "latest"})

// List
const images = await docker.images.list()

// Remove
await docker.images.remove({name: "alpine:3.21"})

// Prune unused images. timeoutMs overrides the timeout for long-running prune requests.
await docker.images.prune({filters: {dangling: ["false"]}, timeoutMs: 300000})
```

### Networks

```js
// Create
const {Id} = await docker.networks.create({Name: "my-network", Driver: "bridge"})

// Inspect
const network = await docker.networks.inspect({id: Id})

// List
const networks = await docker.networks.list()

// Remove
await docker.networks.remove({id: Id})

// Prune unused networks. timeoutMs overrides the timeout for long-running prune requests.
await docker.networks.prune({timeoutMs: 300000})
```

### Volumes

```js
// Create
const volume = await docker.volumes.create({Name: "my-volume", Labels: {env: "production"}})

// Inspect
const inspected = await docker.volumes.inspect({name: "my-volume"})

// List
const {Volumes} = await docker.volumes.list()

// Remove
await docker.volumes.remove({name: "my-volume"})

// Prune unused volumes. timeoutMs overrides the timeout for long-running prune requests.
await docker.volumes.prune({timeoutMs: 300000})
```

### Closing

```js
docker.close()
```

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
```

### Integration tests

Integration tests run against a real Docker server and require the `DOCKER_HOST` environment variable:

```sh
DOCKER_HOST=tcp://localhost:2375 npm run test:integration
```

In CI (PeakFlow), integration tests run automatically against the `docker_server` DinD service.

## Release

```sh
npm run release:patch
```
