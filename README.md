# docker-quack

Docker Engine API client with HTTP keep-alive for Node.js.

## Features

- HTTP and HTTPS connections with persistent keep-alive agents
- Unix socket connections for local Docker daemons
- Full Docker Engine API coverage: containers, images, networks, volumes
- Container exec with multiplexed stdout/stderr parsing
- Container log streaming with frame header parsing
- Container archive upload/download (tar)
- Container commit retries for transient Docker daemon/containerd failures
- Image pull with streaming progress and registry authentication
- TLS client certificate support

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
```

### System info

```js
const version = await docker.version()
const info = await docker.info()
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

// Commit to image
await docker.containers.commit({id: Id, repo: "my-repo", tag: "latest"})

// Archive upload/download
await docker.containers.putArchive({id: Id, path: "/tmp", archive: tarBuffer})
const tar = await docker.containers.getArchive({id: Id, path: "/etc/hostname"})

// Stop and remove
await docker.containers.stop({id: Id})
await docker.containers.remove({id: Id})
await docker.containers.remove({id: Id, force: true})
```

### Images

```js
// Pull
await docker.images.pull({image: "alpine:3.21"})

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

// List
const images = await docker.images.list()

// Remove
await docker.images.remove({name: "alpine:3.21"})
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
