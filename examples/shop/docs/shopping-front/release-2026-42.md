---
type: Change
scope: team:shopping-front
references:
  - { type: MODIFIES, to: web-tracking }
  - { type: CAUSES, to: incident-208 }
---
# Release 2026.42

New cart drawer. Renames the `add_to_cart` event to `cart_add` to match the design system naming.
