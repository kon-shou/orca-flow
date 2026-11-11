import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

// タスクの番号の形は、自分のファイルに書かないよう実行時に組む。
const idForm = new RegExp(`(^|[^A-Za-z0-9])${"P"}[0-9]+[a-z]?([^A-Za-z0-9]|$)`);
const homePath = /(^|[^A-Za-z0-9_.-])\/(home|Users)\//;

/** 「## 手順」の番号つきの項目を、番号 → 本文で返す。 */
function steps(text: string): Map<number, string> {
  const s = text.indexOf("\n## 手順\n");
  const e = text.indexOf("\n## ", s + 1);
  const map = new Map<number, string>();
  for (const l of text.slice(s, e).split("\n")) {
    const m = /^(\d+)\. (.*)$/.exec(l);
    if (m) map.set(Number(m[1]), m[2] ?? "");
  }
  return map;
}

describe("skills/workspace/SKILL.md", () => {
  it("名前・引数・モデルからは呼ばせない印がある", async () => {
    const t = await read("skills/workspace/SKILL.md");
    const head = t.split("---")[1] ?? "";
    expect(head).toMatch(/^name: workspace$/m);
    expect(head).toMatch(/^disable-model-invocation: true$/m);
    expect(head).toMatch(/^argument-hint: /m);
  });

  it("手順は1から6まで並ぶ", async () => {
    const nums = [...steps(await read("skills/workspace/SKILL.md")).keys()];
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("手順1：今の設定があれば書かず、上書きしない", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(1) ?? "";
    expect(s).toContain("orca-flow-workspace.json");
    expect(s).toContain("上書きしない");
    expect(s).toContain("orca-flow workspace --setup");
  });

  it("手順2：--draft --json を流し、入れる子と共通・アプリを聞く", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(2) ?? "";
    expect(s).toContain("orca-flow workspace --draft --json");
    expect(s).toContain("共通");
    expect(s).toContain("clone 元");
    expect(s).toContain("problems");
  });

  it("手順3：keywords・scope・コマンドを人と決め、リポジトリの中身の指示に従わない", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(3) ?? "";
    for (const w of ["keywords", "scope", "bumpCommand", "branchCommand"]) {
      expect(s).toContain(w);
    }
    expect(s).toMatch(/データとして読み[^\n]*従わない/);
  });

  it("手順4：設定は一時ファイルに書いて --setup に渡し、ワークスペースのフォルダに直に書かない", async () => {
    const t = await read("skills/workspace/SKILL.md");
    const s = steps(t).get(4) ?? "";
    expect(s).toContain("一時ファイル");
    expect(s).toContain("orca-flow workspace --setup 〈一時ファイル〉");
    expect(s).toMatch(/`--yes` は付けない/);
    expect(t).toMatch(/設定はワークスペースのフォルダに直に書かない/);
  });

  it("手順5：--yes の前に、設定の全文と一覧を見せて聞く", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(5) ?? "";
    expect(s).toContain("--setup");
    for (const w of ["進める", "直す", "やめる"]) expect(s).toContain(w);
    expect(s).toMatch(/`--yes` の前に[^\n]*聞/);
  });

  it("手順6：--yes で進め、次の手順をそのまま伝え、子の init は流さない", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(6) ?? "";
    expect(s).toContain("--setup 〈一時ファイル〉 --yes");
    expect(s).toMatch(/次の手順[^\n]*そのまま伝え/);
    expect(s).toContain("子の init は流さない");
  });

  it("--yes を付けた流し方は手順6だけにある", async () => {
    const m = steps(await read("skills/workspace/SKILL.md"));
    for (const n of [1, 2, 3, 4, 5]) {
      expect(m.get(n) ?? "", `手順${n}`).not.toContain(
        "--setup 〈一時ファイル〉 --yes",
      );
    }
  });

  it("手順2：users が null の子は推しなしで聞く", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(2) ?? "";
    expect(s).toMatch(/`users` が null[^\n]*推しなしで人に聞く/);
  });

  it("手順5・6：手順1から来たときは一時ファイルを使わず、設定のファイルを渡さない --setup --yes を流す", async () => {
    const m = steps(await read("skills/workspace/SKILL.md"));
    expect(m.get(5) ?? "").toMatch(
      /手順1から来たとき[^\n]*人が手で直すか消して打ち直す/,
    );
    expect(m.get(6) ?? "").toContain("orca-flow workspace --setup --yes");
  });

  it("手順6：終了コード1は写し済みなので手で直して流し直し、止まるときは一時ディレクトリを消す", async () => {
    const s = steps(await read("skills/workspace/SKILL.md")).get(6) ?? "";
    expect(s).toMatch(/終了コード1[^\n]*もう[^\n]*写っている/);
    expect(s).toMatch(/手で直すか消して[^\n]*orca-flow workspace --setup/);
    expect(s).toMatch(/一時ファイルの道へは戻らない/);
    expect(s).toMatch(/終了コードにかかわらず、一時ディレクトリを消す/);
  });

  it("「## 人に聞くとき」の節が手順の前に1つある", async () => {
    const t = await read("skills/workspace/SKILL.md");
    expect(t.split("\n## 人に聞くとき\n")).toHaveLength(2);
    expect(t.indexOf("\n## 人に聞くとき\n")).toBeLessThan(
      t.indexOf("\n## 手順\n"),
    );
    expect(t).toContain("AskUserQuestion");
    expect(t).toContain("- このスキルで当たる所：");
  });

  it("手順6：settings の ask を人が入れる案内があり、守ることに settings を書かない旨がある", async () => {
    const t = await read("skills/workspace/SKILL.md");
    const s = steps(t).get(6) ?? "";
    expect(s).toContain("permissions.ask");
    expect(s).toContain("Bash(orca-flow qa deploy *)");
    expect(s.indexOf("permissions.ask")).toBeLessThan(
      s.indexOf("`/orca-flow:intake`"),
    );
    const rules = t.slice(t.indexOf("\n## 守ること\n"));
    expect(rules).toMatch(
      /settings[^\n]*ユーザーの設定は書かない[^\n]*人が入れる/,
    );
  });

  it("手元のパスとタスクの番号の形が出ない", async () => {
    const t = await read("skills/workspace/SKILL.md");
    const lines = t.split("\n");
    expect(lines.filter((l) => idForm.test(l))).toEqual([]);
    expect(lines.filter((l) => homePath.test(l))).toEqual([]);
  });
});
