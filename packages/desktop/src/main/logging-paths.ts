import { join } from "node:path"

export function debugArchiveName(stamp: string) {
  return `ruying-code-debug-${stamp}.zip`
}

export function serverLogRoots(input: { xdgData: string; userData: string }) {
  return [input.xdgData, input.userData].flatMap((root) =>
    ["ruying-code", "opencode"].map((name) => join(root, name, "log")),
  )
}
