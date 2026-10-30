---
type: Decision
scope: team:user
references:
  - { type: DECIDES, to: user-profile-api }
---
# ADR 0012: email and phone leave the profile

From profile v2, `email` and `phone` are no longer in GET /users/{id}/profile. They move to GET /users/{id}/contact, granted only to services with a declared contact purpose.
Follows a finding of the September GDPR audit (personal data served to callers that do not need it), not shared outside the User team yet.
