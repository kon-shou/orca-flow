import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 設計書の要点に書く行。spec と review で同じ文字を使う */
const POINT_LINE = "- コードレビュー：文書だけ（軽く回す）";

/** この変更の前の docs/spec.md の 10.1 の表で、いちばん長い行の文字数（JS の文字列の長さ。表の区切りの行） */
const MAX_TABLE_ROW = 4688;
/** この変更の前の run の行の中身（前後の空白を除く）の見た目の幅（全角を2と数える）。これを超えると表の幅が広がる */
const RUN_CELL_WIDTH = 4595;

/** 全角（幅広）の文字を2、それ以外を1と数えた見た目の幅 */
function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** `## 見出し` から次の `## ` の前まで */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

/** 手順の行（`〈数〉. ` で始まる行）から、次の手順の行の前まで */
function stepBlock(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${n}\\. `).test(l));
  expect(start, `手順${n}がありません`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && new RegExp(`^${n + 1}\\. `).test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("review の文書だけの扱い", () => {
  it("見分け方に5つの条件が書いてある", async () => {
    const s = section(await read("skills/review/SKILL.md"), /^## 文書だけ/);
    expect(s).toContain(`\`${POINT_LINE}\``);
    expect(s).toMatch(/codeReview が full/);
    expect(s).toContain("reviewBackend が claude");
    expect(s).toContain("拡張子 .md");
    expect(s).toContain("小さな差分のしきい値と同じ数え方");
    expect(s).toContain("sharedPaths");
    expect(s).toContain("pathVerify");
    expect(s).toContain("`〈baseBranch〉...HEAD`");
    expect(s).toContain("1つでも外れたら");
  });

  it("軽い回し方に、レビュー役1つ・検証役なし・タスク長が確かめるもの・件数の書き方がある", async () => {
    const s = section(await read("skills/review/SKILL.md"), /^## 文書だけ/);
    expect(s).toContain("レビュー役（`orca-flow:code-reviewer`）を1つだけ");
    expect(s).toContain("検証役は起動しない");
    expect(s).toContain("タスク長が確かめるもの");
    expect(s).toContain("文書だけ（検証役なし）");
    expect(s).toContain("確認役はいつもどおり動く");
  });

  it("やり直しの形では何も起動せず、秘密と個人のパスの確かめだけを流す", async () => {
    const s = section(await read("skills/review/SKILL.md"), /^## 文書だけ/);
    const line = s
      .split("\n")
      .find((l) => l.startsWith("やり直しの形（文書だけ）"));
    expect(line).toBeDefined();
    expect(line).toContain("何も起動せず");
    expect(line).toContain("秘密と個人のパスの確かめ");
  });

  it("見分け方のファイル一覧のコマンドは、移動元も出す（スキルの定義を .md に移して文書だけと判定されない）", async () => {
    const s = section(await read("skills/review/SKILL.md"), /^## 文書だけ/);
    const line = s.split("\n").find((l) => l.includes("git diff --name-only"));
    expect(line).toBeDefined();
    const found = (line as string).match(/`(git diff --name-only[^`]*)`/);
    expect(found).not.toBeNull();
    const cmd = (found as RegExpMatchArray)[1]?.replace(
      "〈baseBranch〉",
      "main",
    ) as string;
    expect(cmd).toContain("--no-renames");
    const dir = await makeRepo(
      {},
      { "skills/a/SKILL.md": "# skill\nline one\nline two\nline three\n" },
    );
    await git(dir, "checkout", "-q", "-b", "work");
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await git(dir, "mv", "skills/a/SKILL.md", "docs/a.md");
    await git(dir, "commit", "-q", "-m", "move");
    const result = await testRunner("sh", ["-c", cmd], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    const files = result.stdout.split("\n").filter((l) => l !== "");
    expect(files.sort()).toEqual(["docs/a.md", "skills/a/SKILL.md"]);
  });

  it("番号つきの手順に、文書だけの分かれ道がある", async () => {
    const text = await read("skills/review/SKILL.md");
    const step1 = stepBlock(text, 1);
    expect(step1).toContain("sharedPaths");
    expect(step1).toContain("pathVerify");
    expect(step1).toContain("文書だけ");
    expect(step1).toContain("何も起動せず");
    expect(step1).toContain("手順9");
    expect(stepBlock(text, 3)).toContain("文書だけ");
    const step4 = stepBlock(text, 4);
    expect(step4).toContain("文書だけ");
    expect(step4).toContain("検証役を起動せず");
    expect(stepBlock(text, 9)).toContain("タスク長が確かめるもの");
  });

  it("最初のレビューの手順4で、指摘が0件でも秘密と個人のパスの確かめを先に流す", async () => {
    const step4 = stepBlock(await read("skills/review/SKILL.md"), 4);
    const check = step4.indexOf("秘密と個人のパスの確かめ");
    expect(check).toBeGreaterThan(-1);
    expect(step4).toContain("指摘の有無によらず");
    // 「指摘が1つもなければ手順8へ進む」より前に書く（0件で確かめを飛ばさない）
    expect(check).toBeLessThan(step4.indexOf("指摘が1つもなければ"));
  });

  it("md だけの差分の行と、full・light・off の動きは残っている", async () => {
    const text = await read("skills/review/SKILL.md");
    const line = text.split("\n").find((l) => l.includes("md だけの差分"));
    expect(line).toContain("0行");
    expect(line).toContain("レビュー役1つと検証役1つ");
    expect(text).toContain("- `full`（既定。書かれていないときも）");
    expect(text).toContain("- `light`：");
    expect(text).toContain("- `off`：");
  });
});

describe("秘密と個人のパスの確かめ", () => {
  async function checkLines(): Promise<string[]> {
    return (await read("skills/review/SKILL.md"))
      .split("\n")
      .filter((l) => l.startsWith("秘密と個人のパスの確かめ："));
  }

  async function command(): Promise<string> {
    const lines = await checkLines();
    expect(lines.length).toBe(1);
    const found = [...(lines[0] as string).matchAll(/`([^`]*)`/g)];
    expect(found.length, "バッククォートの中のコマンドは1つ").toBe(1);
    return ((found[0] as RegExpMatchArray)[1] as string).replace(
      "〈baseBranch〉",
      "main",
    );
  }

  /** base に base の中身を置き、work で add を足して、コマンドが当たるか */
  async function hits(add: string, remove?: string): Promise<boolean> {
    const dir = await makeRepo(
      {},
      { "notes.md": remove === undefined ? "base\n" : `${remove}\n` },
    );
    await git(dir, "checkout", "-q", "-b", "work");
    await writeFiles(dir, {
      "notes.md": remove === undefined ? `base\n${add}\n` : "base\n",
    });
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "change");
    const result = await testRunner("sh", ["-c", await command()], {
      cwd: dir,
    });
    expect(result.code === 0 || result.code === 1, result.stderr).toBe(true);
    return result.code === 0;
  }

  const TOKEN = "ghp_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7";
  // mac のホームの形。公開の確かめの語に当たらないよう、つないで作る
  const MAC_HOME = "/Use" + "rs/";

  it("行は1つで、足した行だけを見るコマンドが1つある", async () => {
    expect((await checkLines()).length).toBe(1);
    const cmd = await command();
    expect(cmd).toMatch(/^git diff /);
    expect(cmd).toContain("main...HEAD");
    expect(cmd).toContain("grep -E");
  });

  it.each([
    ["ホームの絶対パス（mac）", `ここは ${MAC_HOME}someone/work です`],
    ["ホームの絶対パス（行頭）", `${MAC_HOME}someone/work`],
    ["ホームの絶対パス（linux）", "cd /home/someone/work"],
    ["メールアドレス", "連絡は someone@example.com まで"],
    ["秘密鍵の頭の行", "-----BEGIN RSA PRIVATE KEY-----"],
    ["秘密鍵の頭の行（形式なし）", "-----BEGIN PRIVATE KEY-----"],
    ["トークンの頭", `token: ${TOKEN}`],
    ["名前のあとに / がないパス", `cd ${MAC_HOME}alice`],
    ["バッククォートで囲んだパス", `\`${MAC_HOME}alice\` を使う`],
    ["文末のパス", "場所は /home/bob."],
    ["file:/// のパス", `file://${MAC_HOME}alice/x`],
  ])("足した行の %s に当たる", async (_name, line) => {
    expect(await hits(line)).toBe(true);
  });

  it("消した行の同じ文字には当たらない", async () => {
    expect(await hits("", `${MAC_HOME}someone/work`)).toBe(false);
    expect(await hits("", `token: ${TOKEN}`)).toBe(false);
  });

  it.each([
    ["プラグインの場所", "${CLAUDE_PLUGIN_ROOT}/bin/orca-flow"],
    ["git の共通ディレクトリ", "〈git の共通ディレクトリ〉/orca-flow/reviews"],
    ["ホームの設定", "~/.claude/settings.json"],
    ["~ つきの名前", `~${MAC_HOME}alice/x`],
    ["作業ツリーの中の home", "docs/home/foo/bar.md"],
    ["名前のひな形", `${MAC_HOME}〈名前〉/ や /home/〈名前〉/`],
    ["パッケージ名", "@types/node を入れる"],
    ["長いハイフンつきの名前", "task-orca-flow-review-verifier-agent-name"],
    ["ふつうの文", "文書だけのタスクは、レビュー役が1つで回ります。"],
  ])("%s には当たらない", async (_name, line) => {
    expect(await hits(line)).toBe(false);
  });
});

describe("spec のスキルの文書だけの宣言", () => {
  it("要点の行の文字と、2つの条件がある", async () => {
    const text = await read("skills/spec/SKILL.md");
    expect(text).toContain(`\`${POINT_LINE}\``);
    const line = text.split("\n").find((l) => l.includes(POINT_LINE));
    expect(line).toContain("md");
    expect(line).toContain("sharedPaths");
    expect(line).toContain("pathVerify");
    expect(line).toContain("readFirst");
    expect(line).toContain("正とする仕様");
    expect(line).toContain("変えない");
    expect(line).toContain("変わること");
  });
});

describe("run のスキルの文書だけの扱い", () => {
  it("手順6で、タスク長が確かめるものを根拠を開いて確かめ、本当なら直し、そうでなければ報告に書く", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = block
      .split("\n")
      .find((l) => l.includes("タスク長が確かめるもの"));
    expect(line).toBeDefined();
    expect(line).toContain("根拠");
    expect(line).toContain("開いて");
    expect(line).toContain("本当なら");
    expect(line).toContain("直");
    expect(line).toContain("本当でなければ");
    expect(line).toContain("報告");
    expect(line).toContain("2回");
    expect(line).toContain("確認役はいつもどおり");
  });

  it("手順6で、直したあとに根拠をもう一度開いて確かめ、2回で直らないものの扱いを分ける", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 6);
    const line = block
      .split("\n")
      .find((l) => l.includes("タスク長が確かめるもの")) as string;
    expect(line).toContain("もう一度開いて、直ったかを確かめる");
    expect(line).toMatch(
      /2回で直らない「必ず直す」は[^。]*「統合の前に人が決めるもの」で人に聞く/,
    );
    expect(line).toMatch(
      /2回で直らない「直したほうがよい」は[^。]*報告に「2回で直らない」で書く/,
    );
  });

  it("手順8に、文書だけとして軽く回したことと印を書く", async () => {
    const block = stepBlock(await read("skills/run/SKILL.md"), 8);
    expect(block).toContain("文書だけとして軽く回した");
    expect(block).toContain("検証役なし・タスク長が確かめた");
  });
});

describe("docs/spec.md の文書だけ", () => {
  it("3章の表の下に書いてある", async () => {
    const spec = await read("docs/spec.md");
    const start = spec.indexOf("## 3. ");
    const end = spec.indexOf("## 4. ");
    const chapter = spec.slice(start, end);
    expect(chapter).toContain(POINT_LINE);
    expect(chapter).toContain("文書だけ");
  });

  it("10.1 の spec・review・run の行に書いてある", async () => {
    const rows = (await read("docs/spec.md")).split("\n");
    for (const head of [
      "| `/orca-flow:spec ",
      "| `/orca-flow:review ",
      "| `/orca-flow:run ",
    ]) {
      const row = rows.find((l) => l.startsWith(head));
      expect(row, head).toBeDefined();
      expect(row).toContain("文書だけ");
    }
    const specRow = rows.find((l) => l.startsWith("| `/orca-flow:spec "));
    expect(specRow).toContain(POINT_LINE);
  });

  it("10.1 の表の区切りの行は前より長くならず、run の行の中身の見た目の幅も前より広がらない", async () => {
    const lines = (await read("docs/spec.md")).split("\n");
    const start = lines.findIndex((l) => l.startsWith("### 10.1"));
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    const rows = lines.slice(start, end).filter((l) => l.startsWith("|"));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(row.length, row.slice(0, 30)).toBeLessThanOrEqual(MAX_TABLE_ROW);
    }
    const run = rows.find((l) => l.startsWith("| `/orca-flow:run ")) as string;
    const cells = run.split("|");
    const body = (cells[cells.length - 2] as string).trim();
    expect(displayWidth(body)).toBeLessThanOrEqual(RUN_CELL_WIDTH);
  });
});
