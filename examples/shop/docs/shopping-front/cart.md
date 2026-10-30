---
type: Module
scope: team:shopping-front
references:
  - { type: CONSUMES, to: user-profile-api }
  - { type: CONSUMES, to: recommendations-api }
---
# cart (web)

Estimates delivery from the default address of the profile, and fills the "complete your cart" row from /recommendations.
