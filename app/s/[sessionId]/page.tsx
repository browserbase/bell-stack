import { headers } from "next/headers";
import { priceLineForOperator } from "../../../server/operator-auth";
import Chat from "../../chat";
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const priceLine = priceLineForOperator(await headers());
  return (
    <Chat priceLine={priceLine} sessionId={sessionId} demoUrl={process.env.BELL_DEMO_URL ?? "https://example.com"} />
  );
}
