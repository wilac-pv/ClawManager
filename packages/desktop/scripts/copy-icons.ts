import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const src = `./icons/${channel}`
const dest = "resources/icons"
const files = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
  "dock.png",
  "icon.icns",
  "icon.ico",
  "icon.png",
]

await $`rm -rf ${dest}`
await $`mkdir -p ${dest}`
await $`cp ${files.map((file) => `${src}/${file}`)} ${dest}`
console.log(`Copied ${channel} icons from ${src} to ${dest}`)
