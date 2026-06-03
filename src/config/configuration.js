import SingleMultiUsePool from "velocious/build/src/database/pool/single-multi-use.js"
import SqliteDriver from "velocious/build/src/database/drivers/sqlite/index.js"
import VelociousConfiguration from "velocious/build/src/configuration.js"
import VelociousEnvironmentHandlerNode from "velocious/build/src/environment-handlers/node.js"

const configuration = new VelociousConfiguration({
  database: {
    test: {
      default: {
        driver: SqliteDriver,
        name: "docker-quack-test",
        poolType: SingleMultiUsePool,
        database: ":memory:"
      }
    }
  },
  directory: new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
  environment: "test",
  environmentHandler: new VelociousEnvironmentHandlerNode(),
  initializeModels: () => {},
  locale: "en",
  localeFallbacks: {},
  locales: ["en"]
})

export default configuration
