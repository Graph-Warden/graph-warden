import type { Principal } from "./scope.js";

// Port for the identity provider (proposal 0010): turns a bearer token into the principal it was
// issued for, with the groups the provider reports for them, nested groups resolved. Graph-Warden
// keeps no users, groups or roles of its own.
export interface IdentityProvider {
  // Rejects with `Unauthenticated` when the token is missing, invalid, expired or not meant for
  // this service.
  principalFor(token: string): Promise<Principal>;
}

export class Unauthenticated extends Error {
  override readonly name = "Unauthenticated";
}
