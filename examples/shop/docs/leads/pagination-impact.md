---
type: Concept
scope: shared
references:
  - { type: DERIVED_FROM, to: adr-0007-cursor-pagination }
  - { type: DERIVED_FROM, to: checkout }
  - { type: DERIVED_FROM, to: backoffice }
---
# Impact of cursor pagination

Summary written for the leads: ADR 0007 breaks checkout (page=1) and the back-office export (page 1..N).
Declared shared, but derived from BFF, front-a and front-b documents: ingestion narrows it.
