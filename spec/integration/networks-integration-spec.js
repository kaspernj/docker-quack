import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerFromEnv} from "./docker-helper.js"

const docker = openDockerFromEnv()

if (docker) {
  describe("DockerNetworks integration", () => {
    it("creates, inspects, and removes a network", async () => {
      const created = await docker.networks.create({Name: "docker-quack-test-network", Driver: "bridge"})

      expect(created.Id).not.toEqual(undefined)

      try {
        const inspected = await docker.networks.inspect({id: created.Id})

        expect(inspected.Name).toEqual("docker-quack-test-network")
        expect(inspected.Driver).toEqual("bridge")
      } finally {
        await docker.networks.remove({id: created.Id})
      }
    })

    it("list() returns networks", async () => {
      const networks = await docker.networks.list()

      expect(Array.isArray(networks)).toEqual(true)
      expect(networks.length).not.toEqual(0)
    })
  })
}
