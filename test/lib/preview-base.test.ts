import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewDeps } from "../../src/lib/preview.ts";
import {
  clearE2eCaptures,
  e2eCapturesDir,
  isBrokenPreviewBase,
  previewBaseRecordPath,
  previewBaseStatus,
  previewBaseWorktreeDir,
  readPreviewBaseRecord,
  writePreviewBaseRecord,
  type PreviewBaseRecord,
} from "../../src/lib/preview-base.ts";
import type { CommandContext } from "../../src/types.ts";
import { tempDir } from "../helpers/repo.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const record: PreviewBaseRecord = {
  id: "T7",
  worktree: "/state/base/T7",
  taskWorktree: "/wt/T7-shop",
  terminal: "term_1",
  commit: "abc123",
  url: "http://localhost:5174/",
  at: "2026-11-05T00:00:00.000Z",
};

const answering = (status: number | "refused") => {
  previewDeps.fetch = (async () => {
    if (status === "refused") throw new Error("refused");
    return { status, body: null };
  }) as unknown as typeof fetch;
};

describe("前の画面の記録", () => {
  it("書いたものが同じ形で読め、なければ null", async () => {
    const common = await tempDir("orca-flow-common-");
    expect(await readPreviewBaseRecord(common, "T7")).toBeNull();
    await writePreviewBaseRecord(common, record);
    expect(await readPreviewBaseRecord(common, "T7")).toEqual(record);
    const { url: _url, ...noUrl } = record;
    await writePreviewBaseRecord(common, noUrl);
    expect(await readPreviewBaseRecord(common, "T7")).toEqual(noUrl);
  });

  it("JSON でない・キーが足りない・型が違うものは、投げずに印つきで返す", async () => {
    const common = await tempDir("orca-flow-common-");
    const file = previewBaseRecordPath(common, "T7");
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of [
      "{壊れ",
      "null",
      JSON.stringify({ ...record, commit: undefined }),
      JSON.stringify({ ...record, terminal: 3 }),
    ]) {
      await writeFile(file, text);
      const read = await readPreviewBaseRecord(common, "T7");
      expect(isBrokenPreviewBase(read)).toBe(true);
      expect(read).toMatchObject({ broken: true, reason: expect.any(String) });
    }
  });

  it("ID の形が外れたら記録の場所を組まない", () => {
    expect(() => previewBaseRecordPath("/c", "../x")).toThrow();
    expect(() => e2eCapturesDir("/c", "")).toThrow();
  });
});

describe("前の画面が答えるかの判定", () => {
  it("記録がない・壊れている・URL がまだ・答えないときは、理由つきで answers: false", async () => {
    const common = await tempDir("orca-flow-common-");
    answering(200);
    const none = await previewBaseStatus(common, "T7");
    expect(none).toMatchObject({ answers: false, record: null });
    expect((none as { reason: string }).reason).toContain("記録がありません");

    const file = previewBaseRecordPath(common, "T7");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{壊れ");
    const broken = await previewBaseStatus(common, "T7");
    expect(broken.answers).toBe(false);
    expect((broken as { reason: string }).reason).toContain("壊れ");

    const { url: _url, ...noUrl } = record;
    await writePreviewBaseRecord(common, noUrl);
    expect((await previewBaseStatus(common, "T7")).answers).toBe(false);

    await writePreviewBaseRecord(common, record);
    answering("refused");
    const silent = await previewBaseStatus(common, "T7");
    expect(silent.answers).toBe(false);
    expect((silent as { reason: string }).reason).toContain(record.url!);
    answering(503);
    expect((await previewBaseStatus(common, "T7")).answers).toBe(false);
  });

  it("URL が答えれば answers: true で、URL と記録を返す", async () => {
    const common = await tempDir("orca-flow-common-");
    await writePreviewBaseRecord(common, record);
    answering(200);
    expect(await previewBaseStatus(common, "T7")).toEqual({
      answers: true,
      url: record.url,
      record,
    });
  });
});

describe("置き場", () => {
  it("前の作業ツリーは XDG_STATE_HOME の下で、リポジトリと ID ごとに分かれる", () => {
    const env = { XDG_STATE_HOME: "/state" };
    const a = previewBaseWorktreeDir(env, "/repo-a/.git", "T7");
    expect(a.startsWith("/state/orca-flow/preview-base/")).toBe(true);
    expect(a.endsWith("/T7")).toBe(true);
    expect(previewBaseWorktreeDir(env, "/repo-b/.git", "T7")).not.toBe(a);
    expect(previewBaseWorktreeDir(env, "/repo-a/.git", "T8")).not.toBe(a);
    expect(a).not.toContain("/.git/");
  });

  it("XDG_STATE_HOME がなければ HOME の .local/state、どちらもなければ誤り", () => {
    expect(
      previewBaseWorktreeDir({ HOME: "/home/u" }, "/r/.git", "T7").startsWith(
        "/home/u/.local/state/orca-flow/preview-base/",
      ),
    ).toBe(true);
    expect(() => previewBaseWorktreeDir({}, "/r/.git", "T7")).toThrow();
  });

  it("録画の置き場は共通ディレクトリの orca-flow/e2e-captures/〈ID〉", () => {
    expect(e2eCapturesDir("/r/.git", "T7")).toBe(
      "/r/.git/orca-flow/e2e-captures/T7",
    );
  });

  it("録画の置き場を消す。ID が空・形が外れていれば何も消さない", async () => {
    const common = await tempDir("orca-flow-common-");
    const dir = e2eCapturesDir(common, "T7");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "flow-before.webm"), "x");
    const other = e2eCapturesDir(common, "T8");
    await mkdir(other, { recursive: true });
    const errs: string[] = [];
    const ctx = {
      stderr: (t: string) => errs.push(t),
    } as unknown as CommandContext;
    expect(await clearE2eCaptures(ctx, common, "")).toBe(false);
    expect(await clearE2eCaptures(ctx, common, "../T7")).toBe(false);
    expect(await clearE2eCaptures(ctx, common, "T7")).toBe(true);
    expect(await clearE2eCaptures(ctx, common, "T7")).toBe(false);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.dirname(dir))).toEqual(["T8"]);
    expect(errs).toEqual([]);
  });
});
