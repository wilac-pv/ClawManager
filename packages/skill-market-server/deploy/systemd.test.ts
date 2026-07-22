import { describe, expect, test } from "bun:test"

const directory = new URL("./systemd/", import.meta.url)
const serviceNames = [
  "ruying-skill-market.service",
  "ruying-skill-market-worker.service",
  "ruying-skill-market-sync.service",
  "ruying-skill-market-skillhub.service",
  "ruying-skill-market-evaluation.service",
  "ruying-skill-market-backup.service",
  "ruying-skill-market-cleanup.service",
  "ruying-skill-market-restore-drill.service",
]
const timerNames = serviceNames.slice(1).map((name) => name.replace(/\.service$/, ".timer"))

describe("systemd deployment", () => {
  test("documents immutable releases, secret-safe preflight, and writer quiescence", async () => {
    const readme = await Bun.file(new URL("./README.md", import.meta.url)).text()

    expect(readme).toContain("bun run build:release <output-directory>")
    expect(readme).toContain("src/skillhub-worker.js")
    expect(readme).toContain("src/skillhub-evaluation-worker.js")
    expect(readme).toContain("Do not deploy a source archive or use")
    expect(readme).toContain("sudo -u ruying-market /bin/bash -c")
    expect(readme).toContain("set -a")
    expect(readme).toContain(". /etc/ruying-skill-market/market.env")
    expect(readme).toContain("set +a")
    expect(readme).toContain("ruying-skill-market-skillhub.timer")
    expect(readme).toContain("ruying-skill-market-evaluation.timer")
    expect(readme).toContain("systemctl stop")
    expect(readme).toContain("systemctl is-active --quiet")
    expect(readme).toContain("exec /usr/local/bin/bun script/deploy-check.ts smoke --allow-private-canary")
    expect(readme).toContain("private canary")
    expect(readme).toContain("confirm it is absent")
  })

  test("runs every command as the dedicated unprivileged identity", async () => {
    const services = await Promise.all(serviceNames.map(read))
    services.forEach((service) => {
      expect(service).toContain("User=ruying-market")
      expect(service).toContain("Group=ruying-market")
      expect(service).toContain("EnvironmentFile=/etc/ruying-skill-market/market.env")
      expect(service).toContain("WorkingDirectory=/srv/ruying-skill-market/current/packages/skill-market-server")
      expect(service).toMatch(/ExecStart=\/(?:usr|opt)\/[^\n]*\/bun(?:\s|$)/)
      expect(service).not.toMatch(/ExecStart=.*(?:sh -c|bash -c|\$\{|`)/)
    })
    expect(services[0]).toContain("Restart=on-failure")
    services.slice(1).forEach((service) => expect(service).not.toContain("Restart="))
  })

  test("sandboxes services and serializes overlapping catalog operations", async () => {
    const services = await Promise.all(serviceNames.map(read))
    services.forEach((service) => {
      expect(service).toContain("NoNewPrivileges=true")
      expect(service).toContain("PrivateTmp=true")
      expect(service).toContain("ProtectSystem=strict")
      expect(service).toContain("ProtectHome=true")
      expect(service).toContain("UMask=0077")
      expect(service).toContain("ReadWritePaths=/var/lib/ruying-skill-market /var/backups/ruying-skill-market")
      expect(service).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6")
    })
    services.slice(1, 4).forEach((service) =>
      expect(service).toContain("/run/lock/ruying-skill-market-ops.lock"),
    )
    expect(services[1]).toContain(
      "ExecStart=/usr/bin/flock -n -E 0 /run/lock/ruying-skill-market-ops.lock /usr/local/bin/bun src/worker.ts --once",
    )
    expect(services[3]).toContain(
      "ExecStart=/usr/bin/flock -w 30 /run/lock/ruying-skill-market-ops.lock /usr/local/bin/bun --smol src/skillhub-worker.js",
    )
    expect(services[3]).toContain("MemoryHigh=1536M")
    expect(services[3]).toContain("MemoryMax=2048M")
    expect(services[3]).toContain("TimeoutStartSec=2min")
    expect(services[3]).toContain("TimeoutStopSec=10s")
    expect(services[3]).toContain("Type=oneshot")
    expect(services[4]).toContain(
      "ExecStart=/usr/bin/flock -n -E 0 /run/lock/ruying-skill-market-evaluation.lock /usr/local/bin/bun --smol src/skillhub-evaluation-worker.js",
    )
    expect(services[4]).toContain("MemoryHigh=896M")
    expect(services[4]).toContain("MemoryMax=1024M")
    expect(services[4]).toContain("TimeoutStartSec=90s")
    expect(services[4]).toContain("TimeoutStopSec=10s")
    expect(services[4]).toContain("Type=oneshot")
  })

  test("defines persistent randomized worker, sync, daily, and monthly timers", async () => {
    const timers = await Promise.all(timerNames.map(read))
    timers.forEach((timer) => {
      expect(timer).toContain("Persistent=true")
      expect(timer).toMatch(/RandomizedDelaySec=\S+/)
      expect(timer).toContain("WantedBy=timers.target")
    })
    expect(timers[0]).toContain("OnUnitActiveSec=1min")
    expect(timers[1]).toContain("OnUnitActiveSec=30min")
    expect(timers[2]).toContain("OnUnitActiveSec=1min")
    expect(timers[2]).toContain("OnBootSec=2min")
    expect(timers[2]).toMatch(/RandomizedDelaySec=(?:[0-9]|10)s/)
    expect(timers[3]).toContain("OnUnitActiveSec=1min")
    expect(timers[3]).toContain("OnBootSec=1min")
    expect(timers[3]).toMatch(/RandomizedDelaySec=(?:[0-9]|10)s/)
    expect(timers[4]).toContain("OnCalendar=*-*-* 02:10:00")
    expect(timers[5]).toContain("OnCalendar=*-*-* 03:10:00")
    expect(timers[6]).toContain("OnCalendar=*-*-02 04:10:00")
  })

  test("documents retiring the legacy full sync timer before enabling the bounded SkillHub timer", async () => {
    expect(await Bun.file(new URL("./README.md", import.meta.url)).text()).toContain(`\`\`\`bash
systemctl disable --now ruying-skill-market-sync.timer
systemctl daemon-reload
systemctl enable --now ruying-skill-market-skillhub.timer
\`\`\``)
  })

  test("documents enabling the isolated evaluation timer", async () => {
    expect(await Bun.file(new URL("./README.md", import.meta.url)).text()).toContain(`\`\`\`bash
systemctl daemon-reload
systemctl enable --now ruying-skill-market-evaluation.timer
\`\`\``)
  })
})

function read(name: string) {
  return Bun.file(new URL(name, directory)).text()
}
