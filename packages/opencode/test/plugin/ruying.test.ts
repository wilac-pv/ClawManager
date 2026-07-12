import { describe, expect, mock, spyOn, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { Server } from "http"
import { tmpdir } from "os"
import { join } from "path"
import { applyEdits, modify, parse } from "jsonc-parser"

// Stub the browser launcher so authorize() never spawns a real browser tab.
mock.module("open", () => ({ default: async () => undefined }))

const {
  RuyingAuthPlugin,
  buildSsoUrl,
  parseUserFromTokenName,
  provisionToken,
  fetchModelIds,
  buildProviderPatch,
  writeGlobalProviderConfig,
  readExistingRuyingKey,
  globalConfigFile,
} = await import("../../src/plugin/ruying")

function makeServer(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: (request) => handler(request, new URL(request.url)),
  })
}

function baseUrl(server: ReturnType<typeof Bun.serve>) {
  return server.url.toString().replace(/\/$/, "")
}

let tmpCounter = 0
function tmpConfigFile() {
  return join(tmpdir(), `ruying-test-${process.pid}-${tmpCounter++}.json`)
}

function oauthMethod(hooks: Awaited<ReturnType<typeof RuyingAuthPlugin>>) {
  const method = hooks.auth!.methods[0]
  if (method.type !== "oauth") throw new Error("expected oauth method")
  return method
}

describe("plugin.ruying", () => {
  test("contains no remote bearer-token introspection path", async () => {
    const source = await Bun.file(new URL("../../src/plugin/ruying.ts", import.meta.url)).text()

    expect(source).not.toContain("DEFAULT_CHECK_TOKEN_URL")
    expect(source).not.toContain("verifyAccessToken")
    expect(source).not.toContain("?access_token=")
    expect(source).not.toContain("Bun.file(")
  })

  describe("globalConfigFile", () => {
    test("uses branded config precedence in the branded config directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ruying-config-path-"))
      const legacy = join(dir, "opencode.jsonc")
      const brandedJson = join(dir, "ruying-code.json")
      const brandedJsonc = join(dir, "ruying-code.jsonc")
      await Bun.write(legacy, "{}")
      await Bun.write(brandedJson, "{}")
      await Bun.write(brandedJsonc, "{}")

      expect(globalConfigFile(dir)).toBe(brandedJsonc)

      rmSync(dir, { recursive: true, force: true })
    })

    test("defaults to the highest-precedence branded config name", () => {
      const dir = mkdtempSync(join(tmpdir(), "ruying-config-path-"))
      expect(globalConfigFile(dir)).toBe(join(dir, "ruying-code.jsonc"))
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("buildSsoUrl", () => {
    test("requests TOKEN mode with the loopback redirect", () => {
      const url = new URL(buildSsoUrl("https://sso.gwm.cn/login", "http://127.0.0.1:9527/callback"))
      expect(url.origin + url.pathname).toBe("https://sso.gwm.cn/login")
      expect(url.searchParams.get("mode")).toBe("TOKEN")
      expect(url.searchParams.get("redirect_url")).toBe("http://127.0.0.1:9527/callback")
    })
  })

  describe("parseUserFromTokenName", () => {
    test("splits employee id and display name", () => {
      expect(parseUserFromTokenName("GW00178937-武晓达")).toEqual({
        employeeId: "GW00178937",
        displayName: "武晓达",
        email: "",
      })
    })
    test("handles a name without a dash", () => {
      expect(parseUserFromTokenName("GW002")).toEqual({ employeeId: "GW002", displayName: "", email: "" })
    })
    test("handles undefined", () => {
      expect(parseUserFromTokenName(undefined)).toEqual({ employeeId: "", displayName: "", email: "" })
    })
  })

  describe("provisionToken", () => {
    test("returns the ready key and posts { ssoAccessToken }", async () => {
      let body: any
      let userAgent: string | null = null
      using admin = makeServer(async (request, url) => {
        expect(url.pathname).toBe("/api/provision/token")
        expect(request.method).toBe("POST")
        body = await request.json()
        userAgent = request.headers.get("user-agent")
        return Response.json({ status: "ready", key: "sk-user-abc", tokenName: "GW001-张三" })
      })
      const result = await provisionToken(baseUrl(admin), "SSO-T")
      expect(result).toEqual({ status: "ready", key: "sk-user-abc", tokenName: "GW001-张三" })
      expect(body).toEqual({ ssoAccessToken: "SSO-T" })
      expect(userAgent).toMatch(/^ruying-code\//)
    })

    test("passes through pending_enable", async () => {
      using admin = makeServer(() =>
        Response.json({ status: "pending_enable", tokenName: "GW002-李四", reason: "newly_created" }),
      )
      expect((await provisionToken(baseUrl(admin), "x")).status).toBe("pending_enable")
    })

    test("maps 401 / 429 / other errors to friendly messages", async () => {
      using unauthorized = makeServer(() => new Response("nope", { status: 401 }))
      await expect(provisionToken(baseUrl(unauthorized), "x")).rejects.toThrow(/SSO 校验失败/)

      using throttled = makeServer(() => new Response("slow", { status: 429 }))
      await expect(provisionToken(baseUrl(throttled), "x")).rejects.toThrow(/请求过于频繁/)

      using broken = makeServer(() => new Response("boom", { status: 500 }))
      await expect(provisionToken(baseUrl(broken), "x")).rejects.toThrow(/开通失败 \(500\).*boom/)
    })
  })

  describe("fetchModelIds", () => {
    test("returns valid model ids and filters out blanks / non-strings", async () => {
      const authHeaders: Array<string | null> = []
      const userAgents: Array<string | null> = []
      using server = makeServer((request, url) => {
        expect(url.pathname).toBe("/models")
        authHeaders.push(request.headers.get("authorization"))
        userAgents.push(request.headers.get("user-agent"))
        return Response.json({ data: [{ id: "GLM-5.1" }, { id: "Deepseek-V4" }, { id: "" }, { foo: 1 }, {}] })
      })
      const ids = await fetchModelIds(baseUrl(server), "sk-ruying-abc")
      expect(ids).toEqual(["GLM-5.1", "Deepseek-V4"])
      expect(authHeaders[0]).toBe("Bearer sk-ruying-abc")
      expect(userAgents[0]).toMatch(/^ruying-code\//)
    })

    test("returns [] on a non-ok response", async () => {
      using server = makeServer(() => new Response("denied", { status: 403 }))
      expect(await fetchModelIds(baseUrl(server), "sk")).toEqual([])
    })
  })

  describe("buildProviderPatch", () => {
    test("registers the gateway with baseURL, models, and the logged-in user", () => {
      const patch = buildProviderPatch("https://aicoding.gwm.cn/v1/", ["GLM-5.1", "Deepseek-V4"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "z@gwm.cn",
      })
      const provider = patch.provider.ruying
      expect(provider.name).toBe("如影编码网关")
      expect(provider.npm).toBe("@ai-sdk/openai-compatible")
      expect(provider.options.baseURL).toBe("https://aicoding.gwm.cn/v1")
      expect(Object.keys(provider.models!)).toEqual(["GLM-5.1", "Deepseek-V4"])
      expect((provider.options as Record<string, unknown>).ruyingUser).toEqual({
        employeeId: "GW001",
        displayName: "张三",
        email: "z@gwm.cn",
      })
    })

    test("omits models and ruyingUser when none are available", () => {
      const provider = buildProviderPatch("https://aicoding.gwm.cn/v1", []).provider.ruying
      expect(provider.models).toBeUndefined()
      expect((provider.options as Record<string, unknown>).ruyingUser).toBeUndefined()
    })

    test("omits an empty identity marker", () => {
      const provider = buildProviderPatch("https://aicoding.gwm.cn/v1", [], {
        employeeId: "",
        displayName: "",
        email: "",
      }).provider.ruying
      expect((provider.options as Record<string, unknown>).ruyingUser).toBeUndefined()
    })
  })

  describe("writeGlobalProviderConfig", () => {
    test.skipIf(process.platform === "win32")("preserves an existing config mode of 0600", async () => {
      const file = tmpConfigFile()
      await Bun.write(file, JSON.stringify({ theme: "opencode" }))
      chmodSync(file, 0o600)

      await writeGlobalProviderConfig(file, "https://gateway/v1", ["model-a"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })

      expect(statSync(file).mode & 0o777).toBe(0o600)
      rmSync(file, { force: true })
    })

    test.skipIf(process.platform === "win32")("creates a new config with mode 0600", async () => {
      const file = tmpConfigFile()

      await writeGlobalProviderConfig(file, "https://gateway/v1", ["model-a"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })

      expect(statSync(file).mode & 0o777).toBe(0o600)
      rmSync(file, { force: true })
    })

    test.skipIf(process.platform === "win32")("preserves a config symlink and updates its backing file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ruying-symlink-"))
      const backing = join(dir, "backing.jsonc")
      const link = join(dir, "opencode.jsonc")
      await Bun.write(backing, '{\n  // backing comment\n  "theme": "opencode"\n}\n')
      symlinkSync(backing, link)

      await writeGlobalProviderConfig(link, "https://gateway/v1", ["model-a"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })

      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      const source = await Bun.file(backing).text()
      expect(source).toContain("// backing comment")
      expect(parse(source).provider.ruying.options.baseURL).toBe("https://gateway/v1")
      rmSync(dir, { recursive: true, force: true })
    })

    test("retains existing models when discovery returns none", async () => {
      const file = tmpConfigFile()
      await Bun.write(
        file,
        JSON.stringify({
          provider: {
            ruying: {
              models: {
                existing: { name: "Existing", modalities: { input: ["text"], output: ["text"] } },
              },
            },
          },
        }),
      )

      await writeGlobalProviderConfig(file, "https://gateway/v1", [], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })

      expect(Object.keys(JSON.parse(await Bun.file(file).text()).provider.ruying.models)).toEqual(["existing"])
      rmSync(file, { force: true })
    })

    test("preserves nested provider and option comments", async () => {
      const file = tmpConfigFile()
      await Bun.write(
        file,
        [
          "{",
          '  "provider": {',
          '    "ruying": {',
          "      // keep provider field comment",
          '      "customProviderField": true,',
          '      "options": {',
          "        // keep api key comment",
          '        "apiKey": "chelper-key",',
          "        // keep custom option comment",
          '        "customOption": "custom-value"',
          "      }",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      )

      await writeGlobalProviderConfig(file, "https://gateway/v1", ["model-a"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })

      const source = await Bun.file(file).text()
      const config = parse(source)
      expect(source).toContain("// keep provider field comment")
      expect(source).toContain("// keep api key comment")
      expect(source).toContain("// keep custom option comment")
      expect(config.provider.ruying.customProviderField).toBe(true)
      expect(config.provider.ruying.options.apiKey).toBe("chelper-key")
      expect(config.provider.ruying.options.customOption).toBe("custom-value")
      rmSync(file, { force: true })
    })

    test("re-reads after queued writes and preserves unrelated edits", async () => {
      const file = tmpConfigFile()
      await Bun.write(file, JSON.stringify({ theme: "opencode", custom: { keep: true } }))

      const first = writeGlobalProviderConfig(file, "https://first/v1", ["first-model"], {
        employeeId: "GW-FIRST",
        displayName: "First",
        email: "first@gwm.cn",
      })
      const unrelated = first.then(() => {
        const config = JSON.parse(readFileSync(file, "utf8"))
        writeFileSync(file, JSON.stringify({ ...config, externalEdit: { keep: true } }))
      })
      const second = writeGlobalProviderConfig(
        file,
        "https://second/v1",
        Array.from({ length: 2_000 }, (_, index) => `second-model-${index}`),
        {
          employeeId: "GW-SECOND",
          displayName: "Second",
          email: "second@gwm.cn",
        },
      )
      await Promise.all([unrelated, second])

      const config = JSON.parse(await Bun.file(file).text())
      expect(config.theme).toBe("opencode")
      expect(config.custom).toEqual({ keep: true })
      expect(config.externalEdit).toEqual({ keep: true })
      expect(config.provider.ruying.options.baseURL).toBe("https://second/v1")
      expect(config.provider.ruying.options.ruyingUser.employeeId).toBe("GW-SECOND")
      expect(Object.keys(config.provider.ruying.models)).toHaveLength(2_000)
      rmSync(file, { force: true })
    })

    test.skipIf(process.platform === "win32")(
      "preserves the original when atomic publication cannot create a temporary file",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "ruying-atomic-"))
        const file = join(dir, "config.json")
        const original = JSON.stringify({ theme: "opencode" })
        await Bun.write(file, original)
        chmodSync(dir, 0o500)

        try {
          await expect(
            writeGlobalProviderConfig(file, "https://gateway/v1", ["model-a"], {
              employeeId: "GW001",
              displayName: "张三",
              email: "",
            }),
          ).rejects.toThrow()
          expect(await Bun.file(file).text()).toBe(original)
        } finally {
          chmodSync(dir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )

    test("updates jsonc without discarding comments", async () => {
      const file = tmpConfigFile()
      await Bun.write(file, '{\n  // keep\n  "theme": "opencode"\n}\n')
      await writeGlobalProviderConfig(file, "https://gateway/v1", ["model-a"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })
      const source = await Bun.file(file).text()
      expect(source).toContain("// keep")
      expect(source).toContain('"enabled_providers": [')
      rmSync(file, { force: true })
    })

    test("merges into existing config, preserving other providers + chelper's apiKey", async () => {
      const file = tmpConfigFile()
      writeFileSync(
        file,
        JSON.stringify({
          theme: "opencode",
          provider: {
            alibaba: { options: { apiKey: "sk-a" } },
            ruying: { options: { apiKey: "chelper-key", baseURL: "https://old/v1" } },
          },
        }),
      )
      await writeGlobalProviderConfig(file, "https://aicoding.gwm.cn/v1", ["GLM-5.1"], {
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })
      const c = JSON.parse(readFileSync(file, "utf8"))
      expect(c.theme).toBe("opencode") // unrelated config preserved
      expect(c.provider.alibaba.options.apiKey).toBe("sk-a") // other provider preserved
      expect(c.enabled_providers).toEqual(["ruying"])
      expect(c.provider.ruying.options.apiKey).toBe("chelper-key") // existing key preserved
      expect(c.provider.ruying.options.baseURL).toBe("https://aicoding.gwm.cn/v1") // updated
      expect(c.provider.ruying.options.ruyingUser).toEqual({ employeeId: "GW001", displayName: "张三", email: "" })
      expect(Object.keys(c.provider.ruying.models)).toEqual(["GLM-5.1"])
      rmSync(file, { force: true })
    })

    test("does not clobber a config it cannot parse", async () => {
      const file = tmpConfigFile()
      writeFileSync(file, "{ not valid json // comment")
      await expect(
        writeGlobalProviderConfig(file, "https://x/v1", [], { employeeId: "G", displayName: "", email: "" }),
      ).rejects.toMatchObject({ name: "RuyingConfigPublicationError" })
      expect(readFileSync(file, "utf8")).toBe("{ not valid json // comment")
      rmSync(file, { force: true })
    })
  })

  describe("readExistingRuyingKey", () => {
    test("reads the apiKey from an existing config (e.g. chelper's)", () => {
      const file = tmpConfigFile()
      writeFileSync(file, JSON.stringify({ provider: { ruying: { options: { apiKey: "sk-existing" } } } }))
      expect(readExistingRuyingKey(file)).toBe("sk-existing")
      rmSync(file, { force: true })
    })
    test("returns undefined when the file or key is missing", () => {
      const file = tmpConfigFile()
      expect(readExistingRuyingKey(file)).toBeUndefined()
      writeFileSync(file, JSON.stringify({ provider: { ruying: { options: { baseURL: "x" } } } }))
      expect(readExistingRuyingKey(file)).toBeUndefined()
      rmSync(file, { force: true })
    })
  })

  describe("plugin shape", () => {
    test("exposes a single SSO oauth method for the ruying provider", async () => {
      const hooks = await RuyingAuthPlugin({} as any)
      expect(hooks.auth!.provider).toBe("ruying")
      expect(hooks.auth!.methods.map((m) => [m.type, m.label])).toEqual([["oauth", "如影 SSO 登录 (浏览器)"]])
    })
  })

  describe("authorize -> callback", () => {
    test("cancel completes when callback publication never started", async () => {
      const hooks = await RuyingAuthPlugin({} as any, { callbackPort: 0 })
      const authorized = await oauthMethod(hooks).authorize!()

      await expect(
        Promise.race([
          (authorized as { cancel: () => Promise<void> }).cancel(),
          Bun.sleep(100).then(() => Promise.reject(new Error("cancel timed out"))),
        ]),
      ).resolves.toBeUndefined()
      expect(await (authorized as { callback: () => Promise<unknown> }).callback()).toEqual({ type: "failed" })
    })

    test("cancel immediately before config rename prevents publication", async () => {
      const beforeRename = Promise.withResolvers<void>()
      const releaseRename = Promise.withResolvers<void>()
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-new", tokenName: "GW001-张三" }))
      using gateway = makeServer(() => Response.json({ data: [{ id: "new-model" }] }))
      const dir = mkdtempSync(join(tmpdir(), "ruying-cancel-before-"))
      const target = join(dir, "target.jsonc")
      const link = join(dir, "ruying-code.jsonc")
      const original = [
        "{",
        "  // preserve top-level comment",
        '  "enabled_providers": ["other"],',
        '  "theme": "opencode",',
        '  "provider": {',
        '    "ruying": {',
        '      "custom": true,',
        '      "options": {',
        '        "apiKey": "sk-old",',
        '        "ruyingUser": { "employeeId": "GW-OLD" }',
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n")
      writeFileSync(target, original)
      chmodSync(target, 0o640)
      symlinkSync(target, link)
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: baseUrl(gateway),
        callbackPort: 0,
        configFile: link,
        configPublicationHooks: {
          async beforeRename() {
            beforeRename.resolve()
            await releaseRename.promise
          },
        },
      })
      const authorized = await oauthMethod(hooks).authorize!()
      const redirect = new URL(authorized.url).searchParams.get("redirect_url")!
      const callback = (authorized as { callback: () => Promise<unknown> }).callback()
      const browser = fetch(`${redirect}?access_token=token`)
      await beforeRename.promise

      let canceled = false
      const cancel = (authorized as { cancel: () => Promise<void> }).cancel().then(() => {
        canceled = true
      })
      await Bun.sleep(10)
      expect(canceled).toBe(false)
      releaseRename.resolve()
      await cancel

      expect(await callback).toEqual({ type: "failed" })
      await browser
      expect(readFileSync(target, "utf8")).toBe(original)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(statSync(target).mode & 0o777).toBe(0o640)
      rmSync(dir, { recursive: true, force: true })
    })

    test("cancel immediately after config rename rolls back owned state and preserves concurrent edits", async () => {
      const afterRename = Promise.withResolvers<void>()
      const releaseCallback = Promise.withResolvers<void>()
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-new", tokenName: "GW001-张三" }))
      using gateway = makeServer(() => Response.json({ data: [{ id: "new-model" }] }))
      const file = tmpConfigFile()
      const original = [
        "{",
        "  // preserve top-level comment",
        '  "enabled_providers": ["other"],',
        '  "theme": "opencode",',
        '  "provider": {',
        '    "ruying": {',
        '      "custom": true,',
        '      "options": {',
        '        "apiKey": "sk-old",',
        '        "ruyingUser": { "employeeId": "GW-OLD" }',
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n")
      writeFileSync(file, original)
      chmodSync(file, 0o640)
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: baseUrl(gateway),
        callbackPort: 0,
        configFile: file,
        configPublicationHooks: {
          async afterRename() {
            afterRename.resolve()
            await releaseCallback.promise
          },
        },
      })
      const authorized = await oauthMethod(hooks).authorize!()
      const redirect = new URL(authorized.url).searchParams.get("redirect_url")!
      const callback = (authorized as { callback: () => Promise<unknown> }).callback()
      const browser = fetch(`${redirect}?access_token=token`)
      await afterRename.promise

      const published = readFileSync(file, "utf8")
      expect(parse(published).enabled_providers).toEqual(["ruying"])
      expect(parse(published).provider.ruying.options.ruyingUser.employeeId).toBe("GW001")
      const external = applyEdits(
        published,
        modify(published, ["externalEdit"], { keep: true }, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
      )
      writeFileSync(
        file,
        applyEdits(
          external,
          modify(external, ["enabled_providers"], ["ruying", "third"], {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }),
        ),
      )
      const cancel = (authorized as { cancel: () => Promise<void> }).cancel()
      releaseCallback.resolve()
      await cancel

      expect(await callback).toEqual({ type: "failed" })
      await browser
      const source = readFileSync(file, "utf8")
      const config = parse(source)
      expect(source).toContain("// preserve top-level comment")
      expect(config.enabled_providers).toEqual(["other", "third"])
      expect(config.theme).toBe("opencode")
      expect(config.externalEdit).toEqual({ keep: true })
      expect(config.provider.ruying).toEqual({
        custom: true,
        options: { apiKey: "sk-old", ruyingUser: { employeeId: "GW-OLD" } },
      })
      expect(statSync(file).mode & 0o777).toBe(0o640)
      rmSync(file, { force: true })
    })

    test("cancel during provisioning prevents config persistence", async () => {
      const started = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      using admin = makeServer(async () => {
        started.resolve()
        await released.promise
        return Response.json({ status: "ready", key: "sk-late", tokenName: "GW001-张三" })
      })
      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        callbackPort: 0,
        configFile,
      })
      const authorized = await oauthMethod(hooks).authorize!()
      const redirect = new URL(authorized.url).searchParams.get("redirect_url")!
      const callback = (authorized as { callback: () => Promise<unknown> }).callback()
      const browser = fetch(`${redirect}?access_token=token`)
      await started.promise

      await (authorized as { cancel: () => Promise<void> }).cancel()
      released.resolve()

      expect(await callback).toEqual({ type: "failed" })
      await browser
      expect(existsSync(configFile)).toBe(false)
    })

    test("returns public identity metadata with the api key", async () => {
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-test", tokenName: "GW001-张三" }))
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        callbackPort: 0,
        configFile: tmpConfigFile(),
      })
      const authorized = await oauthMethod(hooks).authorize!()
      const redirect = new URL(authorized.url).searchParams.get("redirect_url")!
      const callback = (authorized as { callback: () => Promise<unknown> }).callback()
      await fetch(`${redirect}?access_token=token`)
      expect(await callback).toMatchObject({
        type: "success",
        key: "sk-test",
        metadata: { employeeId: "GW001", displayName: "张三", email: "" },
      })
    })

    test("releases the callback server after timeout", async () => {
      const hooks = await RuyingAuthPlugin({} as any, { callbackPort: 0, callbackTimeoutMs: 10 })
      const authorized = await oauthMethod(hooks).authorize!()
      const port = Number(new URL(new URL(authorized.url).searchParams.get("redirect_url")!).port)
      expect(await (authorized as { callback: () => Promise<unknown> }).callback()).toEqual({ type: "failed" })
      using probe = Bun.serve({ port, fetch: () => new Response("ok") })
      expect(probe.port).toBe(port)
    }, 500)

    test("falls back to an ephemeral port when the implicit callback port is occupied", async () => {
      using occupied = Bun.serve({ hostname: "127.0.0.1", port: 9527, fetch: () => new Response("occupied") })
      const hooks = await RuyingAuthPlugin({} as any, { callbackTimeoutMs: 10 })
      const authorized = await oauthMethod(hooks).authorize!()
      const port = Number(new URL(new URL(authorized.url).searchParams.get("redirect_url")!).port)
      expect(port).not.toBe(occupied.port)
      expect(await (authorized as { callback: () => Promise<unknown> }).callback()).toEqual({ type: "failed" })
    })

    test("rejects a superseded callback URL without closing or consuming the current attempt", async () => {
      const hooks = await RuyingAuthPlugin({} as any, { callbackPort: 0, callbackTimeoutMs: 20 })
      const first = await oauthMethod(hooks).authorize!()
      const firstRedirect = new URL(first.url).searchParams.get("redirect_url")!
      const firstCallback = (first as { callback: () => Promise<unknown> }).callback()
      const second = await oauthMethod(hooks).authorize!()
      const secondRedirect = new URL(second.url).searchParams.get("redirect_url")!
      const secondCallback = (second as { callback: () => Promise<unknown> }).callback()

      try {
        expect(await firstCallback).toEqual({ type: "failed" })
        expect((await fetch(`${new URL(secondRedirect).origin}/callback`)).status).toBe(404)
        expect((await fetch(firstRedirect)).status).toBe(404)
        expect((await fetch(secondRedirect)).status).toBe(400)
        expect(await secondCallback).toEqual({ type: "failed" })
      } finally {
        await Promise.allSettled([firstCallback, secondCallback])
      }
    }, 500)

    test("keeps a newer attempt listening while the previous callback finishes post-login work", async () => {
      let markModelsStarted = () => {}
      let releaseModels = () => {}
      const modelsStarted = new Promise<void>((resolve) => {
        markModelsStarted = resolve
      })
      const modelsReleased = new Promise<void>((resolve) => {
        releaseModels = resolve
      })
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-first", tokenName: "GW001-张三" }))
      using gateway = makeServer(async () => {
        markModelsStarted()
        await modelsReleased
        return Response.json({ data: [] })
      })
      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: baseUrl(gateway),
        callbackPort: 0,
        callbackTimeoutMs: 50,
        configFile,
      })
      const first = await oauthMethod(hooks).authorize!()
      const firstRedirect = new URL(first.url).searchParams.get("redirect_url")!
      const firstCallback = (first as { callback: () => Promise<unknown> }).callback()
      await fetch(`${firstRedirect}?access_token=first`)
      await modelsStarted

      const second = await oauthMethod(hooks).authorize!()
      const secondRedirect = new URL(second.url).searchParams.get("redirect_url")!
      const secondCallback = (second as { callback: () => Promise<unknown> }).callback()

      try {
        releaseModels()
        expect(await firstCallback).toMatchObject({ type: "success", key: "sk-first" })
        expect((await fetch(secondRedirect)).status).toBe(400)
        expect(await secondCallback).toEqual({ type: "failed" })
      } finally {
        releaseModels()
        await Promise.allSettled([firstCallback, secondCallback])
        rmSync(configFile, { force: true })
      }
    }, 1_000)

    test("does not let an older callback timeout reject the current attempt", async () => {
      let markProvisionStarted = () => {}
      let releaseProvision = () => {}
      const provisionStarted = new Promise<void>((resolve) => {
        markProvisionStarted = resolve
      })
      const provisionReleased = new Promise<void>((resolve) => {
        releaseProvision = resolve
      })
      using admin = makeServer(async () => {
        markProvisionStarted()
        await provisionReleased
        return Response.json({ status: "ready", key: "sk-first", tokenName: "GW001-张三" })
      })
      using gateway = makeServer(() => Response.json({ data: [] }))
      const configFile = tmpConfigFile()
      const firstHooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: baseUrl(gateway),
        callbackPort: 0,
        callbackTimeoutMs: 10,
        configFile,
      })
      const first = await oauthMethod(firstHooks).authorize!()
      const firstRedirect = new URL(first.url).searchParams.get("redirect_url")!
      const firstCallback = (first as { callback: () => Promise<unknown> }).callback()
      const firstRequest = fetch(`${firstRedirect}?access_token=first`)
      await provisionStarted

      const secondHooks = await RuyingAuthPlugin({} as any, { callbackPort: 0, callbackTimeoutMs: 5_000 })
      const second = await oauthMethod(secondHooks).authorize!()
      const secondRedirect = new URL(second.url).searchParams.get("redirect_url")!
      const secondCallback = (second as { callback: () => Promise<unknown> }).callback()

      try {
        await Bun.sleep(20)
        expect((await fetch(secondRedirect)).status).toBe(400)
        expect(await secondCallback).toEqual({ type: "failed" })
      } finally {
        releaseProvision()
        await firstRequest
        await Promise.allSettled([firstCallback, secondCallback])
        rmSync(configFile, { force: true })
      }
    }, 1_000)

    test("shares one listener across same-tick authorizations and closes every advertised port", async () => {
      using occupied = Bun.serve({ hostname: "127.0.0.1", port: 9527, fetch: () => new Response("occupied") })
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-second", tokenName: "GW002-李四" }))
      using sso = makeServer(() =>
        Response.json({ key: "S_0000", result: { user_code: "GW002", user_name: "李四", email: "l@gwm.cn" } }),
      )
      using gateway = makeServer(() => Response.json({ data: [] }))
      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: baseUrl(gateway),
        callbackTimeoutMs: 100,
        configFile,
      })
      const method = oauthMethod(hooks)
      const listen = Server.prototype.listen
      const delayedListen = spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args) {
        queueMicrotask(() => Reflect.apply(listen, this, args))
        return this
      })
      const probes: Array<ReturnType<typeof Bun.serve>> = []
      try {
        const [first, second] = await Promise.all([method.authorize!(), method.authorize!()])
        const firstRedirect = new URL(first.url).searchParams.get("redirect_url")!
        const secondRedirect = new URL(second.url).searchParams.get("redirect_url")!
        const firstCallback = (first as { callback: () => Promise<unknown> }).callback()
        const secondCallback = (second as { callback: () => Promise<unknown> }).callback()

        await fetch(`${secondRedirect}?access_token=second`)
        expect(await firstCallback).toEqual({ type: "failed" })
        expect(await secondCallback).toMatchObject({ type: "success", key: "sk-second" })
        // One failed bind to the implicit default, then one shared ephemeral fallback.
        expect(delayedListen).toHaveBeenCalledTimes(2)

        for (const port of new Set([new URL(firstRedirect).port, new URL(secondRedirect).port])) {
          probes.push(Bun.serve({ port: Number(port), fetch: () => new Response("ok") }))
        }
        expect(probes.map((probe) => probe.port)).toEqual([
          ...new Set([Number(new URL(firstRedirect).port), Number(new URL(secondRedirect).port)]),
        ])
      } finally {
        delayedListen.mockRestore()
        probes.forEach((probe) => probe.stop(true))
        rmSync(configFile, { force: true })
      }
    }, 1_000)

    test("does not share an implicit ephemeral binding with an explicit port request", async () => {
      using occupied = Bun.serve({ hostname: "127.0.0.1", port: 9527, fetch: () => new Response("occupied") })
      const implicitHooks = await RuyingAuthPlugin({} as any, { callbackTimeoutMs: 100 })
      const explicitHooks = await RuyingAuthPlugin({} as any, { callbackPort: 9527, callbackTimeoutMs: 100 })
      const listen = Server.prototype.listen
      const delayedListen = spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args) {
        queueMicrotask(() => Reflect.apply(listen, this, args))
        return this
      })
      const probes: Array<ReturnType<typeof Bun.serve>> = []
      try {
        const [implicit, explicit] = await Promise.allSettled([
          oauthMethod(implicitHooks).authorize!(),
          oauthMethod(explicitHooks).authorize!(),
        ])
        if (implicit.status === "rejected") throw implicit.reason
        const implicitRedirect = new URL(implicit.value.url).searchParams.get("redirect_url")!
        const implicitCallback = (implicit.value as { callback: () => Promise<unknown> }).callback()

        if (explicit.status === "fulfilled") {
          const explicitRedirect = new URL(explicit.value.url).searchParams.get("redirect_url")!
          const explicitCallback = (explicit.value as { callback: () => Promise<unknown> }).callback()
          await fetch(explicitRedirect)
          await Promise.all([implicitCallback, explicitCallback])
        } else {
          await fetch(implicitRedirect)
          await implicitCallback
        }

        expect(explicit.status).toBe("rejected")
        if (explicit.status === "rejected") expect(String(explicit.reason)).toContain("回调服务器配置不匹配")
        probes.push(Bun.serve({ port: Number(new URL(implicitRedirect).port), fetch: () => new Response("ok") }))
      } finally {
        delayedListen.mockRestore()
        probes.forEach((probe) => probe.stop(true))
      }
    }, 1_000)

    test("does not share an implicit ephemeral binding with an environment port request", async () => {
      using occupied = Bun.serve({ hostname: "127.0.0.1", port: 9527, fetch: () => new Response("occupied") })
      const previous = process.env["RUYING_CALLBACK_PORT"]
      delete process.env["RUYING_CALLBACK_PORT"]
      const implicitHooks = await RuyingAuthPlugin({} as any, { callbackTimeoutMs: 100 })
      process.env["RUYING_CALLBACK_PORT"] = "9527"
      const explicitHooks = await RuyingAuthPlugin({} as any, { callbackTimeoutMs: 100 })
      if (previous === undefined) delete process.env["RUYING_CALLBACK_PORT"]
      if (previous !== undefined) process.env["RUYING_CALLBACK_PORT"] = previous

      const probes: Array<ReturnType<typeof Bun.serve>> = []
      try {
        const implicit = await oauthMethod(implicitHooks).authorize!()
        const [explicit] = await Promise.allSettled([oauthMethod(explicitHooks).authorize!()])
        const implicitRedirect = new URL(implicit.url).searchParams.get("redirect_url")!
        const implicitCallback = (implicit as { callback: () => Promise<unknown> }).callback()

        if (explicit.status === "fulfilled") {
          const explicitRedirect = new URL(explicit.value.url).searchParams.get("redirect_url")!
          const explicitCallback = (explicit.value as { callback: () => Promise<unknown> }).callback()
          await fetch(explicitRedirect)
          await Promise.all([implicitCallback, explicitCallback])
        } else {
          await fetch(implicitRedirect)
          await implicitCallback
        }

        expect(explicit.status).toBe("rejected")
        if (explicit.status === "rejected") expect(String(explicit.reason)).toContain("回调服务器配置不匹配")
        probes.push(Bun.serve({ port: Number(new URL(implicitRedirect).port), fetch: () => new Response("ok") }))
      } finally {
        probes.forEach((probe) => probe.stop(true))
      }
    }, 1_000)

    test("does not fall back when the callback port is configured through the environment", async () => {
      using occupied = Bun.serve({ hostname: "127.0.0.1", port: 9527, fetch: () => new Response("occupied") })
      const previous = process.env["RUYING_CALLBACK_PORT"]
      process.env["RUYING_CALLBACK_PORT"] = "9527"
      try {
        const hooks = await RuyingAuthPlugin({} as any)
        await expect(oauthMethod(hooks).authorize!()).rejects.toThrow(/端口 9527 已被占用/)
      } finally {
        if (previous === undefined) delete process.env["RUYING_CALLBACK_PORT"]
        if (previous !== undefined) process.env["RUYING_CALLBACK_PORT"] = previous
      }
    })

    test("provisions a key, fetches user + models, writes config to disk, returns success", async () => {
      using admin = makeServer((_, url) => {
        if (url.pathname === "/api/provision/token")
          return Response.json({ status: "ready", key: "sk-user-abc", tokenName: "GW001-张三" })
        return new Response("nf", { status: 404 })
      })
      using gw = makeServer((_, url) => {
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "GLM-5.1" }, { id: "Deepseek-V4" }] })
        return new Response("nf", { status: 404 })
      })

      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: `${baseUrl(gw)}/v1`,
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
      })

      const authorized = await oauthMethod(hooks).authorize!()
      expect(authorized.method).toBe("auto")
      expect(authorized.instructions).toContain("如影 Code")
      expect(authorized.instructions).not.toContain("opencode")
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!

      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      const hit = await fetch(`${redirectUri}?access_token=SSO-T`)
      const html = await hit.text()
      expect(html).toContain("登录成功")
      expect(html).toContain("如影 Code")
      expect(html).not.toContain("opencode")

      expect(await callbackPromise).toEqual({
        type: "success",
        key: "sk-user-abc",
        metadata: { employeeId: "GW001", displayName: "张三", email: "" },
      })

      const config = JSON.parse(readFileSync(configFile, "utf8"))
      expect(config.enabled_providers).toEqual(["ruying"])
      expect(config.provider.ruying.options.baseURL).toBe(`${baseUrl(gw)}/v1`)
      expect(Object.keys(config.provider.ruying.models)).toEqual(["GLM-5.1", "Deepseek-V4"])
      expect(config.provider.ruying.options.ruyingUser).toEqual({
        employeeId: "GW001",
        displayName: "张三",
        email: "",
      })
      rmSync(configFile, { force: true })
    })

    test("fails without committing config when employee identity is empty", async () => {
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-user-abc", tokenName: "" }))
      using sso = makeServer(() => new Response("down", { status: 500 }))
      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
      })

      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      await fetch(`${redirectUri}?access_token=SSO-T`)

      expect(await callbackPromise).toEqual({ type: "failed" })
      expect(existsSync(configFile)).toBe(false)
    })

    test("fails and restores config when publication reports an error", async () => {
      using admin = makeServer(() => Response.json({ status: "ready", key: "sk-user-abc", tokenName: "GW001-张三" }))
      using gw = makeServer(() => Response.json({ data: [] }))
      const configFile = tmpConfigFile()
      const original = JSON.stringify({ theme: "dark" })
      writeFileSync(configFile, original)
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: `${baseUrl(gw)}/v1`,
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
        configPublicationHooks: {
          afterRename: async () => {
            throw new Error("publication failed")
          },
        },
      })

      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      await fetch(`${redirectUri}?access_token=SSO-T`)

      expect(await callbackPromise).toEqual({ type: "failed" })
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual(JSON.parse(original))
      rmSync(configFile, { force: true })
    })

    for (const [name, source] of [
      ["malformed JSONC", '{ "theme": "dark",'],
      ["non-object JSON", "[]"],
    ] as const) {
      test(`fails without credential or config commit for ${name}`, async () => {
        using admin = makeServer(() => Response.json({ status: "ready", key: "sk-user-abc", tokenName: "GW001-张三" }))
        using gateway = makeServer(() => Response.json({ data: [] }))
        const configFile = tmpConfigFile()
        writeFileSync(configFile, source)
        const hooks = await RuyingAuthPlugin({} as any, {
          adminApiBase: baseUrl(admin),
          gatewayApiBase: `${baseUrl(gateway)}/v1`,
          configFile,
          callbackHost: "127.0.0.1",
          callbackPort: 0,
        })

        const authorized = await oauthMethod(hooks).authorize!()
        const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
        const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
        await fetch(`${redirectUri}?access_token=SSO-T`)

        expect(await callbackPromise).toEqual({ type: "failed" })
        expect(readFileSync(configFile, "utf8")).toBe(source)
        rmSync(configFile, { force: true })
      })
    }

    test("uses the authenticated provisioning token name as identity", async () => {
      using admin = makeServer((_, url) =>
        url.pathname === "/api/provision/token"
          ? Response.json({ status: "ready", key: "sk-k", tokenName: "GW00178937-武晓达" })
          : new Response("nf", { status: 404 }),
      )
      using gw = makeServer((_, url) =>
        url.pathname === "/v1/models" ? Response.json({ data: [] }) : new Response("nf", { status: 404 }),
      )

      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        gatewayApiBase: `${baseUrl(gw)}/v1`,
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
      })

      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      await fetch(`${redirectUri}?access_token=SSO-T`)

      expect(await callbackPromise).toEqual({
        type: "success",
        key: "sk-k",
        metadata: { employeeId: "GW00178937", displayName: "武晓达", email: "" },
      })
      const config = JSON.parse(readFileSync(configFile, "utf8"))
      expect(config.provider.ruying.options.ruyingUser).toEqual({
        employeeId: "GW00178937",
        displayName: "武晓达",
        email: "",
      })
      rmSync(configFile, { force: true })
    })

    test("returns failed and shows the pending reason; writes no config", async () => {
      using admin = makeServer(() => Response.json({ status: "pending_enable", tokenName: "GW002-李四" }))
      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
      })

      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      const body = await (await fetch(`${redirectUri}?access_token=SSO-X`)).text()

      expect(body).toContain("待管理员开通")
      expect(body).toContain("GW002-李四")
      expect(await callbackPromise).toEqual({ type: "failed" })
      expect(existsSync(configFile)).toBe(false)
    })

    test("does not trust an existing config key when authoritative provisioning is down", async () => {
      using admin = makeServer(() => new Response("503 Service Temporarily Unavailable", { status: 503 }))

      const configFile = tmpConfigFile()
      // A key chelper already provisioned into the config.
      writeFileSync(
        configFile,
        JSON.stringify({
          provider: { ruying: { options: { apiKey: "sk-chelper", baseURL: "https://aicoding.gwm.cn/v1" } } },
        }),
      )

      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
      })

      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      expect(await (await fetch(`${redirectUri}?access_token=SSO-T`)).text()).toContain("开通失败")
      expect(await callbackPromise).toEqual({ type: "failed" })
      const config = JSON.parse(readFileSync(configFile, "utf8"))
      expect(config.provider.ruying.options.apiKey).toBe("sk-chelper")
      expect(config.provider.ruying.options.ruyingUser).toBeUndefined()
      rmSync(configFile, { force: true })
    })

    test("fails with an explanatory page when provisioning is down and there is no existing key", async () => {
      using admin = makeServer(() => new Response("503", { status: 503 }))
      using sso = makeServer(() => Response.json({ key: "S_0000", result: { user_code: "GW001", user_name: "张三" } }))
      const configFile = tmpConfigFile()
      const hooks = await RuyingAuthPlugin({} as any, {
        adminApiBase: baseUrl(admin),
        configFile,
        callbackHost: "127.0.0.1",
        callbackPort: 0,
      })

      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      expect(await (await fetch(`${redirectUri}?access_token=SSO-X`)).text()).toContain("开通失败")

      expect(await callbackPromise).toEqual({ type: "failed" })
      expect(existsSync(configFile)).toBe(false)
    })

    test("returns failed and shows a reason when the callback has no token", async () => {
      const hooks = await RuyingAuthPlugin({} as any, { callbackHost: "127.0.0.1", callbackPort: 0 })
      const authorized = await oauthMethod(hooks).authorize!()
      const redirectUri = new URL(authorized.url).searchParams.get("redirect_url")!
      const callbackPromise = (authorized as { callback: () => Promise<any> }).callback()
      const hit = await fetch(redirectUri)
      expect(hit.status).toBe(400)
      const html = await hit.text()
      expect(html).toContain("access_token")
      expect(html).toContain("如影 Code")
      expect(html).not.toContain("opencode")
      expect(await callbackPromise).toEqual({ type: "failed" })
    })
  })
})
