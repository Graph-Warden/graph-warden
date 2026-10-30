import { BFF } from "./api";

export async function home() {
  const profile = await fetch(`${BFF}/profile`).then((r) => r.json());
  const recommended = await fetch(`${BFF}/recommendations`).then((r) => r.json());
  return { profile, recommended };
}
