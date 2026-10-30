---
type: Decision
scope: shared
references:
  - { type: DECIDES, to: clickstream-events }
  - { type: FIXES, to: incident-208 }
---
# ADR 0003: a versioned clickstream contract

Written by Data and Shopping-Front together. An event is renamed only in a new version of the contract (web.v3), both names are sent for a month, and the dbt tests fail on an unknown event instead of counting zero.
