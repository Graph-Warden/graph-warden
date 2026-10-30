import { paginate } from "@/lib/pagination";

const orders = [{ id: "o-1", total: 42 }];

export const listOrders = (cursor?: string) => paginate(orders, cursor);
export const getOrder = (id: string) => orders.find((order) => order.id === id);
export const refundOrder = (id: string) => ({ ...getOrder(id), refunded: true });
