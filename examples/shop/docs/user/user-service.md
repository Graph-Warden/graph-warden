---
type: Module
scope: team:user
references:
  - { type: EXPOSES, to: user-profile-api }
  - { type: EXPOSES, to: consent-events }
---
# user-service

Accounts, profiles and consents. Erasing an account deletes the profile at once and publishes `account.erased` on user.consent.v1; what other teams copied is theirs to purge.
