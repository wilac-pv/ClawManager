# Role Preassignment Design

## Context

Production has one `users` row, one Admin assignment, and no Reviewer
assignments. `Moderation.assignRole(...)` currently rejects an employee ID that
does not already exist in `users`. A user row is normally created only after
the employee completes the first SSO login, so an Admin cannot grant access in
advance.

The failed response groups invalid input, an unknown user, and a duplicate role
under the same message, `角色分配请求无效`. The returned request ID is not present
in the service journal, so it cannot identify which business guard rejected the
request.

## Goals

- Allow an Admin to assign Reviewer or Admin before the employee's first login.
- Preserve employee ID schema validation, Admin authorization, Origin and CSRF
  protection, atomic role assignment, and append-only auditing.
- Let the first successful SSO login replace the placeholder display name with
  the trusted provisioning identity.
- Keep duplicate assignment idempotency explicit to the operator without
  changing the public role assignment success schema.
- Keep final-Admin removal protection unchanged.

## Non-goals

- Do not invent or expose an employee-directory lookup endpoint.
- Do not accept names, email addresses, or role values from outside the
  existing `RoleInput` schema.
- Do not grant a role when the request fails validation or authorization.
- Do not alter disabled-user login behavior.

## Design

`Moderation.assignRole(...)` keeps the existing schema and Admin checks. Inside
its existing database transaction it first inserts a placeholder user:

- `employee_id`: the validated employee ID;
- `display_name`: the same employee ID;
- `created_at` and `last_login_at`: the assignment timestamp.

The insert uses `ON CONFLICT(employee_id) DO NOTHING`, so it never overwrites an
existing trusted display name, email address, login timestamp, or disabled
state. It then performs the existing duplicate-role check, role insert, audit
insert, and assignment read in the same transaction.

If the role insert or audit insert fails, the placeholder insert rolls back
with the transaction. A duplicate assignment also rolls back a newly attempted
placeholder insert and returns a specific operator-facing message that the
employee already has the selected role.

The existing SSO callback remains the authority for identity display data. Its
`INSERT ... ON CONFLICT DO UPDATE` path replaces the placeholder display name
and `last_login_at` after trusted provisioning succeeds. The preassigned role
is then included in the new session.

## Security and audit

Only a current Admin with a valid session, exact Origin, and CSRF token may
create the placeholder and role. Employee IDs remain limited to the existing
64-character safe pattern.

The audit event remains `role-assigned`, uses the acting Admin as
`actor_employee_id`, and records only the target employee ID and role. No SSO
token, session token, CSRF value, employee-directory response, or secret is
logged.

The API continues returning bounded problems with a request ID. Duplicate
assignment receives a specific safe message; malformed input remains a generic
invalid role request. Dependency and authorization failures retain their
existing mappings.

## Testing

Add moderation tests that prove:

- assigning a role to a missing employee creates one placeholder and one role
  atomically;
- the role assignment response contains the placeholder identity;
- a duplicate assignment creates no extra user, role, or audit event and
  returns the duplicate reason;
- an invalid employee ID creates nothing;
- an existing disabled or fully provisioned user is not overwritten.

Add authentication coverage that preassigns a placeholder role, completes SSO
for that employee, and proves the trusted display name replaces the placeholder
while the role appears in the session.

Add HTTP coverage for a successful preassignment and the safe duplicate
message. Run the full server tests and `bun typecheck` from
`packages/skill-market-server`.
