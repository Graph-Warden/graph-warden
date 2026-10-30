import { getOrder, refundOrder } from "@shop/api-client";

export async function refund(id: string) {
  const order = await getOrder(id);
  return order.total > 0 ? refundOrder(id) : order;
}
