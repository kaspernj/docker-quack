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
 * @typedef {object} ExecOptions
 * @property {string} id - Container ID
 * @property {string[]} Cmd - Command to execute
 * @property {string} [WorkingDir] - Working directory for the exec
 * @property {string[]} [Env] - Environment variables
 * @property {string} [User] - User to run the command as
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
   * @param {{id: string, stdout?: boolean, stderr?: boolean, follow?: boolean, tail?: string | number}} options
   * @returns {Promise<string>}
   */
  async logs(options) {
    const query = {
      stdout: options.stdout !== false,
      stderr: options.stderr !== false
    }

    if (options.follow !== undefined) query.follow = options.follow
    if (options.tail !== undefined) query.tail = String(options.tail)

    const {stream} = await this.connection.requestStream({
      method: "GET",
      path: `/containers/${options.id}/logs`,
      query
    })

    return await this.consumeLogStream(stream)
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
      body: {Detach: false, Tty: false}
    })

    const {stdout, stderr} = await this.demuxStream(stream)

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
      query
    })
  }

  /**
   * Upload a tar archive to a container path.
   * @param {{id: string, path: string, archive: Buffer | import("node:stream").Readable}} options
   * @returns {Promise<void>}
   */
  async putArchive(options) {
    await this.connection.requestRaw({
      method: "PUT",
      path: `/containers/${options.id}/archive`,
      query: {path: options.path},
      body: options.archive,
      headers: {"Content-Type": "application/x-tar"}
    })
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
   * @param {import("node:http").IncomingMessage} stream
   * @returns {Promise<string>}
   */
  consumeLogStream(stream) {
    return new Promise((resolve, reject) => {
      const chunks = []

      stream.on("data", (chunk) => chunks.push(chunk))
      stream.on("error", reject)
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks)
        const output = []
        let offset = 0

        // Parse multiplexed frames
        while (offset + 8 <= buffer.length) {
          const size = buffer.readUInt32BE(offset + 4)

          if (offset + 8 + size > buffer.length) break

          output.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf-8"))
          offset += 8 + size
        }

        // If no frames were parsed, return raw content (TTY mode has no headers)
        if (output.length === 0 && buffer.length > 0) {
          resolve(buffer.toString("utf-8"))
          return
        }

        resolve(output.join(""))
      })
    })
  }

  /**
   * Demultiplex a Docker exec stream into separate stdout and stderr buffers.
   * Frame format: [stream_type(1 byte), 0, 0, 0, size(4 bytes big-endian), payload].
   * Stream type 1 = stdout, 2 = stderr.
   * @param {import("node:http").IncomingMessage} stream
   * @returns {Promise<{stdout: string, stderr: string}>}
   */
  demuxStream(stream) {
    return new Promise((resolve, reject) => {
      const chunks = []

      stream.on("data", (chunk) => chunks.push(chunk))
      stream.on("error", reject)
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks)
        const stdoutParts = []
        const stderrParts = []
        let offset = 0

        while (offset + 8 <= buffer.length) {
          const streamType = buffer.readUInt8(offset)
          const size = buffer.readUInt32BE(offset + 4)

          if (offset + 8 + size > buffer.length) break

          const payload = buffer.subarray(offset + 8, offset + 8 + size).toString("utf-8")

          if (streamType === 1) {
            stdoutParts.push(payload)
          } else if (streamType === 2) {
            stderrParts.push(payload)
          }

          offset += 8 + size
        }

        resolve({
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join("")
        })
      })
    })
  }
}

export default DockerContainers
