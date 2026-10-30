---
type: Concept
scope: shared
references:
  - { type: DERIVED_FROM, to: adr-0012-email-out-of-profile }
  - { type: DERIVED_FROM, to: product-page }
  - { type: DERIVED_FROM, to: customer-360 }
---
# Impact of profile v2

Summary written for the leads: ADR 0012 breaks the newsletter prefill of the product page, and the nightly CRM matching of customer_360, which joins on `email`. Both need the contact purpose, or another key.
Declared shared, but derived from User, Shopping-Front and Data documents: ingestion narrows it.
