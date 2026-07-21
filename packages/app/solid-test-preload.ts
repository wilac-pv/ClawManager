import { mock } from "bun:test"
import solidPlugin from "vite-plugin-solid"

const solidRuntime = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solidRuntime)

const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)

const solid = solidPlugin({ dev: false })

Bun.plugin({
  name: "solid-test-transform",
  setup(build) {
    build.onLoad({ filter: /packages\/app\/src\/.*\.tsx$/ }, async (args) => {
      if (typeof solid.transform !== "function") throw new Error("Solid transform hook is unavailable")
      const result = await solid.transform(await Bun.file(args.path).text(), args.path, { ssr: false })
      if (!result || typeof result === "string") return { contents: result ?? "", loader: "ts" }
      return { contents: result.code, loader: "ts" }
    })
  },
})
