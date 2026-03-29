import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerFromEnv} from "./docker-helper.js"

const docker = openDockerFromEnv()

if (docker) {
  describe("DockerImages integration", () => {
    it("pull() pulls an image from registry", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const inspected = await docker.images.inspect({name: "alpine:3.21"})

      expect(inspected.Id).not.toEqual(undefined)
      expect(inspected.RepoTags).not.toEqual(undefined)
    })

    it("list() returns images", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const images = await docker.images.list()

      expect(Array.isArray(images)).toEqual(true)
      expect(images.length).not.toEqual(0)
    })

    it("inspect() returns image details", async () => {
      await docker.images.pull({image: "alpine:3.21"})

      const result = await docker.images.inspect({name: "alpine:3.21"})

      expect(result.Id).not.toEqual(undefined)
      expect(result.Size).not.toEqual(undefined)
      expect(result.Architecture).not.toEqual(undefined)
    })

    it("remove() deletes an image", async () => {
      await docker.images.pull({image: "alpine:3.20"})

      const result = await docker.images.remove({name: "alpine:3.20"})

      expect(Array.isArray(result)).toEqual(true)
    })
  })
}
