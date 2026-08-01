# ADR-0018: Persist daily operating aggregates with source status

Core uses daily store, district, and company aggregate records for reporting rather than relying on
dashboard queries against operational tables. Monetary values are integer minor units; estimated
workforce costs remain separate from finalized payroll and settlement figures.
