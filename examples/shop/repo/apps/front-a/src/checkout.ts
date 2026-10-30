import { listOrders, getProfile } from "@shop/api-client";
import { euros } from "~/format";

export async function checkout() {
  const [{ orders }, profile] = await Promise.all([listOrders(), getProfile()]);
  return `${profile.name}: ${orders.map((order) => euros(order.total)).join(", ")}`;
}
