import type { WslCommandLine } from "./runtime"

type Logger = {
  log: (message: string, meta?: unknown) => void
}

type Spawn = (
  distro: string,
  opts: { onLine?: (line: WslCommandLine) => void },
) => Promise<{
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}>

export function createWslSidecarLauncher(logger: Logger, spawn: Spawn) {
  return async (distro: string) => {
    logger.log("spawning wsl sidecar", { distro })
    return spawn(distro, {
      onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
    })
  }
}
