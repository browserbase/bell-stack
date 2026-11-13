import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seal, unseal } from "../server/encrypted-record";
import { PoppyStore, type PoppyGrant } from "../server/poppy/store";

const clientId = "https://bell.example/agent.json";
const company = "https://auth.company.example";
const owner = "synthetic-owner";
const grant: PoppyGrant = {
  accessToken: "synthetic-private-access-token", refreshToken: "synthetic-private-refresh-token",
  expiresAt: 1_800_000_000_000, scopes: ["orders:read"], status: "active",
};
let directory: string;
let file: string;
let key: Buffer;
const store = () => new PoppyStore({ path: file, encryptionKey: key, clientId });
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "bell-poppy-store-"));
  file = path.join(directory, "poppy.enc.json");
  key = randomBytes(32);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Poppy encrypted state", () => {
  it("preserves random pairwise identities across restarts and isolates owners and companies", async () => {
    const first = await store().withCompany(owner, company, async state => {
      state.sessions.conversation = "random_session";
      state.grant = { ...grant };
      return state.userId;
    });
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await store().withCompany(owner, company, async state => {
      expect(state.userId).toBe(first);
      expect(state.sessions.conversation).toBe("random_session");
      expect(state.grant).toEqual(grant);
    });
    for (const [otherOwner, otherCompany] of [["other-owner", company], [owner, "https://other.company.example"]]) {
      await store().withCompany(otherOwner, otherCompany, async state => {
        expect(state.userId).not.toBe(first);
        expect(state.grant).toBeUndefined();
        expect(state.sessions).toEqual({});
      });
    }
    const disk = await readFile(file, "utf8");
    for (const secret of [owner, company, first, grant.accessToken, grant.refreshToken, "random_session"]) expect(disk).not.toContain(secret);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["poppy.enc.json"]);
  });

  it("serializes state across instances and equivalent file paths", async () => {
    const stores = [store(), new PoppyStore({ path: path.relative(process.cwd(), file), encryptionKey: key, clientId })];
    const ids = await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2].withCompany(owner, company, async state => {
      await Promise.resolve();
      state.sessions[`conversation_${index}`] = `session_${index}`;
      return state.userId;
    })));
    expect(new Set(ids).size).toBe(1);
    await store().withCompany(owner, company, async state => { expect(Object.keys(state.sessions)).toHaveLength(12); });
  });

  it("persists a crash checkpoint without committing later failed changes", async () => {
    await store().withCompany(owner, company, async state => { state.grant = { ...grant }; });
    await expect(store().withCompany(owner, company, async (state, save) => {
      state.grant!.status = "uncertain";
      await save();
      state.grant!.accessToken = "response-not-persisted";
      throw new Error("synthetic network failure");
    })).rejects.toThrow("synthetic network failure");
    await store().withCompany(owner, company, async state => {
      expect(state.grant).toMatchObject({ status: "uncertain", accessToken: grant.accessToken });
      state.retiredRefreshTokens = ["synthetic-retired-refresh"];
      state.device = {
        deviceCode: "synthetic-private-device-code", userCode: "DEMO-CODE", verificationUri: "https://company.example/device",
        expiresAt: 1_800_000_000_000, interval: 5, nextPollAt: 1_700_000_000_000, scopes: ["orders:read"], status: "uncertain",
        resource: "https://api.company.example",
      };
    });
    await store().withCompany(owner, company, async state => {
      expect(state.retiredRefreshTokens).toEqual(["synthetic-retired-refresh"]);
      expect(state.device).toMatchObject({ status: "uncertain", resource: "https://api.company.example" });
    });
    const disk = await readFile(file, "utf8");
    expect(disk).not.toMatch(/synthetic-private|synthetic-retired|DEMO-CODE/);
  });

  it("does not persist a failed operation and forbids use of checkpoints after releasing the lock", async () => {
    let saved: (() => Promise<void>) | undefined;
    await store().withCompany(owner, company, async (_state, save) => { saved = save; });
    await expect(saved!()).rejects.toThrow("outside its lock");
    await expect(store().withCompany(owner, company, async state => {
      state.sessions.failed = "failed_session";
      throw new Error("stop");
    })).rejects.toThrow("stop");
    await store().withCompany(owner, company, async state => { expect(state.sessions.failed).toBeUndefined(); });
  });

  it("fails closed on malformed ciphertext, wrong encryption keys, or client identity changes", async () => {
    await store().withCompany(owner, company, async state => { state.grant = { ...grant }; });
    const original = await readFile(file, "utf8");
    for (const alternate of [
      new PoppyStore({ path: file, encryptionKey: randomBytes(32), clientId }),
      new PoppyStore({ path: file, encryptionKey: key, clientId: "https://other.agent.example/agent.json" }),
    ]) await expect(alternate.withCompany(owner, company, async () => {})).rejects.toThrow("refusing to overwrite");
    expect(await readFile(file, "utf8")).toBe(original);
    for (const contents of ["{broken", JSON.stringify({ version: 2, ciphertext: "bogus" }), JSON.stringify({ version: 1, ciphertext: "v1.bad.bad.bad" })]) {
      await writeFile(file, contents);
      await expect(store().withCompany(owner, company, async () => {})).rejects.toThrow("refusing to overwrite");
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  });

  it("validates decrypted records and prevents moving an owner's state to a different company", async () => {
    await store().withCompany(owner, company, async () => {});
    const envelope = JSON.parse(await readFile(file, "utf8"));
    const database = unseal<{ records: Record<string, unknown> }>(envelope.ciphertext, key, `poppy:store:${clientId}`);
    const recordKey = JSON.stringify([owner, company]);
    database.records[JSON.stringify(["another-owner", company])] = database.records[recordKey];
    delete database.records[recordKey];
    const corrupted = JSON.stringify({ version: 1, ciphertext: seal(database, key, `poppy:store:${clientId}`) });
    await writeFile(file, corrupted);
    await expect(store().withCompany(owner, company, async () => {})).rejects.toThrow("refusing to overwrite");
    expect(await readFile(file, "utf8")).toBe(corrupted);
  });

  it("does not replace valid data with invalid state or an I/O failure", async () => {
    await store().withCompany(owner, company, async () => {});
    const original = await readFile(file, "utf8");
    await expect(store().withCompany(owner, company, async state => {
      state.grant = { ...grant, scopes: [] };
    })).rejects.toThrow("refusing to save");
    expect(await readFile(file, "utf8")).toBe(original);
    await rm(file);
    await expect(store().withCompany(owner, company, async () => { await mkdir(file); })).rejects.toThrow("could not be saved");
    expect(await readdir(directory)).toEqual(["poppy.enc.json"]);
    await expect(store().withCompany(owner, company, async () => {})).rejects.toThrow("could not be read");
  });
});
