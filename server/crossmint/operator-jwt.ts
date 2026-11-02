import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

/**
 * The operator's JWT for Crossmint Agent Cards.
 *
 * Crossmint accepts order intent calls only with the user's JWT. Bell serves one trusted operator,
 * so it issues that JWT itself as the project's custom JWT provider: RS256, `iss` the Crossmint
 * project id, `sub` the operator's CROSSMINT_USER_ID, `aud` crossmint.com, ten minutes. Crossmint
 * checks the signature against the JWKS Bell serves at /api/crossmint/jwks.
 * Guide: https://docs.crossmint.com/introduction/platform/api-keys/custom-jwt-auth-guide
 *
 * This file uses only erasable TypeScript, so scripts/crossmint-operator-jwt.mjs can load it.
 */

export const JWT_TTL_SECONDS = 600;
const AUDIENCE = "crossmint.com";

export interface OperatorJwtConfig {
  projectId: string;
  userId: string;
  privateKey: KeyObject;
}

/** Read CROSSMINT_JWT_PRIVATE_KEY: a PEM RSA private key, base64 encoded as in Crossmint's guide, or plain. */
export function parseRsaPrivateKey(value: string): KeyObject | undefined {
  const text = value.includes("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  try {
    const key = createPrivateKey(text);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return key.asymmetricKeyType === "rsa" && bits >= 2048 ? key : undefined;
  } catch {
    return undefined;
  }
}

function publicJwk(privateKey: KeyObject): { kty: "RSA"; n: string; e: string; kid: string } {
  const { n, e } = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof n !== "string" || typeof e !== "string") throw new Error("The operator key is not an RSA key.");
  // RFC 7638 thumbprint: the required members in lexicographic order.
  const kid = createHash("sha256").update(JSON.stringify({ e, kty: "RSA", n })).digest("base64url");
  return { kty: "RSA", n, e, kid };
}

/** The public half of the operator key, as the JWKS Crossmint fetches. */
export function operatorJwks(privateKey: KeyObject) {
  return { keys: [{ ...publicJwk(privateKey), alg: "RS256", use: "sig" }] };
}

/** Sign a short-lived operator JWT. It stays on the server, except on the operator-only setup page. */
export function operatorJwt(config: OperatorJwtConfig, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid: publicJwk(config.privateKey).kid });
  const payload = encode({ iss: config.projectId, sub: config.userId, aud: AUDIENCE, iat, exp: iat + JWT_TTL_SECONDS });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), config.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
