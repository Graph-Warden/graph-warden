---
type: Decision
scope: team:bff
references:
  - { type: DECIDES, to: orders-api }
---
# ADR 0007: cursor pagination on /orders

Offset pagination is replaced by cursors in Q1. `page` is removed; clients must send `cursor`.
Driven by the ERP migration, which is not announced outside the BFF team yet.
