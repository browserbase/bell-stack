import { routeAuth } from "eve/channels/auth";
import { NextResponse } from "next/server";
import { operatorAuth } from "./server/operator-auth";

// The Crossmint card setup page is for the operator only. Asking here lets the browser show its
// HTTP Basic prompt; the page and its action route check again.
export async function proxy(request: Request) {
  const auth = await routeAuth(request, [operatorAuth]);
  return auth instanceof Response ? auth : NextResponse.next();
}

export const config = { matcher: ["/crossmint/:path*"] };
