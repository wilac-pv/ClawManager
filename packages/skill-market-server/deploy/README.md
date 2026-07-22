# Ruying Skill Market deployment

This directory contains the IP-test and future-domain deployment assets for the
Ruying Skill Market. The runtime is intentionally split into a root-owned
immutable release and a low-privilege `ruying-market` service identity.

## Security boundaries

- Public objects use `ai-coding/ruying-code/skill-market-test/`.
- Private uploads and backups use the separate
  `ai-coding/ruying-code/skill-market-private-test/` prefix.
- Never place private content below the public prefix or grant anonymous bucket
  listing.
- Install credentials only through the root-managed environment file. Do not
  copy a developer `.env` or place credentials in a command line, unit, archive,
  shell history, or deployment log.
- The supplied test credential must be replaced with a prefix-scoped service
  identity before production and rotated after the deployment session.
- The HTTP flags are for the private-IP test stage only. All three must be
  removed or set to `false` for the formal domain.

## Filesystem and identity

Use this layout exactly:

```text
/srv/ruying-skill-market/releases/<git-sha>/       root:root 0755
/srv/ruying-skill-market/current -> releases/<git-sha> root-owned symlink
/srv/ruying-skill-market/web/releases/<release>/  root:root 0755
/srv/ruying-skill-market/web/current -> releases/<release> root-owned symlink
/var/lib/ruying-skill-market/                      ruying-market 0700
/var/backups/ruying-skill-market/                  ruying-market 0700
/etc/ruying-skill-market/market.env                root:ruying-market 0640
```

Provision the service identity once:

```bash
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ruying-market
install -d -o root -g root -m 0755 /srv/ruying-skill-market/releases /srv/ruying-skill-market/web/releases
install -d -o ruying-market -g ruying-market -m 0700 /var/lib/ruying-skill-market
install -d -o ruying-market -g ruying-market -m 0700 /var/backups/ruying-skill-market
install -d -o root -g ruying-market -m 0750 /etc/ruying-skill-market
```

The service identity has no login shell, home, sudo rule, or write permission to
release, systemd, or Nginx files.

## Host dependencies and proxy

Install Bun at `/usr/local/bin/bun`, plus `zstd`, `nginx`, `privoxy`, `curl`,
`sqlite3`, and `util-linux` (`flock`). Confirm versions before installing units.

When direct external access is unavailable, bind Privoxy only to
`127.0.0.1:8118` and configure its root-owned host file to forward through the
approved SOCKS5 endpoint. The endpoint belongs in host configuration, not this
repository. Configure the service environment with:

```text
HTTPS_PROXY=http://127.0.0.1:8118
NO_PROXY=127.0.0.1,localhost,<server-host>,<oss-host>,<sso-host>,<provisioning-host>,.internal
```

Keep OSS, SSO, provisioning, localhost, and internal networks on direct routes.
Test both the proxied SkillHub request and every `NO_PROXY` dependency before
starting synchronization.

## OSS policy

Review the existing bucket policy before changing it and save a protected copy
outside the release. Replace only `${bucket}` and `${service_principal}` in the
policy templates:

- `oss-policy-public-read.json` grants anonymous `GetObject` only to current
  catalog, immutable indexes, packages, icons, and Web releases.
- `oss-policy-service.json` grants object operations on the two exact test
  prefixes and constrains bucket listing using `oss:Prefix`.

Apply these statements additively; do not replace unrelated bucket policy
statements. Verify four negative cases after applying them:

1. anonymous bucket listing is denied;
2. anonymous private object reads are denied;
3. the service identity cannot read or write an unrelated prefix;
4. the service identity cannot list outside the two approved roots.

`HeadObject` is authorized by `oss:GetObject`; copy requires read access to the
source and write access to the destination.

## Install the environment

Copy `ruying-skill-market.env.example` to a temporary root-only location, fill it
interactively, then install it without printing its contents:

```bash
install -o root -g ruying-market -m 0640 <root-only-market-env> /etc/ruying-skill-market/market.env
stat -c '%U %G %a %n' /etc/ruying-skill-market/market.env
```

For private-IP testing, use these explicit exceptions:

```text
SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP=true
SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP=true
SKILL_MARKET_ALLOW_INSECURE_IP_HTTP=true
SKILL_MARKET_WEB_ORIGIN=http://<server-ip>:4211
SKILL_MARKET_API_PUBLIC_URL=http://<server-ip>:4211
SKILL_MARKET_PUBLIC_BASE_URL=http://<server-ip>:4211/market-objects/
```

The OSS endpoint may be internal HTTP only while the first flag is enabled. The
public content URL must still use the private server IP. Before installing the IP
Nginx config, replace `oss-public-origin.invalid` and `bucket` in the read-only
`/market-objects/` proxy target with the internal OSS host and bucket. The target
path must end at the exact public test prefix. Run `nginx -t` after rendering.
The same gateway proxies `/v1/` to loopback port `4210`; direct `4210` remains
available for desktop compatibility and service probes.

Do not enable an HTTP public URL for a hostname or public address. The application
rejects that configuration even when the flag is set.

## SkillHub mirror controls

The `ruying-skill-market-skillhub.timer` starts two minutes after boot and then
runs once per minute. It shares `/run/lock/ruying-skill-market-ops.lock` with
community publication, cleanup, and legacy synchronization so only one catalog
writer can run at a time. The service runs Bun in small-heap mode and is bounded
by `MemoryHigh=1536M`, `MemoryMax=2048M`, and a two-minute start timeout so a
large catalog publication cannot exhaust the host.

Use the six resource controls in the environment file at their design defaults
unless a measured operational need requires adjustment:

| Variable | Default | Bound |
| --- | ---: | --- |
| `SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY` | `4` | maximum `16` |
| `SKILL_MARKET_SKILLHUB_METADATA_CONCURRENCY` | `8` | maximum `32` |
| `SKILL_MARKET_SKILLHUB_PACKAGE_CONCURRENCY` | `6` | maximum `12` |
| `SKILL_MARKET_SKILLHUB_PUBLISH_BATCH` | `2000` | positive integer |
| `SKILL_MARKET_SKILLHUB_PUBLISH_MINUTES` | `30` | positive integer |
| `SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB` | `1536` | minimum `512` MiB |

`SKILL_MARKET_SKILLHUB_LIMIT=30` is an emergency canary override only. Omit it
from every production full-mirror environment. Preflight prints only these
numeric values and validates that both database and migration-backup directories
are writable; it never prints environment values or secrets.

## TRACE evaluation controls

The `ruying-skill-market-evaluation.timer` starts one minute after boot and then
runs once a minute. It uses a dedicated lock so a prior evaluation run causes a
later invocation to exit cleanly, without blocking the independent SkillHub
mirror. The service is constrained to `MemoryHigh=896M`, `MemoryMax=1024M`,
`TimeoutStartSec=90s`, and `TimeoutStopSec=10s`; it can write only the market
data, backup, and lock directories.

Use these canonical environment settings:

```dotenv
SKILL_MARKET_EVALUATION_CONCURRENCY=2
SKILL_MARKET_EVALUATION_REQUESTS_PER_MINUTE=60
SKILL_MARKET_EVALUATION_REFRESH_DAYS=7
SKILL_MARKET_EVALUATION_PUBLISH_BATCH=100
```

The publication batch must stay in the range `1..100`; the delta publisher
enforces the same limit independently of environment parsing.

The older `SKILL_MARKET_SKILLHUB_EVALUATION_*` names remain accepted while hosts
roll forward, but the canonical value wins if both are present. Preflight emits
only the resulting numeric values, never environment values or secrets.

If a bounded evaluation run is killed or times out before it persists a catalog
target revision, its completed evaluation rows remain retryable: the transient
catalog job is retired and the next bounded run selects those rows again. If a
target revision already exists, do not clear its lease manually: expiry recovery
checks the catalog pointer, finalizes only a matching publication, and retires
a mismatch so the completed evaluation rows are selected again by a later run.

After an abnormal memory or IO event, leave both
`ruying-skill-market-evaluation.timer` and
`ruying-skill-market-worker.timer` disabled. Run one evaluation service manually
and require it to finish within its limit with memory below `1024M`, no sustained
swap or IO-wait growth, and no pending or running target-less catalog job before
enabling either timer.

## Bootstrap Admin

Set `SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS` to employee IDs only. On an empty
database, start once and verify a single bootstrap role assignment and audit
event. Complete the first SSO login in a browser. Starting again must not create
another assignment or audit event.

After a working Admin exists, retain the value only as documented break-glass
input. Bootstrap does not re-grant roles after the database already contains an
Admin.

## Build and transfer a release

Build from a clean, committed checkout. Do not deploy a source archive or use
`git archive`: transfer only the prebuilt immutable release output, which
contains the generated Bun JavaScript entrypoints.
Run `bun run build:release <output-directory>` before any transfer.

```bash
test -z "$(git status --porcelain)"
release_commit=$(git rev-parse HEAD)
release_output=/tmp/ruying-skill-market-${release_commit}
bun run build:release "$release_output"
printf '{"commit":"%s","builtAt":"%s"}\n' "$release_commit" "$(date -u +%FT%TZ)" > "$release_output/RELEASE.json"
test -s "$release_output/RELEASE.json"
test -f "$release_output/packages/skill-market-server/package.json"
test -s "$release_output/packages/skill-market-server/src/skillhub-worker.js"
test -s "$release_output/packages/skill-market-server/src/skillhub-evaluation-worker.js"
```

Transfer exactly `$release_output` and its `RELEASE.json`, then install that
verified directory as `root:root 0755` under
`/srv/ruying-skill-market/releases/<git-sha>`. Do not rebuild or install
dependencies on the host; the service user never receives write permission to a
release.

The immutable server runtime includes bundled server, sync, durable worker,
SkillHub mirror, and TRACE evaluation entrypoints. The SkillHub units run the
bundled `src/skillhub-worker.js` and `src/skillhub-evaluation-worker.js`
entrypoints; the evaluation worker uses Bun's `--smol` mode to keep catalog
parsing below its cgroup limit. Do not substitute source `.ts` paths.

## Preflight and initial migration

Before mutation, run the read-only checks as the service identity:

```bash
sudo -u ruying-market /bin/bash -c '
  set -a
  . /etc/ruying-skill-market/market.env
  set +a
  cd /srv/ruying-skill-market/current/packages/skill-market-server
  exec /usr/local/bin/bun script/deploy-check.ts preflight
'
```

Resolve every `FAIL`. An unreachable optional proxy may be `SKIP` only when all
external dependencies are directly reachable. `sudo` changes to the service
identity before the group-readable environment file is sourced; do not use
`cat`, `env`, shell tracing, or a command that prints the loaded values.

If a database exists, record active timers, then stop every writer timer before
the backup or migration. Wait for an already-running oneshot writer to finish,
stop the API service, and confirm it is inactive before mutating data:

```bash
writer_timers=(
  ruying-skill-market-worker.timer ruying-skill-market-sync.timer ruying-skill-market-skillhub.timer
  ruying-skill-market-evaluation.timer ruying-skill-market-cleanup.timer ruying-skill-market-backup.timer
  ruying-skill-market-restore-drill.timer
)
active_timers=()
for timer in "${writer_timers[@]}"; do systemctl is-active --quiet "$timer" && active_timers+=("$timer"); done
systemctl stop "${writer_timers[@]}"
while systemctl is-active --quiet ruying-skill-market-worker.service || \
  systemctl is-active --quiet ruying-skill-market-sync.service || \
  systemctl is-active --quiet ruying-skill-market-skillhub.service || \
  systemctl is-active --quiet ruying-skill-market-evaluation.service || \
  systemctl is-active --quiet ruying-skill-market-cleanup.service || \
  systemctl is-active --quiet ruying-skill-market-backup.service || \
  systemctl is-active --quiet ruying-skill-market-restore-drill.service; do sleep 1; done
systemctl stop ruying-skill-market.service
! systemctl is-active --quiet ruying-skill-market.service
```

Create a verified local and OSS backup and record its non-sensitive identity.
Switch the code symlink only after the backup succeeds. Run migration without
exposing the HTTP port, then verify:

```bash
sudo -u ruying-market /bin/bash -c '
  set -a
  . /etc/ruying-skill-market/market.env
  set +a
  cd /srv/ruying-skill-market/current/packages/skill-market-server
  exec /usr/local/bin/bun script/migrate.ts
'
```

```text
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA user_version;
```

Never continue after a failed migration. After a successful migration, start the
API service and run the smoke checks. Only then restore the timers recorded as
active before the quiescence procedure; do not enable a timer that was
intentionally inactive. Keep the same root shell open for the recorded timer
array:

```bash
systemctl start ruying-skill-market.service
# Run smoke in this shell, then resume only the recorded active timers.
((${#active_timers[@]})) && systemctl start "${active_timers[@]}"
```

## Install systemd and Nginx

Install the units under `/etc/systemd/system/`, then verify before enabling:

```bash
systemd-analyze verify /etc/systemd/system/ruying-skill-market*.service /etc/systemd/system/ruying-skill-market*.timer
systemctl daemon-reload
```

Install the rendered IP Nginx configuration, run `nginx -t`, and reload Nginx.
Start in this order:

1. API service;
2. `/health` readiness check;
3. verified Web release and `web/current` symlink;
4. for an empty OSS prefix, run `ruying-skill-market-sync.service` once and
   require a non-empty 2xx catalog response;
5. HTTP smoke and private OSS canary;
6. worker, sync, SkillHub mirror, and TRACE evaluation timers;
7. backup, cleanup, and restore-drill timers.

Do not treat a `503` catalog response as a CORS failure during first install.
The API cannot serve a catalog until the initial synchronization has published
and verified `current.json` plus its immutable snapshot objects. Keep the prior
sync timer stopped while initializing a replacement prefix so it cannot move
the new pointer with incompatible output.

Record the previous API and Web symlink targets before switching them.

## Smoke and canary

Run the HTTP checks after the API and Web are reachable:

```bash
sudo -u ruying-market /bin/bash -c '
  set -a
  . /etc/ruying-skill-market/market.env
  set +a
  cd /srv/ruying-skill-market/current/packages/skill-market-server
  exec /usr/local/bin/bun script/deploy-check.ts smoke
'
```

Ordinary smoke is read-only and does not replace the private canary. During an
explicit deployment window only, run the separate private canary command with
the same service identity, environment-file loading, and release working
directory:

```bash
sudo -u ruying-market /bin/bash -c '
  set -a
  . /etc/ruying-skill-market/market.env
  set +a
  cd /srv/ruying-skill-market/current/packages/skill-market-server
  exec /usr/local/bin/bun script/deploy-check.ts smoke --allow-private-canary
'
```

The private canary is allowed only below the private `canary/` directory. It
writes, reads, verifies, and deletes the object; it then uses a post-delete
404/absence check to confirm it is absent. Then run an initial database backup
and confirm that it is not anonymously readable.

## Upgrade and code rollback

For an upgrade, install a new immutable release, run preflight, pause timers,
back up the database, migrate, atomically change `current`, restart, run smoke,
then resume timers. Keep previous releases and backups.

The generic `ruying-skill-market-sync.timer` still exists for manual recovery
and initial-prefix bootstrap, but it loads a complete catalog snapshot. Keep it
disabled after the durable SkillHub mirror has been installed. Enable only the
bounded SkillHub timer for normal operation:

```bash
systemctl disable --now ruying-skill-market-sync.timer
systemctl daemon-reload
systemctl enable --now ruying-skill-market-skillhub.timer
```

Enable the independent TRACE evaluation timer only after the API release has
migrated successfully and a manual bounded run has passed following any
memory/IO incident:

```bash
systemctl daemon-reload
systemctl enable --now ruying-skill-market-evaluation.timer
```

Production must verify `systemctl list-timers --all` shows the dedicated
SkillHub mirror and TRACE evaluation timers and does not show the generic sync
timer before resuming the other writers.

If health or smoke fails, restore the previous API and Web symlink targets and
restart/reload. Do not delete the candidate release. No database restore is
needed for a backward-compatible migration.

For a data rollback rehearsal, stop every writer, preserve the failed database,
restore the verified backup to a new path, run integrity, foreign-key, and schema
checks, then atomically switch files and start the compatible prior release.
Never overwrite the only live database or delete the failed copy.

Catalog and Web OSS rollback changes only the reviewed `current.json` pointer
after validating every immutable object referenced by the target release.

## Secret rotation and incident response

Install the new scoped key in the root-managed environment, run the private
canary and catalog read checks, restart services, and only then revoke the old
key. Inspect journal output for names and status only; authentication response
bodies and environment values must never be logged.

If private objects become anonymously readable, stop publication and upload,
remove the offending public statement, rotate the service key, audit object
access, and verify the exact public/private prefix boundary before resuming.
