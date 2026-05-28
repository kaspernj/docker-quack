import {Readable} from "node:stream"

export default class FakeDockerConnection {
  constructor() {
    this.calls = []
    this.timeoutMs = 120_000
  }

  async request(options) {
    this.calls.push(options)

    return this.responseFor(options)
  }

  async requestRaw(options) {
    this.calls.push(options)

    return Buffer.from("archive-bytes")
  }

  async requestStream(options) {
    this.calls.push(options)

    return {stream: Readable.from([]), statusCode: 200}
  }

  responseFor(options) {
    if (options.path === "/commit") {
      return {Id: "sha256:committed-image"}
    }

    if (options.path.endsWith("/exec")) {
      return {Id: "exec-123"}
    }

    if (options.path === "/exec/exec-123/json") {
      return {ExitCode: 0}
    }

    if (options.path === "/images/json" || options.path === "/networks") {
      return []
    }

    if (options.path === "/volumes") {
      return {Volumes: [], Warnings: []}
    }

    return {Id: "fake-id"}
  }
}
