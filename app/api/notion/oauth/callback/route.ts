import { notionCallback } from "../../../../../server/notion/callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => notionCallback(request);
