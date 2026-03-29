import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerFromEnv} from "./docker-helper.js"

const docker = openDockerFromEnv()

if (docker) {
  describe("DockerVolumes integration", () => {
    it("creates, inspects, and removes a volume", async () => {
      const created = await docker.volumes.create({Name: "docker-quack-test-volume", Labels: {env: "test"}})

      expect(created.Name).toEqual("docker-quack-test-volume")
      expect(created.Driver).toEqual("local")

      try {
        const inspected = await docker.volumes.inspect({name: "docker-quack-test-volume"})

        expect(inspected.Name).toEqual("docker-quack-test-volume")
        expect(inspected.Labels.env).toEqual("test")
      } finally {
        await docker.volumes.remove({name: "docker-quack-test-volume"})
      }
    })

    it("list() returns volumes", async () => {
      const result = await docker.volumes.list()

      expect(result.Volumes).not.toEqual(undefined)
      expect(Array.isArray(result.Volumes)).toEqual(true)
    })
  })
}
