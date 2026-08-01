# Obsidian Core

Obsidian Core is the centralized operating platform for Obsidian Systems. It is the source of truth for customer identities, employee identities, permissions, stores, districts, quotes, jobs, repairs, routes, subscriptions, payments, commissions, timekeeping, reporting, and audit history.

Customer-facing, employee-facing, administrative, and executive applications must communicate with Core through authenticated APIs. Business rules belong in Core rather than being duplicated across applications.

## Current implementation

The repository currently contains the foundation for a backend-only Node.js service. `apps/core-api` uses Fastify and strict TypeScript, and exposes only `GET /health` while database, identity, authorization, audit, and business domains are built in priority order. No graphical user interface is included in this repository. Future Vercel-hosted customer, employee, administrative, and executive applications must communicate with Core through authenticated APIs and must not become independent systems of record.

### Identity provider

Auth0 is the selected identity provider. Applications will use OIDC Authorization Code with PKCE; Core will verify tokens server-side and remain authoritative for profiles, entitlements, roles, permissions, and resource-level authorization.

Before enabling login, create separate Auth0 tenants for development, staging, and production; configure each API audience and allowed callback/logout URLs; then set `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` through secret management. Never commit client secrets or management API credentials.

`GET /v1/identity/me` is Core's initial protected API boundary. It requires an `Authorization: Bearer <token>` header, verifies the Auth0 RS256 signature through the tenant JWKS, and validates both issuer and API audience. Missing, malformed, invalid, or wrong-audience tokens receive `401` with the stable `UNAUTHENTICATED` error code. `/health` and `/ready` intentionally remain unauthenticated operational endpoints. This endpoint confirms authentication only; it does not grant an application entitlement or business permission, which are enforced in the next authorization priority.

### Local development

Prerequisites: Node.js 24 LTS, npm, PostgreSQL 17, and Git. The documented Windows development setup
uses native PostgreSQL and does not require virtualization. Docker Compose remains an optional alternative
for developers whose machines support Docker Desktop.

```text
npm install
copy .env.example .env
npm run db:up
npm run db:migrate
npm run dev
```

The API listens on `http://127.0.0.1:3000` by default. Verify it with `GET /health`. `npm run db:up`
starts or verifies the native `postgresql-x64-17` Windows service and checks the `obsidian_core`
database. The local database uses the development-only credentials in `.env.example`; never use them
outside a local environment. `npm run db:docker:up` is available as an optional Docker-based setup.
`npm run db:migrate` reports how many migrations it newly applied and how many existing migrations it
verified against their recorded checksums.

### Database foundation

`CORE-002` establishes the initial PostgreSQL tables for identity, sessions, organizational hierarchy,
applications, roles, permissions, entitlements, and audit events. Each table uses a UUID primary key and
UTC timestamps. Migration files are append-only: their SHA-256 checksums are recorded in
`schema_migrations`, and a changed historical migration is rejected before it can be applied.

### Observability

Core API requests receive or propagate `x-correlation-id` and include it in structured logs. `GET /health`
reports API liveness, while `GET /ready` verifies PostgreSQL readiness without exposing configuration. Audit
helpers reject card data, authentication secrets, and tokens from metadata before persistence.

Run the foundation quality gates with:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run db:validate
npm run build
```

### Iteration delivery

Every completed implementation iteration updates this README, runs its applicable validation checks,
and is committed and pushed to the configured GitHub remote. Unfinished or blocked work remains
uncommitted until it can be validated.

## Planned applications

1. Obsidian Systems Website
2. Obsidian Customer Mobile App
3. Obsidian Employee App
4. Obsidian Core Backend
5. Obsidian Core Executive Panel
6. Obsidian Customer Account Portal
7. Obsidian Employee Web Portal
8. Obsidian Core Admin Portal
9. Obsidian Prospecting Engine

## Guiding principles

- One identity can participate in multiple roles and organizations.
- One customer account can be used across authorized Obsidian applications.
- Obsidian Core owns business data and business rules.
- Applications are focused interfaces into Core, not independent systems of record.
- Every sensitive action must be permission-checked and auditable.
- Payment credentials remain with the payment processor; Core stores only processor references and safe display metadata.
- Payroll calculations and tax filings remain with a payroll provider; Core tracks time, commissions, approvals, and exports.
- Begin as a modular monolith unless scale or operational needs justify separating services.
- Prefer explicit workflows, immutable history, and reversible changes over hidden mutations.

---

# 1. Recommended repository structure

Use a TypeScript monorepo so applications can share schemas, API clients, authorization utilities, UI components, and domain types without duplicating business logic.

```text
obsidian-platform/
├── apps/
│   ├── core-api/                 # Core backend and API
│   ├── public-web/               # Public Obsidian Systems website
│   ├── customer-portal/          # Customer web account
│   ├── customer-mobile/          # Customer mobile app
│   ├── employee-web/             # Employee browser application
│   ├── employee-mobile/          # Employee/mobile technician app
│   ├── executive-panel/          # Executive analytics and governance
│   └── core-admin/               # Restricted system administration
├── packages/
│   ├── auth/                     # Identity, sessions, MFA, OIDC helpers
│   ├── authorization/            # Roles, permissions, policies, entitlements
│   ├── database/                 # Schema, migrations, repositories
│   ├── domain/                   # Domain models, commands, events
│   ├── api-contracts/            # Request/response schemas and generated clients
│   ├── ui/                       # Shared web UI components
│   ├── observability/            # Logging, metrics, tracing, audit helpers
│   ├── config/                   # Shared configuration validation
│   ├── payments/                 # Payment-provider abstraction
│   ├── notifications/            # Email, SMS, push abstraction
│   ├── quoting/                  # Quote and pricing engine
│   ├── commissions/              # Commission rules and calculations
│   └── testing/                  # Test fixtures and helpers
├── docs/
│   ├── architecture/
│   ├── decisions/                # Architecture Decision Records
│   ├── api/
│   ├── security/
│   └── product/
├── infra/
│   ├── local/
│   ├── vercel/
│   └── database/
├── AGENTS.md
├── README.md
└── package.json
```

Recommended baseline technologies:

- TypeScript throughout
- Next.js for web applications
- React Native with Expo for mobile applications
- PostgreSQL as the primary relational database
- Prisma or Drizzle for schema and migrations
- OpenAPI or type-safe RPC contracts for APIs
- A dedicated identity provider or standards-based OIDC implementation
- Redis only when needed for queues, caching, throttling, or ephemeral state
- Object storage for documents, photos, signatures, and attachments
- Vercel for web deployment where appropriate
- A separately deployed API/runtime if Core workloads exceed serverless constraints

Do not select a payment, payroll, mapping, messaging, or identity vendor until its required capabilities have been verified.

---

# 2. Build system and priority workflow

The repository must maintain a machine-readable priority queue. Create:

```text
planning/priorities.yml
```

Example:

```yaml
current_release: foundation-1

priorities:
  - id: CORE-001
    title: Repository and local development foundation
    status: ready
    priority: 1
    dependencies: []
    acceptance_criteria:
      - Monorepo installs with one command
      - All applications pass lint and typecheck
      - Local PostgreSQL starts through documented tooling
      - Environment variables are validated

  - id: CORE-002
    title: Central identity and application access
    status: blocked
    priority: 2
    dependencies: [CORE-001]
    acceptance_criteria:
      - Users can authenticate through the selected identity service
      - Core can map an identity to customer and employee records
      - Application entitlements are enforced server-side
```

Allowed statuses:

```text
proposed
ready
in_progress
blocked
done
deferred
```

## “Build priority parts” command behavior

When instructed to **Build priority parts**, Codex must:

1. Read `AGENTS.md`, this `README.md`, and `planning/priorities.yml`.
2. Inspect the repository and existing tests before changing code.
3. Select the highest-priority `ready` item whose dependencies are complete.
4. Break that item into small implementation tasks.
5. Implement only the selected priority and necessary supporting work.
6. Add or update tests, migrations, documentation, and API contracts.
7. Run the relevant lint, typecheck, unit, integration, and migration checks.
8. Update the priority item’s status and implementation notes.
9. Record newly discovered work as separate proposed priority items rather than silently expanding scope.
10. Produce a completion report listing files changed, checks run, unresolved risks, and the next eligible priority.

Codex must not mark an item complete unless every acceptance criterion is demonstrably satisfied.

---

# 3. Delivery phases

## Phase 0 — Product and architecture foundation

### Step 0.1: Create decision records

Create Architecture Decision Records for:

- Monorepo tooling
- Backend framework
- Database and ORM
- Authentication strategy
- Authorization model
- API style
- Hosting model
- Mobile framework
- Audit logging
- Background jobs
- File storage
- Payment integration boundary
- Payroll export boundary

Each decision must document context, chosen approach, rejected alternatives, security implications, and migration consequences.

### Step 0.2: Define environments

Support at least:

```text
local
development
staging
production
```

Every environment must use isolated databases, credentials, payment environments, storage, callback URLs, and signing keys.

### Step 0.3: Establish quality gates

Require:

- Formatting
- Linting
- Type checking
- Unit tests
- Integration tests
- Migration validation
- Dependency and secret scanning
- Build verification

No production deployment should occur from a failing main branch.

---

## Phase 1 — Core platform foundation

### Step 1.1: Create the monorepo

Set up workspaces, shared TypeScript configuration, lint configuration, test tooling, environment validation, and common scripts.

Minimum scripts:

```text
install
dev
build
lint
typecheck
test
test:integration
db:migrate
db:seed
db:reset
```

### Step 1.2: Establish the database

Create initial tables for:

- `users`
- `identities`
- `sessions`
- `organizations`
- `business_units`
- `districts`
- `stores`
- `departments`
- `applications`
- `roles`
- `permissions`
- `role_permissions`
- `user_roles`
- `application_entitlements`
- `audit_events`

Every business record should use immutable identifiers, creation timestamps, update timestamps, and appropriate archival/deactivation fields.

### Step 1.3: Implement observability

Add structured logs, correlation IDs, request IDs, error tracking, health checks, and audit-event helpers before building sensitive workflows.

### Step 1.4: Implement API conventions

Standardize:

- Authentication
- Authorization failures
- Validation errors
- Pagination
- Filtering and sorting
- Idempotency
- Versioning
- Rate limits
- Correlation IDs
- Error response formats

---

## Phase 2 — Identity, roles, and application access

### Step 2.1: Central identity

Implement one identity layer shared by all Obsidian applications.

Required capabilities:

- Email verification
- Password reset where passwords are used
- MFA or passkeys
- Session revocation
- Device/session history
- OIDC/OAuth-compatible mobile sign-in
- Account lockout and throttling

### Step 2.2: Separate identity from business profiles

An authenticated user may link to:

- A customer profile
- An employee profile
- One or more business contacts
- Executive permissions
- Administrative permissions

Do not create duplicate login accounts solely because a person has multiple roles.

### Step 2.3: Application entitlements

Create server-enforced entitlements for each application and feature. Authentication proves identity; entitlements determine application access.

Example applications:

```text
public_web
customer_portal
customer_mobile
employee_web
employee_mobile
executive_panel
core_admin
```

### Step 2.4: Authorization policies

Support both role-based and resource-based checks.

Examples:

- Customers may view only their own records or authorized household/business records.
- Employees may view assigned or permitted stores, jobs, and customers.
- Store managers may view their store.
- District managers may view stores in their district.
- Executives may view company-wide data according to explicit permissions.
- Only designated administrators may manage roles, payment configuration, or executive access.

All authorization must be enforced by the Core API, never only by the user interface.

---

## Phase 3 — Customer accounts

### Step 3.1: Customer profiles

Create customer and household/business profile support.

Track:

- Names and preferred names
- Verified contact methods
- Communication preferences
- Customer status
- Customer type
- Associated identities
- Notes with appropriate access controls

### Step 3.2: Shared addresses

Create reusable address records with labels, billing/service defaults, access instructions, validation status, and ownership relationships.

### Step 3.3: Customer devices

Track devices, serial numbers where appropriate, ownership, warranties, protection coverage, service history, and consented diagnostic information.

### Step 3.4: Saved payment methods

Store only payment-provider customer IDs, tokens/references, brand, last four digits, expiration metadata, and billing-address links. Never store raw card numbers or CVV values.

### Step 3.5: Customer portal API

Provide endpoints for profile, addresses, devices, subscriptions, quotes, jobs, appointments, invoices, and payment-method references.

---

## Phase 4 — Catalog, quoting, and work management

### Step 4.1: Service and product catalog

Create versioned records for:

- Products
- Services
- Parts
- Labor categories
- Fees
- Taxes
- Discounts
- Eligibility rules
- Store or district overrides

### Step 4.2: Quote engine

The quote engine must calculate prices inside Core using versioned rules.

A quote should preserve:

- Input facts
- Pricing-rule version
- Line items
- Taxes
- Discounts
- Protection coverage
- Expiration
- Approval state
- Customer acceptance evidence

Changing current pricing must not rewrite historical quotes.

### Step 4.3: Jobs and work orders

Implement a state-controlled job workflow such as:

```text
requested
scheduled
assigned
accepted
en_route
arrived
inspection
quoted
approved
in_progress
payment_due
completed
cancelled
```

Every state transition must be timestamped, attributed, validated, and auditable.

### Step 4.4: Attachments and signatures

Support photos, documents, customer approvals, and signatures in object storage with access-controlled references in Core.

---

## Phase 5 — Scheduling, dispatch, and routes

### Step 5.1: Appointments

Track service windows, locations, required skills, assigned employees, status, estimated duration, and customer notifications.

### Step 5.2: Routes

Create route and route-stop records for mobile technicians. Mapping and navigation should use an external provider through an abstraction layer.

### Step 5.3: Technician workflow

The employee mobile app should support:

- Today’s route
- Job acceptance
- En-route and arrival status
- Quote presentation
- Work notes
- Photos
- Parts used
- Customer approval
- Payment collection
- Completion

### Step 5.4: Offline operation

Design mobile operations to tolerate intermittent connectivity. Queue safe actions locally, use idempotency keys, and reconcile conflicts explicitly.

---

## Phase 6 — Payments and subscriptions

### Step 6.1: Payment-provider adapter

Create a provider-independent payments interface. Square is the interim payment provider because
Commerce360/GoDaddy online-payment and subscription capabilities are not yet confirmed. Verify
Square capabilities before implementing its adapter; defer any Commerce360 adapter until its
capabilities are confirmed.

All applications must send payment requests to Core APIs. They must not integrate directly with
Square or any future payment processor.

The Obsidian Systems website and Obsidian Prospecting Engine may initiate online-item checkout,
website-service invoices, and retainer subscriptions through Core. Core authorizes the request,
performs the Square interaction, verifies webhooks, and finalizes the audited payment, invoice, or
subscription state. GUIs never receive Square secret credentials or finalize payment state directly.

Required capabilities to confirm:

- Hosted or tokenized payment collection
- Reusable customer payment profiles
- Recurring billing
- Refunds and partial refunds
- Card-present or terminal payments
- Mobile payment acceptance
- Webhooks
- Settlement reporting
- Idempotency
- Sandbox access

### Step 6.2: Payment lifecycle

Track payment intent/request, authorization, capture, failure, refund, dispute, settlement, and reconciliation states.

Webhook processing must be signed, idempotent, replay-safe, and auditable.

### Step 6.3: Device protection subscription

Create a configurable plan initially priced at `$15.00` monthly, without hard-coding plan logic throughout the codebase.

Track:

- Customer
- Plan/version
- Status
- Start and renewal dates
- Covered devices
- Payment-provider references
- Grace periods
- Cancellation
- Failed-payment handling

### Step 6.4: Invoice and receipt records

Core owns the operational invoice and receipt records, while the processor remains authoritative for transaction processing and settlement. Invoices must support online website-service sales; retainers must be configurable recurring subscriptions rather than a special case of the device-protection plan.

---

## Phase 7 — Employees, timekeeping, and compensation

### Step 7.1: Employee records

Track:

- Employee number
- Employment status
- Job title
- Department
- Assigned store and district
- Manager
- Start/end dates
- Skills and certifications
- Compensation-plan assignment
- Access roles

Restrict sensitive employment data with dedicated permissions.

### Step 7.2: Timekeeping

Track clock-in, clock-out, breaks, source, location validation where lawful and appropriate, shift/job association, approval status, and correction history.

Never silently overwrite time entries. Corrections must preserve original values, changed values, actor, timestamp, and reason.

### Step 7.3: Compensation plans

Create versioned compensation plans rather than hard-coding amounts.

Initial plan:

```text
Hourly base rate: $20.00
Commission rate: 10%
```

The commission base must be configurable. A recommended initial definition is qualifying collected revenue after discounts and refunds, excluding sales tax, tips, and explicitly noncommissionable fees.

### Step 7.4: Commission attribution

Support multiple contributors to a transaction even if the first policy assigns the full commission to one employee.

Track:

- Sold by
- Performed by
- Assisted by
- Attribution percentage
- Eligible revenue
- Commission rate
- Amount
- Status
- Pay period
- Adjustments and reversals

### Step 7.5: Commission lifecycle

Use statuses such as:

```text
pending
earned
approved
sent_to_payroll
paid
disputed
adjusted
reversed
cancelled
```

Do not delete paid or reversed commission history.

### Step 7.6: Payroll exports

Core should export approved hours, overtime categories, commissions, bonuses, reimbursements, and adjustments to a payroll provider. The payroll provider remains responsible for taxes, deductions, filings, wage statements, and disbursement.

### Step 7.7: Employee earnings views

Employees should see estimated current-period hours, hourly wages, eligible sales, pending/approved commissions, adjustments, and estimated gross earnings. Estimated figures must be clearly distinguished from finalized payroll.

---

## Phase 8 — Store, district, and company intelligence

### Step 8.1: Organizational hierarchy

Model:

```text
Company → District → Store → Department → Employee
```

Records should support effective dates so reorganizations do not corrupt historical reporting.

### Step 8.2: Revenue metrics

Track and distinguish:

- Gross sales
- Discounts
- Refunds
- Net sales
- Sales tax
- Tips
- Commissionable revenue
- Collected revenue
- Outstanding revenue
- Subscription revenue

### Step 8.3: Wage and labor metrics

Track per store, district, and company:

- Regular hourly wages
- Overtime wages
- Commissions
- Bonuses
- Employer payroll costs when available
- Estimated payroll
- Finalized payroll
- Labor cost as a percentage of net sales
- Sales per labor hour
- Revenue per employee

### Step 8.4: Profitability metrics

Where source data exists, calculate:

- Net sales
- Cost of goods or parts
- Labor expense
- Commission expense
- Payment-processing fees
- Refunds
- Contribution margin
- Estimated operating margin

Clearly label estimates, pending settlements, payroll-approved numbers, and accounting-finalized numbers.

### Step 8.5: Aggregation pipeline

Do not run every executive dashboard directly from high-volume transactional tables. Create validated daily or hourly aggregates, with drilldown links back to source records.

Every metric must have a documented definition, owner, refresh cadence, and source-of-truth tables.

---

## Phase 9 — Executive Panel

### Step 9.1: Executive access

Initial intended executive users include the founder, Chris Stamm, and Chris Russell. Access must still be assigned through roles and permissions, not hard-coded names.

Require stronger controls:

- Mandatory MFA or passkeys
- Shorter sessions
- Reauthentication for sensitive actions
- Login/device history
- Export logging
- Permission-change logging

### Step 9.2: Executive overview

Provide company-wide summary metrics and comparisons across periods.

### Step 9.3: Drilldowns

Support:

```text
Company → District → Store → Department → Employee/Job/Transaction
```

### Step 9.4: Executive modules

```text
Overview
Sales
Operations
Customers
Subscriptions
Workforce
Wages and commissions
Finance
Stores and districts
Alerts
Reports
Administration
```

### Step 9.5: Alerts

Create configurable alerts for unusual or important conditions, including sales below target, high labor-to-sales ratios, overtime exposure, refund spikes, payment failures, delayed routes, unreconciled settlements, and pending commission adjustments.

### Step 9.6: Read versus approval authority

Use separate permissions for viewing, exporting, approving, and modifying sensitive data. Executive status alone must not grant unrestricted mutation privileges.

---

## Phase 10 — Administrative controls

The Core Admin Portal should manage:

- Applications
- Roles and permissions
- Entitlements
- Stores and districts
- Catalog and pricing versions
- Compensation plans
- Integration configuration
- Feature flags
- Audit review
- Data retention
- Account suspension and access revocation

Highly sensitive settings should require step-up authentication and dual approval where appropriate.

---

## Phase 11 — Public website and customer applications

### Public website

Build marketing pages, service discovery, account creation, subscription enrollment, quote requests, and entry points into authenticated customer experiences.

### Customer portal

Build profile, addresses, devices, subscriptions, appointments, quotes, invoices, repair status, and safe payment-method management.

### Customer mobile app

Build shared-account login, scheduling, house-visit requests, repair tracking, notifications, address selection, subscription visibility, and payment flows.

These applications must use generated or validated Core API clients. They must not duplicate pricing, authorization, subscription, or payment-state logic.

---

## Phase 12 — Employee applications

### Employee mobile app

Prioritize:

1. Authentication and device registration
2. Clock in/out and breaks
3. Shift and schedule
4. Assigned jobs
5. Route and stop details
6. Job status workflow
7. Quote presentation
8. Notes, photos, and signatures
9. Payment collection
10. Hours, sales, and commissions

### Employee web portal

Provide timesheets, schedules, jobs, sales, commissions, earnings estimates, profile, and correction/dispute requests.

---

# 4. Security requirements

- Use least privilege by default.
- Enforce permissions on every protected API operation.
- Encrypt data in transit and at rest.
- Use managed secret storage; never commit secrets.
- Redact sensitive values from logs.
- Store processor tokens, never raw card data.
- Use signed and replay-safe webhooks.
- Add rate limits to authentication and high-risk endpoints.
- Require step-up authentication for exports, compensation changes, refunds, role changes, and payment configuration.
- Record immutable audit events for sensitive reads and writes.
- Define retention and deletion policies before collecting unnecessary personal data.
- Treat location information, employee compensation, customer data, and executive reports as restricted information.
- Build export and deletion workflows that respect legal and contractual obligations.
- Conduct security reviews before production launches and before adding high-risk integrations.

---

# 5. Testing strategy

Each domain must include:

- Unit tests for calculations and policy decisions
- Integration tests against a real test database
- Authorization tests for allowed and denied access
- Contract tests for APIs and external integrations
- Idempotency tests for payments and background jobs
- Migration tests
- End-to-end tests for critical workflows

Critical end-to-end workflows:

1. Customer creates one account and accesses multiple authorized applications.
2. Customer enrolls in the `$15/month` protection plan.
3. Customer schedules a mobile repair using a saved address.
4. Technician clocks in, follows a route, performs a job, and accepts payment.
5. Core calculates `$20/hour` wages and a configurable `10%` commission.
6. Manager reviews time and commission exceptions.
7. Executive views sales, wage payouts, and labor efficiency by store, district, and company.
8. Refund or cancellation creates reversible financial and commission adjustments.
9. Unauthorized users cannot access customer, employee, executive, or administrative records.

---

# 6. Definition of done

A feature is complete only when:

- Acceptance criteria are satisfied.
- Business rules live in Core rather than only in a client.
- Authorization is enforced and tested.
- Audit requirements are implemented.
- Validation and error behavior are documented.
- Database migrations are included and reversible where practical.
- Unit and integration tests pass.
- Relevant end-to-end coverage exists.
- API contracts and generated clients are updated.
- Monitoring and failure handling are present.
- Documentation is updated.
- No secrets, raw payment credentials, or sensitive test data are committed.

---

# 7. Initial priority queue

Create these items in `planning/priorities.yml` in this order:

1. `CORE-001` — Monorepo and local development foundation
2. `CORE-002` — Database schema foundation and migrations
3. `CORE-003` — Structured logging, health checks, and audit framework
4. `CORE-004` — Central identity integration
5. `CORE-005` — Roles, permissions, and application entitlements
6. `CORE-006` — Company, district, store, and department hierarchy
7. `CORE-007` — Customer profiles and shared addresses
8. `CORE-008` — Employee profiles and store assignments
9. `CORE-009` — Timekeeping and immutable corrections
10. `CORE-010` — Product/service catalog and versioned quote engine
11. `CORE-011` — Jobs, appointments, and workflow state machine
12. `CORE-012` — Payment-provider capability spike and adapter contract
13. `CORE-013` — Subscription model and `$15/month` protection-plan configuration
14. `CORE-014` — Commission engine with `$20/hour` plan and `10%` default commission
15. `CORE-015` — Store/district/company sales and wage aggregates
16. `CORE-016` — Executive Panel authentication and overview
17. `CORE-017` — Employee mobile clock and assigned-job MVP
18. `CORE-018` — Customer portal MVP
19. `CORE-019` — Public website account and protection enrollment
20. `CORE-020` — Payroll export integration

Only one item should normally be `in_progress` per development agent unless parallel ownership is explicitly assigned.

---

# 8. Commands for Codex

## Build priority parts

Select and complete the next eligible item from `planning/priorities.yml` according to the workflow in this document and `AGENTS.md`.

## Plan priority parts

Inspect the highest eligible priority and produce a detailed implementation plan without changing production code. Update the priority item with clarified acceptance criteria, dependencies, risks, and test strategy.

## Review priority parts

Review the current `in_progress` or most recently completed priority. Verify acceptance criteria, architecture boundaries, authorization, auditability, tests, migration safety, and documentation. Do not mark complete if evidence is missing.

## Reprioritize parts

Reorder only `ready` or `proposed` items based on stated business direction. Preserve completed history and document why the order changed.

## Build `<priority-id>`

Implement the specified priority if its dependencies are complete. Otherwise, report blockers and work on no unrelated priority.

---

# 9. Immediate next action

The first implementation session should create the repository foundation, `planning/priorities.yml`, architecture decision templates, environment validation, local PostgreSQL tooling, CI checks, and an empty deployable `core-api` with a health endpoint. No customer, employee, payment, or executive feature should be implemented until the identity, authorization, audit, and database foundations are in place.
