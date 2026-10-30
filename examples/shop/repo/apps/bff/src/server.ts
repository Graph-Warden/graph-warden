import { getOrder, listOrders, refundOrder } from "./routes/orders";
import { getProfile } from "./routes/profile";
import { listRecommendations } from "@/routes/recommendations";

export const routes = {
  "GET /orders": listOrders,
  "GET /orders/{id}": getOrder,
  "POST /orders/{id}/refund": refundOrder,
  "GET /profile": getProfile,
  "GET /recommendations": listRecommendations,
};
