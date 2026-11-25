import { headers } from "next/headers";
import { priceLineForOperator } from "../server/operator-auth";
import Chat from "./chat";
export default async function Page() {
  const priceLine = priceLineForOperator(await headers());
  return <Chat priceLine={priceLine} demoUrl={process.env.BELL_DEMO_URL ?? "https://example.com"} />;
}
