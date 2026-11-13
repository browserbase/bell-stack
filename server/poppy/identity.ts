import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify,
  type JsonWebKey, type KeyObject,
} from "node:crypto";

export interface PoppyIdentityConfig {
  clientId: string;
  privateJwk: JsonWebKey | string;
  jwksUri?: string;
  now?: () => number;
}

export interface PoppySessionRequest {
  company: string;
  version: string;
  userId: string;
  sessionId: string;
  method: string;
  url: string;
  accessToken?: string;
}

function httpsUrl(value: string, allowFragment = false): URL {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && (allowFragment || !url.hash)) return url;
  } catch { /* Return a configuration error without the supplied value. */ }
  throw new Error("Poppy requires an HTTPS URL without credentials or a fragment.");
}

function publicEcJwk(key: KeyObject): JsonWebKey {
  const exported = createPublicKey(key).export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x: exported.x, y: exported.y };
}

function thumbprint(key: JsonWebKey): string {
  return createHash("sha256").update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest("base64url");
}

function jwt(key: KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

const randomId = () => randomBytes(32).toString("base64url");
interface Delegation { key: KeyObject; kid: string; token: string; legacyToken?: string; issuedAt: number; expiresAt: number }

export class PoppyIdentity {
  readonly clientId: string;
  readonly jwksUri: string;
  readonly #rootKey: KeyObject;
  readonly #rootJwk: JsonWebKey;
  readonly #rootKid: string;
  readonly #now: () => number;
  readonly #delegations = new Map<string, Delegation>();

  constructor(config: PoppyIdentityConfig) {
    const client = httpsUrl(config.clientId);
    if (client.search) throw new Error("Poppy client metadata URL must not contain a query.");
    this.clientId = config.clientId;
    this.jwksUri = config.jwksUri ?? new URL("jwks.json", client).href;
    const jwks = httpsUrl(this.jwksUri);
    if (jwks.hostname !== client.hostname || jwks.search)
      throw new Error("Poppy public keys must be on the client metadata domain.");
    this.#now = config.now ?? Date.now;
    try {
      const source: JsonWebKey = typeof config.privateJwk === "string" ? JSON.parse(config.privateJwk) : config.privateJwk;
      if (source.kty !== "EC" || source.crv !== "P-256" || (source.alg && source.alg !== "ES256")
        || ![source.x, source.y, source.d].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
          && Buffer.from(value, "base64url").toString("base64url") === value)) throw new Error();
      this.#rootKey = createPrivateKey({ key: source, format: "jwk" });
      this.#rootJwk = publicEcJwk(this.#rootKey);
      this.#rootKid = thumbprint(this.#rootJwk);
      // Reject a private scalar paired with a different public key.
      const probe = Buffer.from("Bell Poppy signing key validation");
      if (!verify("sha256", probe, createPublicKey(this.#rootKey), sign("sha256", probe, this.#rootKey))) throw new Error();
    } catch {
      throw new Error("Configure BELL_POPPY_PRIVATE_JWK with a valid private ES256 JWK.");
    }
  }

  publicJwks() {
    return { keys: [{ ...this.#rootJwk, kid: this.#rootKid, alg: "ES256", use: "sig" }] };
  }

  clientMetadata() {
    return {
      client_id: this.clientId, client_name: "Bell", jwks_uri: this.jwksUri,
      token_endpoint_auth_method: "private_key_jwt",
    };
  }

  assertion(issuer: string): string {
    if (httpsUrl(issuer).search) throw new Error("Poppy issuer must not contain a query.");
    const now = Math.floor(this.#now() / 1000);
    return jwt(this.#rootKey, { alg: "ES256", typ: "JWT", kid: this.#rootKid }, {
      iss: this.clientId, sub: this.clientId, aud: issuer, iat: now, exp: now + 60, jti: randomId(),
    });
  }

  sessionHeaders(request: PoppySessionRequest): Record<string, string> {
    if (httpsUrl(request.company).search || !/^\d+\.\d+$/.test(request.version)
      || !/^[A-Za-z0-9_-]{1,256}$/.test(request.sessionId) || !/^[A-Za-z0-9_-]{1,256}$/.test(request.userId)
      || !/^[A-Z]+$/.test(request.method)
      || (request.accessToken !== undefined && !/^[\x21-\x7e]+$/.test(request.accessToken)))
      throw new Error("Invalid Poppy Session request.");
    const target = httpsUrl(request.url, true);
    target.search = "";
    target.hash = "";
    const now = Math.floor(this.#now() / 1000);
    const delegation = this.delegation(request.company, request.userId, now);
    // Some deployed 0.3 servers retain PAP's delegation names. Both proofs
    // authorize the same key; including the alias preserves modern validation.
    if (request.version === "0.3" && !delegation.legacyToken) {
      delegation.legacyToken = jwt(this.#rootKey, { alg: "ES256", typ: "pap-delegation+jwt", kid: this.#rootKid }, {
        iss: this.clientId, cnf: { jwk: publicEcJwk(delegation.key) },
        iat: delegation.issuedAt, exp: delegation.expiresAt, jti: randomId(),
      });
    }
    const token = jwt(delegation.key, {
      alg: "ES256", typ: "poppy-session+jwt", kid: delegation.kid, poppy_dlg: delegation.token,
      ...(request.version === "0.3" ? { pap_dlg: delegation.legacyToken } : {}),
    }, {
      iss: this.clientId, aud: request.company, sid: request.sessionId, sub: request.userId,
      htm: request.method, htu: target.href, iat: now, jti: randomId(),
      ...(request.accessToken === undefined ? {} : { ath: createHash("sha256").update(request.accessToken, "ascii").digest("base64url") }),
    });
    return {
      "Poppy-Session": token, "Poppy-Version": request.version,
      ...(request.accessToken === undefined ? {} : { Authorization: `Bearer ${request.accessToken}` }),
    };
  }

  private delegation(company: string, userId: string, now: number): Delegation {
    for (const [key, value] of this.#delegations) {
      if (value.expiresAt <= now || value.issuedAt > now) this.#delegations.delete(key);
    }
    const cacheKey = JSON.stringify([company, userId]);
    const existing = this.#delegations.get(cacheKey);
    if (existing && existing.expiresAt > now + 30) return existing;
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = publicEcJwk(privateKey);
    const expiresAt = now + 60 * 60;
    const value = {
      key: privateKey, kid: thumbprint(publicKey), issuedAt: now, expiresAt,
      token: jwt(this.#rootKey, { alg: "ES256", typ: "poppy-delegation+jwt", kid: this.#rootKid }, {
        iss: this.clientId, cnf: { jwk: publicKey }, iat: now, exp: expiresAt, jti: randomId(),
      }),
    };
    this.#delegations.set(cacheKey, value);
    return value;
  }
}

let identity: PoppyIdentity | undefined;
export function getPoppyIdentity(): PoppyIdentity {
  if (!identity) {
    const clientId = process.env.BELL_POPPY_CLIENT_ID?.trim();
    const privateJwk = process.env.BELL_POPPY_PRIVATE_JWK?.trim();
    if (!clientId || !privateJwk) throw new Error("Configure BELL_POPPY_CLIENT_ID and BELL_POPPY_PRIVATE_JWK to enable Poppy.");
    identity = new PoppyIdentity({ clientId, privateJwk, jwksUri: process.env.BELL_POPPY_JWKS_URI?.trim() || undefined });
  }
  return identity;
}
