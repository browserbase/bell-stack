import { getPoppyIdentity } from "../../../server/poppy/identity";

export const dynamic = "force-dynamic";
export function GET() {
  try { return Response.json(getPoppyIdentity().clientMetadata(), { headers: { "cache-control": "public, max-age=300" } }); }
  catch { return Response.json({ error: "Poppy identity is not configured." }, { status: 503 }); }
}
