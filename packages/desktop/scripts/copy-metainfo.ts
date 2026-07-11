import { resolveChannel } from "./utils"
import { readdir, rm } from "node:fs/promises"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "cn.gwm.ruying-code" : `cn.gwm.ruying-code.${channel}`
const productName = channel === "prod" ? "如影 Code" : `如影 Code ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `如影 Code AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="cn.gwm">
    <name>GWM</name>
  </developer>

  <description>
    <p>
      如影 Code helps you write and run code with AI.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

</component>
`

await Promise.all(
  (await readdir("resources"))
    .filter((file) => file.endsWith(".metainfo.xml"))
    .map((file) => rm(`resources/${file}`, { force: true })),
)
await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
