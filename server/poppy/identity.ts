import {
  DelegatedSessionSigner, InMemoryDelegatedKeys, jwkThumbprint, parseClientMetadata,
  parseJsonWebKeySet, type ClientMetadata, type Signer,
} from "@datalayer/personal-agent-protocol";
import { JoseSigner } from "@datalayer/personal-agent-protocol/server";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";

export interface PoppyIdentityConfig {
  clientId: string;
  privateJwk: JWK | string;
  jwksUri?: string;
}

export class PoppyIdentity {
  readonly clientId: string;
  readonly jwksUri: string;
  readonly signer: Signer;
  readonly sessionSigner: DelegatedSessionSigner;
  readonly #metadata: ClientMetadata;
  readonly #privateJwk: JWK;
  #prepared?: ReturnType<PoppyIdentity["prepare"]>;

  constructor(config: PoppyIdentityConfig) {
    try {
      this.#metadata = parseClientMetadata({
        client_id: config.clientId, client_name: "Bell",
        jwks_uri: config.jwksUri ?? new URL("jwks.json", config.clientId).href,
        token_endpoint_auth_method: "private_key_jwt",
      });
      for (const value of [this.#metadata.client_id, this.#metadata.jwks_uri]) {
        const url = new URL(value);
        if (url.search || url.hash) throw new Error();
      }
      this.#privateJwk = typeof config.privateJwk === "string" ? JSON.parse(config.privateJwk) : { ...config.privateJwk };
      if (this.#privateJwk.kty !== "EC" || this.#privateJwk.crv !== "P-256" || !this.#privateJwk.d
        || (this.#privateJwk.alg && this.#privateJwk.alg !== "ES256")) throw new Error();
    } catch {
      throw new Error("Configure a valid Poppy HTTPS client identity and private ES256 JWK.");
    }
    this.clientId = this.#metadata.client_id;
    this.jwksUri = this.#metadata.jwks_uri;
    this.signer = { sign: async (claims, options) => (await this.ready()).signer.sign(claims, options) };
    this.sessionSigner = new DelegatedSessionSigner({ custody: new InMemoryDelegatedKeys(), signer: this.signer });
  }

  private async prepare() {
    try {
      const { kty, crv, x, y } = this.#privateJwk;
      const publicKey: JWK = { kty, crv, x, y };
      const [privateKey, verificationKey, kid] = await Promise.all([
        importJWK(this.#privateJwk, "ES256"), importJWK(publicKey, "ES256"), jwkThumbprint(publicKey),
      ]);
      // Validate the configured key pair before publishing its public half.
      const probe = await new CompactSign(new TextEncoder().encode("Bell signing key validation"))
        .setProtectedHeader({ alg: "ES256" }).sign(privateKey);
      await compactVerify(probe, verificationKey, { algorithms: ["ES256"] });
      return {
        signer: new JoseSigner({ privateKey, algorithm: "ES256", keyId: kid }),
        jwks: parseJsonWebKeySet({ keys: [{ ...publicKey, kid, alg: "ES256", use: "sig" }] }),
      };
    } catch { throw new Error("Configure BELL_POPPY_PRIVATE_JWK with a valid private ES256 JWK."); }
  }

  private ready() { return this.#prepared ??= this.prepare(); }
  async publicJwks() { return structuredClone((await this.ready()).jwks); }
  async clientMetadata() { await this.ready(); return structuredClone(this.#metadata); }
}

let identity: PoppyIdentity | undefined;
export function getPoppyIdentity() {
  if (!identity) {
    const clientId = process.env.BELL_POPPY_CLIENT_ID?.trim();
    const privateJwk = process.env.BELL_POPPY_PRIVATE_JWK;
    if (!clientId || !privateJwk) throw new Error("Configure BELL_POPPY_CLIENT_ID and BELL_POPPY_PRIVATE_JWK to enable Poppy.");
    identity = new PoppyIdentity({ clientId, privateJwk, jwksUri: process.env.BELL_POPPY_JWKS_URI?.trim() || undefined });
  }
  return identity;
}
