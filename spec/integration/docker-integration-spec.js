import {describe, expect, it} from "velocious/build/src/testing/test.js"
import {openDockerFromEnv} from "./docker-helper.js"

const docker = openDockerFromEnv()

if (docker) {
  describe("Docker integration", () => {
    it("version() returns Docker version info", async () => {
      const result = await docker.version()

      expect(result.Version).not.toEqual(undefined)
      expect(result.ApiVersion).not.toEqual(undefined)
      expect(result.Os).toEqual("linux")
    })

    it("info() returns Docker system info", async () => {
      const result = await docker.info()

      expect(result.ID).not.toEqual(undefined)
      expect(result.OperatingSystem).not.toEqual(undefined)
      expect(result.Containers).not.toEqual(undefined)
    })
  })
}
