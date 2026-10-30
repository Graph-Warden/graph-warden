---
type: Module
scope: team:data
references:
  - { type: EXPOSES, to: recommendations-api }
  - { type: CONSUMES, to: customer-360 }
---
# recommendations-service

Retrained every Sunday on customer_360. A customer erased on Monday stays in the model's features until the next training.
