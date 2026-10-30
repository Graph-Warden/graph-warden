---
type: Module
scope: team:shopping-front
references:
  - { type: EXPOSES, to: clickstream-events }
---
# web tracking

Server-side tagging of the web shop: sends the clickstream events, without the customer id when marketing consent is withdrawn.
