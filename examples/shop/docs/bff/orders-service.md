---
type: Module
scope: team:bff
references:
  - { type: EXPOSES, to: orders-api }
---
# orders-service

BFF module behind `GET /orders`. Talks to the legacy ERP through a batch adapter; retries are not idempotent yet.
