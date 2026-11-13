import { randomUUID } from "node:crypto";
import { generatePairwiseUserId, PapSession, SecretValue, type AuthorizationStateStore, type PapSessionJson, type TokenStore } from "@datalayer/personal-agent-protocol";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { seal, unseal } from "../encrypted-record";

const httpsUrl = z.string().url().refine(value => new URL(value).protocol === "https:");
const stateSchema = z.object({
  userId: z.string().min(1),
  sessions: z.record(z.string(), z.custom<PapSessionJson>(value => {
    try { PapSession.fromJson(value as PapSessionJson); return true; } catch { return false; }
  })),
  tokens: z.record(z.string(), z.string().min(1)),
  authorization: z.record(z.string(), z.object({ expiresAt: z.number(), value: z.unknown() })),
  grant: z.object({ reference: z.string(), scopes: z.array(z.string()) }).optional(),
  device: z.object({ reference: z.string(), userCode: z.string(), verificationUri: httpsUrl,
    expiresAt: z.number(), scopes: z.array(z.string()) }).optional(),
  blocked: z.boolean().optional(),
}).strict();
const recordSchema = z.object({
  clientId: httpsUrl, owner: z.string().min(1).max(2048), company: httpsUrl, state: stateSchema,
}).strict();
const databaseSchema = z.object({ records: z.record(z.string(), recordSchema) }).strict();
const envelopeSchema = z.object({ version: z.literal(2), ciphertext: z.string().min(1) }).strict();

export type PoppyCompanyState = z.infer<typeof stateSchema>;
export interface PoppySdkStores {
  tokens: TokenStore;
  authorization: AuthorizationStateStore;
}

// SDK authorization state is opaque, but its Date/SecretValue instances must survive
// encrypted JSON storage. Tag every container to avoid interpreting provider fields as tags.
function encode(value: unknown): unknown {
  if (value instanceof SecretValue) return ["secret", value.reveal()];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value === undefined) return ["undefined"];
  if (Array.isArray(value)) return ["array", value.map(encode)];
  if (value && typeof value === "object") return ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
  return value;
}
function decode(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const [kind, body] = value;
  if (kind === "secret") return new SecretValue(body);
  if (kind === "date") return new Date(body);
  if (kind === "undefined") return undefined;
  if (kind === "array") return (body as unknown[]).map(decode);
  if (kind === "object") return Object.fromEntries((body as [string, unknown][]).map(([key, item]) => [key, decode(item)]));
  throw new Error("Invalid encrypted SDK state.");
}

/** Each adapter is scoped to a locked, authenticated owner/company record. */
export function sdkStores(state: PoppyCompanyState, save: () => Promise<void>): PoppySdkStores {
  return {
    tokens: {
      async put(reference, token) { state.tokens[reference] = token.reveal(); await save(); },
      async get(reference) { return Object.hasOwn(state.tokens, reference) ? new SecretValue(state.tokens[reference]) : undefined; },
      async delete(reference) { delete state.tokens[reference]; await save(); },
    },
    authorization: {
      async put(reference, value, { expiresAt }) {
        state.authorization[reference] = { value: encode(value), expiresAt: expiresAt.getTime() };
        await save();
      },
      async take(reference) {
        const record = Object.hasOwn(state.authorization, reference) ? state.authorization[reference] : undefined;
        delete state.authorization[reference];
        await save();
        return record && record.expiresAt > Date.now() ? decode(record.value) : undefined;
      },
    },
  };
}

export interface PoppyStoreConfig { path?: string; encryptionKey?: Buffer; clientId?: string }
type Database = z.infer<typeof databaseSchema>;

// This store supports one Bell process. Every instance in that process shares the file's lock.
const pending = new Map<string, Promise<void>>();

export class PoppyStore {
  readonly #path: string;
  readonly #key: Buffer;
  readonly #clientId: string;

  constructor(config: PoppyStoreConfig = {}) {
    this.#path = path.resolve(config.path ?? process.env.BELL_POPPY_STORE_PATH ?? path.join(process.cwd(), ".bell", "poppy.enc.json"));
    const clientId = config.clientId ?? process.env.BELL_POPPY_CLIENT_ID?.trim();
    if (!httpsUrl.safeParse(clientId).success) throw new Error("Configure BELL_POPPY_CLIENT_ID to use the Poppy store.");
    this.#clientId = clientId!;
    const encoded = process.env.BELL_POPPY_ENCRYPTION_KEY?.trim() ?? "";
    const key = config.encryptionKey ?? Buffer.from(encoded, "base64");
    if (key.length !== 32 || (!config.encryptionKey && key.toString("base64") !== encoded))
      throw new Error("Configure BELL_POPPY_ENCRYPTION_KEY with a base64-encoded 32-byte key.");
    this.#key = Buffer.from(key);
  }

  async withCompany<T>(owner: string, company: string, operation: (state: PoppyCompanyState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    if (!z.string().min(1).max(2048).safeParse(owner).success || !httpsUrl.safeParse(company).success)
      throw new Error("Poppy state requires an authenticated owner and company identifier.");
    const work = (pending.get(this.#path) ?? Promise.resolve()).then(async () => {
      const database = await this.read();
      const recordKey = JSON.stringify([owner, company]);
      const record = database.records[recordKey] ?? {
        clientId: this.#clientId, owner, company,
        state: { userId: generatePairwiseUserId(), sessions: {}, tokens: {}, authorization: {} },
      };
      database.records[recordKey] = record;
      const userId = record.state.userId;
      let active = true;
      let writes = Promise.resolve();
      const save = (): Promise<void> => {
        if (!active) return Promise.reject(new Error("Poppy state checkpoint is outside its lock."));
        let serialized: string;
        try {
          if (record.state.userId !== userId) throw new Error();
          const checked = databaseSchema.parse(database);
          serialized = JSON.stringify({ version: 2, ciphertext: seal(checked, this.#key, this.context()) });
        } catch { return Promise.reject(new Error("Poppy state is invalid; refusing to save it.")); }
        writes = writes.then(() => this.write(serialized));
        return writes;
      };
      try {
        const result = await operation(record.state, save);
        await save();
        return result;
      } finally {
        active = false;
        await writes;
      }
    });
    const tail = work.then(() => undefined, () => undefined);
    pending.set(this.#path, tail);
    try { return await work; }
    finally { if (pending.get(this.#path) === tail) pending.delete(this.#path); }
  }

  private context(): string { return `poppy:sdk-store:${this.#clientId}`; }

  private async read(): Promise<Database> {
    let contents: string;
    try { contents = await readFile(this.#path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: {} };
      throw new Error("Poppy state could not be read.");
    }
    try {
      const envelope = envelopeSchema.parse(JSON.parse(contents));
      const database = databaseSchema.parse(unseal(envelope.ciphertext, this.#key, this.context()));
      for (const [key, record] of Object.entries(database.records)) {
        if (record.clientId !== this.#clientId || key !== JSON.stringify([record.owner, record.company])) throw new Error();
      }
      return database;
    } catch { throw new Error("Poppy state is invalid or could not be decrypted; refusing to overwrite it."); }
  }

  private async write(contents: string): Promise<void> {
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.#path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#path);
    } catch { throw new Error("Poppy state could not be saved."); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}

let store: PoppyStore | undefined;
export function getPoppyStore(): PoppyStore { return store ??= new PoppyStore(); }
