// Generated from apps/bff/openapi.yaml. Do not edit.
import { request } from "./http";

export interface Profile {
  id: string;
  name: string;
}

/** @operationId getProfile */
export const getProfile = () => request<Profile>("GET", "/profile");
