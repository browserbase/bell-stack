import { createHash, createPublicKey, generateKeyPairSync, verify, type JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PoppyIdentity, type PoppySessionRequest } from "../server/poppy/identity";

const clientId = "https://bell.example/poppy/agent.json";
const root = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
const request: PoppySessionRequest = {
  company: "https://auth.company.example", version: "1.0", userId: "random_user", sessionId: "random_session",
  method: "GET", url: "https://api.company.example/orders?limit=5#ignored",
};
interface Jwt {
  header: { alg: string; typ: string; kid: string; poppy_dlg?: string; pap_dlg?: string };
  claims: {
    iss: string; sub?: string; aud?: string; sid?: string; htm?: string; htu?: string; iat: number;
    exp?: number; jti: string; ath?: string; cnf?: { jwk: JsonWebKey };
  };
}
function decode(token: string): Jwt {
  const [header, claims] = token.split(".");
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()), claims: JSON.parse(Buffer.from(claims, "base64url").toString()) };
}
function verified(token: string, key: JsonWebKey) {
  const [header, claims, signature] = token.split(".");
  return verify("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, Buffer.from(signature, "base64url"));
}

describe("Poppy client identity", () => {
  it("publishes only the public root key and same-domain device client metadata", () => {
    const identity = new PoppyIdentity({ clientId, privateJwk: JSON.stringify(root) });
    expect(identity.clientMetadata()).toEqual({
      client_id: clientId, client_name: "Bell", jwks_uri: "https://bell.example/poppy/jwks.json",
      token_endpoint_auth_method: "private_key_jwt",
    });
    expect(identity.publicJwks().keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(identity.publicJwks().keys[0]).not.toHaveProperty("d");
    const returned = identity.publicJwks();
    returned.keys[0].x = "changed";
    expect(identity.publicJwks().keys[0].x).toBe(root.x);
    expect(JSON.stringify(identity)).not.toContain(root.d);
  });

  it("signs unique short-lived client assertions for the exact issuer", () => {
    const now = 1_800_000_000_000;
    const identity = new PoppyIdentity({ clientId, privateJwk: root, now: () => now });
    const issuer = "https://auth.company.example/tenant";
    const first = identity.assertion(issuer);
    const value = decode(first);
    expect(verified(first, identity.publicJwks().keys[0])).toBe(true);
    expect(value.header).toMatchObject({ alg: "ES256", kid: identity.publicJwks().keys[0].kid });
    expect(value.claims).toMatchObject({ iss: clientId, sub: clientId, aud: issuer, iat: now / 1000, exp: now / 1000 + 60 });
    expect(value.claims.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decode(identity.assertion(issuer)).claims.jti).not.toBe(value.claims.jti);
  });

  it.each(["0.3", "0.4", "1.0"])("cryptographically binds a %s Session to the request and access token through its delegation", version => {
    const identity = new PoppyIdentity({ clientId, privateJwk: root });
    const headers = identity.sessionHeaders({ ...request, version, accessToken: "synthetic-access-token" });
    const session = decode(headers["Poppy-Session"]);
    const delegation = decode(session.header.poppy_dlg!);
    const delegatedKey = delegation.claims.cnf!.jwk;
    expect(verified(session.header.poppy_dlg!, identity.publicJwks().keys[0])).toBe(true);
    expect(verified(headers["Poppy-Session"], delegatedKey)).toBe(true);
    expect(verified(headers["Poppy-Session"], identity.publicJwks().keys[0])).toBe(false);
    expect(delegation.header).toMatchObject({ typ: "poppy-delegation+jwt", alg: "ES256" });
    expect(Object.keys(delegation.claims).sort()).toEqual(["cnf", "exp", "iat", "iss", "jti"]);
    expect(delegatedKey).not.toHaveProperty("d");
    expect(delegation.claims.exp! - delegation.claims.iat).toBeLessThanOrEqual(24 * 60 * 60);
    expect(session.header).toMatchObject({ typ: "poppy-session+jwt", alg: "ES256" });
    expect(session.header.kid).toBe(createHash("sha256").update(JSON.stringify({
      crv: delegatedKey.crv, kty: delegatedKey.kty, x: delegatedKey.x, y: delegatedKey.y,
    })).digest("base64url"));
    expect(session.claims).toMatchObject({
      iss: clientId, aud: request.company, sid: request.sessionId, sub: request.userId, htm: "GET",
      htu: "https://api.company.example/orders",
      ath: createHash("sha256").update("synthetic-access-token").digest("base64url"),
    });
    expect(headers).toMatchObject({ "Poppy-Version": version, Authorization: "Bearer synthetic-access-token" });
    expect(Buffer.from(headers["Poppy-Session"].split(".")[2], "base64url")).toHaveLength(64);
  });

  it("supports both deployed 0.3 delegation names without weakening either signature chain", () => {
    const identity = new PoppyIdentity({ clientId, privateJwk: root });
    const headers = identity.sessionHeaders({ ...request, version: "0.3", accessToken: "synthetic-token" });
    const session = decode(headers["Poppy-Session"]);
    const modern = decode(session.header.poppy_dlg!);
    const legacy = decode(session.header.pap_dlg!);
    expect(legacy.header).toMatchObject({ alg: "ES256", typ: "pap-delegation+jwt", kid: identity.publicJwks().keys[0].kid });
    expect(verified(session.header.pap_dlg!, identity.publicJwks().keys[0])).toBe(true);
    expect(legacy.claims).toEqual({ ...modern.claims, jti: legacy.claims.jti });
    expect(legacy.claims.jti).not.toBe(modern.claims.jti);
    expect(verified(headers["Poppy-Session"], legacy.claims.cnf!.jwk)).toBe(true);
    expect(session.claims.ath).toBe(createHash("sha256").update("synthetic-token").digest("base64url"));
    for (const version of ["0.4", "1.0"])
      expect(decode(identity.sessionHeaders({ ...request, version })["Poppy-Session"]).header).not.toHaveProperty("pap_dlg");
  });

  it("isolates delegated keys by Company and User, refreshes jti, and omits account claims when signed out", () => {
    const identity = new PoppyIdentity({ clientId, privateJwk: root });
    const first = decode(identity.sessionHeaders(request)["Poppy-Session"]);
    const second = decode(identity.sessionHeaders({ ...request, sessionId: "another_session" })["Poppy-Session"]);
    expect(second.header.poppy_dlg).toBe(first.header.poppy_dlg);
    expect(second.claims.jti).not.toBe(first.claims.jti);
    expect(first.claims).not.toHaveProperty("ath");
    expect(identity.sessionHeaders(request)).not.toHaveProperty("Authorization");
    for (const change of [{ company: "https://other.company.example" }, { userId: "another_user" }]) {
      const other = decode(identity.sessionHeaders({ ...request, ...change })["Poppy-Session"]);
      expect(other.header.kid).not.toBe(first.header.kid);
      expect(other.header.poppy_dlg).not.toBe(first.header.poppy_dlg);
    }
  });

  it("renews expired delegations without changing the logical Session", () => {
    let now = 1_800_000_000_000;
    const identity = new PoppyIdentity({ clientId, privateJwk: root, now: () => now });
    const first = decode(identity.sessionHeaders(request)["Poppy-Session"]);
    now = decode(first.header.poppy_dlg!).claims.exp! * 1000;
    const renewed = decode(identity.sessionHeaders(request)["Poppy-Session"]);
    expect(renewed.header.kid).not.toBe(first.header.kid);
    expect(renewed.claims.sid).toBe(first.claims.sid);
    expect(renewed.claims.sub).toBe(first.claims.sub);
    expect(decode(renewed.header.poppy_dlg!).claims.exp).toBeGreaterThan(now / 1000);
  });

  it("rejects invalid client configuration and mismatched key pairs without leaking it", () => {
    for (const badClientId of ["http://bell.example/agent.json", "https://secret@bell.example/agent.json", `${clientId}?secret=1`, `${clientId}#secret`])
      expect(() => new PoppyIdentity({ clientId: badClientId, privateJwk: root })).toThrow();
    expect(() => new PoppyIdentity({ clientId, privateJwk: root, jwksUri: "https://different.example/jwks.json" })).toThrow();
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
    for (const privateJwk of ["private-secret-not-json", { ...root, d: undefined }, { ...root, crv: "P-384" }, { ...root, d: other.d }]) {
      expect(() => new PoppyIdentity({ clientId, privateJwk })).toThrow("valid private ES256 JWK");
      expect(() => new PoppyIdentity({ clientId, privateJwk })).not.toThrow("private-secret-not-json");
    }
  });

  it("rejects invalid signing inputs rather than creating injectable headers", () => {
    const identity = new PoppyIdentity({ clientId, privateJwk: root });
    for (const change of [{ url: "http://company.example/api" }, { url: "https://secret@company.example/api" },
      { accessToken: "secret\r\nInjected: yes" }, { accessToken: "" }, { method: "GET\nPOST" }, { version: "1.0\r\n" }, { sessionId: "../session" }])
      expect(() => identity.sessionHeaders({ ...request, ...change })).toThrow();
  });
});
