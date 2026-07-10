import { Config, Effect, Option } from "effect"
import { Brand } from "../brand/brand"

function value(key: string) {
  return Brand.env(key.replace(/^OPENCODE_/, ""))
}

function booleanConfig(key: string) {
  return Config.make((provider) =>
    Effect.gen(function* () {
      const branded = yield* Config.option(
        Config.boolean(key.replace(/^OPENCODE_/, "RUYING_CODE_")),
      ).parse(provider)
      if (Option.isSome(branded)) return branded.value
      return yield* Config.boolean(key).pipe(Config.withDefault(false)).parse(provider)
    }),
  )
}

export function truthy(key: string) {
  const current = value(key)?.toLowerCase()
  return current === "true" || current === "1"
}

const copy = value("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = value("OPENCODE_DISABLE_FFF")

function enabledByExperimental(key: string) {
  return value(key) === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: value("OPENCODE_GIT_BASH_PATH"),
  OPENCODE_CONFIG: value("OPENCODE_CONFIG"),
  OPENCODE_CONFIG_CONTENT: value("OPENCODE_CONFIG_CONTENT"),
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: value("OPENCODE_FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: value("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: value("OPENCODE_SERVER_USERNAME"),
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: booleanConfig("OPENCODE_EXPERIMENTAL_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: booleanConfig("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: value("OPENCODE_MODELS_URL"),
  OPENCODE_MODELS_PATH: value("OPENCODE_MODELS_PATH"),
  OPENCODE_DB: value("OPENCODE_DB"),

  OPENCODE_WORKSPACE_ID: value("OPENCODE_WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return value("OPENCODE_TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return value("OPENCODE_CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return value("OPENCODE_PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return value("OPENCODE_PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return value("OPENCODE_CLIENT") ?? "cli"
  },
}
