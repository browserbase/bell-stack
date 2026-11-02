import { operatorJwks, parseRsaPrivateKey } from "../../../../server/crossmint/operator-jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

// Public by design: Crossmint fetches this to check the operator JWTs Bell signs.
export function GET() {
  const configured = process.env.CROSSMINT_JWT_PRIVATE_KEY?.trim();
  if (!configured) return new Response("Not found.", { status: 404, headers });
  const key = parseRsaPrivateKey(configured);
  if (!key) return new Response("Check CROSSMINT_JWT_PRIVATE_KEY in the server configuration.", { status: 500, headers });
  return Response.json(operatorJwks(key), { headers: { ...headers, "cache-control": "public, max-age=300" } });
}
