import { ForbiddenError, localDev, verifyHttpBasic, withAuthChallenges, type AuthResult } from "eve/channels/auth";

const developmentAuth = localDev();
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

export async function localOperatorAuth(request: Request) {
  // Checking every host also covers Next's proxy and prevents DNS rebinding.
  const hosts = [new URL(request.url).host, request.headers.get("host"), request.headers.get("x-forwarded-host")];
  if (hosts.some(host => host !== null && !loopbackHost.test(host))) return null;
  const auth = await developmentAuth(request);
  return auth ? operatorIdentity(auth) : null;
}

function operatorCredentials() {
  const username = process.env.BELL_OPERATOR_USERNAME?.trim();
  const password = process.env.BELL_OPERATOR_PASSWORD;
  return username && !username.includes(":") && password && Buffer.byteLength(password) >= 32
    ? { username, password } : undefined;
}

export const operatorAuth = withAuthChallenges((request: Request) => {
  // Browser requests need this guard even when local development auth is used.
  // Server clients do not send browser origin metadata and authenticate normally.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      (request.headers.has("origin") || request.headers.has("sec-fetch-site")))
    assertOperatorOrigin(request);
  const credentials = operatorCredentials();
  if (!credentials) return null;
  const result = verifyHttpBasic(request.headers.get("authorization"), credentials);
  return result.ok ? operatorIdentity(result.sessionAuth) : null;
}, [{ scheme: "Basic", parameters: { realm: "Bell", charset: "UTF-8" } }]);

function assertOperatorOrigin(request: Request): void {
  const expected = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto");
  if (host) { expected.port = ""; expected.host = host; }
  if (protocol === "https" || protocol === "http") expected.protocol = `${protocol}:`;
  const origin = request.headers.get("origin");
  if (origin !== null ? origin !== expected.origin : request.headers.get("sec-fetch-site") !== "same-origin")
    throw new ForbiddenError({ message: "Same-origin access required." });
}

// Basic and loopback development access represent the same personal assistant owner.
function operatorIdentity(auth: AuthResult): AuthResult {
  return { ...auth, principalType: "user", issuer: "bell:operator", principalId: "operator" };
}
