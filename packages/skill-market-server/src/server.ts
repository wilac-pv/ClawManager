import { createCatalogHandler } from "./handlers"
import { loadConfig } from "./config"
import { loadCurrentSnapshot, makeS3ObjectStore } from "./oss"

const config = loadConfig()
const store = makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket })
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  fetch: createCatalogHandler(() => loadCurrentSnapshot(store, { prefix: config.ossPrefix })),
})

console.info(`Ruying Skill Market listening on ${server.url.href}`)
