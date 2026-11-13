import { getPoppyIdentity } from "../../../server/poppy/identity";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await getPoppyIdentity().publicJwks(), { headers: { "cache-control": "public, max-age=300" } }); }
  catch { return Response.json({ error: "Poppy identity is not configured." }, { status: 503 }); }
}
