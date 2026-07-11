export type SidecarStartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  legacyUserDataPath: string
}

export type SidecarCommand = SidecarStartCommand | { type: "stop" }

export function createSidecarStartCommand(input: Omit<SidecarStartCommand, "type">): SidecarStartCommand {
  return { type: "start", ...input }
}

export function parseSidecarCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<SidecarCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.legacyUserDataPath !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    legacyUserDataPath: command.legacyUserDataPath,
  }
}

export function sidecarListenOptions(command: SidecarStartCommand) {
  return {
    port: command.port,
    hostname: command.hostname,
    username: "opencode",
    password: command.password,
    cors: ["oc://renderer"],
    legacyStateRoot: command.legacyUserDataPath,
  }
}
