# AGENTS.md — Obsidian Core Codex Instructions

This file defines how Codex and other coding agents must operate inside the Obsidian Core repository.

## Mission

Build Obsidian Core as the secure, centralized operating platform for Obsidian Systems. Core is the source of truth for identity, access, customers, employees, stores, districts, quotes, jobs, routes, payments, subscriptions, timekeeping, commissions, reporting, and audit history.

Applications consume Core services. They must not create independent sources of truth or duplicate critical business rules.

## Instruction precedence

Follow instructions in this order:

1. Explicit user instruction for the current task
2. This `AGENTS.md`
3. Repository `README.md`
4. Architecture Decision Records
5. Priority acceptance criteria
6. Existing code conventions

When instructions conflict, stop the conflicting work, document the conflict, and choose the safest interpretation that preserves data, security, and compatibility.

## Mandatory startup procedure

Before changing code:

1. Read `AGENTS.md`.
2. Read the relevant sections of `README.md`.
3. Read `planning/priorities.yml`.
4. Inspect relevant Architecture Decision Records.
5. Inspect existing implementation, tests, migrations, and API contracts.
6. Check the current Git status and do not overwrite unrelated changes.
7. Identify the exact acceptance criteria to be satisfied.

Do not begin with assumptions that can be resolved from repository content.

## Priority behavior

When asked to **Build priority parts**:

1. Select the lowest-numbered/highest-priority item with `status: ready`.
2. Confirm all dependencies are `done`.
3. Change its status to `in_progress` before substantive implementation.
4. Implement only that priority and necessary supporting changes.
5. Add tests and documentation as part of the same work.
6. Run all applicable checks.
7. Mark it `done` only after every acceptance criterion passes.
8. Add discovered follow-up work as separate `proposed` priorities.
9. Report the next eligible priority without starting it unless explicitly instructed.

Never skip a higher priority because a later item is easier or more interesting.

## Scope discipline

- Make the smallest coherent change that fully satisfies the selected priority.
- Do not silently add unrelated features.
- Do not perform broad refactors unless required by the current acceptance criteria.
- Preserve public API compatibility unless the task explicitly authorizes a breaking change.
- Record architectural changes in an ADR.
- Prefer configuration and versioned policy data over hard-coded business values.

## Architecture rules

- Obsidian Core owns business logic and authoritative records.
- Client applications handle presentation, user interaction, and local UI state.
- Begin with a modular monolith; maintain explicit domain boundaries.
- Modules communicate through defined interfaces, commands, queries, or events.
- Avoid direct cross-module table access when a domain interface exists.
- External providers must be accessed through adapters.
- Store external provider identifiers separately from internal IDs.
- Use idempotency for payments, webhooks, mobile retries, and background jobs.
- Preserve historical versions for prices, quotes, compensation plans, and organizational assignments.

## Domain boundaries

Expected Core domains include:

```text
Identity
Authorization
Organizations
Customers
Employees
Catalog
Quoting
Jobs
Scheduling
Routing
Payments
Subscriptions
Timekeeping
Commissions
Payroll Exports
Reporting
Notifications
Audit
Administration
```

Do not combine domains merely to reduce file count.

## Identity and authorization rules

- Separate login identity from customer and employee profiles.
- One identity may have multiple profiles and roles.
- Authentication does not imply application access.
- Enforce application entitlements server-side.
- Enforce resource-level authorization server-side.
- Default to deny.
- Never rely on hidden buttons or client-side route guards as the sole authorization control.
- Add tests for both allowed and denied access paths.
- Executive access and Core Admin access are separate permission sets.
- Do not hard-code access to personal names, including the founder, Chris Stamm, or Chris Russell.

## Security requirements

- Never commit secrets, tokens, private keys, production credentials, or real customer/employee data.
- Validate environment variables at startup.
- Use parameterized database access through the approved data layer.
- Redact credentials, payment tokens, addresses, and sensitive employee information from logs.
- Never store raw card numbers or CVV values.
- Store only payment-provider references and safe display metadata.
- Verify webhook signatures and implement replay protection.
- Require step-up authentication for high-risk operations.
- Add rate limiting to authentication and sensitive endpoints.
- Treat exports as sensitive actions and audit them.
- Use secure defaults for cookies, sessions, CORS, headers, and redirect URIs.
- Never weaken security controls merely to make a test pass.

## Data and migration rules

- Use immutable UUID/ULID-style internal identifiers according to the selected ADR.
- Include creation and update timestamps.
- Use archival/deactivation when records must remain historically visible.
- Never rewrite historical financial, quote, time, commission, or audit records.
- Corrections must create traceable adjustments or revisions.
- Migrations must be deterministic and reviewed for data loss.
- Destructive migrations require an explicit migration plan and backup/rollback strategy.
- Seed data must be synthetic and safe.
- Monetary values must use fixed-precision decimal or integer minor units, never floating-point arithmetic.
- Store timestamps in UTC and render them in the appropriate user/business timezone.

## Financial logic rules

- Keep gross sales, discounts, refunds, tax, tips, net sales, collected revenue, and outstanding revenue distinct.
- Keep estimated payroll separate from finalized payroll.
- Keep payment transaction state separate from invoice state.
- Commission calculations must be reproducible from a versioned plan and eligible-revenue definition.
- Initial compensation assumptions are `$20.00/hour` and a configurable `10%` commission; do not hard-code them globally.
- Refunds and reversals create adjustment records rather than deleting history.
- Payment and payroll providers remain authoritative for settlement and finalized payroll respectively.
- Every financial operation must be idempotent and auditable.

## Audit behavior

Audit events are required for:

- Authentication and session changes
- Permission and entitlement changes
- Customer-sensitive record access where required
- Employee compensation and time corrections
- Quote approvals and overrides
- Payment, refund, and settlement changes
- Commission adjustments
- Payroll exports
- Executive and administrative exports
- Integration configuration changes

An audit event should capture actor, action, target, timestamp, correlation ID, relevant before/after values, and reason where appropriate. Audit records must not contain secrets or prohibited payment data.

## API behavior

- Validate every external input at the boundary.
- Use stable, documented error codes.
- Return only fields the caller is authorized to see.
- Support pagination for collections.
- Avoid leaking internal stack traces or database details.
- Maintain API contracts in the approved contract package.
- Update generated clients when contracts change.
- Version breaking changes deliberately.
- Add idempotency keys to creation endpoints that may be retried.

## Mobile and offline behavior

- Assume mobile connectivity can be intermittent.
- Do not accept duplicate clock, job-status, payment, or signature events on retry.
- Queue only actions that are safe to perform offline.
- Show conflict states rather than silently overwriting newer server data.
- Keep sensitive local data minimal and encrypted using platform capabilities.
- Never store raw payment credentials on the device.

## Reporting behavior

- Every metric must have one documented definition.
- Do not present estimates as finalized accounting figures.
- Preserve organizational effective dates for historical store and district reporting.
- Prefer validated aggregate tables or materialized views for dashboards.
- Dashboard totals must be reconcilable to source records.
- Store, district, and company reports must use the same metric definitions.
- Wage payout reporting must distinguish hourly wages, overtime, commissions, bonuses, employer costs when available, estimated amounts, and finalized payroll amounts.

## Testing requirements

For every completed priority, add the appropriate combination of:

- Unit tests
- Integration tests using a real test database
- Authorization tests
- API contract tests
- Migration tests
- End-to-end tests
- Provider adapter tests with mocks or sandbox environments

Tests must cover failure paths, duplicate requests, unauthorized access, and boundary conditions—not only happy paths.

Never delete or weaken a valid test to make a change pass without explaining and correcting the underlying requirement.

## Required validation before completion

Run the repository-approved equivalents of:

```text
format check
lint
typecheck
unit tests
integration tests
migration validation
build
```

Run end-to-end tests when the priority changes a critical workflow.

If a check cannot run, state exactly why and do not claim it passed.

## Documentation behavior

Update documentation when changing:

- Architecture
- Environment variables
- Setup steps
- API contracts
- Database schema
- Permissions
- Business rules
- External integrations
- Operational runbooks
- API routes, authorization requirements, request inputs, response intent, or error behavior; keep the README API reference complete for every externally callable Core endpoint

Add an ADR for decisions that materially affect architecture, security, data ownership, deployment, or vendor dependence.

## Iteration delivery process

When an implementation iteration is complete:

1. Update `README.md` with the implemented behavior, setup, operational, or validation changes.
2. Run the applicable required validation checks.
3. Review Git status and stage only the completed iteration; do not include unrelated or unfinished work.
4. Commit with a conventional commit message containing the applicable priority ID.
5. Push the commit to the configured GitHub remote.

Do not commit or push unfinished work merely to satisfy this process. If a check is blocked, document the
blocker and keep the relevant priority in progress.

## Completion report format

At the end of implementation, report:

```text
Priority completed:
Summary:
Acceptance criteria:
Files changed:
Migrations:
Tests added or updated:
Checks run:
Security and authorization notes:
Known limitations or risks:
New proposed priorities:
Next eligible priority:
```

Be factual. Do not claim completion when acceptance criteria or checks remain unresolved.

## Prohibited behaviors

Codex must not:

- Hard-code executive access by name
- Store raw payment credentials
- Implement production payroll tax calculations without an explicitly approved scope
- Duplicate quote, commission, authorization, or subscription logic in client applications
- Bypass Core APIs by allowing applications direct production database access
- Modify historical financial or timekeeping records without traceable adjustment history
- Use floating-point arithmetic for money
- Log secrets or sensitive personal data
- Mark priorities complete without evidence
- Invent provider capabilities
- Add dependencies without documenting their purpose and reviewing security/licensing implications
- Rewrite unrelated user changes
- Push, deploy, migrate production, or send external communications unless explicitly instructed

## Ambiguity handling

When a requirement is materially ambiguous:

1. Search repository documentation and existing decisions.
2. Prefer a configurable and reversible implementation.
3. Document the assumption in code or the priority notes.
4. Add a proposed follow-up priority if policy clarification is needed.
5. Do not invent legal, payroll, payment-provider, or compliance requirements.

For high-risk ambiguity involving money, access, payroll, personal data, or destructive migrations, stop that portion of work and clearly identify the unresolved decision.

## Default engineering preferences

Unless an ADR says otherwise:

- TypeScript strict mode
- Explicit schemas at all boundaries
- Small composable functions
- Dependency injection for external providers
- Repository/service interfaces around domain persistence
- Structured errors
- UTC storage for timestamps
- Fixed-precision monetary values
- Accessibility for user interfaces
- Feature flags for incomplete or staged capabilities
- Backward-compatible migrations
- Synthetic fixtures
- Conventional commits with the priority ID in the message

## Core product principle

When deciding where functionality belongs, apply this rule:

> If the rule must be consistent across more than one Obsidian application, it belongs in Obsidian Core.

When deciding whether a task is complete, apply this rule:

> A feature is not complete until it is secure, authorized, auditable, tested, documented, and reconcilable to its source of truth.
