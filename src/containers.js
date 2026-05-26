import {Readable} from "node:stream"
import {createGzip} from "node:zlib"

/**
 * @typedef {object} CreateContainerOptions
 * @property {string} [name] - Container name
 * @property {string} Image - Image to use
 * @property {string[]} [Cmd] - Command to run
 * @property {string[]} [Env] - Environment variables
 * @property {string} [WorkingDir] - Working directory inside the container
 * @property {string} [User] - User inside the container
 * @property {object} [NetworkingConfig] - Network configuration
 * @property {object} [HostConfig] - Host configuration (binds, port bindings, etc.)
 * @property {object} [ExposedPorts] - Exposed ports
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
 */

/**
 * @typedef {object} ExecResult
 * @property {number} exitCode - Exit code of the command
 * @property {string} stdout - Standard output
 * @property {string} stderr - Standard error
 */

/** Docker containers API. */
class DockerContainers {
  /**
   * @param {import("./docker-connection.js").default} connection
   */
  constructor(connection) {
    this.connection = connection
  }

  /**
   * Create a new container.
   * @param {CreateContainerOptions} options
   * @returns {Promise<{Id: string}>}
   */
  async create(options) {
    const {name, ...body} = options
    const query = name ? {name} : undefined

    return await this.connection.request({
      method: "POST",
      path: "/containers/create",
      query,
      body
    })
  }

  /**
   * Start a container.
   * @param {{id: string}} options
   * @returns {Promise<void>}
   */
  async start(options) {
    await this.connection.requestRaw({
      method: "POST",
      path: `/containers/${options.id}/start`
    })
  }

  /**
   * Stop a container.
   * @param {{id: string, t?: number}} options
   * @returns {Promise<void>}
   */
  async stop(options) {
    const query = options.t !== undefined ? {t: options.t} : undefined

    await this.connection.requestRaw({
      method: "POST",
      path: `/containers/${options.id}/stop`,
      query
    })
  }

  /**
   * Remove a container.
   * @param {{id: string, force?: boolean}} options
   * @returns {Promise<void>}
   */
  async remove(options) {
    const query = options.force ? {force: true} : undefined

    await this.connection.requestRaw({
      method: "DELETE",
      path: `/containers/${options.id}`,
      query
    })
  }

  /**
   * Inspect a container.
   * @param {{id: string}} options
   * @returns {Promise<object>}
   */
  async inspect(options) {
    return await this.connection.request({
      method: "GET",
      path: `/containers/${options.id}/json`
    })
  }

  /**
   * Fetch container logs. Parses the multiplexed stream header when tty is not used.
   * @param {{id: string, stdout?: boolean, stderr?: boolean, follow?: boolean, since?: number | string, tail?: string | number, signal?: AbortSignal, onOutput?: (output: {stream: "stdout" | "stderr", data: string}) => void}} options
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
      signal: options.signal
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

    const execCreate = await this.connection.request({
      method: "POST",
      path: `/containers/${options.id}/exec`,
      body: execBody
    })

    const execId = execCreate.Id

    // Step 2: Start exec and capture multiplexed stream
    const {stream} = await this.connection.requestStream({
      method: "POST",
      path: `/exec/${execId}/start`,
      body: {Detach: false, Tty: false},
      signal: options.signal
    })

    const {stdout, stderr} = await this.demuxStream(stream, options.onOutput)

    // Step 3: Inspect exec to get exit code
    const execInspect = await this.connection.request({
      method: "GET",
      path: `/exec/${execId}/json`
    })

    return {
      exitCode: execInspect.ExitCode,
      stdout,
      stderr
    }
  }

  /**
   * Commit a container to create a new image.
   * @param {{id: string, repo: string, tag?: string}} options
   * @returns {Promise<{Id: string}>}
   */
  async commit(options) {
    const query = {
      container: options.id,
      repo: options.repo
    }

    if (options.tag) query.tag = options.tag

    return await this.connection.request({
      method: "POST",
      path: "/commit",
      query,
      retry: true
    })
  }

  /**
   * Upload a tar archive to a container path.
   * @param {{id: string, path: string, archive: Buffer | import("node:stream").Readable, archiveCompression?: ArchiveCompression}} options
   * @returns {Promise<void>}
   */
  async putArchive(options) {
    await this.connection.requestRaw({
      method: "PUT",
      path: `/containers/${options.id}/archive`,
      query: {path: options.path},
      body: this.archiveBody(options.archive, options.archiveCompression || "gzip"),
      headers: {"Content-Type": "application/x-tar"}
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
   * @param {{id: string, path: string}} options
   * @returns {Promise<Buffer>}
   */
  async getArchive(options) {
    return await this.connection.requestRaw({
      method: "GET",
      path: `/containers/${options.id}/archive`,
      query: {path: options.path}
    })
  }

  /**
   * List containers.
   * @param {{all?: boolean, filters?: object}} [options]
   * @returns {Promise<object[]>}
   */
  async list(options = {}) {
    const query = {}

    if (options.all) query.all = true
    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "GET",
      path: "/containers/json",
      query
    })
  }

  /**
   * Prune stopped containers.
   * @param {{filters?: object}} [options]
   * @returns {Promise<{ContainersDeleted?: string[], SpaceReclaimed?: number}>}
   */
  async prune(options = {}) {
    const query = {}

    if (options.filters) query.filters = JSON.stringify(options.filters)

    return await this.connection.request({
      method: "POST",
      path: "/containers/prune",
      query
    })
  }

  /**
   * Get one-shot container stats (no streaming).
   * @param {{id: string}} options
   * @returns {Promise<object>}
   */
  async stats(options) {
    return await this.connection.request({
      method: "GET",
      path: `/containers/${options.id}/stats`,
      query: {stream: false}
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
