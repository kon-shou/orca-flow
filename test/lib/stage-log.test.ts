import { describe, expect, it } from "vitest";
import {
  aggregate,
  computeTiming,
  formatDuration,
  median,
  noteKey,
  parseStages,
  turnOf,
  type StageEntry,
} from "../../src/lib/stage-log.ts";

const row = (
  at: string,
  state: string,
  note: string | null = null,
  command = "status",
): StageEntry => ({ at, state, note, command });
const line = (e: StageEntry) => JSON.stringify(e);
const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

describe("parseStages", () => {
  it("時刻の順に並べ、壊れた行は飛ばして数える", () => {
    const text = [
      line(row(T(10), "working")),
      "これは壊れている",
      line(row(T(0), "designing", null, "new")),
      '{"at":"xx","state":"a","note":null,"command":"status"}',
      '{"at":"2026-01-01T00:00:00Z"}',
      "",
    ].join("\n");
    const parsed = parseStages(text);
    expect(parsed.broken).toBe(3);
    expect(parsed.entries.map((e) => e.state)).toEqual([
      "designing",
      "working",
    ]);
  });

  it("最後の new の行より前は読まない", () => {
    const text = [
      row(T(0), "designing", null, "new"),
      row(T(5), "working"),
      row(T(9), "integrated", null, "integrate"),
      row(T(100), "designing", null, "new"),
      row(T(103), "spec-review"),
    ]
      .map(line)
      .join("\n");
    const parsed = parseStages(text);
    expect(parsed.entries.map((e) => e.state)).toEqual([
      "designing",
      "spec-review",
    ]);
  });
});

describe("computeTiming", () => {
  const entries = [
    row(T(0), "designing", null, "new"),
    row(T(4), "spec-review"),
    row(T(10), "working", "実装 1 を進める"),
    row(T(30), "working", "実装 2 を進める"),
    row(T(40), "question"),
    row(T(45), "integrate-wait"),
    row(T(55), "integrated", null, "integrate"),
  ];

  it("段の時間は次の行までの差で、合計と全体が合う", () => {
    const t = computeTiming(entries, new Date(T(999)));
    expect(t.integrated).toBe(true);
    expect(t.totalSeconds).toBe(55 * 60);
    expect(t.byState.get("designing")).toBe(4 * 60);
    expect(t.byState.get("working")).toBe(30 * 60);
    expect(t.byState.get("spec-review")).toBe(6 * 60);
    expect(t.byState.has("integrated")).toBe(false);
    expect(t.byNote.get("実装〈数〉を進める")).toBeUndefined();
    expect(t.byNote.get("実装 〈数〉 を進める")).toBe(30 * 60);
    expect(t.byTurn.get("タスク長")).toBe(34 * 60);
    expect(t.byTurn.get("待ち")).toBe(21 * 60);
    const sum = [...t.byState.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(t.totalSeconds);
  });

  it("統合前は今の段を now まで数え、印をつける", () => {
    const t = computeTiming(entries.slice(0, 3), new Date(T(25)));
    expect(t.integrated).toBe(false);
    expect(t.segments.at(-1)).toMatchObject({
      state: "working",
      seconds: 15 * 60,
      open: true,
    });
    expect(t.totalSeconds).toBe(25 * 60);
  });
});

describe("そのほか", () => {
  it("番の分け方", () => {
    expect(turnOf("designing")).toBe("タスク長");
    expect(turnOf("working")).toBe("タスク長");
    for (const s of ["spec-review", "question", "integrate-wait"])
      expect(turnOf(s)).toBe("待ち");
    expect(turnOf("zzz")).toBe("そのほか");
  });
  it("一言の数字を〈数〉にまとめる", () => {
    expect(noteKey("T12 の 3 回目")).toBe("T〈数〉 の 〈数〉 回目");
    expect(noteKey(null)).toBe("（一言なし）");
  });
  it("中央値と集計", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 3])).toBe(2);
    const stats = aggregate([
      new Map([["a", 60]]),
      new Map([["a", 180]]),
      new Map([["a", 600]]),
    ]);
    expect(stats).toEqual([
      { key: "a", count: 3, totalSeconds: 840, medianSeconds: 180 },
    ]);
  });
  it("時間の書き方", () => {
    expect(formatDuration(90)).toBe("1.5分");
    expect(formatDuration(3900)).toBe("1時間05分");
  });
});
