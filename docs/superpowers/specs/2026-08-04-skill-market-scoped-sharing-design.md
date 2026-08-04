# Skill Market Scoped Sharing, Lifecycle, and Typography Design

**Date:** 2026-08-04
**Status:** Approved
**Target:** Ruying SkillHub Web and `skill-market-server`

## Summary

Ruying SkillHub currently supports two upload targets: a private personal space and the company market. Personal packages are deliberately owner-only, while company submissions pass security scanning and manual review before entering the existing public company catalog.

This design adds two intermediate sharing scopes—SSO department and reusable custom groups—without weakening personal isolation or exposing private OSS objects. It also adds missing personal deletion, submission withdrawal, delisting requests, and a consistent Chinese typography system across the Web application.

The selected model is a constrained, unified publication-audience model rather than duplicated per-group publications or a general-purpose ACL engine.

## Goals

- Let a Skill be available only to its owner, one SSO department, one or more custom groups, or the whole company.
- Keep company catalog access compatible with the current intranet, anonymous-read client flow.
- Require SSO authorization for personal, department, and group content.
- Require manual review for every publication that another employee can use.
- Let personal Skill owners promote an already uploaded package to a shared scope without re-uploading it.
- Let users delete and restore personal Skills, withdraw unfinished submissions, and request delisting of published content.
- Make group membership reusable, auditable, cross-department, and independent of whether an employee has logged in before.
- Apply one Chinese-first typography system across all SkillHub pages and controls.

## Non-goals

- Public internet sharing or permanent unauthenticated links to private packages.
- Automatic synchronization with a company group or project-team directory.
- A general resource-policy language or arbitrary per-resource ACL expressions.
- Allowing ordinary group members to manage membership or publish on behalf of a group.
- Publishing one submission simultaneously to different scope kinds. A group-scoped publication may target multiple groups, but a submission is otherwise exactly one of personal, department, groups, or company.

## Current State

- SSO provisioning already accepts and persists trusted `departmentId` and `departmentName` values.
- Users without department identity can log in, use personal space, and publish company content.
- Submission scope currently supports only `personal` and `company`.
- A published personal package is selected by submission ID plus owner employee ID. Other users, including reviewers, receive `404`.
- Company content is published to the existing company catalog and public OSS prefix.
- Department and group catalog authorization, group membership, personal trash, withdrawal, and delisting requests do not exist.

## Publication Scopes

Each submission selects one scope kind. Group scope may select multiple active groups.

| Scope | Audience | Review | Storage and delivery |
|---|---|---|---|
| Personal | Owner only | No; scanning success activates it | Private OSS; authenticated owner API |
| Groups | Owner plus current members of any selected group | Yes | Private OSS; authenticated restricted catalog API |
| Department | Employees whose current trusted SSO department matches the target | Yes | Private OSS; authenticated restricted catalog API |
| Company | Any user on the company network | Yes | Existing company catalog and public OSS delivery |

### Authorization rules

- Department authorization uses the stable department ID, never a display name or browser-provided identity.
- A normal user may target only the department in the current SSO session. An administrator may manage any synchronized department through the administration boundary.
- On an employee's next successful login after a transfer, access follows the new department immediately and access to the former department is lost.
- A group may include employees from any department.
- Group audience is a live union. Membership in any selected active group grants access.
- Removing a member or disabling a group revokes list, search, detail, version, install-grant, GET, and HEAD access immediately.
- Unauthorized direct reads return `404` so they do not disclose resource existence.
- Administrators inspect all scopes through administration endpoints. The normal market remains filtered to the current principal.
- Company catalog reads remain compatible with anonymous intranet access. Every other scope requires a valid SSO session.

## Custom Groups

### Model

A custom group has a stable ID, name, optional description, owner employee ID, active or disabled status, timestamps, and an audit history. Membership stores employee IDs directly and does not require a foreign key to an existing market user. This permits adding an employee before their first SkillHub login.

When a pending member first logs in, the existing SSO identity flow supplies the employee's name and department for display. Authorization continues to use the stable employee ID.

### Permissions

- The creator becomes group owner and a member automatically.
- The owner may edit metadata, add or remove members, transfer ownership, and disable or restore the group.
- The owner cannot remove themselves until ownership has been transferred.
- Administrators may manage every group and repair ownership.
- Ordinary members may view and use group Skills but cannot manage membership or submit on behalf of the group.
- Only the group owner or an administrator may select a group as a publication target.
- Group membership changes do not trigger content review, but every change is audited.
- Disabling a group immediately revokes its audience contribution and prevents new targeting. The group is soft-disabled rather than physically deleted.

## Submission, Review, and Publication

### New submission

1. The form submits one scope kind and its required target data.
2. The server validates target authority before accepting package metadata.
3. Every package enters quarantine, validation, and security scanning.
4. A clean personal submission becomes active immediately.
5. A clean department, group, or company submission enters the manual review queue.
6. The review page displays scope, department, and every target group alongside scan evidence.
7. Approval publishes company content through the existing public publisher. Department and group approval creates or updates a restricted publication backed by private OSS.

Personal submissions never enter the review queue. Moderation queries include company, department, and group submissions and exclude personal submissions.

### Promote a personal Skill

A published personal Skill provides a **发布给其他人** action. The owner chooses department, one or more owned groups, or company. The server creates a separate sharing submission that references the verified private package and metadata, reruns validation and security scanning, and then follows manual review. No re-upload is required.

The original personal Skill remains usable regardless of the sharing request outcome. Rejection or withdrawal of the sharing request does not delete or alter the personal copy.

### Audience changes

Changing the department or adding/removing target groups creates an audience-change review. Approval atomically updates the active restricted publication audience. Group membership changes remain immediate and do not require content review.

Changing package content requires a new version, a new scan, and manual review for all non-personal scopes.

## Private Catalog and Installation

The catalog handler gains an optional-session boundary. Anonymous callers receive only company content. Authenticated callers receive company content plus authorized restricted publications. A centralized access policy is used by list, search, detail, versions, install metadata, package GET, and package HEAD handlers so authorization cannot drift between endpoints.

Department and group objects never move into the public OSS prefix and never expose their private object key or a permanent OSS URL.

Browser downloads use the current SSO session. Copying an installation prompt creates a bearer installation grant with these properties:

- bound to one publication and immutable version;
- valid for 10 minutes;
- stored only as a hash with issue and expiry metadata;
- suitable for the bounded GET/HEAD sequence used by installers;
- revocable by publication delisting, group disablement, or audience loss;
- audited by employee, Skill, version, and timestamp without logging plaintext tokens.

Restricted responses use `Cache-Control: private, no-store`. APISIX, Nginx, browser, and shared caches must not cache private catalog bodies or installation grants.

## Personal Skill Deletion and Recovery

- A personal Skill exposes a destructive **删除** action with a confirmation dialog naming the Skill and version.
- Deletion immediately hides the Skill from normal personal lists and rejects detail, download, and install access.
- The item enters a personal trash view for seven days and may be restored by its owner during that interval.
- A scheduled cleanup permanently removes private package, icon, validation artifacts, and recoverable record data after the deadline.
- Audit identity and lifecycle events remain after artifact cleanup.
- Deleting a personal copy never deletes already approved department, group, or company publications. Those require their own delisting lifecycle.

## Submission Withdrawal and Delisting

The owner may withdraw submissions in `validating`, `validation_failed`, `pending_review`, `changes_requested`, or `publish_failed` state.

- Withdrawal changes the status to `withdrawn`, removes the item from moderation, and fences scanner or publisher continuations from promoting it.
- `publishing` cannot be withdrawn because publication ownership may already be active.
- Published content uses a **申请下架** action. An administrator approves the request and atomically removes catalog visibility before scheduling private artifact cleanup where applicable.
- Withdrawn package and icon artifacts remain recoverable for seven days, then are cleaned up. Audit events and non-sensitive submission metadata remain.
- A withdrawn item may prefill a new submission, but the user must upload the package again and it must be scanned again.

## Web Information Architecture

**我的空间** contains these Chinese-only submenus:

- 个人 Skill
- 我的投稿
- 我的小组
- 我的收藏
- 回收站

The group page separates **我管理的小组** and **我加入的小组**. Group detail shows metadata, owner, member list, pending employee IDs, target publications, audit-safe lifecycle information, and management actions appropriate to the principal.

The submission form displays four save-location cards:

- 个人空间
- 指定小组
- 本部门
- 全公司

Selecting group scope displays a multi-select containing only active groups the user owns. Selecting department scope displays the trusted SSO department and does not permit editing it. Users without department identity see the department choice disabled with a clear login or administrator instruction.

## Typography and Visual Consistency

The approved direction is **全中文统一**.

- Remove incidental labels such as `Personal workspace`, `Skill package`, and other English eyebrow text.
- Retain the SkillHub brand and necessary technical names such as API, ZIP, SHA-256, and SemVer.
- Use one system sans-serif stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `PingFang SC`, `Microsoft YaHei`, `Noto Sans CJK SC`, `sans-serif`.
- Define shared tokens for page title, section title, card title, body, secondary text, label, badge, and button typography.
- Make `button`, `input`, `select`, and `textarea` inherit the global font.
- Reserve the monospace stack for commands, code, hashes, and machine identifiers.
- Remove component-local font-family overrides unless they implement the monospace exception.
- Perform page-by-page desktop and mobile visual checks across catalog, detail, submissions, personal space, groups, favorites, announcements, and administration.

## Data Model

The next migration extends the current department and personal-space schema with:

- `market_groups`: group identity, metadata, owner, status, and lifecycle timestamps;
- `market_group_members`: group ID, employee ID, actor, and membership timestamps, without a user foreign key;
- `submission_group_targets`: the reviewed group target set for a submission;
- `submissions.target_department_id`: required only for department scope;
- expanded submission scope and status constraints for `groups`, `department`, and `withdrawn`;
- `restricted_publications`: current private catalog identity, immutable artifact identity, metadata, scope, department, status, and row version;
- `restricted_publication_groups`: the active multi-group target set;
- personal deletion and purge timestamps;
- hashed private installation grants with expiry and bounded delivery state;
- delisting requests and their moderation state.

Relational checks enforce these invariants:

- personal and company scope have neither a department nor group targets;
- department scope has exactly one department and no group targets;
- group scope has at least one group and no department;
- only active groups may be selected for a new submission;
- one active restricted publication has one scope kind at a time;
- public company package identities never reference the private prefix.

## HTTP Boundaries

The typed Protocol and generated Client are extended rather than bypassed with untyped routes. Public API changes require the repository's normal client generation workflow.

New endpoint families cover:

- group list, detail, creation, update, ownership transfer, disable/restore, and member add/remove;
- personal trash list, delete, and restore;
- submission withdrawal, personal promotion, audience-change request, and delisting request;
- restricted catalog reads and installation-grant issuance;
- administrator group management, audience-aware moderation, and delisting approval.

All state-changing endpoints use the existing session, origin, CSRF, idempotency, request-ID, and audit boundaries. Group and publication version fields provide optimistic concurrency; stale writes return `409` rather than overwriting newer state.

## Errors and Security

- Unauthorized private reads: `404`.
- Missing authenticated session: the existing unauthenticated contract.
- Group-management authorization failure where the group is already visible to the principal: `403`.
- Stale group, submission, audience, or deletion state: `409`.
- Invalid target combinations, empty group selection, malformed employee IDs, and unsupported transitions: `400` typed invalid-request response.
- Unavailable private storage or catalog dependency: bounded `502` or `503` responses without object keys or credentials.
- All destructive and audience-changing operations emit audit events with actor, before state, after state, and request ID.
- Private body, token, cookie, OSS credential, and package key values are excluded from logs and audit JSON.

## Concurrency and Background Work

- Scanner completion checks current submission status before applying results. A withdrawn or trashed submission cannot advance.
- Publisher claims include submission version and audience revision. Audience changes cannot race a stale publisher into visibility.
- Group membership authorization is evaluated at request time rather than copied into publication rows.
- Cleanup jobs use claim-and-fence semantics, recheck purge deadlines, and remain idempotent when an item is restored or already removed.
- Delisting removes catalog visibility before object cleanup.

## Testing and Acceptance

### Authorization matrix

Exercise owner, selected-group member, unselected-group member, same-department employee, other-department employee, administrator, reviewer, and anonymous caller across list, search, detail, versions, install grant, GET, and HEAD.

### Lifecycle

- Add and remove group members and verify immediate access changes.
- Transfer group ownership and disable/restore a group.
- Publish to multiple groups and verify union authorization without duplicate catalog cards.
- Simulate an SSO department transfer and verify old access is lost and new access is gained after login.
- Promote a personal package without re-upload and verify a new scan and review.
- Withdraw during validation and pending review and prove no stale worker can publish.
- Reject withdrawal during publishing and route published content to delisting.
- Delete, restore, and purge a personal Skill across the seven-day boundary.
- Expire and revoke private installation grants and verify no private response is cacheable.

### Compatibility and UI

- Anonymous company catalog and existing desktop package delivery remain unchanged.
- Existing personal and company rows migrate without changing visibility.
- Protocol schema and generated Client tests cover every new typed route and union.
- Typography tests verify shared tokens and inherited control fonts.
- Browser tests cover all new actions, keyboard focus, confirmation dialogs, empty/error states, and responsive layouts.
- Desktop and mobile screenshot review covers every top-level page before deployment.

## Rollout

1. Back up and verify the SQLite database and private OSS metadata before migration.
2. Deploy the backward-compatible server schema and group APIs while leaving new UI controls disabled.
3. Run access-matrix and migration verification against controlled accounts from two departments.
4. Deploy the Web release with group, audience, lifecycle, and typography UI.
5. Enable private catalog merging and installation grants after gateway no-cache verification.
6. Monitor authorization denials, withdrawal races, cleanup failures, grant issuance, and private package delivery without logging sensitive values.
7. Keep rollback able to disable new UI and restricted catalog reads without making any private object public.

## Acceptance Criteria

- A personal Skill remains owner-only until a sharing submission is approved.
- One approved Skill may be visible to members of multiple selected groups and to nobody outside their union.
- Department visibility follows the employee's current trusted SSO department.
- Every non-personal publication has a completed manual review.
- Company content remains usable through the existing intranet and desktop flow.
- Personal deletion is immediately effective, recoverable for seven days, and eventually purged.
- Eligible submissions can be withdrawn without later worker or publisher promotion.
- Published content follows an audited delisting request instead of direct withdrawal.
- Private package URLs, tokens, object keys, and content do not leak through catalog responses, logs, caches, or errors.
- All SkillHub pages use the approved Chinese-first typography hierarchy on desktop and mobile.
