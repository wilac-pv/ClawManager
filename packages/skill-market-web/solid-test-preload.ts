import solidPlugin from "vite-plugin-solid"

const solid = solidPlugin({ dev: false })

Bun.plugin({
  name: "skill-market-solid-test-transform",
  setup(build) {
    build.onLoad({ filter: /packages\/skill-market-web\/src\/.*\.tsx$/ }, async (args) => {
      if (typeof solid.transform !== "function") throw new Error("Solid transform hook is unavailable")
      const result = await solid.transform(await Bun.file(args.path).text(), args.path, { ssr: false })
      if (!result || typeof result === "string") return { contents: result ?? "", loader: "ts" }
      return { contents: result.code, loader: "ts" }
    })
  },
})
