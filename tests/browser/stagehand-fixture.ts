import type { Stagehand } from "@browserbasehq/stagehand";
import { vi } from "vitest";

/** Execute real middleware callbacks against a native-page fixture. */
export function stagehandFixture<Page>(page: Page) {
  const context = {
    activePage: vi.fn(async () => page),
    pages: vi.fn(async () => [page]),
    newPage: vi.fn(async () => page),
    setActivePage: vi.fn(async () => {}),
  };
  const browser = { context, close: vi.fn(async () => {}) };
  const batch = vi.fn(async <Result, Input>(
    callback: (runtime: { page: Page; context: typeof context }, input: Input) => Promise<Result>,
    input: Input,
  ) => callback({ page, context }, input));
  const stagehand = {
    browser,
    experimentalBatch: batch,
    close: vi.fn(async () => {}),
  } as unknown as Stagehand;
  return { stagehand, browser, batch, context };
}
