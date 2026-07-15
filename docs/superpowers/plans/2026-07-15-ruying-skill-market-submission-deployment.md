# Ruying Skill Market Submission Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将带投稿审核能力的 Skill 市场安全部署到现有内网测试服务器，以专用低权限用户运行，配置私有/公开 OSS 边界、定时恢复与同步、SQLite 备份清理，并完成 IP 阶段验收和可回滚交付。

**Architecture:** 应用发布物安装到 `/srv/ruying-skill-market/releases/<git-sha>`，`current` 软链切换版本；`ruying-market` 系统用户只拥有应用数据目录和所需 OSS 前缀权限。systemd 常驻 API，timer 触发 durable worker、两分钟同步/发布恢复、每日备份/清理和每月恢复演练。IP 测试阶段 Nginx 在 4211 提供本地验证过的静态 Web，API 在 4210；正式域名后由同源 HTTPS 网关承载 Web 和 `/v1/*`。

**Tech Stack:** Linux/systemd、Bun、Nginx、SQLite、zstd、Privoxy + SOCKS5、S3 兼容 OSS、Bun test、curl。

## Global Constraints

- 服务器地址、端口和现有登录凭据只用于人工部署会话，不写入仓库、脚本、systemd unit、日志或计划输出。
- 用户在对话中提供过测试 AK/SK；实际部署必须通过 root-only 环境文件注入。生产前申请仅限两个前缀的服务凭据并轮换测试凭据。
- 私有前缀必须是 `ai-coding/ruying-code/skill-market-private-test/`，不能位于公开 `skill-market-test/` 下，也不能授予匿名读/list。
- 公开前缀保持 `ai-coding/ruying-code/skill-market-test/`；只允许公开读已发布目录/包/图标，不允许匿名写/list。
- 任何部署步骤都先做只读预检；数据库迁移前备份，服务切换后健康检查失败则恢复旧 release，不删除新 release 或历史目录。
- IP HTTP 模式只能在显式测试开关下启用；正式域名验收必须关闭该开关并启用 `Secure __Host-` Cookie。
- 代理只用于无法直连的外部 SkillHub/SSO 依赖；OSS、SSO 内网服务、服务器自身和内网网段应通过 `NO_PROXY` 直连。

---

## File Structure

- `packages/skill-market-server/deploy/systemd/ruying-skill-market.service`：API 常驻服务。
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-worker.{service,timer}`：durable 校验/发布任务恢复。
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-sync.{service,timer}`：两分钟统一同步。
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-backup.{service,timer}`：每日 SQLite 一致性备份。
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-cleanup.{service,timer}`：每日私有隔离区清理。
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-restore-drill.{service,timer}`：每月恢复演练。
- `packages/skill-market-server/deploy/ruying-skill-market.env.example`：无凭据环境模板。
- `packages/skill-market-server/deploy/nginx-ip-test.conf`：4211 IP 测试静态 Web 配置。
- `packages/skill-market-server/script/backup.ts`：一致性 SQLite 备份、压缩和私有 OSS 上传。
- `packages/skill-market-server/script/cleanup.ts`：30 天隔离文件/备份保留策略。
- `packages/skill-market-server/script/restore-drill.ts`：临时恢复和 integrity check。
- `packages/skill-market-server/script/deploy-check.ts`：配置、目录、OSS、数据库和 HTTP 预检/验收。
- `packages/skill-market-server/deploy/README.md`：安装、升级、回滚、域名切换和应急手册。

### Task 1: Implement and test backup, retention, and restore-drill commands

**Files:**
- Create: `packages/skill-market-server/script/backup.ts`
- Create: `packages/skill-market-server/script/backup.test.ts`
- Create: `packages/skill-market-server/script/cleanup.ts`
- Create: `packages/skill-market-server/script/cleanup.test.ts`
- Create: `packages/skill-market-server/script/restore-drill.ts`
- Create: `packages/skill-market-server/script/restore-drill.test.ts`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- `backupDatabase(options)` creates a transactionally consistent temporary SQLite copy, runs integrity check, zstd-compresses it and uploads it to the private backup prefix with SHA-256 metadata.
- `cleanupPrivateObjects(options)` deletes only rejected/abandoned quarantine objects and backups older than 30 days after cross-checking SQLite state.
- `restoreDrill(options)` restores a selected backup into a new temporary path and runs schema version, foreign key and full integrity checks without touching the live DB.

- [ ] **Step 1: Write failing backup tests using a real WAL database and fake ObjectStore**

Write concurrent committed rows while backing up, restore the produced artifact, and assert all committed transactions are present with no partial row. Assert a failed integrity check or upload leaves the live database untouched and reports a stable non-secret error.

- [ ] **Step 2: Write failing retention boundary tests**

Cover 29/30/31-day objects, published/pending/rejected/abandoned revisions, unrelated object prefixes and 29/30/31-day backups. Only eligible objects under the exact private prefix may be deleted.

- [ ] **Step 3: Write failing restore-drill tests**

Cover valid backup, corrupt zstd, corrupt SQLite, wrong `user_version`, foreign-key violation and guaranteed temporary-file cleanup.

- [ ] **Step 4: Implement consistent backup and compression**

Use SQLite's online backup/VACUUM-into capability from `bun:sqlite` to produce a separate restricted file, verify `PRAGMA integrity_check = ok`, spawn `zstd -T1 -q`, hash the compressed bytes, upload to:

```text
<private-prefix>/backups/sqlite/<UTC timestamp>-v<user_version>-<sha256>.db.zst
```

Never shell-interpolate paths; pass argument arrays to `Bun.spawn`.

- [ ] **Step 5: Implement safe cleanup and restore drill**

List only the configured private subprefix, parse object keys strictly, consult retained submission state before deleting quarantine objects, and cap every run. Restore drill chooses the latest completed backup, verifies object metadata/hash, decompresses to a unique mode-0600 temp file and opens it read-only for checks.

- [ ] **Step 6: Test/typecheck and commit**

```bash
cd packages/skill-market-server
bun test script/backup.test.ts script/cleanup.test.ts script/restore-drill.test.ts
bun typecheck
git add script package.json
git commit -m "feat(skill-market): add recovery operations"
```

### Task 2: Add deployment preflight and smoke-check automation

**Files:**
- Create: `packages/skill-market-server/script/deploy-check.ts`
- Create: `packages/skill-market-server/script/deploy-check.test.ts`
- Create: `packages/skill-market-server/deploy/ruying-skill-market.env.example`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- `deploy-check preflight` validates environment shape, paths, permissions, dependency binaries, proxy reachability and OSS prefix separation without changing live state.
- `deploy-check smoke` performs bounded health/catalog/session/CORS checks and an OSS canary write/read/delete only under an explicit private `canary/` key.
- Output redacts environment values and reports names/status only.

- [ ] **Step 1: Write failing redaction and configuration tests**

Feed marker values for AK/SK/session/SSO and assert they never appear in stdout/stderr/errors. Reject missing DB parent, group/world-readable env file, same/nested public/private prefix, public HTTP mode and invalid Origin.

- [ ] **Step 2: Write failing HTTP security smoke tests**

Assert catalog GET/HEAD/OPTIONS wildcard CORS, control no-store/credentialed exact Origin, anonymous session shape, off-origin write rejection, health/readiness and no server stack in 4xx/5xx responses.

- [ ] **Step 3: Implement named preflight checks**

Report `PASS|FAIL|SKIP` for Bun version, `zstd`, database directory ownership/mode, env file mode, public/private prefix separation, OSS endpoint, external proxy, SSO/provisioning reachability, public catalog and static Web. Do not print response bodies from authentication endpoints.

- [ ] **Step 4: Implement explicit OSS canary semantics**

Only when `--allow-private-canary` is passed, PUT a random object under `<private-prefix>/canary/`, HEAD/GET-verify its bytes, DELETE it and verify absence. Refuse any canary prefix that normalizes outside private root.

- [ ] **Step 5: Test/typecheck and commit**

```bash
cd packages/skill-market-server
bun test script/deploy-check.test.ts
bun typecheck
git add script/deploy-check.ts script/deploy-check.test.ts deploy/ruying-skill-market.env.example package.json
git commit -m "chore(skill-market): add deployment checks"
```

### Task 3: Add hardened systemd units and timers

**Files:**
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-worker.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-worker.timer`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-sync.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-sync.timer`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-backup.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-backup.timer`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-cleanup.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-cleanup.timer`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-restore-drill.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-restore-drill.timer`
- Create: `packages/skill-market-server/deploy/systemd.test.ts`

- [ ] **Step 1: Write a failing static unit test**

Parse every unit and assert `User=ruying-market`, `Group=ruying-market`, root-only `EnvironmentFile`, absolute Bun executable, `WorkingDirectory=/srv/ruying-skill-market/current/packages/skill-market-server`, restart policy only for API, no shell command interpolation and a shared non-overlap lock for worker/sync/publish.

- [ ] **Step 2: Define API sandboxing**

Use `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=/var/lib/ruying-skill-market /var/backups/ruying-skill-market`, `UMask=0077`, bounded file/process limits and network address families only. Do not grant sudo/capabilities.

- [ ] **Step 3: Define one-shot service and timer schedules**

Use randomized persistent timers:

```text
worker:        every 1 minute
sync/recover:  every 2 minutes
backup:        daily around 02:10
cleanup:       daily around 03:10
restore drill: monthly on day 2 around 04:10
```

One-shot services use `flock` on `/run/lock/ruying-skill-market-ops.lock` where catalog pointer work can overlap. Backup may use its own lock while SQLite online backup runs.

- [ ] **Step 4: Ensure timers never expose environment values**

Use `EnvironmentFile=/etc/ruying-skill-market/market.env`, `StandardOutput=journal`, stable command flags, and no `set -x`/inline secrets. Add `SuccessExitStatus` only for explicitly documented no-work exits.

- [ ] **Step 5: Verify units and commit**

```bash
cd packages/skill-market-server
bun test deploy/systemd.test.ts
systemd-analyze verify deploy/systemd/*.service deploy/systemd/*.timer
git add deploy/systemd deploy/systemd.test.ts
git commit -m "chore(skill-market): add systemd services"
```

Expected: Bun static tests PASS. Run `systemd-analyze verify` on Linux; on macOS record it as deferred and run it on the target before installation.

### Task 4: Add IP-test Nginx/static release and future HTTPS gateway configuration

**Files:**
- Create: `packages/skill-market-server/deploy/nginx-ip-test.conf`
- Create: `packages/skill-market-server/deploy/nginx-domain.conf.example`
- Create: `packages/skill-market-server/deploy/nginx.test.ts`
- Modify: `packages/skill-market-web/script/release.ts`
- Modify: `packages/skill-market-web/script/release.test.ts`

**Interfaces:**
- IP test: 4211 serves a verified local immutable Web release and SPA fallback; browser calls 4210 under exact-origin CORS.
- Domain: one HTTPS origin serves Web and proxies `/v1/` to localhost:4210; Secure Cookie is mandatory.
- Web release tool can stage the same content-addressed release locally after OSS verification.

- [ ] **Step 1: Write failing Nginx route tests**

Assert `/skills/*`, `/submissions/*` and `/admin/*` fall back to current `index.html`; `/assets/*` is immutable; dotfiles/private/data/env paths are denied; IP config listens only on 4211; domain config redirects HTTP to HTTPS and proxies `/v1/` without rewriting Cookie security.

- [ ] **Step 2: Extend release tests for a local atomic stage**

Build a fixture release, copy it to `/srv/ruying-skill-market/web/releases/<release>`, verify hashes against manifest, atomically replace the `current` symlink and leave the previous release intact. A partial/hash-mismatched stage must not move the symlink.

- [ ] **Step 3: Implement internal HTTP OSS endpoint only behind an explicit release flag**

The provided test OSS endpoint is HTTP. Extend release/server config to accept it only when `SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP=true`, reject embedded credentials, and document that the flag is forbidden in domain/production mode. Keep public content URLs HTTPS unless the approved IP-test public URL is an RFC1918 origin under its own explicit flag.

- [ ] **Step 4: Implement safe Nginx caching and headers**

HTML uses no-cache/short cache; hashed assets immutable; add CSP, `frame-ancestors 'none'`, `nosniff`, referrer policy and no directory listing. Raise request body limit above the application ZIP limit only on control routes in the future domain config; backend remains authoritative.

- [ ] **Step 5: Test/build and commit**

```bash
cd packages/skill-market-web
bun test script/release.test.ts
bun run build
cd ../skill-market-server
bun test deploy/nginx.test.ts
git add deploy/nginx-ip-test.conf deploy/nginx-domain.conf.example deploy/nginx.test.ts ../skill-market-web/script/release.ts ../skill-market-web/script/release.test.ts
git commit -m "chore(skill-market): stage market web"
```

### Task 5: Write the least-privilege OSS and server provisioning runbook

**Files:**
- Create: `packages/skill-market-server/deploy/oss-policy-public-read.json`
- Create: `packages/skill-market-server/deploy/oss-policy-service.json`
- Create: `packages/skill-market-server/deploy/README.md`

- [ ] **Step 1: Define public and service policy documents with variables only**

Public policy permits `GetObject` only for published Web/catalog/package/icon prefixes. Service policy permits required get/put/head/copy/delete/list constrained to the exact public test and private test prefixes. Never include account IDs, real bucket credentials or a broad bucket wildcard without prefix conditions.

- [ ] **Step 2: Document the target filesystem and identities**

Use this exact layout:

```text
/srv/ruying-skill-market/releases/<git-sha>/       root:root 0755
/srv/ruying-skill-market/current -> releases/<git-sha> root-owned symlink
/srv/ruying-skill-market/web/releases/<release>/  root:root 0755
/srv/ruying-skill-market/web/current -> releases/<release> root-owned symlink
/var/lib/ruying-skill-market/                      ruying-market 0700
/var/backups/ruying-skill-market/                  ruying-market 0700
/etc/ruying-skill-market/market.env                root:ruying-market 0640
```

Create `ruying-market` as a system user with no login shell, no home and no sudo. Release directories are not writable by the service user.

- [ ] **Step 3: Document proxy configuration without embedding the upstream secret**

Install Privoxy bound to `127.0.0.1:8118` and forward outbound HTTPS through the approved SOCKS5 proxy. Put exact SOCKS endpoint in root-managed host config, not the repo. Set `HTTPS_PROXY=http://127.0.0.1:8118` and a precise `NO_PROXY` covering localhost, the target host, OSS and internal SSO/provisioning hosts.

- [ ] **Step 4: Document secret installation and rotation**

Use a temporary root-only transfer or interactive editor to create `market.env`; validate mode/ownership before start. Do not copy a developer `.env`. Require scoped service AK/SK rotation before production and after personnel/tool exposure; revoke the old key only after the new key passes the private canary and catalog read tests.

- [ ] **Step 5: Document bootstrap Admin and first-login recovery**

Configure only employee IDs in `SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS`. Verify the audit bootstrap event and first SSO login, then retain the env value only as documented break-glass input; it must not re-grant roles once an Admin exists.

- [ ] **Step 6: Validate policy JSON/runbook and commit**

```bash
python3 -m json.tool packages/skill-market-server/deploy/oss-policy-public-read.json >/dev/null
python3 -m json.tool packages/skill-market-server/deploy/oss-policy-service.json >/dev/null
rg -n "AccessKey|Secret|password|root@|10\.[0-9]+\.[0-9]+\.[0-9]+" packages/skill-market-server/deploy
```

Expected: JSON is valid; searches show only explanatory/redacted terms, no live credentials or target login data.

```bash
git add packages/skill-market-server/deploy
git commit -m "docs(skill-market): add deployment runbook"
```

### Task 6: Build and install a reproducible test-server release

**Files:**
- Verify: repository lockfile and package manifests
- Create on target: filesystem layout from the runbook
- Install on target: systemd/Nginx/env files

- [ ] **Step 1: Record local source identity and verify a clean intended diff**

```bash
git rev-parse HEAD
git status --short
git diff --check
```

Record the full commit SHA. Exclude `.git`, `.codegraph`, `.superpowers/brainstorm`, local caches, `.env`, DB files and build outputs from the deployment archive.

- [ ] **Step 2: Run all local build gates before transfer**

```bash
cd packages/schema && bun test && bun typecheck
cd ../protocol && bun test && bun typecheck
cd ../client && bun run generate && git diff --exit-code -- src/generated src/generated-effect && bun typecheck
cd ../skill-market-server && bun test && bun typecheck
cd ../skill-market-web && bun test && bun typecheck && bun run build && bun run test:e2e
cd ../app && bun test src/skill-market && bun test src/pages/skill-market.test.tsx && bun typecheck
```

Expected: every command exits 0 before any target mutation.

- [ ] **Step 3: Provision the target as root, then stop using root for runtime**

Create the system user/directories, install Bun/zstd/Nginx/Privoxy, install the root-owned release, place the root-managed env, and run `deploy-check preflight` as `ruying-market`. Do not grant the service user ownership of source/release/unit/Nginx files.

- [ ] **Step 4: Create a pre-migration backup and migrate without listening**

If a DB exists, stop API/worker timers, run the backup command and verify its local + OSS result. Invoke a migration-only/preflight start and run `PRAGMA integrity_check`, `foreign_key_check` and `user_version`. Start no HTTP service when migration fails.

- [ ] **Step 5: Install units and start in dependency order**

Run daemon reload and verify all units, then start API, check readiness, stage/switch Web, start worker/sync timers, then backup/cleanup/restore timers. Keep the previous API and Web symlinks recorded for rollback.

- [ ] **Step 6: Verify deployed source matches the recorded commit**

Store a `RELEASE.json` containing commit SHA, build time and Web release ID but no secrets. Compare it with local `git rev-parse HEAD`, inspect package checksums and record the result in the deployment log.

### Task 7: Configure OSS permissions and seed the empty control plane safely

**Files:**
- Apply externally: public read and service policies
- Verify externally: exact test prefixes

- [ ] **Step 1: Inspect existing bucket policy before changing it**

Export the current policy to a protected operator location and identify any rule that makes `skill-market-private-test/` readable or listable. Do not replace unrelated bucket policy statements.

- [ ] **Step 2: Apply additive least-privilege service access**

Grant the deployment identity only the policy actions/prefixes in the reviewed service policy. Verify it cannot read/write outside those prefixes with negative canary tests.

- [ ] **Step 3: Apply public read only to release objects**

Allow anonymous GET for Web/catalog/community package/icon objects needed by the product. Deny anonymous private GET and bucket listing. Validate one public object succeeds and a randomized private object returns 403/404.

- [ ] **Step 4: Run private canary and first backup**

As `ruying-market`, run `deploy-check smoke --allow-private-canary`, then create the initial empty/control DB backup. Confirm the compressed backup exists under the private prefix and is not anonymously readable.

- [ ] **Step 5: Verify bootstrap Admin is idempotent**

Start twice and assert only one role assignment exists and audit contains one bootstrap event. Do not test with a real Admin password/token in logs; complete SSO interactively in the browser later.

### Task 8: Perform IP-stage functional, security, and recovery acceptance

**Files:**
- Verify externally: `http://<server-ip>:4211/ai-coding/ruying-code/skill-market/skills`
- Verify externally: `http://<server-ip>:4210`

- [ ] **Step 1: Run anonymous catalog/Web smoke checks**

Verify `/skills`, SkillHub, enterprise and community filters; direct detail refresh; HEAD/OPTIONS; public CORS; hashed assets; 404 behavior and no private/admin payload in anonymous responses.

- [ ] **Step 2: Run real SSO and session checks interactively**

From the IP Web, login through GWM SSO, verify return to `/submissions`, compact identity layout, refresh persistence, logout, expired-session handling and attempt replay failure. Browser devtools must show no SSO token or AI key in storage/URLs after callback.

- [ ] **Step 3: Run the full submission/review journey with two test employees**

Submit valid and invalid ZIPs; verify validation; request changes; revise; reject; approve a non-self submission; publish; submit a higher version while old remains public; verify self-review and unauthorized admin routes fail.

- [ ] **Step 4: Run failure and recovery drills**

Induce a safe test failure before pointer update and verify old catalog remains. Stop the API during a pending job, restart and verify recovery. Run concurrent Reviewer decisions, a manual backup, a restore drill and an eligible quarantine cleanup dry-run.

- [ ] **Step 5: Verify system and secret posture**

Check unit sandboxing, file ownership/modes, listening ports, no service sudo/login shell, journal redaction, private OSS anonymity denial, exact service prefix denial outside scope, timer status and disk usage.

- [ ] **Step 6: Record acceptance without sensitive material**

Record timestamp, release SHA/Web ID, route/status, catalog revision, test submission IDs and PASS/FAIL. Redact employee IDs, cookies, tokens, full object keys, OSS credentials and proxy credentials.

### Task 9: Prove rollback and document formal-domain cutover

**Files:**
- Modify: `packages/skill-market-server/deploy/README.md`

- [ ] **Step 1: Exercise code/Web rollback**

Switch API and Web `current` symlinks to the previous known-good release, restart/reload, run smoke checks, then return to the candidate release. No database restore is needed when migrations are backward compatible.

- [ ] **Step 2: Exercise data rollback only in a maintenance rehearsal**

Stop all writers, save the broken DB, restore the verified pre-migration backup to a new path, run integrity/foreign-key/schema checks, atomically switch the DB file, start the prior compatible release and smoke test. Never overwrite the sole live DB or delete the failed copy.

- [ ] **Step 3: Document catalog/Web OSS pointer rollback**

Validate target immutable revision/release and every referenced object, then move only `current.json`. Confirm revision headers and a community download. Do not delete newer immutable objects during rollback.

- [ ] **Step 4: Add the formal-domain checklist**

Require DNS/certificate, same-origin Web + `/v1`, exact production Origin, removal of IP insecure Cookie/OSS/public URL flags, `__Host-ruying_market_session` Secure Cookie, HSTS after validation, updated SSO callback allowlist and desktop submission URL rebuild.

- [ ] **Step 5: Run final repository hygiene and commit the handoff**

```bash
git diff --check
rg -n "TO[D]O|FIXM[E]|T[B]D|AccessKey ID|AccessKey Secret|password" packages/skill-market-server/deploy packages/skill-market-server/script
git status --short
```

Expected: no placeholders or credentials; only intended tracked changes plus pre-existing untracked directories.

```bash
git add packages/skill-market-server/deploy/README.md
git commit -m "docs(skill-market): document production cutover"
```
