# ADR-0013: Version catalog prices and snapshot quotes

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Decision

Represent products, services, parts, labor, and fees as catalog items with immutable,
effective-dated versions. Store all prices and quote totals as integer minor units. Core resolves
the active catalog version, calculates each line and total, and snapshots the item key, version,
name, quantity, price, currency, and catalog-v1 pricing context into an idempotent quote.

## Consequences

Changing the catalog cannot rewrite a quote that was already created. This initial engine accepts
only catalog-derived lines in one currency. Tax, discount, fee policy, store overrides, manual
overrides, issuing/approving, customer acceptance, and payment conversion remain deferred until
their dedicated, auditable workflows are defined.
