import { paginate } from "../lib/pagination";

export const listRecommendations = () => paginate(["p-1", "p-2"], undefined);
