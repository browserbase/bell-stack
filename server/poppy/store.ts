import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { seal, unseal } from "../encrypted-record";

const secret = z.string().min(1).max(65_536);
const timestamp = z.number().finite().nonnegative();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const scopes = z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).min(1).max(1024);
const httpsUrl = z.string().max(8192).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; }
  catch { return false; }
});
const grantSchema = z.object({
  accessToken: secret, refreshToken: secret, expiresAt: timestamp, scopes,
  resource: httpsUrl.optional(), status: z.enum(["active", "uncertain", "revoking"]),
}).strict();
const deviceSchema = z.object({
  deviceCode: secret, userCode: z.string().min(1).max(1024), verificationUri: httpsUrl,
  expiresAt: timestamp, interval: z.number().int().positive(), nextPollAt: timestamp, scopes,
  resource: httpsUrl.optional(), status: z.enum(["pending", "polling", "uncertain"]),
}).strict();
const stateSchema = z.object({
  userId: id, sessions: z.record(z.string().min(1).max(2048), id),
  grant: grantSchema.optional(), device: deviceSchema.optional(), retiredRefreshTokens: z.array(secret).optional(),
}).strict();
const recordSchema = z.object({
  clientId: httpsUrl, owner: z.string().min(1).max(2048), company: httpsUrl, state: stateSchema,
}).strict();
const databaseSchema = z.object({ records: z.record(z.string(), recordSchema) }).strict();
const envelopeSchema = z.object({ version: z.literal(1), ciphertext: z.string().min(1) }).strict();

export type PoppyGrant = z.infer<typeof grantSchema>;
export type PoppyDevice = z.infer<typeof deviceSchema>;
export type PoppyCompanyState = Omit<z.infer<typeof stateSchema>, "userId"> & { readonly userId: string };
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
        state: { userId: randomBytes(32).toString("base64url"), sessions: {} },
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
          serialized = JSON.stringify({ version: 1, ciphertext: seal(checked, this.#key, this.context()) });
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

  private context(): string { return `poppy:store:${this.#clientId}`; }

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
