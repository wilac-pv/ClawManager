import { describe, expect, test } from "bun:test"

describe("Nginx market gateway", () => {
  test("serves IP-test SPA routes and immutable assets only on port 4211", async () => {
    const config = await Bun.file(new URL("./nginx-ip-test.conf", import.meta.url)).text()
    expect(config).toContain("listen 4211;")
    expect(config).not.toMatch(/listen\s+(?:80|443)\b/)
    expect(config).toContain("/ai-coding/ruying-code/skill-market/")
    expect(config).toMatch(/try_files[^;]+index\.html/)
    expect(config).toMatch(/location[^\n]+assets/)
    expect(config).toContain("immutable")
    expect(config).toContain("autoindex off")
    expect(config).toMatch(/location[^\n]+\\\./)
    expect(config).toMatch(/private\|data\|env/)
    expect(config).toContain("Content-Security-Policy")
    expect(config).toContain("X-Content-Type-Options")
  })

  test("redirects the future domain to HTTPS and preserves /v1 paths", async () => {
    const config = await Bun.file(new URL("./nginx-domain.conf.example", import.meta.url)).text()
    expect(config).toMatch(/listen\s+80;/)
    expect(config).toMatch(/return\s+301\s+https:\/\//)
    expect(config).toMatch(/listen\s+443\s+ssl/)
    expect(config).toMatch(/location \/v1\//)
    expect(config).toContain("proxy_pass http://127.0.0.1:4210;")
    expect(config).not.toContain("proxy_cookie_flags")
    expect(config).toContain("client_max_body_size 55m")
  })
})
