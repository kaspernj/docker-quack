import {Readable} from "node:stream"
import {createGzip} from "node:zlib"
import DockerImageTagger from "./image-tagging.js"

/**
 * @typedef {object} DockerDeviceMapping
 * @property {string} PathOnHost - Device path on the Docker host.
 * @property {string} PathInContainer - Device path inside the container.
 * @property {string} CgroupPermissions - Device cgroup permissions, such as `rwm`.
 */

/**
 * @typedef {object} DockerPortBinding
 * @property {string} [HostIp] - Host interface to bind.
 * @property {string} [HostPort] - Host port to bind.
 */

/**
 * @typedef {object} DockerRestartPolicy
 * @property {string} [Name] - Docker restart policy name.
 * @property {number} [MaximumRetryCount] - Maximum retries for `on-failure` policies.
 */

/**
 * @typedef {object} DockerUlimit
 * @property {string} Name - Ulimit name.
 * @property {number} Soft - Soft limit value.
 * @property {number} Hard - Hard limit value.
 */

/**
 * @typedef {import("./docker-connection.js").DockerJsonValue | DockerDeviceMapping[] | DockerPortBinding[] | DockerRestartPolicy | DockerUlimit[] | Record<string, DockerPortBinding[]>} DockerHostConfigValue
 */

/**
 * @typedef {object} DockerContainerHostConfigFields
 * @property {boolean} [AutoRemove] - Automatically remove the container after it exits.
 * @property {string[]} [Binds] - Host bind mounts.
 * @property {number} [CpuShares] - Relative CPU share weight.
 * @property {DockerDeviceMapping[]} [Devices] - Host devices mapped into the container.
 * @property {string[]} [ExtraHosts] - Additional host entries.
 * @property {number} [Memory] - Memory limit in bytes.
 * @property {number} [MemorySwap] - Total memory plus swap limit in bytes.
 * @property {string} [NetworkMode] - Docker network mode.
 * @property {Record<string, DockerPortBinding[]>} [PortBindings] - Published container port bindings.
 * @property {boolean} [Privileged] - Whether the container runs in privileged mode.
 * @property {DockerRestartPolicy} [RestartPolicy] - Container restart policy.
 * @property {DockerUlimit[]} [Ulimits] - Container ulimit overrides.
 */

/**
 * @typedef {DockerContainerHostConfigFields & Record<string, DockerHostConfigValue>} DockerContainerHostConfig
 */

/**
 * @typedef {object} DockerContainerEndpointSettings
 * @property {string[]} [Aliases] - Network aliases for the container endpoint.
 * @property {string[]} [Links] - Container links for the endpoint.
 * @property {string} [NetworkID] - Docker network ID.
 * @property {string} [EndpointID] - Docker endpoint ID.
 * @property {string} [Gateway] - IPv4 gateway address.
 * @property {string} [IPAddress] - IPv4 endpoint address.
 * @property {number} [IPPrefixLen] - IPv4 prefix length.
 * @property {string} [IPv6Gateway] - IPv6 gateway address.
 * @property {string} [GlobalIPv6Address] - IPv6 endpoint address.
 * @property {number} [GlobalIPv6PrefixLen] - IPv6 prefix length.
 * @property {string} [MacAddress] - Endpoint MAC address.
 */

/**
 * @typedef {object} DockerContainerNetworkingConfig
 * @property {Record<string, DockerContainerEndpointSettings>} [EndpointsConfig] - Network-specific endpoint settings.
 */

/**
 * @typedef {Record<string, Record<string, never>>} DockerContainerExposedPorts
 */

/**
 * @typedef {object} DockerHealthcheckConfig
 * @property {string[]} [Test] - Healthcheck command in Docker API form.
 * @property {number} [Interval] - Healthcheck interval in nanoseconds.
 * @property {number} [Timeout] - Healthcheck timeout in nanoseconds.
 * @property {number} [StartPeriod] - Startup grace period in nanoseconds.
 * @property {number} [Retries] - Number of retries before Docker marks the container unhealthy.
 */

/**
 * @typedef {object} DockerContainerMountPoint
 * @property {string} [Type] - Mount type, such as `volume` or `bind`.
 * @property {string} [Name] - Docker-managed volume name.
 * @property {string} [Source] - Host source path or volume source.
 * @property {string} [Destination] - Container destination path.
 * @property {string} [Driver] - Volume driver.
 * @property {string} [Mode] - Mount mode.
 * @property {boolean} [RW] - Whether the mount is writable.
 * @property {string} [Propagation] - Bind propagation mode.
 */

/**
 * @typedef {object} DockerContainerInspectResponse
 * @property {string} [Id] - Container ID.
 * @property {string} [Name] - Container name.
 * @property {Record<string, string>} [Labels] - Container labels.
 * @property {DockerContainerMountPoint[]} [Mounts] - Container mount points.
 * @property {{Networks?: Record<string, DockerContainerEndpointSettings>}} [NetworkSettings] - Runtime network details.
 * @property {DockerContainerHostConfig} [HostConfig] - Host configuration reported by Docker.
 */

/**
 * @typedef {object} DockerContainerListItem
 * @property {string} [Id] - Container ID.
 * @property {string[]} [Names] - Container names.
 * @property {string} [Image] - Image reference.
 * @property {string} [ImageID] - Image ID.
 * @property {string} [Command] - Container command.
 * @property {number} [Created] - Creation time as a Unix timestamp.
 * @property {Record<string, string>} [Labels] - Container labels.
 * @property {string} [State] - Container state.
 * @property {string} [Status] - Human-readable container status.
 */

/**
 * @typedef {object} DockerContainerStatsResponse
 * @property {{usage?: number, limit?: number}} [memory_stats] - One-shot memory usage data.
 */

/**
 * @typedef {object} CreateContainerOptions
 * @property {string} [name] - Container name
 * @property {string} Image - Image to use
 * @property {string[]} [Cmd] - Command to run
 * @property {string[]} [Env] - Environment variables
 * @property {string} [WorkingDir] - Working directory inside the container
 * @property {string} [User] - User inside the container
 * @property {string[]} [Entrypoint] - Entrypoint command.
 * @property {DockerContainerNetworkingConfig} [NetworkingConfig] - Network configuration
 * @property {DockerContainerHostConfig} [HostConfig] - Host configuration (binds, port bindings, etc.)
 * @property {DockerContainerExposedPorts} [ExposedPorts] - Exposed ports
 * @property {DockerHealthcheckConfig} [Healthcheck] - Container healthcheck configuration.
 * @property {Record<string, string>} [Labels] - Container labels (key/value), passed through to the Engine container config.
 * @property {number} [timeoutMs] - Optional per-request timeout for the create request.
 */

/**
 * @typedef {"gzip" | "identity"} ArchiveCompression
 */

/**
 * @typedef {object} ExecOptions
 * @property {string} id - Container ID
 * @property {string[]} Cmd - Command to execute
 * @property {string} [WorkingDir] - Working directory for the exec
 * @property {string[]} [Env] - Environment variables
 * @property {string} [User] - User to run the command as
 * @property {(output: {stream: "stdout" | "stderr", data: string}) => void} [onOutput] - Called with each chunk as it arrives
 * @property {AbortSignal} [signal] - Optional signal to abort the exec stream
 * @property {number} [timeoutMs] - Optional per-request timeout for the exec create/start/inspect requests.
 */

/**
 * @typedef {object} DockerContainersOptions
 * @property {number} [execInspectPollAttempts] - Maximum inspect attempts after an exec stream closes without a numeric exit code.
 * @property {number} [execInspectPollIntervalMs] - Delay between incomplete exec inspect attempts.
 */

/**
 * @typedef {object} ExecResult
 * @property {number} exitCode - Exit code of the command
 * @property {string} stdout - Standard output
 * @property {string} stderr - Standard error
 */

/**
 * @typedef {object} DockerExecCreateResponse
 * @property {string} Id - Docker exec instance ID.
 */

/**
 * @typedef {object} DockerExecInspectResponse
 * @property {number | null} ExitCode - Exec command exit code.
 * @property {boolean} [Running] - Whether Docker still considers the exec command running.
 */

/**
 * @typedef {object} DockerCommitResponse
 * @property {string} Id - Committed image ID.
 */

/**
 * @typedef {object} CommitOptions
 * @property {string} id - Container ID
 * @property {string} [repo] - Optional image repository to tag after the commit
 * @property {string} [tag] - Optional image tag. Defaults to `latest` when `repo` is provided.
 * @property {Record<string, string>} [Labels] - Optional labels to set on the committed image (sent as the commit container config).
 * @property {number} [timeoutMs] - Optional per-request timeout for the commit and tag requests.
 */

/** Docker containers API. */
const DEFAULT_EXEC_INSPECT_POLL_ATTEMPTS = 20
const DEFAULT_EXEC_INSPECT_POLL_INTERVAL_MS = 100

export class DockerExecIncompleteError extends Error {
  /**
   * @param {{execId: string, inspect: DockerExecInspectResponse | null}} args
   */
  constructor({execId, inspect}) {
    const running = inspect?.Running === undefined ? "unknown" : String(inspect.Running)
    const exitCode = inspect?.ExitCode === undefined || inspect.ExitCode === null ? "null" : String(inspect.ExitCode)

    super(`Docker exec ${execId} did not report an exit code after the output stream ended (Running=${running}, ExitCode=${exitCode}). The Docker exec stream may have ended before the command completed.`)
    this.name = "DockerExecIncompleteError"
    this.execId = execId
    this.inspect = inspect
  }
}

class DockerContainers {
  /**
   * @param {import("./docker-connection.js").default} connection
   * @param {DockerContainersOptions} [options]
   */
  constructor(connection, options = {}) {
    this.connection = connection
    this.imageTagger = new DockerImageTagger(connection)
    this.execInspectPollAttempts = options.execInspectPollAttempts ?? DEFAULT_EXEC_INSPECT_POLL_ATTEMPTS
    this.execInspectPollIntervalMs = options.execInspectPollIntervalMs ?? DEFAULT_EXEC_INSPECT_POLL_INTERVAL_MS
  }

  /**
   * Create a new container.
   * @param {CreateContainerOptions} options
   * @returns {Promise<{Id: string}>}
   */
  async create(options) {
    const {name, timeoutMs, ...body} = options
    const query = name ? {name} : undefined

    return await this.connection.request({
      method: "POST",
      path: "/containers/create",
      query,
      body,
      timeoutMs
    })
  }

  /**
   * Start a container.
   * @param {{id: string, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async start(options) {
    await this.connection.requestRaw({
      method: "POST",
      path: `/containers/${options.id}/start`,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Stop a container.
   * @param {{id: string, t?: number, timeoutMs?: number}} options - `t` is the
   *   graceful-stop grace period in seconds; `timeoutMs` overrides the derived
   *   per-request timeout.
   * @returns {Promise<void>}
   */
  async stop(options) {
    const query = options.t !== undefined ? {t: options.t} : undefined

    await this.connection.requestRaw({
      method: "POST",
      path: `/containers/${options.id}/stop`,
      query,
      timeoutMs: this.stopRequestTimeoutMs(options)
    })
  }

  /**
   * Docker waits up to `t` seconds for a graceful stop before sending SIGKILL, so
   * the request can legitimately run that long. The connection's default
   * per-request timeout would cut a long grace period short, so give the request
   * the grace period plus the default timeout as headroom. An explicit `timeoutMs`
   * wins; with no grace period (or when timeouts are disabled) the connection
   * default applies.
   * @param {{t?: number, timeoutMs?: number}} options
   * @returns {number}
   */
  stopRequestTimeoutMs(options) {
    if (options.timeoutMs !== undefined) return options.timeoutMs
    if (options.t === undefined || !this.connection.timeoutMs) return this.connection.timeoutMs

    return options.t * 1000 + this.connection.timeoutMs
  }

  /**
   * Remove a container.
   * @param {{id: string, force?: boolean, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async remove(options) {
    const query = options.force ? {force: true} : undefined

    await this.connection.requestRaw({
      method: "DELETE",
      path: `/containers/${options.id}`,
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Inspect a container.
   * @param {{id: string, timeoutMs?: number}} options
   * @returns {Promise<DockerContainerInspectResponse>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/containers/${options.id}/json`,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Fetch container logs. Parses the multiplexed stream header when tty is not used.
   * @param {{id: string, stdout?: boolean, stderr?: boolean, follow?: boolean, since?: number | string, tail?: string | number, signal?: AbortSignal, timeoutMs?: number, onOutput?: (output: {stream: "stdout" | "stderr", data: string}) => void}} options
   * @returns {Promise<string>}
   */
  async logs(options) {
    const query = {
      stdout: options.stdout !== false,
      stderr: options.stderr !== false
    }

    if (options.follow !== undefined) query.follow = options.follow
    if (options.since !== undefined) query.since = String(options.since)
    if (options.tail !== undefined) query.tail = String(options.tail)

    const {stream} = await this.connection.requestStream({
      method: "GET",
      path: `/containers/${options.id}/logs`,
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    })

    return await this.consumeLogStream(stream, options.onOutput)
  }

  /**
   * Execute a command inside a running container.
   * Creates an exec instance, starts it, and parses the multiplexed stdout/stderr output.
   * @param {ExecOptions} options
   * @returns {Promise<ExecResult>}
   */
  async exec(options) {
    // Step 1: Create exec instance
    const execBody = {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: options.Cmd
    }

    if (options.WorkingDir) execBody.WorkingDir = options.WorkingDir
    if (options.Env) execBody.Env = options.Env
    if (options.User) execBody.User = options.User

    /** @type {DockerExecCreateResponse} */
    const execCreate = await this.connection.request({
      method: "POST",
      path: `/containers/${options.id}/exec`,
      body: execBody,
      timeoutMs: options.timeoutMs
    })

    const execId = execCreate.Id

    // Step 2: Start exec and capture multiplexed stream
    const {stream} = await this.connection.requestStream({
      method: "POST",
      path: `/exec/${execId}/start`,
      body: {Detach: false, Tty: false},
      signal: options.signal,
      timeoutMs: options.timeoutMs
    })

    const {stdout, stderr} = await this.demuxStream(stream, options.onOutput)

    const execInspect = await this.inspectExecUntilComplete({execId, timeoutMs: options.timeoutMs})

    return {
      exitCode: execInspect.ExitCode,
      stdout,
      stderr
    }
  }

  /**
   * @param {{execId: string, timeoutMs?: number}} args
   * @returns {Promise<DockerExecInspectResponse & {ExitCode: number}>}
   */
  async inspectExecUntilComplete({execId, timeoutMs}) {
    /** @type {DockerExecInspectResponse | null} */
    let execInspect = null

    for (let attempt = 1; attempt <= this.execInspectPollAttempts; attempt++) {
      execInspect = await this.connection.request({
        method: "GET",
        path: `/exec/${execId}/json`,
        timeoutMs
      })

      if (typeof execInspect.ExitCode === "number") {
        return /** @type {DockerExecInspectResponse & {ExitCode: number}} */ (execInspect)
      }

      if (execInspect.Running === false) {
        break
      }

      if (attempt < this.execInspectPollAttempts) {
        await this.wait(this.execInspectPollIntervalMs)
      }
    }

    throw new DockerExecIncompleteError({execId, inspect: execInspect})
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async wait(ms) {
    if (ms <= 0) return

    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Commit a container to create a new image.
   * Commits anonymously first and then tags the returned immutable image ID so
   * Docker versions that reject `/commit?repo=...&tag=...` for existing target
   * tags still behave like `docker commit && docker tag`.
   * @param {CommitOptions} options
   * @returns {Promise<DockerCommitResponse>}
   */
  async commit(options) {
    /** @type {DockerCommitResponse} */
    const result = await this.connection.request({
      method: "POST",
      path: "/commit",
      query: {container: options.id},
      ...(options.Labels ? {body: {Labels: options.Labels}} : {}),
      retry: true,
      timeoutMs: options.timeoutMs
    })

    if (options.repo) {
      await this.imageTagger.tag({
        source: this.imageTagger.imageIdFromResponse(result, options.id),
        repo: options.repo,
        tag: options.tag,
        timeoutMs: options.timeoutMs
      })
    }

    return result
  }

  /**
   * Upload a tar archive to a container path.
   * @param {{id: string, path: string, archive: Buffer | import("node:stream").Readable, archiveCompression?: ArchiveCompression, timeoutMs?: number}} options
   * @returns {Promise<void>}
   */
  async putArchive(options) {
    await this.connection.requestRaw({
      method: "PUT",
      path: `/containers/${options.id}/archive`,
      query: {path: options.path},
      body: this.archiveBody(options.archive, options.archiveCompression || "gzip"),
      headers: {"Content-Type": "application/x-tar"},
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * @param {Buffer | import("node:stream").Readable} archive
   * @param {ArchiveCompression} archiveCompression
   * @returns {Buffer | import("node:stream").Readable}
   */
  archiveBody(archive, archiveCompression) {
    if (archiveCompression === "identity") {
      return archive
    }

    if (archiveCompression === "gzip") {
      return this.gzipArchive(archive)
    }

    throw new Error(`Unsupported Docker archive compression: ${archiveCompression}`)
  }

  /**
   * @param {Buffer | import("node:stream").Readable} archive
   * @returns {import("node:stream").Readable}
   */
  gzipArchive(archive) {
    const source = Buffer.isBuffer(archive) ? Readable.from(archive) : archive
    const gzip = createGzip()

    source.on("error", (error) => {
      gzip.destroy(error)
    })
    source.pipe(gzip)

    return gzip
  }

  /**
   * Download a tar archive of a container path.
   * @param {{id: string, path: string, timeoutMs?: number}} options
   * @returns {Promise<Buffer>}
   */
  async getArchive(options) {
    return await this.connection.requestRaw({
      method: "GET",
      path: `/containers/${options.id}/archive`,
      query: {path: options.path},
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * List containers.
   * @param {{all?: boolean, filters?: import("./docker-connection.js").DockerFilters, timeoutMs?: number}} [options]
   * @returns {Promise<DockerContainerListItem[]>}
   */
  async list(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.all) query.all = true
    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/containers/json",
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Prune stopped containers.
   * @param {{filters?: import("./docker-connection.js").DockerFilters, timeoutMs?: number}} [options]
   * @returns {Promise<{ContainersDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    /** @type {import("./docker-connection.js").DockerQuery} */
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/containers/prune",
      query,
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Get one-shot container stats (no streaming).
   * @param {{id: string, timeoutMs?: number}} options
   * @returns {Promise<DockerContainerStatsResponse>}
   */
  async stats(options) {
    return await this.connection.request({
      method: "GET",
      path: `/containers/${options.id}/stats`,
      query: {stream: false},
      timeoutMs: options.timeoutMs
    })
  }

  /**
   * Consume a Docker log stream, stripping the 8-byte multiplexed frame headers.
   * Each frame: [stream_type(1 byte), 0, 0, 0, size(4 bytes big-endian), payload(size bytes)].
   * @param {import("node:stream").Readable} stream
   * @param {((output: {stream: "stdout" | "stderr", data: string}) => void)} [onOutput] - Called with each frame as it arrives
   * @returns {Promise<string>}
   */
  consumeLogStream(stream, onOutput) {
    return new Promise((resolve, reject) => {
      const output = onOutput ? null : []
      /** @type {Buffer} */
      let pending = Buffer.from([])

      stream.on("data", (chunk) => {
        pending = /** @type {Buffer} */ (Buffer.concat([pending, chunk]))
        pending = this.drainLogFrames(pending, output, onOutput)
      })
      stream.on("error", reject)
      stream.on("end", () => {
        if (onOutput) {
          // TTY mode fallback: if there are leftover bytes with no parsed frames, emit them
          if (pending.length > 0) {
            onOutput({stream: "stdout", data: pending.toString("utf-8")})
          }

          resolve("")
          return
        }

        // If no frames were parsed, return raw content (TTY mode has no headers)
        if (output.length === 0 && pending.length > 0) {
          resolve(pending.toString("utf-8"))
          return
        }

        resolve(output.join(""))
      })
    })
  }

  /**
   * Parse complete multiplexed frames from a buffer, returning any leftover bytes.
   * @param {Buffer} buffer
   * @param {string[] | null} output - Accumulator for full output, null when streaming via callback
   * @param {((output: {stream: "stdout" | "stderr", data: string}) => void)} [onOutput]
   * @returns {Buffer} Remaining unparsed bytes
   */
  drainLogFrames(buffer, output, onOutput) {
    let offset = 0

    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4)

      if (offset + 8 + size > buffer.length) break

      const streamType = buffer.readUInt8(offset)
      const data = buffer.subarray(offset + 8, offset + 8 + size).toString("utf-8")
      const streamName = streamType === 2 ? "stderr" : "stdout"

      if (output) output.push(data)
      if (onOutput) onOutput({stream: streamName, data})

      offset += 8 + size
    }

    return /** @type {Buffer} */ (buffer.subarray(offset))
  }

  /**
   * Demultiplex a Docker exec stream into separate stdout and stderr buffers.
   * When onOutput is provided, frames are forwarded live and not accumulated in memory.
   * Frame format: [stream_type(1 byte), 0, 0, 0, size(4 bytes big-endian), payload].
   * Stream type 1 = stdout, 2 = stderr.
   * @param {import("node:stream").Readable} stream
   * @param {((output: {stream: "stdout" | "stderr", data: string}) => void)} [onOutput] - Called with each frame as it arrives
   * @returns {Promise<{stdout: string, stderr: string}>}
   */
  demuxStream(stream, onOutput) {
    return new Promise((resolve, reject) => {
      const stdoutParts = onOutput ? null : []
      const stderrParts = onOutput ? null : []
      /** @type {Buffer} */
      let pending = Buffer.from([])

      stream.on("data", (chunk) => {
        pending = /** @type {Buffer} */ (Buffer.concat([pending, chunk]))

        let offset = 0

        while (offset + 8 <= pending.length) {
          const streamType = pending.readUInt8(offset)
          const size = pending.readUInt32BE(offset + 4)

          if (offset + 8 + size > pending.length) break

          const data = pending.subarray(offset + 8, offset + 8 + size).toString("utf-8")
          const streamName = streamType === 2 ? "stderr" : "stdout"

          if (onOutput) {
            onOutput({stream: streamName, data})
          } else if (streamType === 1) {
            stdoutParts.push(data)
          } else if (streamType === 2) {
            stderrParts.push(data)
          }

          offset += 8 + size
        }

        pending = /** @type {Buffer} */ (pending.subarray(offset))
      })
      stream.on("error", reject)
      stream.on("end", () => {
        resolve({
          stdout: stdoutParts ? stdoutParts.join("") : "",
          stderr: stderrParts ? stderrParts.join("") : ""
        })
      })
    })
  }
}

export default DockerContainers
