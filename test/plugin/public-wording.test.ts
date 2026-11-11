import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// 公開用の確かめに自分が当たらないよう、探す言葉は実行時に組む。
// OS の意味の端末の名前（「〈端末〉では …」）は書いてよいので、端末の名前と「束」の組み合わせだけを運用の言い回しとして見る。
const DEVICE = ["M", "ac"].join("");
const HOME_HEAD = ["/", "Us", "ers", "/"].join("");
const forbidden: { label: string; re: RegExp }[] = [
  {
    label: "手元の運用の言い回し",
    re: new RegExp(`(?<![A-Za-z])${DEVICE}(?![A-Za-z])[^。、\\n]{0,8}束`),
  },
  {
    label: "手元の道具のパス",
    re: new RegExp(["scripts", "/", "mac", "-patch"].join(""), "i"),
  },
  // 公開用の確かめ local の手元のパスの規則にそろえる（偽の値の /home/〈名前〉/ は見ない）
  {
    label: "手元のホームの頭",
    re: new RegExp(`(?<![A-Za-z0-9_.-])${HOME_HEAD}`, "i"),
  },
];

function hitLabels(line: string): string[] {
  return forbidden.filter(({ re }) => re.test(line)).map(({ label }) => label);
}

const files = [
  "skills/integrate/SKILL.md",
  "docs/spec.md",
  "src/lib/merge-subject.ts",
];

describe("公開に出る文：手元の運用の言葉がない", () => {
  for (const file of files) {
    it(`${file} に手元の端末の名前と道具のパスがない`, async () => {
      const text = await readFile(path.join(ROOT, file), "utf8");
      const lines = text.split("\n");
      const hits = lines.flatMap((l, i) =>
        hitLabels(l).map((label) => `${i + 1}：${label}`),
      );
      expect(hits, file).toEqual([]);
    });
  }

  it("手での取り込みの括弧は、別の手元で作ったパッチの取り込みを指す", async () => {
    const spec = await readFile(path.join(ROOT, "docs/spec.md"), "utf8");
    const skill = await readFile(
      path.join(ROOT, "skills/integrate/SKILL.md"),
      "utf8",
    );
    const phrase =
      "手での取り込み（cherry-pick や別の手元で作ったパッチの取り込み）";
    expect(spec).toContain(phrase);
    expect(skill).toContain(phrase);
  });

  it("OS の意味の端末の名前と偽のホームの例には当たらない", () => {
    const allowed = [
      `Linux は ss、${DEVICE} は lsof で見る。`,
      `${DEVICE} では動かない。`,
      `${DEVICE}OS の版`,
      `偽の値に ${["/", "home", "/", "someone", "/"].join("")} を使う。`,
      `GET /api${HOME_HEAD}1`,
    ];
    for (const line of allowed) {
      expect(hitLabels(line), line).toEqual([]);
    }
  });

  it("運用の言い回し・道具のパス・ホームの頭には当たる", () => {
    const cases: [string, string][] = [
      [
        `手での取り込み（cherry-pick や ${DEVICE} からの束）`,
        "手元の運用の言い回し",
      ],
      [`${DEVICE} への束を作る`, "手元の運用の言い回し"],
      [`${DEVICE}からの束`, "手元の運用の言い回し"],
      [
        `${["scripts", "/", "mac", "-patch"].join("")}/send.sh`,
        "手元の道具のパス",
      ],
      [`${HOME_HEAD}someone/dev`, "手元のホームの頭"],
    ];
    for (const [line, label] of cases) {
      expect(hitLabels(line), line).toEqual([label]);
    }
  });
});
