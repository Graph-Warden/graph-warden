---
type: Module
scope: team:shopping-front
references:
  - { type: CONSUMES, to: recommendations-api }
  - { type: CONSUMES, to: user-profile-api }
---
# product page (web)

Shows "You may also like" from /recommendations, greets a signed-in customer by first name, and prefills the newsletter box with `email` from the profile.
