import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newSessionId, PapSession, SecretValue } from "@datalayer/personal-agent-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seal, unseal } from "../server/encrypted-record";
import { PoppyStore, sdkStores } from "../server/poppy/store";

const clientId = "https://bell.example/agent.json";
const company = "https://auth.company.example";
const owner = "synthetic-owner";
const secret = "synthetic-private-refresh-token";
let directory: string, file: string, key: Buffer;
const store = () => new PoppyStore({ path: file, encryptionKey: key, clientId });
const session = () => new PapSession({ sid: newSessionId(), sub: "synthetic-user", issuer: company, clientId, tenantId: "bell" }).toJson();
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "bell-poppy-store-"));
  file = path.join(directory, "poppy.enc.json");
  key = randomBytes(32);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Poppy application storage", () => {
  it("encrypts SDK credentials and preserves identities while isolating owners and companies", async () => {
    const first = await store().withCompany(owner, company, async (state, save) => {
      await sdkStores(state, save).tokens.put("refresh", new SecretValue(secret));
      state.grant = { reference: "refresh", scopes: ["orders:read"] };
      return state.userId;
    });
    await store().withCompany(owner, company, async (state, save) => {
      expect(state.userId).toBe(first);
      expect((await sdkStores(state, save).tokens.get("refresh"))?.reveal()).toBe(secret);
    });
    for (const [otherOwner, otherCompany] of [["other-owner", company], [owner, "https://other.company.example"]]) {
      await store().withCompany(otherOwner, otherCompany, async (state, save) => {
        expect(state.userId).not.toBe(first);
        expect(await sdkStores(state, save).tokens.get("refresh")).toBeUndefined();
        expect(state.grant).toBeUndefined();
      });
    }
    const disk = await readFile(file, "utf8");
    for (const value of [owner, company, first, secret]) expect(disk).not.toContain(value);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["poppy.enc.json"]);
  });

  it("round-trips opaque SDK state with nested Date/SecretValue instances and consumes it once", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await store().withCompany(owner, company, async (state, save) => {
      await sdkStores(state, save).authorization.put("device", {
        expiresAt, code: new SecretValue(secret), optional: undefined,
        nested: [{ value: new SecretValue("nested-secret"), at: expiresAt }],
        arbitrary: ["secret", "ordinary-provider-data"],
      }, { expiresAt });
    });
    await store().withCompany(owner, company, async (state, save) => {
      const adapter = sdkStores(state, save).authorization;
      const value = await adapter.take("device") as { expiresAt: Date; code: SecretValue; nested: { value: SecretValue; at: Date }[]; arbitrary: string[] };
      expect(value.expiresAt).toEqual(expiresAt);
      expect(value.code.reveal()).toBe(secret);
      expect(value.nested[0].value.reveal()).toBe("nested-secret");
      expect(value.nested[0].at).toEqual(expiresAt);
      expect(value.arbitrary).toEqual(["secret", "ordinary-provider-data"]);
      expect(await adapter.take("device")).toBeUndefined();
      await adapter.put("expired", new SecretValue(secret), { expiresAt: new Date(0) });
      expect(await adapter.take("expired")).toBeUndefined();
    });
  });

  it("lets other accounts checkpoint while one account waits and merges all updates", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = store().withCompany(owner, company, async (state, save) => {
      state.tokens.first = "before-provider-wait";
      await save();
      entered.resolve();
      await release.promise;
      state.tokens.first = "after-provider-wait";
      await save();
    });
    await entered.promise;
    let sameAccountEntered = false;
    const sameAccount = new PoppyStore({ path: path.relative(process.cwd(), file), encryptionKey: key, clientId })
      .withCompany(owner, company, async state => {
        sameAccountEntered = true;
        expect(state.tokens.first).toBe("after-provider-wait");
        state.tokens.second = "same-account-update";
      });
    const others = [["other-owner", company], [owner, "https://other.company.example"]];
    const unrelated = Promise.all(others.map(([otherOwner, otherCompany]) => store().withCompany(otherOwner, otherCompany, async (state, save) => {
      state.tokens.first = "independent-checkpoint";
      await save();
      state.tokens.second = "independent-completion";
      await save();
    })));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([unrelated, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Unrelated accounts waited for the held provider operation.")), 2000);
      })]);
      expect(sameAccountEntered).toBe(false);
    } finally {
      clearTimeout(timeout);
      release.resolve();
      await Promise.all([first, sameAccount, unrelated]);
    }
    expect(sameAccountEntered).toBe(true);
    await store().withCompany(owner, company, async state => {
      expect(state.tokens).toEqual({ first: "after-provider-wait", second: "same-account-update" });
    });
    for (const [otherOwner, otherCompany] of others) {
      await store().withCompany(otherOwner, otherCompany, async state => {
        expect(state.tokens).toEqual({ first: "independent-checkpoint", second: "independent-completion" });
      });
    }
  });

  it("serializes mutations across store instances and retains durable recovery checkpoints", async () => {
    const stores = [store(), new PoppyStore({ path: path.relative(process.cwd(), file), encryptionKey: key, clientId })];
    const ids = await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2].withCompany(owner, company, async state => {
      state.sessions[`conversation_${index}`] = session();
      return state.userId;
    })));
    expect(new Set(ids).size).toBe(1);
    await expect(store().withCompany(owner, company, async (state, save) => {
      expect(Object.keys(state.sessions)).toHaveLength(12);
      state.blocked = true;
      await save();
      state.blocked = false;
      throw new Error("simulated interrupted credential mutation");
    })).rejects.toThrow("interrupted");
    await store().withCompany(owner, company, async state => { expect(state.blocked).toBe(true); });
  });

  it("rejects checkpoints outside their lock and preserves data after failed operations", async () => {
    let saved: (() => Promise<void>) | undefined;
    await store().withCompany(owner, company, async (_state, save) => { saved = save; });
    await expect(saved!()).rejects.toThrow("outside its lock");
    await expect(store().withCompany(owner, company, async state => {
      state.tokens.failed = "not-saved";
      throw new Error("stop");
    })).rejects.toThrow("stop");
    await store().withCompany(owner, company, async state => { expect(state.tokens.failed).toBeUndefined(); });
  });

  it("fails closed on invalid ciphertext, identity changes, and moved ownership records", async () => {
    await store().withCompany(owner, company, async () => {});
    const original = await readFile(file, "utf8");
    for (const alternate of [new PoppyStore({ path: file, encryptionKey: randomBytes(32), clientId }),
      new PoppyStore({ path: file, encryptionKey: key, clientId: "https://other.agent.example/agent.json" })]) {
      await expect(alternate.withCompany(owner, company, async () => {})).rejects.toThrow("refusing to overwrite");
    }
    const context = `poppy:sdk-store:${clientId}`;
    const database = unseal<{ records: Record<string, unknown> }>(JSON.parse(original).ciphertext, key, context);
    const recordKey = JSON.stringify([owner, company]);
    database.records[JSON.stringify(["another-owner", company])] = database.records[recordKey];
    delete database.records[recordKey];
    for (const contents of ["{broken", JSON.stringify({ version: 2, ciphertext: "bogus" }),
      JSON.stringify({ version: 2, ciphertext: seal(database, key, context) })]) {
      await writeFile(file, contents);
      await expect(store().withCompany(owner, company, async () => {})).rejects.toThrow("refusing to overwrite");
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  });

  it("revalidates the shared file before merging a checkpoint", async () => {
    await store().withCompany(owner, company, async () => {});
    await expect(store().withCompany(owner, company, async (state, save) => {
      state.tokens.pending = "must-not-overwrite-corrupt-data";
      await writeFile(file, "{broken");
      await save();
    })).rejects.toThrow("refusing to overwrite");
    expect(await readFile(file, "utf8")).toBe("{broken");
  });

  it("does not replace valid data after invalid state or an I/O failure", async () => {
    await store().withCompany(owner, company, async () => {});
    const original = await readFile(file, "utf8");
    await expect(store().withCompany(owner, company, async state => { state.userId = "changed"; })).rejects.toThrow("refusing to save");
    expect(await readFile(file, "utf8")).toBe(original);
    await rm(file);
    await expect(store().withCompany(owner, company, async () => { await mkdir(file); })).rejects.toThrow("could not be read");
    expect(await readdir(directory)).toEqual(["poppy.enc.json"]);
  });
});
