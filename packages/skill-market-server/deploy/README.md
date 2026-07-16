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
SKILL_MARKET_API_PUBLIC_URL=http://<server-ip>:4210
SKILL_MARKET_PUBLIC_BASE_URL=http://<server-ip>:4211/market-objects/
```

The OSS endpoint may be internal HTTP only while the first flag is enabled. The
public content URL must still use the private server IP. Before installing the IP
Nginx config, replace `oss-public-origin.invalid` and `bucket` in the read-only
`/market-objects/` proxy target with the internal OSS host and bucket. The target
path must end at the exact public test prefix. Run `nginx -t` after rendering.

Do not enable an HTTP public URL for a hostname or public address. The application
rejects that configuration even when the flag is set.

## Bootstrap Admin

Set `SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS` to employee IDs only. On an empty
database, start once and verify a single bootstrap role assignment and audit
event. Complete the first SSO login in a browser. Starting again must not create
another assignment or audit event.

After a working Admin exists, retain the value only as documented break-glass
input. Bootstrap does not re-grant roles after the database already contains an
Admin.

## Build and transfer a release

Record the source identity and run all repository gates before transfer:

```bash
git rev-parse HEAD
git status --short
git diff --check
```

Create the archive from tracked files only. Exclude `.git`, `.codegraph`,
`.superpowers/brainstorm`, caches, `.env` files, databases, and build output.
Store a `RELEASE.json` beside the release containing only commit SHA, build time,
and Web release ID.

Install the extracted archive as `root:root 0755` under
`/srv/ruying-skill-market/releases/<git-sha>`. Install dependencies without
granting the service user write permission to the release.

## Preflight and initial migration

Before mutation, run the read-only checks as the service identity:

```bash
sudo -u ruying-market /usr/local/bin/bun script/deploy-check.ts preflight
```

Resolve every `FAIL`. An unreachable optional proxy may be `SKIP` only when all
external dependencies are directly reachable.

If a database exists, stop the API and worker/sync timers, create a verified
local and OSS backup, and record its non-sensitive identity. Switch the code
symlink only after the backup succeeds. Run migration without exposing the HTTP
port, then verify:

```bash
sudo -u ruying-market /usr/local/bin/bun script/migrate.ts
```

```text
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA user_version;
```

Never continue after a failed migration.

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
4. worker and sync timers;
5. backup, cleanup, and restore-drill timers.

Record the previous API and Web symlink targets before switching them.

## Smoke and canary

Run the HTTP checks after the API and Web are reachable:

```bash
sudo -u ruying-market /usr/local/bin/bun script/deploy-check.ts smoke
sudo -u ruying-market /usr/local/bin/bun script/deploy-check.ts smoke --allow-private-canary
```

The canary is allowed only below the private `canary/` directory and must be
written, read, verified, deleted, and confirmed absent. Then run an initial
database backup and confirm that it is not anonymously readable.

## Upgrade and code rollback

For an upgrade, install a new immutable release, run preflight, pause timers,
back up the database, migrate, atomically change `current`, restart, run smoke,
then resume timers. Keep previous releases and backups.

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
