import { routeAuth } from "eve/channels/auth";
import { NextResponse } from "next/server";
import { operatorAuth } from "./server/operator-auth";

// No other site may frame these pages, so a hostile page cannot trick the operator into a click.
const FRAME_HEADERS = { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" };

// The Crossmint setup page is for the operator only. Asking here lets the browser show its HTTP
// Basic prompt; the page and every action check again.
export async function proxy(request: Request) {
  const auth = await routeAuth(request, [operatorAuth]);
  const response = auth instanceof Response ? auth : NextResponse.next();
  for (const [name, value] of Object.entries(FRAME_HEADERS)) response.headers.set(name, value);
  return response;
}

export const config = { matcher: ["/crossmint/:path*"] };
