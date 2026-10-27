import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const metadataSchema = z.object({
  selectedContextId: z.string().optional(),
  contexts: z.record(z.string(), z.object({
    name: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    status: z.enum(["draft", "saved"]).optional(),
    ownerSessionId: z.string().optional(),
    expiresAt: z.iso.datetime().optional(),
    /** Verified principal id of the Context owner (isolated sessions only). */
    ownerId: z.string().optional(),
    /** Conversation audience the Context belongs to; "group" is never reusable. */
    audience: z.enum(["direct", "group"]).optional(),
  })),
  /**
   * Immutable initiating-principal bindings for group browser tasks. The first
   * verified group member to start browser work (or the durable conversation's
   * initiatingPrincipal when known) owns the task until its browser closes.
   */
  groupBrowserTasks: z.record(z.string(), z.object({
    ownerId: z.string(),
    audience: z.literal("group"),
    bindingId: z.string().optional(),
    membershipVersion: z.number().int().nonnegative().optional(),
    boundAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })).optional(),
});

export type ContextMetadataFile = z.infer<typeof metadataSchema>;

/**
 * Whether a stored Context row may be reused outside the task that owns it.
 * Group-isolated rows are the only non-reusable audience; drafts remain
 * reusable by their owning session until expiry.
 */
export function isReusableContext(
  row: ContextMetadataFile["contexts"][string] | undefined,
): boolean {
  return row?.audience !== "group";
}

/**
 * Whether a stored Context row is the group-isolated Context owned by this
 * session — the restore/release guard; a foreign or shared Context never
 * satisfies it.
 */
export function isOwnedGroupContext(
  row: ContextMetadataFile["contexts"][string] | undefined,
  ownerSessionId: string,
): boolean {
  return row?.audience === "group" && row.ownerSessionId === ownerSessionId;
}

// All instances in this process share the read/modify/write queue for a path.
const pendingWrites = new Map<string, Promise<void>>();

export class ContextMetadataStore {
  private readonly filePath: string;

  constructor(filePath = defaultMetadataPath()) {
    this.filePath = path.resolve(filePath);
  }

  async read(): Promise<ContextMetadataFile> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contexts: {} };
      throw error;
    }
    try {
      return metadataSchema.parse(JSON.parse(contents));
    } catch (error) {
      throw new Error("Browser context metadata is invalid; refusing to overwrite it.", { cause: error });
    }
  }

  /**
   * Every Context a caller may list, select or promote — group-isolated and
   * draft rows are excluded so call sites never re-test the invariant.
   */
  async listReusable(): Promise<ContextMetadataFile> {
    const local = await this.read();
    return {
      ...local,
      contexts: Object.fromEntries(
        Object.entries(local.contexts).filter(
          ([, row]) => row.audience !== "group" && row.status !== "draft",
        ),
      ),
    };
  }

  /**
   * The row for `id`, throwing when it is group-isolated — guards that must
   * never proceed against a foreign group task's Context share this check.
   */
  async assertReusable(id: string): Promise<ContextMetadataFile["contexts"][string] | undefined> {
    const row = (await this.read()).contexts[id];
    if (row?.audience === "group")
      throw new Error("This Context belongs to an isolated group task.");
    return row;
  }

  async add(id: string, name: string, now = new Date()): Promise<void> {
    await this.update((current) => {
      const at = now.toISOString();
      current.contexts[id] = { name, createdAt: at, updatedAt: at };
      current.selectedContextId ??= id;
    });
  }

  async addDraft(
    id: string,
    name: string,
    ownerSessionId: string,
    expiresAt: Date,
    now = new Date(),
    isolation?: { ownerId?: string; audience?: "direct" | "group" },
  ): Promise<void> {
    await this.update((current) => {
      const at = now.toISOString();
      current.contexts[id] = {
        name,
        createdAt: at,
        updatedAt: at,
        status: "draft",
        ownerSessionId,
        expiresAt: expiresAt.toISOString(),
        ...(isolation?.ownerId ? { ownerId: isolation.ownerId } : {}),
        ...(isolation?.audience ? { audience: isolation.audience } : {}),
      };
    });
  }

  async touchDraft(id: string, expiresAt: Date, now = new Date()): Promise<void> {
    await this.update((current) => {
      const context = current.contexts[id];
      if (!context || context.status !== "draft") return false;
      context.updatedAt = now.toISOString();
      context.expiresAt = expiresAt.toISOString();
    });
  }

  async promote(id: string, name: string, now = new Date()): Promise<void> {
    await this.update((current) => {
      const context = current.contexts[id];
      if (!context) throw new Error("Unknown Context.");
      context.name = name;
      context.updatedAt = now.toISOString();
      context.status = "saved";
      delete context.ownerSessionId;
      delete context.expiresAt;
      current.selectedContextId = id;
    });
  }

  async remove(id: string): Promise<void> {
    await this.update((current) => {
      delete current.contexts[id];
      if (current.selectedContextId === id)
        current.selectedContextId = Object.keys(current.contexts)[0];
    });
  }

  async select(id: string): Promise<void> {
    await this.update((current) => {
      if (!current.contexts[id]) throw new Error("Unknown Context.");
      current.selectedContextId = id;
      current.contexts[id].updatedAt = new Date().toISOString();
    });
  }

  /** The recorded owner of a group browser task, when one was bound. */
  async groupBrowserTask(
    sessionId: string,
  ): Promise<NonNullable<ContextMetadataFile["groupBrowserTasks"]>[string] | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    return (await this.read()).groupBrowserTasks?.[sessionId];
  }

  /**
   * Binds (or refreshes) the immutable owner of a group browser task. The
   * original boundAt is preserved; ownerId, bindingId and membershipVersion
   * update only when new values are supplied.
   */
  async bindGroupBrowserTask(
    sessionId: string,
    fields: { ownerId: string; bindingId?: string; membershipVersion?: number },
    now = new Date(),
  ): Promise<void> {
    await this.update((current) => {
      current.groupBrowserTasks ??= {};
      const existing = current.groupBrowserTasks[sessionId];
      const at = now.toISOString();
      current.groupBrowserTasks[sessionId] = {
        ownerId: fields.ownerId,
        audience: "group",
        bindingId: fields.bindingId ?? existing?.bindingId,
        membershipVersion: fields.membershipVersion ?? existing?.membershipVersion,
        boundAt: existing?.boundAt ?? at,
        updatedAt: at,
      };
    });
  }

  /**
   * Releases the binding when a group browser task closes so a later task can
   * bind an explicitly verified owner again (a new task/session generation).
   */
  async unbindGroupBrowserTask(sessionId: string): Promise<void> {
    await this.update((current) => {
      if (!current.groupBrowserTasks?.[sessionId]) return false;
      delete current.groupBrowserTasks[sessionId];
    });
  }

  private async update(mutate: (value: ContextMetadataFile) => void | false): Promise<void> {
    const operation = (pendingWrites.get(this.filePath) ?? Promise.resolve()).then(async () => {
      const current = await this.read();
      if (mutate(current) !== false) await this.write(current);
    });
    const tail = operation.catch(() => undefined);
    pendingWrites.set(this.filePath, tail);
    try {
      await operation;
    } finally {
      if (pendingWrites.get(this.filePath) === tail) pendingWrites.delete(this.filePath);
    }
  }

  private async write(value: ContextMetadataFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

declare global {
  var __bellContextMetadataStore: ContextMetadataStore | undefined;
}

export function getContextMetadataStore(): ContextMetadataStore {
  globalThis.__bellContextMetadataStore ??= new ContextMetadataStore();
  return globalThis.__bellContextMetadataStore;
}

function defaultMetadataPath(): string {
  return process.env.BELL_CONTEXT_METADATA_PATH
    ? path.resolve(process.env.BELL_CONTEXT_METADATA_PATH)
    : path.join(process.cwd(), ".bell", "contexts.json");
}
