# Obsidian Core

Obsidian Core is the centralized operating platform for Obsidian Systems. It is the source of truth for customer identities, employee identities, permissions, stores, districts, quotes, jobs, repairs, routes, subscriptions, payments, commissions, timekeeping, reporting, and audit history.

Customer-facing, employee-facing, administrative, and executive applications must communicate with Core through authenticated APIs. Business rules belong in Core rather than being duplicated across applications.

## Current implementation

The repository currently contains the foundation for a backend-only Node.js service. `apps/core-api` uses Fastify and strict TypeScript, and exposes health, readiness, identity, and initial authorization boundaries while database, identity, authorization, audit, and business domains are built in priority order. No graphical user interface is included in this repository. Future Vercel-hosted customer, employee, administrative, and executive applications must communicate with Core through authenticated APIs and must not become independent systems of record.

### Identity provider

Auth0 is the selected identity provider. Applications will use OIDC Authorization Code with PKCE; Core will verify tokens server-side and remain authoritative for profiles, entitlements, roles, permissions, and resource-level authorization.

Before enabling login, create separate Auth0 tenants for development, staging, and production; configure each API audience and allowed callback/logout URLs; then set `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` through secret management. Never commit client secrets or management API credentials.

`GET /v1/identity/me` is Core's initial protected API boundary. It requires an `Authorization: Bearer <token>` header, verifies the Auth0 RS256 signature through the tenant JWKS, and validates both issuer and API audience. Missing, malformed, invalid, or wrong-audience tokens receive `401` with the stable `UNAUTHENTICATED` error code. `/health` and `/ready` intentionally remain unauthenticated operational endpoints.

### API perimeter configuration

Core applies no-sniff, frame-deny, referrer, and cross-origin resource-policy headers to every
response. Configure browser access with `API_ALLOWED_ORIGINS` as a comma-separated allowlist and
configure sensitive write protection with `API_SENSITIVE_RATE_LIMIT_MAX` and
`API_SENSITIVE_RATE_LIMIT_WINDOW_MS`. Production requires HTTPS origins and an Auth0 custom
step-up claim/value (`AUTH0_STEP_UP_CLAIM`, `AUTH0_STEP_UP_VALUE`); subscription-plan changes reject
tokens without that claim. The built-in limiter is per-process and suitable for a single Core
instance only; distributed production deployments require a shared limiter before horizontal scaling.

### Employee mobile contract

CORE provides the future React Native/Expo employee application with a client-independent,
Auth0-protected mobile contract. Mobile clock commands contain only an event type, an idempotency
key, and an optional assigned job ID. Core timestamps the event, stores immutable clock and break
history, and creates the completed time entry only when the employee clocks out. Retrying a command
with the same key is safe; an invalid event sequence returns `409 MOBILE_TIME_EVENT_CONFLICT`.

Mobile job reads and workflow transitions are restricted to the caller's active employee profile.
Mobile location, device fingerprinting, and telemetry collection are intentionally disabled. Route
planning and maps remain a separate CORE-025 integration. A future employee application must use a
dedicated Auth0 Native application; no client secrets belong in the application.

## API reference

Production base URL: `https://api.obsidian-systems.tech`. Local development uses the configured
`CORE_API_HOST` and `CORE_API_PORT`. All `/v1/*` routes require an Auth0 access token in
`Authorization: Bearer <token>` unless marked public. Core
returns `401 UNAUTHENTICATED` for invalid tokens, `403 FORBIDDEN` for missing entitlement or
permission, and `400` with a stable route-specific `INVALID_*` code for invalid input. Send an
`X-Correlation-Id` UUID on write requests to connect client, audit, and server logs.

| Method | Route | Required application + permission | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | Public | API liveness. |
| GET | `/ready` | Public | Database readiness. |
| GET | `/v1/identity/me` | Authenticated | Returns the Auth0 subject recognized by Core. |
| GET | `/v1/core-admin/authorization/access` | `core-admin` + `authorization.read` | Verifies Core Admin access. |
| GET | `/v1/core-admin/organization-hierarchy` | `core-admin` + `organization.read` | Returns active organization hierarchy. |
| GET | `/v1/customer-portal/profile` | `customer-portal` + `customer.profile.read` | Returns the caller's customer profile. |
| POST | `/v1/customer-portal/registration` | Authenticated Auth0 user | Creates the caller's encrypted Core customer profile and least-privilege portal access. |
| PUT | `/v1/customer-portal/profile` | `customer-portal` + `customer.profile.write` | Replaces the caller's encrypted Core profile with an idempotent revision. |
| DELETE | `/v1/customer-portal/account` | `customer-portal` + `customer.account.close` | Closes and archives the caller's Core customer account after explicit confirmation. |
| POST | `/v1/customer-portal/addresses` | `customer-portal` + `customer.profile.write` | Adds an encrypted address owned by the caller. |
| POST | `/v1/customer-portal/devices` | `customer-portal` + `customer.profile.write` | Adds an encrypted device owned by the caller. |
| POST | `/v1/customer-portal/repair-requests` | `customer-portal` + `repair-request.create` | Creates an idempotent, customer-owned requested repair job. |
| POST | `/v1/customer-portal/payment-methods` | `customer-portal` + `payment-method.manage` | Saves a tokenized Square card on the caller's Core-owned payment profile. |
| GET | `/v1/customer-portal/payment-methods` | `customer-portal` + `payment-method.read` | Lists only the caller's safe saved-card metadata. |
| PUT | `/v1/customer-portal/payment-methods/:id/primary` | `customer-portal` + `payment-method.manage` | Sets the primary card and replaces the billing card for active Device Care subscriptions. |
| DELETE | `/v1/customer-portal/payment-methods/:id` | `customer-portal` + `payment-method.manage` | Disables an unlinked saved Square card. |
| POST | `/v1/customer-portal/subscriptions/device-care` | `customer-portal` + `subscription.enroll` | Enrolls the caller in the configured Device Care plan using an owned saved card. |
| POST | `/v1/customer-portal/subscriptions/device-care/cancel` | `customer-portal` + `subscription.cancel` | Schedules cancellation at the Square billing-period boundary. |
| GET | `/v1/customer-portal/overview` | `customer-portal` + `customer.portal.read` | Returns the caller's owned portal records, excluding payment data until the portal-payment follow-up. |
| GET | `/v1/employee-portal/profile` | `employee-portal` + `employee.profile.read` | Returns the caller's employee profile and effective assignments. |
| GET | `/v1/employee-portal/time-entries` | `employee-portal` + `timekeeping.self.manage` | Lists the caller's time entries. |
| POST | `/v1/employee-portal/time-entries` | `employee-portal` + `timekeeping.self.manage` | Creates an idempotent time entry. |
| POST | `/v1/employee-portal/time-entries/:id/corrections` | `employee-portal` + `timekeeping.self.manage` | Appends a reasoned time correction. |
| GET | `/v1/employee-mobile/timekeeping-state` | `employee-mobile` + `timekeeping.self.manage` | Returns only the caller's current mobile clock/break state. |
| POST | `/v1/employee-mobile/time-events` | `employee-mobile` + `timekeeping.self.manage` | Records an idempotent `clock_in`, `clock_out`, `break_start`, or `break_end` event. |
| GET | `/v1/employee-mobile/jobs` | `employee-mobile` + `job.self.read` | Lists only jobs assigned to the caller's active employee profile. |
| POST | `/v1/employee-mobile/jobs/:id/transitions` | `employee-mobile` + `job.self.transition` | Appends an allowed transition for an assigned job only. |
| POST | `/v1/core-admin/quotes` | `core-admin` + `quote.create` | Creates an idempotent catalog-priced quote. |
| POST | `/v1/core-admin/jobs` | `core-admin` + `job.create` | Creates an idempotent job and appointment. |
| POST | `/v1/core-admin/jobs/:id/transitions` | `core-admin` + `job.transition` | Appends an allowed workflow transition. |
| POST | `/v1/executive/subscription-plan-versions` | `executive-panel` + `subscription.plan.manage` | Creates an audited plan version; production requires step-up authentication. |
| GET | `/v1/executive/overview` | `executive-panel` + `reporting.read` | Latest/previous hierarchy-scoped aggregate comparison. |
| GET | `/v1/executive/operating-aggregates` | `executive-panel` + `reporting.read` | Lists hierarchy-scoped persisted aggregate rows. |
| POST | `/v1/core-admin/compensation-assignments` | `core-admin` + `compensation.manage` | Creates an effective-dated compensation assignment. |
| POST | `/v1/core-admin/commissions` | `core-admin` + `compensation.manage` | Creates an auditable commission entry. |
| POST | `/v1/core-admin/commissions/:id/events` | `core-admin` + `compensation.manage` | Appends a reasoned commission lifecycle event. |
| POST | `/v1/core-admin/payments` | `core-admin` + `payment.manage` | Creates or returns an idempotent token/reference-based payment. |
| POST | `/v1/core-admin/payments/:id/refunds` | `core-admin` + `payment.manage` | Creates or returns an idempotent full or partial refund. |
| POST | `/v1/webhooks/square/sandbox` | Public, signed Square sandbox webhook | Verifies, replay-protects, and records Square sandbox payment lifecycle notifications. |
| POST | `/v1/webhooks/square/production` | Public, signed Square production webhook | Verifies, replay-protects, and records Square production payment lifecycle notifications. |
| GET | `/v1/employee-portal/earnings-estimate` | `employee-portal` + `earnings.self.read` | Returns estimated and pending commission totals, never finalized payroll. |

Write payloads use JSON. Money values are integer minor units and may be represented as decimal strings
at the boundary. Creation routes that expose an `idempotencyKey` require a UUID. Applications must
never call the database directly or reimplement Core authorization, pricing, compensation, payment,
or subscription rules.

### API integration contract

All timestamps are ISO-8601 UTC timestamps. IDs and idempotency keys are UUIDs. Monetary values and
other potentially large integer values are decimal strings in responses and must never be converted
to JavaScript floating-point values. A caller retries a creation or mobile command only with the
same `idempotencyKey` and the same logical request. Core returns the prior result for a safe retry.

Every protected route requires an Auth0 access token for the configured Core API audience. Every
write should include `X-Correlation-Id: <uuid>`; Core generates one when absent and returns it in
the response. Invalid input returns `400 INVALID_*`, an invalid workflow or clock-state change
returns `409`, a missing authorized record returns `404`, and rejected catalog pricing returns
`422 UNQUOTABLE_CATALOG`. Clients must never infer authorization from the visibility of a screen or
button; `403 FORBIDDEN` is authoritative.

#### Operational and identity routes

- `GET /health` returns `{ "status": "ok" }` and performs no database check.
- `GET /ready` returns `{ "status": "ready" }` only when Core can reach PostgreSQL; otherwise it
  returns `503 { "status": "unavailable" }`.
- `GET /v1/identity/me` returns `{ "subject": "auth0|..." }` for a validated access token. It
  returns `401 UNAUTHENTICATED` when the bearer token is missing, malformed, expired, incorrectly
  issued, or for a different audience.
- `GET /v1/core-admin/authorization/access` returns `{ "status": "authorized" }` only after
  `core-admin` entitlement plus `authorization.read` permission checks pass.
- `GET /v1/core-admin/organization-hierarchy` returns the active organization, business-unit,
  district, store, and department hierarchy ordered by parent relationship. It is read-only;
  administration writes are CORE-029.

#### Customer and employee profile routes

- `GET /v1/customer-portal/profile` returns the caller's `{ id, value, addresses }`, where
  `value` and each address `value` are the decrypted, application-authorized profile payload and an
  address has `{ id, label, value }`. Core resolves access through customer membership, not merely
  through an Auth0 login. A caller without a linked active profile receives
  `404 CUSTOMER_PROFILE_NOT_FOUND`.
- `POST /v1/customer-portal/registration` accepts `{ email, profile, idempotencyKey }` after a
  valid Auth0 login. `profile` is a string-only field map encrypted at rest. Core binds the Auth0
  subject to a new customer profile, grants only the `customer-portal` entitlement and self-service
  role, and audits the registration without copying profile data into audit records. A safe repeat
  registration for an already-linked subject reconciles that standard role's current permissions
  before returning the existing profile; a portal never needs an Auth0 role, permission, or scope
  claim for customer self-service. Invalid input returns `400 INVALID_CUSTOMER_REGISTRATION`; an
  email already linked to a different Core identity returns `409 CUSTOMER_EMAIL_ALREADY_LINKED`.
- `PUT /v1/customer-portal/profile` accepts `{ profile, idempotencyKey }`. `profile` is a complete,
  string-only replacement field map; Core encrypts it, retains an encrypted idempotent revision,
  returns the updated owned profile, and audits only changed field names. It cannot change the Core
  account email or Auth0 identity. Invalid input returns `400 INVALID_CUSTOMER_PROFILE_UPDATE`; an
  absent or closed profile returns `404 CUSTOMER_PROFILE_NOT_FOUND`.
- `DELETE /v1/customer-portal/account` accepts `{ confirmation: "CLOSE_MY_ACCOUNT",
  idempotencyKey, reason? }`. Core archives the profile, addresses, and devices; deactivates Core's
  saved-payment-method records and customer-portal entitlement; and records a safe audit event. It
  preserves encrypted revisions and operational/audit history rather than deleting financial or
  repair evidence. Closing is blocked with `409 ACTIVE_SUBSCRIPTION_REQUIRES_CANCELLATION` while a
  Device Care subscription is active, pending, past due, or in grace. Auth0 login identity deletion
  is intentionally outside this route because Core does not hold Auth0 Management API credentials.
- `POST /v1/customer-portal/addresses` accepts `{ label?, value, idempotencyKey }`; `value` is an
  encrypted string-only address map. `POST /v1/customer-portal/devices` accepts
  `{ value, idempotencyKey }` and encrypts its string-only device map. Both return the created (or
  retried) owned record, audit the safe action metadata, and return `404 CUSTOMER_PROFILE_NOT_FOUND`
  if the authenticated customer has no active profile.
- `POST /v1/customer-portal/repair-requests` accepts `{ addressId, deviceId?, description,
  preferredWindowStart, preferredWindowEnd, idempotencyKey }`. Core verifies ownership of the active
  address/device, encrypts the repair description, creates a requested job and preferred appointment
  window, and audits the creation. Invalid input returns `400 INVALID_REPAIR_REQUEST`; a missing or
  non-owned address/device returns `404 CUSTOMER_RESOURCE_NOT_FOUND`. This route does not schedule,
  assign, price, or collect payment for the repair.
- `GET /v1/customer-portal/overview` returns only the caller's profile, decrypted addresses and
  devices, quotes, appointment-backed jobs, and subscription agreements. It returns
  `{ page: { limit, offset, nextOffset } }`; payment methods, invoices, receipts, and payment state
  are deliberately omitted until the CORE-018 payment follow-up.
- `GET /v1/employee-portal/profile` returns `{ id, value, assignments }`. An assignment has
  `id`, `storeId`, `departmentId`, `managerEmployeeProfileId`, `effectiveFrom`, and `effectiveTo`.
  Only active, effective assignments are returned. A caller without an active employee profile
  receives `404 EMPLOYEE_PROFILE_NOT_FOUND`.

#### Employee timekeeping and mobile routes

- `GET /v1/employee-portal/time-entries` returns the caller's effective entries, each with
  `{ id, source, startedAt, endedAt, totalSeconds, correctedAt }`. `totalSeconds` excludes any
  unpaid mobile break time. No other employee's entries are ever returned.
- `POST /v1/employee-portal/time-entries` accepts
  `{ startedAt, endedAt, source, idempotencyKey, employeeAssignmentId? }`, where `source` is one
  of `web`, `mobile`, `manager`, or `import`, and `endedAt` must be after `startedAt`. It creates or
  returns the idempotent completed entry.
- `POST /v1/employee-portal/time-entries/:id/corrections` accepts
  `{ startedAt, endedAt, reason, idempotencyKey }`. It never edits the source entry; it appends a
  reasoned correction and audit event. Missing or non-owned entries return
  `404 TIME_ENTRY_NOT_FOUND`.
- `GET /v1/employee-mobile/timekeeping-state` returns
  `{ clockedInAt: timestamp|null, activeBreakStartedAt: timestamp|null }` for the caller only.
- `POST /v1/employee-mobile/time-events` accepts
  `{ eventType, idempotencyKey, jobId? }`, with event types `clock_in`, `clock_out`, `break_start`,
  and `break_end`. Core supplies the authoritative event time, validates the current sequence,
  verifies an optional job is assigned to the caller, records an immutable event and audit record,
  and creates the completed mobile time entry on `clock_out`. An invalid sequence or a reused key
  with a different event returns `409 MOBILE_TIME_EVENT_CONFLICT`.
- `GET /v1/employee-mobile/jobs` returns only jobs assigned to the active caller. Each job has
  `{ id, status, windowStart, windowEnd }`.
- `POST /v1/employee-mobile/jobs/:id/transitions` accepts
  `{ toStatus, reason?, idempotencyKey }`. Core verifies current assignment and the append-only
  workflow graph. Missing or unassigned jobs return `404 JOB_NOT_FOUND`; invalid transitions return
  `409 INVALID_JOB_TRANSITION`.

#### Core Administration routes

- `POST /v1/core-admin/quotes` accepts
  `{ customerProfileId?, idempotencyKey, items: [{ catalogItemKey, quantity }] }`. Core resolves
  active catalog versions, snapshots them, and returns
  `{ id, currency, totalAmountMinor, items }`; every returned line includes the catalog version,
  name, quantity, unit and line minor-unit amounts. It does not accept client-supplied prices.
- `POST /v1/core-admin/jobs` accepts
  `{ customerProfileId?, quoteId?, employeeProfileId?, windowStart, windowEnd, idempotencyKey }`
  and returns `{ id, status, windowStart, windowEnd }`. It creates the appointment and an audited,
  initially `requested` job.
- `POST /v1/core-admin/jobs/:id/transitions` accepts the same transition body as the employee-mobile
  route. Core Admin has a separate `job.transition` permission; transitions are immutable and
  idempotent.
- `POST /v1/core-admin/compensation-assignments` accepts
  `{ employeeProfileId, compensationPlanVersionId, effectiveFrom, effectiveTo? }` and returns the
  new `{ id }`. Effective dates are retained as history.
- `POST /v1/core-admin/commissions` accepts
  `{ employeeProfileId, compensationPlanVersionId, sourceQuoteId?, eligibleRevenueMinor,
  attributionBasisPoints }` and returns `{ id, amountMinor }`. Core derives the rate from the
  selected plan version; clients do not supply a commission amount or rate.
- `POST /v1/core-admin/commissions/:id/events` accepts
  `{ status, reason }`, where status is `earned`, `approved`, `disputed`, `reversed`, or
  `cancelled`; it appends an audited lifecycle event and returns `{ id, status }`.
- `POST /v1/core-admin/payments` accepts `{ amountMinor, currency, idempotencyKey,
  paymentMethodReference }`. `amountMinor` is a decimal string, and `paymentMethodReference` is
  a Square-generated token or card-on-file reference; Core never persists it. Core returns
  `{ id, amountMinor, currency, providerPaymentReference, status }`, audits the action, and returns
  the original operation for a duplicate idempotency key. Provider failures return
  `502 PAYMENT_PROVIDER_UNAVAILABLE`.
- `POST /v1/core-admin/payments/:id/refunds` accepts `{ amountMinor, idempotencyKey, reason }`.
  It returns `{ id, amountMinor, providerRefundReference, status }`, preserves the refund ledger,
  and rejects a request exceeding the original or remaining payment balance with
  `422 REFUND_AMOUNT_EXCEEDS_PAYMENT`.
- `POST /v1/webhooks/square/sandbox` and `/v1/webhooks/square/production` are intentionally
  unauthenticated because Square calls them. Each accepts only a valid
  `x-square-hmacsha256-signature` for that environment's configured exact notification URL and raw
  JSON payload. Core persists each provider event ID before processing, so a replay returns
  `{ status: "duplicate" }` without another state mutation. Invalid signatures return
  `403 INVALID_WEBHOOK_SIGNATURE`; malformed signed events return `400 INVALID_SQUARE_WEBHOOK`.
  While the custom domain is pending, configure Square with
  `https://obsidian-core-2eat.onrender.com/v1/webhooks/square/sandbox` for the sandbox subscription
  and `https://obsidian-core-2eat.onrender.com/v1/webhooks/square/production` for production. Do
  not reuse one listener for both Square environments. After the custom domain is verified, update
  both the Square subscription and its matching `SQUARE_*_WEBHOOK_NOTIFICATION_URL` to the exact
  equivalent `https://api.obsidian-systems.tech/...` URL before testing again.

#### Executive routes

- `POST /v1/executive/subscription-plan-versions` accepts
  `{ planKey, name, currency, amountMinor, cadence, effectiveFrom, providerPlanReference? }` and
  returns `{ id }`. `cadence` is `monthly` or `annual`; production also requires the configured
  Auth0 step-up claim. Core keeps each version instead of changing historical subscription terms.
- `GET /v1/executive/operating-aggregates` returns hierarchy-scoped persisted rows with
  `{ aggregationDate, scopeType, netSalesMinor }`. This is an aggregate read, not a live accounting
  calculation.
- `GET /v1/executive/overview` returns `{ current, previous }`. Each non-null snapshot includes
  `aggregationDate`, `netSalesMinor`, `collectedRevenueMinor`, `estimatedHourlyWagesMinor`,
  `estimatedCommissionsMinor`, and `finalizedPayrollMinor`. Estimated and finalized figures are
  deliberately distinct.

### Environment and deployment contract

| Variable | Required | Current purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection URL. |
| `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` | Yes | Auth0 issuer/JWKS discovery and expected API audience. |
| `FIELD_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY_ID` | Yes | Authenticated field encryption for customer and employee profile payloads. Rotate through a controlled migration, never by changing historical ciphertext in place. |
| `API_ALLOWED_ORIGINS` | Production | Comma-separated HTTPS browser-origin allowlist. |
| `API_SENSITIVE_RATE_LIMIT_MAX`, `API_SENSITIVE_RATE_LIMIT_WINDOW_MS` | No | Per-process sensitive-route limiter configuration. A distributed deployment requires a shared limiter before horizontal scaling. |
| `AUTH0_STEP_UP_CLAIM`, `AUTH0_STEP_UP_VALUE` | Production | Required production step-up authentication configuration. |
| `CORE_API_HOST`, `CORE_API_PORT`, `NODE_ENV` | No | Runtime host, port, and environment controls. |
| `PORT` | Managed-platform runtime | When injected by a platform such as Render, Core binds to this port on `0.0.0.0`; local development continues to use `CORE_API_HOST` and `CORE_API_PORT`. |
| `BOOTSTRAP_SUPER_ADMIN*` | Controlled bootstrap only | One-time local/controlled super-admin provisioning; never set in normal application runtime. |
| `PAYMENTS_ENABLED` | No, default `false` | Explicit safety gate. Set `true` only after selected-provider credentials, public webhook subscription, and sandbox verification are complete. |
| `PAYMENT_PROCESSOR` | No | Payment-provider selector: `square`, `worldpay`, or `commerce360`. `commerce360` is normalized to the Access Worldpay adapter configuration. Default: `square`. |
| `SQUARE_*` | Required when `PAYMENTS_ENABLED=true` and Square is selected | Server-only access token, application/location IDs, API version, exact webhook notification URL, and webhook signature key. |
| `WORLDPAY_*` | Reserved, disabled | Commerce360/Access Worldpay configuration; processing is deliberately blocked pending provider-issued values and verification. |

Production deployment must use managed secret storage, HTTPS termination, a backed-up PostgreSQL
service, a shared rate-limit store when multiple Core instances run, centralized redacted logs, and
an externally monitored readiness endpoint. Core currently has no automatic production deployment,
background worker, hosted object storage, webhook receiver, or provider connection; those are
separate documented priorities rather than hidden assumptions.

### Interchangeable payment-provider configuration

Core owns a provider-neutral payment interface. Set `PAYMENT_PROCESSOR=square` for Square or set
`PAYMENT_PROCESSOR=worldpay` or `PAYMENT_PROCESSOR=commerce360` for the Access Worldpay path used
by Commerce360. The latter two values are intentionally equivalent; internally they select the
`worldpay` adapter. This selector validates the chosen adapter configuration and rejects production
provider modes unless `NODE_ENV=production`.

For Square, populate the existing sandbox or production application, location, and access-token
variables, including the matching `SQUARE_*_WEBHOOK_NOTIFICATION_URL` and
`SQUARE_*_WEBHOOK_SIGNATURE_KEY`. Do not set `PAYMENTS_ENABLED=true` until Square has accepted the
public HTTPS subscription URL and a signed sandbox event test succeeds. For Commerce360/Worldpay, populate `WORLDPAY_USERNAME`, `WORLDPAY_PASSWORD`, optional
`WORLDPAY_BASE_URL`, `WORLDPAY_ENVIRONMENT`, `WORLDPAY_API_VERSION`, and the planned HTTPS
`WORLDPAY_WEBHOOK_NOTIFICATION_URL`. Worldpay supplies credentials through its onboarding process;
the integration must use a trusted HTTPS webhook endpoint. No raw card details, CVVs, or provider
credentials reach a GUI or are committed to the repository. The runtime selector is configured now,
Worldpay processing remains disabled until its provider contract, credentials, event types, signing
scheme, and sandbox/production behavior are verified. Changing `PAYMENT_PROCESSOR` alone never
activates it.

### Production-readiness scope

Completed CORE priorities are production-grade for their documented API boundaries, not claims that
every adjacent business workflow is already live. The production-readiness audit records remaining
end-to-end integrations as CORE-029 through CORE-035: administrative master-data writes, quote
approval/acceptance, aggregate refresh, Square payment/webhooks, authorization administration,
machine-readable API contracts, and production deployment durability.
They are explicit prerequisites before relying on those workflows as operational systems of record.

### Authorization

Core resolves each Auth0 subject to an active internal user, then requires both an active application
entitlement and an effective role permission. Authorization is default-deny: authentication alone
does not grant any application access. `GET /v1/core-admin/authorization/access` is the initial
authorization-enforced boundary and requires the server-declared `core-admin` application
entitlement and `authorization.read` permission; missing authorization returns `403 FORBIDDEN`.
Future resource routes will use this same server-side guard and add organization/resource scope checks.

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

`CORE-005` uses the foundation tables to resolve an Auth0 identity to a Core user, application
entitlement, roles, and permissions. Current role assignments and entitlements are evaluated using
their effective dates and deactivation state. User provisioning and role/entitlement administration
will be added in later priorities; no user receives access by default.

### Organization hierarchy

`GET /v1/core-admin/organization-hierarchy` returns active organization, business unit, district,
store, and department records in parent order. It requires the `core-admin` entitlement and
`organization.read` permission. Core preserves unassigned departments explicitly rather than assigning
them to an arbitrary store. Organization mutation workflows are deferred until they can be audited and
permission-controlled.

### Customer profiles and addresses

Customer profiles and reusable addresses are separate from Auth0 identities. Their payloads are stored with AES-256-GCM application-layer encryption using `FIELD_ENCRYPTION_KEY` and `FIELD_ENCRYPTION_KEY_ID`; keys must be managed outside the repository. `GET /v1/customer-portal/profile` is membership-scoped and requires `customer-portal` plus `customer.profile.read`. Customer write and administrative workflows remain deferred.

### Employee profiles and assignments

Employee profiles are separate from Auth0 identities and store their profile payloads using the
same AES-256-GCM application-layer encryption configuration as customer profiles. Core preserves
effective-dated store, department, and manager assignments rather than overwriting prior
assignments. `GET /v1/employee-portal/profile` is self-service only: it requires the
`employee-portal` entitlement and `employee.profile.read` permission, and returns the profile
linked to the authenticated identity together with currently effective assignments.

SSNs, government-ID copies, payroll tax details, compensation data, employee write workflows, and
administrative assignment workflows are intentionally not collected by this iteration. They require
separate least-privilege access, audit, retention, encrypted-document-storage, and compliance
controls before Core accepts them.

### Timekeeping

Core records completed work intervals in UTC for employees of every classification, including
salaried employees. `GET` and `POST /v1/employee-portal/time-entries`, plus
`POST /v1/employee-portal/time-entries/:id/corrections`, require `employee-portal` and
`timekeeping.self.manage`; they are self-service boundaries tied to the authenticated employee
profile. Creation and corrections require UUID idempotency keys. Time entries and corrections are
append-only at the database layer. A correction requires a reason, preserves the original interval,
becomes the effective interval for reads, and creates an audit event without storing sensitive time
values in the audit metadata.

This iteration records time but does not calculate payroll, overtime, hourly estimates, salaries,
or commissions. Those calculations require effective-dated compensation and payroll policies.

### Catalog and quotes

Core stores products, services, parts, labor, and fees as effective-dated catalog versions with
integer minor-unit prices. `POST /v1/core-admin/quotes` requires `core-admin` and `quote.create`.
It accepts catalog item keys, integer quantities, and an idempotency key; Core resolves active
versions, calculates the total, and snapshots the resolved item/version/name/price/quantity and
pricing context. A later catalog version cannot change an existing quote.

The initial engine is intentionally limited to catalog-derived, single-currency lines. Tax,
discounts, store overrides, manual overrides, approval/issue states, customer acceptance evidence,
and payment conversion require separate policy and audit workflows.

### Jobs and appointments

Core creates jobs with appointment windows and optional customer, quote, and employee references.
`POST /v1/core-admin/jobs` requires `job.create`; job transitions use
`POST /v1/core-admin/jobs/:id/transitions` and require `job.transition`. Core permits only its
defined workflow transitions and records each transition immutably with an actor, reason,
idempotency key, and correlation ID. Mapping and route optimization are deferred to a dedicated
provider adapter after route-stop and dispatch policies are defined.

### Square configuration placeholders

`.env.example` contains separate sandbox and production placeholders for the server-side Square
adapter: access token, application ID, location ID, webhook signature key, notification URL, and API
version. `SQUARE_ENVIRONMENT` selects the active mode. Development and test deployments must select
`sandbox`; the future adapter will reject production mode unless `NODE_ENV=production`. Keep all values
in environment-specific secret management. Never expose access tokens or webhook signature keys to any
GUI. CORE-032 implements payment and refund calls, an append-only operational ledger, signed webhook
verification, provider-event replay protection, and payment-state audit history. It does not yet
implement invoices, saved-payment-method lifecycle, Square Catalog plan synchronization, or
automated recurring billing; those remain CORE-018/021/022 follow-up work.

For the configured Device Care enrollment workflow, set the active environment's
`SQUARE_*_DEVICE_CARE_PLAN_VARIATION_ID` and `SQUARE_*_DEVICE_CARE_ORDER_TEMPLATE_ID`. The order
template must be a customer-neutral, open Square order containing the `$15.00` item variation; Core
combines it with the authenticated customer's Square customer ID and a card-on-file ID. For the
current sandbox configuration, use `NVzIs5FJwKYC5C7fvRs2gtTHTe4F` as the order-template value. Do
not place this identifier in a client application or use a customer-specific order as the template.

### Payment-provider adapter contract

CORE-012 verifies Square's documented sandbox, payment, subscription, invoice, idempotency, and
webhook-signature capabilities and defines a provider-neutral Core payment contract. It accepts
only provider payment-method references and integer minor-unit amounts—never raw card data. The
configuration loader selects sandbox or production credentials without exposing them to any GUI and
rejects production Square mode unless `NODE_ENV=production`. CORE-032 implements the active Square
adapter behind that contract. A payment method reference is used only in the outbound request and is
never stored; Core persists provider payment/refund references, integer minor-unit amounts, statuses,
idempotency keys, and safe audit metadata. The webhook handler validates Square's HMAC-SHA256 header
using the subscription signature key, exact notification URL, and raw request body before it writes
its replay ledger or changes payment state.

### Subscription plans

`POST /v1/executive/subscription-plan-versions` is executive-authorized, serialized per plan key,
transactional, and audited. Core seeds the initial `$15.00` monthly `device-care` version and
preserves all later executive-created versions. The customer enrollment boundary additionally saves
only Square's card-on-file reference and safe display metadata (brand, last four digits, and expiry),
never a raw card number, CVV, source token, or buyer-verification token.

`POST /v1/customer-portal/payment-methods` accepts `{ cardholderName, sourceId,
verificationToken?, saveCardConsent: true, idempotencyKey }`. `sourceId` and optional
`verificationToken` must be produced by Square's browser SDK and are forwarded once to Square; they
are not persisted or logged. It returns `{ id, brand, last4, expMonth, expYear, status }`. Square
rejections return the generic `502 PAYMENT_PROVIDER_UNAVAILABLE`; Core logs only Square's safe
status, error code, and field for operational diagnosis.
`POST /v1/customer-portal/subscriptions/device-care` accepts `{ paymentMethodId, idempotencyKey }`,
requires the caller to own an active saved card, then creates the Square subscription and returns the
Core agreement `{ id, status, renewalAt, providerSubscriptionReference }`. Invalid bodies return
`400`; missing profile returns `404 CUSTOMER_PROFILE_NOT_FOUND`; missing card/configuration returns
`409 DEVICE_CARE_CONFIGURATION_UNAVAILABLE`; Square rejection returns `502
PAYMENT_PROVIDER_UNAVAILABLE`. Both operations are idempotent and safely audited.

Customer payment-method lifecycle is Core-owned. `GET /v1/customer-portal/payment-methods` returns
only `{ id, brand, last4, expMonth, expYear, status, isPrimary }`; it never returns Square customer
IDs, card IDs, card source tokens, or raw payment data. `PUT
/v1/customer-portal/payment-methods/:id/primary` accepts `{ idempotencyKey }`, atomically records
the new primary method, and asks Square to replace the card used by every current Device Care
subscription owned by that customer. `DELETE /v1/customer-portal/payment-methods/:id` accepts the
same idempotency body and disables the Square card only when no pending, active, past-due, or grace
subscription references it; otherwise it returns `409 PAYMENT_METHOD_IN_USE`. `POST
/v1/customer-portal/subscriptions/device-care/cancel` accepts `{ idempotencyKey }` and schedules
cancellation through Square at the end of the active billing period. The agreement remains active
until Square reports the final canceled state, so its billing card cannot be removed prematurely.

Subscription plans and their effective-dated versions use integer minor-unit prices, cadence, and
optional provider references. Customer subscriptions preserve the selected plan version and safe
provider subscription reference—never card credentials. The initial configurable **Obsidian Device
Care** default is `$15.00` monthly. Future plan versions are restricted to the `executive-panel`
entitlement and `subscription.plan.manage` permission, so Executive users can change pricing or
cadence without rewriting existing agreements.

### Obsidian Device Care policy

Device Care is a Core-owned membership program, not a Square payment-link feature. Square may
collect a temporary enrollment payment, but Core must reconcile that provider subscription into the
member agreement, repair-credit ledger, benefit entitlements, and audit history.

- Each active `$15.00` monthly payment accrues Repair Credits. Credits are usable once the member's
  balance reaches `$60.00`, are capped at `$350.00`, and use integer minor units.
- An active member who does not use Repair Credits on a repair receives `10%` off eligible repairs
  and repair parts, plus `15%` off eligible accessories and other eligible inventory excluding parts.
- Credits may be applied to eligible devices owned by the member's immediate household. Core must
  require explicit, auditable household membership and device ownership before an application.
- The membership must remain active to retain credits. Any lapse, grace period, forfeiture trigger,
  reinstatement rule, and restoration behavior must be versioned executive policy; Core must never
  silently delete a credit balance.
- At the `$350.00` cap, a member receives MAX Status while the membership remains active. Further
  monthly payments maintain—not exceed—the cap. MAX benefits are priority service when practical,
  free diagnostics, one free cleaning/detailing entitlement every three months, `20%` eligible
  accessory discount, complimentary minor cleaning services, free screen-protector installation
  with protector purchase, loaner-device priority when available, and a `90`-day workmanship
  warranty rather than the standard `60` days.
- If a MAX member spends credits and drops below `$350.00`, future active monthly payments resume
  credit accrual until the cap and MAX Status are reached again.

The detailed credit ledger, eligibility rules, benefit-redemption limits, household relationship
model, lapse policy, and repair-price application are scheduled as CORE-036. A future customer UI
must read Core's available balance and benefits; it must not calculate credits or discounts itself.

### Compensation and commissions

**Current implementation boundary:** CORE-014 provides the effective-dated compensation and
commission schema plus the integer-based calculation helper. It does not yet provide administrative
assignment, commission generation or adjustment, employee earnings, or payroll-export workflows;
those writes must be authorized and audited when CORE-027 implements them.

CORE-027 adds Core-admin compensation assignment and commission APIs plus an employee earnings
estimate read. Commission entries are immutable: lifecycle changes are append-only commission events
with an actor, correlation ID, reason, and audit event. Earnings responses report estimated and
pending commission minor units only; they are not finalized payroll, wages, overtime, taxes, or a
payroll-provider export.

Core uses effective-dated hourly or salary compensation plans and employee assignments. Commission
entries snapshot eligible revenue, a configurable basis-point rate, attribution, and lifecycle
status using integer minor units. The initial configuration is `$20.00/hour` and `10%`, but it is
versioned policy rather than a hard-coded payroll rule. Earnings remain estimates until finalized
through payroll export.

### Operating aggregates

**Current implementation boundary:** CORE-015 defines the aggregate schema and authorized reads,
but no aggregate-refresh pipeline exists yet. The endpoint returns only rows already persisted by
an authorized operational process and resolves store and district rows through the executive's
effective organization hierarchy.

Core persists daily store, district, and company aggregate records that keep gross sales, discounts,
refunds, net/collected/outstanding revenue, estimated hourly wages, estimated commissions, and
finalized payroll distinct. Aggregate records identify whether their source is estimated or
finalized; they are not accounting statements until their source systems finalize them.
`GET /v1/executive/operating-aggregates` requires `executive-panel` and `reporting.read`; Core
filters aggregate rows to the executive's effective organization scope.

### Bootstrap Super Admin

The controlled `npm run db:seed` bootstrap creates or reactivates one Core user, maps a supplied
Auth0 User ID, and grants the initial `core-admin` entitlement with the currently defined
`authorization.read` permission. It is disabled by default and requires all three environment
variables: `BOOTSTRAP_SUPER_ADMIN=true`, `BOOTSTRAP_SUPER_ADMIN_EMAIL`, and
`BOOTSTRAP_SUPER_ADMIN_AUTH0_SUBJECT`. The email and Auth0 subject are local operational data and
must never be committed. The seed is idempotent and refuses to remap an Auth0 subject already
assigned to another Core user. "Super Admin" does not bypass authorization; future permissions must
be assigned explicitly as they are introduced.

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

For recurring subscriptions, customer-facing applications submit the customer's selected plan and
payment-method consent to Core. Core owns the automated lifecycle: due-date tracking, operational
invoice creation, tokenized saved-card charges through Square, signed webhook handling, payment
retries, grace periods, cancellation state, and billing notifications. This behavior must be
configurable, idempotent, auditable, and shared by every Obsidian application.

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

Core now exposes `GET /v1/executive/overview` for the Vercel-hosted Executive Panel. It requires a
valid Auth0 access token plus the `executive-panel` entitlement and `reporting.read` permission.
The response compares the latest persisted aggregate date with the preceding available date in the
caller’s organization scope. It keeps net sales, collected revenue, estimated hourly wages,
estimated commissions, and finalized payroll distinct; it does not generate or finalize accounting
records.

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
17. `CORE-017` — Employee mobile clock and assigned-job integration
18. `CORE-018` — Customer portal integration
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
