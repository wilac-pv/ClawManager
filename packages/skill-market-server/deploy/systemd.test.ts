import { describe, expect, test } from "bun:test"

const directory = new URL("./systemd/", import.meta.url)
const serviceNames = [
  "ruying-skill-market.service",
  "ruying-skill-market-worker.service",
  "ruying-skill-market-sync.service",
  "ruying-skill-market-backup.service",
  "ruying-skill-market-cleanup.service",
  "ruying-skill-market-restore-drill.service",
]
const timerNames = serviceNames.slice(1).map((name) => name.replace(/\.service$/, ".timer"))

describe("systemd deployment", () => {
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
    services.slice(1, 3).forEach((service) =>
      expect(service).toContain("/run/lock/ruying-skill-market-ops.lock"),
    )
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
    expect(timers[2]).toContain("OnCalendar=*-*-* 02:10:00")
    expect(timers[3]).toContain("OnCalendar=*-*-* 03:10:00")
    expect(timers[4]).toContain("OnCalendar=*-*-02 04:10:00")
  })

  test("documents retiring the legacy SkillHub timer before enabling the formal sync timer", async () => {
    expect(await Bun.file(new URL("./README.md", import.meta.url)).text()).toContain(`\`\`\`bash
systemctl disable --now ruying-skill-market-skillhub.timer
rm -f /etc/systemd/system/ruying-skill-market-skillhub.timer
rm -f /etc/systemd/system/ruying-skill-market-skillhub.service
systemctl daemon-reload
systemctl enable --now ruying-skill-market-sync.timer
\`\`\``)
  })
})

function read(name: string) {
  return Bun.file(new URL(name, directory)).text()
}
