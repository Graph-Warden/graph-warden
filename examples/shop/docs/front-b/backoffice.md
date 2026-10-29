---
type: Module
scope: team:front-b
references:
  - { type: CONSUMES, to: orders-api }
---
# back-office

Exports every order page by page, `page` from 1 to N.
