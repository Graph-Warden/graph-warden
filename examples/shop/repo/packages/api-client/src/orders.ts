// Generated from apps/bff/openapi.yaml. Do not edit.
import { request } from "./http";

export interface Order {
  id: string;
  total: number;
}

/** @operationId listOrders */
export const listOrders = (cursor?: string) => request<{ orders: Order[]; next?: string }>("GET", `/orders${cursor ? `?cursor=${cursor}` : ""}`);

/** @operationId getOrder */
export const getOrder = (id: string) => request<Order>("GET", `/orders/${id}`);

/** @operationId refundOrder */
export const refundOrder = (id: string) => request<Order>("POST", `/orders/${id}/refund`);
