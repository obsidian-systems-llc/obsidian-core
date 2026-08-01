# ADR-0005: Core owns Square payment workflows

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Context

The Obsidian Systems website and Obsidian Prospecting Engine will sell online items and website
services. They need hosted payment collection, invoices, and recurring retainer subscriptions.
Those applications are user interfaces, not payment systems of record.

## Decision

Use Square through Obsidian Core for all payment workflows. External applications may initiate a
checkout, invoice, or subscription request through Core APIs, but Core owns authorization,
idempotency, processor calls, webhook verification, payment state changes, invoice and receipt
records, and audit events.

Support general invoices and configurable retainer subscriptions in addition to the separate
device-protection subscription offering. The processor remains authoritative for payment processing
and settlement; Core remains authoritative for the related operational workflow and records.

## Consequences

- The website and Prospecting Engine must never receive Square secret credentials or finalize
  payment state directly.
- Payment APIs require server-side authorization and idempotency keys where a request may be retried.
- Square webhooks must be signature-verified, replay-safe, and auditable before they change Core
  records.
- General invoicing and retainer subscriptions are planned as a separate follow-up after the Square
  adapter contract and customer foundations are complete.
