---
type: Module
scope: team:data
title: BigQuery analytics.customer_360
references:
  - { type: CONSUMES, to: clickstream-events }
  - { type: CONSUMES, to: consent-events }
  - { type: CONSUMES, to: user-profile-api }
  - { type: CONSUMES, to: orders-api }
---
# BigQuery analytics.customer_360

One row per customer, rebuilt every night by dbt: profile snapshot (matched to the CRM on `email`), orders exported from GET /orders page 1 to N, and the last 90 days of clickstream. Holds personal data: the Data team only.
