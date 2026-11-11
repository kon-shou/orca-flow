import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Orca } from "../../src/lib/orca.ts";
import {
  previewDeps,
  previewRecordPath,
  readPreviewRecord,
  removePreviewRecord,
  urlAnswers,
  urlFromOutput,
  waitForPreview,
  writePreviewRecord,
} from "../../src/lib/preview.ts";
import { tempDir } from "../helpers/repo.ts";

const SAVED = { ...previewDeps };
let now = 0;
beforeEach(() => {
  now = 0;
  previewDeps.clock = () => now;
  previewDeps.sleep = async (ms) => {
    now += ms;
  };
  previewDeps.pollMs = 1_000;
});
afterEach(() => Object.assign(previewDeps, SAVED));

const orcaWith = (reads: (n: number) => string[] | Error) => {
  let n = 0;
  return {
    reads: () => n,
    orca: {
      readOutput: async () => {
        const r = reads(n++);
        if (r instanceof Error) throw r;
        return r;
      },
    } as unknown as Orca,
  };
};

const fetchStatus = (statuses: (number | "fail")[]) => {
  let i = 0;
  previewDeps.fetch = (async () => {
    const s = statuses[Math.min(i++, statuses.length - 1)]!;
    if (s === "fail") throw new Error("refused");
    return { status: s, body: null };
  }) as unknown as typeof fetch;
};

describe("urlFromOutput", () => {
  it("最後に出た ORCA_FLOW_URL= の行の URL を取る", () => {
    expect(
      urlFromOutput([
        "ORCA_FLOW_URL=http://localhost:1/",
        "noise",
        "  ORCA_FLOW_URL=https://localhost:2/x  ",
      ]),
    ).toBe("https://localhost:2/x");
  });

  it("行の先頭でないもの・http(s) でないものは使わない", () => {
    expect(urlFromOutput(["$ echo ORCA_FLOW_URL=http://a/"])).toBeNull();
    expect(urlFromOutput(["ORCA_FLOW_URL=ftp://a/"])).toBeNull();
    expect(urlFromOutput(["ORCA_FLOW_URL=javascript:alert(1)"])).toBeNull();
    expect(urlFromOutput([])).toBeNull();
  });

  it("最後の行が http(s) でなければ、その前の正しい行を使う", () => {
    expect(
      urlFromOutput(["ORCA_FLOW_URL=http://a/", "ORCA_FLOW_URL=nope"]),
    ).toBe("http://a/");
  });
});

describe("urlFromOutput：制御文字", () => {
  it("ESC・BEL などの制御文字を含む行は使わない", () => {
    expect(
      urlFromOutput(["ORCA_FLOW_URL=http://localhost:3000\x1b[0m"]),
    ).toBeNull();
    expect(
      urlFromOutput(["ORCA_FLOW_URL=http://localhost:3000/\x1b]52;c;AAAA\x07"]),
    ).toBeNull();
    expect(
      urlFromOutput(["ORCA_FLOW_URL=http://localhost:3000/\u3042"]),
    ).toBeNull();
  });

  it("制御文字の行より前の正しい行を使い、URL は正規形で返す", () => {
    expect(
      urlFromOutput([
        "ORCA_FLOW_URL=http://localhost:3000/ok",
        "ORCA_FLOW_URL=http://localhost:3001\x1b[0m",
      ]),
    ).toBe("http://localhost:3000/ok");
    expect(urlFromOutput(["ORCA_FLOW_URL=http://LocalHost:3000"])).toBe(
      "http://localhost:3000/",
    );
  });
});

describe("urlAnswers", () => {
  it("応答が返れば true（5xx は false、接続の失敗も false）", async () => {
    fetchStatus([200]);
    expect(await urlAnswers("http://a/")).toBe(true);
    fetchStatus([404]);
    expect(await urlAnswers("http://a/")).toBe(true);
    fetchStatus([502]);
    expect(await urlAnswers("http://a/")).toBe(false);
    fetchStatus(["fail"]);
    expect(await urlAnswers("http://a/")).toBe(false);
  });
});

describe("waitForPreview", () => {
  const preview = { up: "x", timeoutSeconds: 10 };

  it("出力に URL が出て答えたら ready", async () => {
    const { orca } = orcaWith((n) =>
      n < 2 ? [] : ["ORCA_FLOW_URL=http://localhost:5173"],
    );
    fetchStatus(["fail", 200]);
    expect(await waitForPreview(orca, preview, "t")).toEqual({
      kind: "ready",
      url: "http://localhost:5173/",
    });
  });

  it("出力の読み取りが失敗しても次の回に続け、時間が来たら timeout", async () => {
    const { orca, reads } = orcaWith(() => new Error("読めない"));
    fetchStatus([200]);
    expect(await waitForPreview(orca, preview, "t")).toEqual({
      kind: "timeout",
    });
    expect(reads()).toBeGreaterThan(1);
  });

  it("設定の url があれば出力を読まない", async () => {
    const { orca, reads } = orcaWith(() => []);
    fetchStatus([200]);
    expect(
      await waitForPreview(
        orca,
        { ...preview, url: "http://localhost:80" },
        "t",
      ),
    ).toEqual({ kind: "ready", url: "http://localhost:80" });
    expect(reads()).toBe(0);
  });

  it("答えない URL は timeoutSeconds で打ち切る", async () => {
    const { orca } = orcaWith(() => ["ORCA_FLOW_URL=http://localhost:1"]);
    fetchStatus(["fail"]);
    expect(await waitForPreview(orca, preview, "t")).toEqual({
      kind: "timeout",
    });
    expect(now).toBeGreaterThanOrEqual(10_000);
    expect(now).toBeLessThanOrEqual(10_000 + 1_000);
  });
});

describe("記録", () => {
  it("書いて読み、消せる。なければ null", async () => {
    const common = await tempDir();
    expect(await readPreviewRecord(common, "T1")).toBeNull();
    const record = {
      id: "T1",
      worktree: "/w",
      terminal: "term_1",
      url: "http://a/",
      at: "2026-11-05T00:00:00.000Z",
    };
    await writePreviewRecord(common, record);
    expect(previewRecordPath(common, "T1")).toBe(
      path.join(common, "orca-flow", "preview", "T1.json"),
    );
    expect(await readPreviewRecord(common, "T1")).toEqual(record);
    await removePreviewRecord(common, "T1");
    expect(await readPreviewRecord(common, "T1")).toBeNull();
    await removePreviewRecord(common, "T1");
  });

  it("壊れた記録は FlowError(1) で、消す場所を伝える", async () => {
    const common = await tempDir();
    const file = previewRecordPath(common, "T1");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json");
    await expect(readPreviewRecord(common, "T1")).rejects.toMatchObject({
      code: 1,
      message: expect.stringContaining(file),
    });
    await writeFile(file, JSON.stringify({ id: "T1" }));
    await expect(readPreviewRecord(common, "T1")).rejects.toMatchObject({
      code: 1,
    });
    expect(await readFile(file, "utf8")).toContain("T1");
  });
});
