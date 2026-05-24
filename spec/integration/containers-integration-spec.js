import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerFromEnv} from "./docker-helper.js"

const docker = openDockerFromEnv()

/**
 * @param {string} fileName
 * @param {string} content
 * @returns {Buffer}
 */
function tarBufferForFile(fileName, content) {
  const contentBuffer = Buffer.from(content, "utf8")
  const header = Buffer.alloc(512)

  header.write(fileName, 0, 100, "utf8")
  header.write("0000644\0", 100, 8, "ascii")
  header.write("0000000\0", 108, 8, "ascii")
  header.write("0000000\0", 116, 8, "ascii")
  header.write(contentBuffer.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii")
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii")
  header.fill(" ", 148, 156)
  header.write("0", 156, 1, "ascii")
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")

  let checksum = 0

  for (const byte of header) {
    checksum += byte
  }

  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii")
  header[154] = 0
  header[155] = 32

  const padding = Buffer.alloc((512 - (contentBuffer.length % 512)) % 512)

  return Buffer.concat([header, contentBuffer, padding, Buffer.alloc(1024)])
}

if (docker) {
  describe("DockerContainers integration", () => {
    it("creates, inspects, starts, stops, and removes a container", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const created = await docker.containers.create({
        name: "docker-quack-test-container",
        Image: "alpine:3.21",
        Cmd: ["sleep", "30"]
      })

      expect(created.Id).not.toEqual(undefined)

      try {
        const inspected = await docker.containers.inspect({id: created.Id})

        expect(inspected.Name).toEqual("/docker-quack-test-container")
        expect(inspected.Config.Image).toEqual("alpine:3.21")

        await docker.containers.start({id: created.Id})

        const running = await docker.containers.inspect({id: created.Id})

        expect(running.State.Running).toEqual(true)

        await docker.containers.stop({id: created.Id, t: 1})

        const stopped = await docker.containers.inspect({id: created.Id})

        expect(stopped.State.Running).toEqual(false)
      } finally {
        await docker.containers.remove({id: created.Id, force: true})
      }
    })

    it("list() returns containers", async () => {
      const result = await docker.containers.list({all: true})

      expect(Array.isArray(result)).toEqual(true)
    })

    it("exec() runs a command inside a container", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const created = await docker.containers.create({
        name: "docker-quack-test-exec",
        Image: "alpine:3.21",
        Cmd: ["sleep", "30"]
      })

      try {
        await docker.containers.start({id: created.Id})

        const result = await docker.containers.exec({
          id: created.Id,
          Cmd: ["echo", "hello from docker-quack"]
        })

        expect(result.exitCode).toEqual(0)
        expect(result.stdout.trim()).toEqual("hello from docker-quack")
      } finally {
        await docker.containers.remove({id: created.Id, force: true})
      }
    })

    it("logs() returns container output", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const created = await docker.containers.create({
        name: "docker-quack-test-logs",
        Image: "alpine:3.21",
        Cmd: ["echo", "docker-quack-log-test"]
      })

      try {
        await docker.containers.start({id: created.Id})

        // Wait for container to finish
        let state

        do {
          const inspected = await docker.containers.inspect({id: created.Id})

          state = inspected.State.Status
        } while (state === "running")

        const logs = await docker.containers.logs({id: created.Id})

        expect(logs).toMatch(/docker-quack-log-test/)
      } finally {
        await docker.containers.remove({id: created.Id, force: true})
      }
    })

    it("putArchive() uploads gzip-compressed tar archives by default", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const created = await docker.containers.create({
        name: "docker-quack-test-put-archive-gzip",
        Image: "alpine:3.21",
        Cmd: ["sleep", "30"]
      })

      try {
        await docker.containers.start({id: created.Id})
        await docker.containers.putArchive({
          id: created.Id,
          path: "/tmp",
          archive: tarBufferForFile("docker-quack-upload.txt", "hello compressed archive")
        })

        const result = await docker.containers.exec({
          id: created.Id,
          Cmd: ["cat", "/tmp/docker-quack-upload.txt"]
        })

        expect(result.exitCode).toEqual(0)
        expect(result.stdout).toEqual("hello compressed archive")
      } finally {
        await docker.containers.remove({id: created.Id, force: true})
      }
    })

    it("stats() returns container stats", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const created = await docker.containers.create({
        name: "docker-quack-test-stats",
        Image: "alpine:3.21",
        Cmd: ["sleep", "30"]
      })

      try {
        await docker.containers.start({id: created.Id})

        const stats = await docker.containers.stats({id: created.Id})

        expect(stats.memory_stats).not.toEqual(undefined)
      } finally {
        await docker.containers.remove({id: created.Id, force: true})
      }
    })

    it("commit() creates an image from a container", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const created = await docker.containers.create({
        name: "docker-quack-test-commit",
        Image: "alpine:3.21",
        Cmd: ["true"]
      })

      try {
        const result = await docker.containers.commit({
          id: created.Id,
          repo: "docker-quack-test-committed",
          tag: "latest"
        })

        expect(result.Id).not.toEqual(undefined)

        await docker.images.remove({name: "docker-quack-test-committed:latest", force: true})
      } finally {
        await docker.containers.remove({id: created.Id, force: true})
      }
    })
  })
}
