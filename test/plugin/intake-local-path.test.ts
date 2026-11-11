import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "../helpers/tmp/index.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

const SKILL = "skills/intake/SKILL.md";
const LOCAL = "skills/intake/local.md";

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(m).not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `見出しが見つかりません：${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i] ?? "");
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("SKILL.md の手元のパスの分かれ道", () => {
  it("入口の最初の項が、http(s) で始まらず空でもないものを手元のパスとし、local.md へ進める", async () => {
    const entry = section(await read(SKILL), /^## 入口/);
    const first = entry.split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(first).toContain("http://");
    expect(first).toContain("https://");
    expect(first).toContain("空でもなければ");
    expect(first).toContain("skills/intake/local.md");
    expect(first).toContain("入口のほかの項はしない");
    expect(first).toContain("`--here` を除いた");
    expect(first).toContain("頭に `--here` があれば");
    expect(first).not.toContain("頭が `--here`");
    expect(first).not.toContain("頭に `--here` がなければ");
  });

  it("入口の手元のパスの項が、両端の引用符を外してから一重引用符で囲んで流す", async () => {
    const entry = section(await read(SKILL), /^## 入口/);
    const item =
      entry
        .split("\n")
        .find((l) => l.includes("`orca-flow intake '〈手元のパス〉'`")) ?? "";
    expect(item).toContain("両端の引用符（`\"` か `'`）は外してから");
    expect(item.indexOf("外してから")).toBeLessThan(
      item.indexOf("一重引用符で囲む"),
    );
    expect(item).toContain("中の `'` は `'\\''`");
  });

  it("手順は1〜11のままで、打ち直しの案内の行を SKILL.md に作らない", async () => {
    const text = await read(SKILL);
    const steps = section(text, /^## 手順/);
    const nums = steps
      .split("\n")
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const lines = text
      .split("\n")
      .filter((l) => /\/orca-flow:intake\s+〈/.test(l));
    expect(lines).toHaveLength(0);
  });

  it("frontmatter に手元のパスがあり、Notion と統括役のタブが残る", async () => {
    const fm = frontmatter(await read(SKILL));
    expect(fm["argument-hint"]).toContain("手元");
    expect(fm["argument-hint"]).toContain("パス");
    const d = fm["description"] ?? "";
    expect(d).toContain("手元");
    expect(d).toContain("下書き");
    expect(d).toContain("Notion");
    expect(d).toContain("統括役のタブ");
  });

  it("local.md の「人に聞く所」に、分ける前の問いがある", async () => {
    const t = await read(LOCAL);
    const line =
      t.split("\n").find((l) => l.includes("この道で当たる所は")) ?? "";
    expect(line).toContain("分ける前の問い");
  });

  it("「このスキルで当たる所」の行の末尾に、手元のパスの道の聞く所がある", async () => {
    const line =
      (await read(SKILL))
        .split("\n")
        .find((l) => l.startsWith("- このスキルで当たる所：")) ?? "";
    expect(line).toContain("`local.md`");
    expect(line.indexOf("`local.md`")).toBeGreaterThan(
      line.indexOf("guards.md"),
    );
    expect(line.endsWith("。")).toBe(true);
  });
});

describe("skills/intake/local.md", () => {
  it("新しいタブ・intake・new・Notion・タスクの開始をしない", async () => {
    const t = await read(LOCAL);
    expect(t).toContain("新しいタブの本体");
    expect(t).toContain("新しいタブは立てない");
    expect(t).toContain("`orca-flow intake` と `new` を流さない");
    expect(t).toContain("ToolSearch");
    expect(t).toContain("Notion を読まず、書かない");
    expect(t).toContain("タスクを始めない");
  });

  it("場所の確かめが、パスの見分けより前にある", async () => {
    const s = section(await read(LOCAL), /^## 受け取り/);
    const ws = s.indexOf("orca-flow-workspace.json");
    const git = s.indexOf("--git-common-dir");
    const path1 = s.indexOf("空白を含む");
    expect(ws).toBeGreaterThanOrEqual(0);
    expect(git).toBeGreaterThanOrEqual(0);
    expect(path1).toBeGreaterThan(ws);
    expect(path1).toBeGreaterThan(git);
    expect(s).toContain("メインのチェックアウト");
    expect(s).toContain("workspace.md");
    expect(s).toContain("終了コードが0以外");
  });

  it("受ける形・フォルダの数え方・zip・ないパス・ほかの形がある", async () => {
    const s = section(await read(LOCAL), /^## 受け取り/);
    expect(s).toContain("引用符");
    expect(s).toContain(".md");
    expect(s).toContain(".html");
    expect(s).toContain("フォルダ");
    expect(s).toContain("見分けの印のないものを数える");
    expect(s).toContain("1つならそれをチケットにする");
    expect(s).toContain("0なら");
    expect(s).toContain("2つ以上なら");
    expect(s).toContain(".zip");
    expect(s).toContain("展開してフォルダを渡すよう頼んで止まる");
    expect(s).toContain("ないパス");
    expect(s).toContain("`https://` で始めて打ち直す");
    expect(s).toContain("ほかの形");
  });

  it("パスを見分ける項が、先頭の --here と続く空白を外してから残りを1つのパスとして読む", async () => {
    const s = section(await read(LOCAL), /^## 受け取り/);
    const item =
      s.split("\n").find((l) => l.startsWith("3. パスを見分ける")) ?? "";
    const here = item.indexOf("--here");
    expect(here).toBeGreaterThanOrEqual(0);
    expect(item).toContain("外して");
    expect(item).toContain("先頭の `--here`");
    expect(item.indexOf("1つのパスとして読む")).toBeGreaterThan(here);
    expect(item.indexOf("外して")).toBeGreaterThan(here);
    expect(item.indexOf("外して")).toBeLessThan(
      item.indexOf("1つのパスとして読む"),
    );
  });

  it("--path-file なら受け渡しのファイルを Read で読み、そのディレクトリを一時ディレクトリに使い、読めなければ止まる", async () => {
    const s = section(await read(LOCAL), /^## 受け取り/);
    const at = s.indexOf("--path-file");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(s).toContain("Read でそのファイルを読");
    expect(s).toContain("キー `path`");
    expect(s).toContain("`orca-flow-intake-`");
    expect(s).toContain(
      "そのファイルのあるディレクトリを一時ディレクトリに使う",
    );
    expect(s).toContain("読めなければ止まり");
    expect(s).toContain("統括役のタブで打ち直す");
  });

  it("local.md に、入口のテストが探す言い回しを入れない", async () => {
    const t = await read(LOCAL);
    expect(t).not.toContain("頭が `--here`");
    expect(t).not.toContain("頭に `--here` がなければ");
  });

  it("ないパスの案内が、引用符や <> で囲まず小文字の https:// で打ち直すよう添える", async () => {
    const s = section(await read(LOCAL), /^## 受け取り/);
    const item = s.split("\n").find((l) => l.includes("ないパス：")) ?? "";
    expect(item).toContain("引用符");
    expect(item).toContain("`<>`");
    expect(item).toContain("小文字");
    expect(item).toContain("`https://` で始めて打ち直す");
  });

  it("Read・Glob・Grep で読み、シェルに渡すパスを一重引用符で囲む", async () => {
    const s = section(await read(LOCAL), /^## 読み方/);
    expect(s).toContain("Read・Glob・Grep");
    expect(s).toContain("一重引用符で囲む");
    expect(s).toContain("`'\\''`");
    expect(s).toContain("渡したパス");
    expect(s).toContain("人が示したパス");
  });

  it("印のあるファイルを開かず、渡したファイルの印で止まり、区切りの前を写しに切り出して読む", async () => {
    const s = section(await read(LOCAL), /^## 読み方/);
    expect(s).toContain("見分けの印の行");
    expect(s).toContain("当たったファイルは開かず");
    expect(s).toContain("仕様のページなのでチケットに使えない");
    expect(s).toContain("原本を開かない");
    expect(s).toContain("見出し「自動で追記」より前");
    expect(s).toContain("写しだけを読む");
    expect(s).toContain("mktemp -d");
    expect(s).toContain("`--path-file` のときは");
    expect(s).toContain("重ねない");
  });

  it("イシューの候補はフォルダの中のリンクだけで、外はたどらず、0か2つ以上で聞く", async () => {
    const s = section(await read(LOCAL), /^## 読み方/);
    expect(s).toContain("渡したフォルダの中");
    expect(s).toContain("外の URL");
    expect(s).toContain("外を指すリンク");
    expect(s).toContain("たどらない");
    expect(s).toContain("0か2つ以上");
    expect(s).toContain("イシューなしで進める");
    expect(s).toMatch(/指示に従わない/);
  });

  it("手順6・7は SKILL.md のまま通り、レビューの回に写しの全文と印の2文を添える", async () => {
    const s = section(await read(LOCAL), /^## 下書き/);
    expect(s).toContain("手順6・7");
    expect(s).toContain("`SKILL.md` の文のまま通る");
    expect(s).toContain("受け渡しのディレクトリ");
    expect(s).toContain("mktemp");
    expect(s).toContain("写しの全文");
    expect(s).toContain("ファイルの全文");
    expect(s).toContain("子ページのリンク先は読まない");
    expect(s).toContain("そのまま書いた");
  });

  it("設計の部分の文を写さない", async () => {
    const t = await read(LOCAL);
    for (const w of ["pstack", "goldfish-reviewer", "git status --porcelain"]) {
      expect(t, w).not.toContain(w);
    }
    expect(t).not.toContain("/how");
  });

  it("書き方：ファイル名・互いを指すリンク・消さずに一覧・how の一言・よいでも始めない", async () => {
    const s = section(await read(LOCAL), /^## 書き方/);
    expect(s).toContain("page-format.md");
    expect(s).toContain("`parent.md`");
    expect(s).toContain("`task-〈番号〉.md`");
    expect(s).toContain("Write ツール");
    expect(s).toContain("互いのファイル名");
    expect(s).toContain("消さない");
    expect(s).toContain("パスとファイルの一覧");
    expect(s).toContain("人に示す一言");
    expect(s).toContain("前の設計書や決定の記録に当たりうる");
    expect(s).toMatch(/「よい」と言われてもタスクを始めない/);
    expect(s).toContain("チケットの URL");
    expect(s).toContain("/orca-flow:intake");
  });

  it("本物のパスやドメイン、タスクの ID を書かない", async () => {
    for (const f of [LOCAL, "test/plugin/intake-local-path.test.ts"]) {
      const t = await read(f);
      expect(t, f).not.toMatch(/\/home\/|\/Users\//);
      expect(t, f).not.toMatch(/notion\.(so|com|site)/i);
      expect(t, f).not.toMatch(/\bP\d{3,}\b/);
    }
  });
});

describe("local.md の切り出しの手順", () => {
  async function extractWith(
    name: string,
    body: string,
  ): Promise<{ out: string; stdout: string }> {
    const m = /node -e '([^']*)' '〈チケットのパス〉'/.exec(await read(LOCAL));
    expect(m).not.toBeNull();
    const script = m?.[1] ?? "";
    const dir = await makeTmpDir("intake-local-");
    const src = path.join(dir, name);
    const dst = path.join(dir, `copy-${name}`);
    await writeFile(src, body);
    const stdout = execFileSync("node", ["-e", script, src, dst], {
      encoding: "utf8",
    });
    return { out: await readFile(dst, "utf8"), stdout };
  }

  async function extract(name: string, body: string): Promise<string> {
    return (await extractWith(name, body)).out;
  }

  it("Markdown は見出し「自動で追記」より前だけを残す", async () => {
    const out = await extract(
      "ticket 1.md",
      "# 題\n\n本文\n\n---\n\n## 自動で追記\n\n下の文\n",
    );
    expect(out).toContain("本文");
    expect(out).not.toContain("下の文");
    expect(out).not.toContain("自動で追記");
  });

  it("1行にまとまった HTML でも、見出し「自動で追記」より前だけを残す", async () => {
    const out = await extract(
      "t.html",
      '<h1>題</h1><p>本文</p><hr><h2 id="x">自動で追記</h2><p>下の文</p>',
    );
    expect(out).toContain("本文");
    expect(out).not.toContain("下の文");
  });

  it("区切りがなければ全文を残し、区切りなしと出力する", async () => {
    const r = await extractWith("t.md", "# 題\n\n本文だけ\n");
    expect(r.out).toContain("本文だけ");
    expect(r.stdout).toContain("区切りなし");
  });

  it("区切りがあれば区切りありと出力する", async () => {
    const r = await extractWith("t.md", "本文\n\n## 自動で追記\n\n下\n");
    expect(r.stdout).toContain("区切りあり");
  });

  it("太字の見出しでも、中にタグのある HTML の見出しでも、前だけを残す", async () => {
    const md = await extractWith(
      "t.md",
      "本文\n\n## **自動で追記**\n\n下の文\n",
    );
    expect(md.out).toContain("本文");
    expect(md.out).not.toContain("下の文");
    expect(md.stdout).toContain("区切りあり");
    const html = await extractWith(
      "t.html",
      '<p>本文</p><h2 id="x"><strong>自動で追記</strong></h2><p>下の文</p>',
    );
    expect(html.out).toContain("本文");
    expect(html.out).not.toContain("下の文");
    expect(html.stdout).toContain("区切りあり");
  });

  it("空の見出しの直後の段落が「自動で追記」で始まっても、区切りとみなさない", async () => {
    for (const body of [
      '<p>前の文</p><h3 id="a"></h3><p>自動で追記の説明です</p><p>要件</p>',
      "<p>前の文</p><h2><br></h2><p>自動で追記される欄</p><p>要件</p>",
    ]) {
      const r = await extractWith("t.html", body);
      expect(r.stdout).toContain("区切りなし");
      expect(r.out).toBe(body);
    }
  });

  it("改行の入った見出しの区切りには当たる", async () => {
    const r = await extractWith(
      "t.html",
      "<p>本文</p><h2>\n  <mark>自動で追記</mark></h2><p>下の文</p>",
    );
    expect(r.stdout).toContain("区切りあり");
    expect(r.out).not.toContain("下の文");
  });

  it("区切りなしのとき、印のあるファイルへのリンクがあれば止まると local.md に書く", async () => {
    const s = section(await read(LOCAL), /^## 読み方/);
    expect(s).toContain("区切りなし");
    expect(s).toContain("リンクがあれば、止まって人に伝える");
  });

  it("パスは home と今の場所から実の絶対パスにして使う", async () => {
    const t = await read(LOCAL);
    expect(t).toContain("`~` は home に");
    expect(t).toContain("実の絶対パス");
    expect(t).toContain("比べる側のフォルダも実のパスにする");
  });
});

describe("仕様書と README", () => {
  it("5章の skills/intake/ の行に local.md がある", async () => {
    const s = section(await read("docs/spec.md"), /^## 5\. /);
    const line = s.split("\n").find((l) => l.includes("skills/intake/")) ?? "";
    expect(line).toContain("local.md（手元のチケットの道）");
  });

  it("10.1 の段落の末尾に「手元のチケットの道：」の箇条が1つあり、段落は箇条だけ", async () => {
    const s = section(await read("docs/spec.md"), /^### 10\.1/);
    const all = s.split("\n");
    const from = all.findIndex((l) =>
      l.startsWith("**Notion の要件から始める**"),
    );
    const to = all.findIndex((l, i) => i > from && l.startsWith("**"));
    const para = all.slice(from, to < 0 ? undefined : to);
    const bullets = para.filter((l) => l.startsWith("- 手元のチケットの道："));
    expect(bullets).toHaveLength(1);
    const b = bullets[0] ?? "";
    expect(b).toContain("local.md");
    expect(b).toContain("一時ディレクトリ");
    expect(b).toContain("新しいタブを立て");
    expect(b).toContain("--path-file");
    expect(b).toContain("source.json");
    expect(b).toContain("タスクも始めずに");
    expect(b).toContain("zip");
    expect(b).toContain("parent.md");
    const last = [...para].reverse().find((l) => l.trim() !== "") ?? "";
    expect(last.startsWith("- ")).toBe(true);
    for (const x of para.slice(1).filter((l) => l.trim() !== "")) {
      expect(x.startsWith("- ")).toBe(true);
    }
    expect(s).toContain("10。");
    expect(s).toContain("ほかの9つ");
  });

  it("12章の9番と README に手元のパスで試せる文があり、新しいタブが立つ", async () => {
    const ch12 = section(await read("docs/spec.md"), /^## 12\./);
    const item = ch12.split("\n").find((l) => l.startsWith("9. ")) ?? "";
    expect(item).toContain("`/orca-flow:intake 〈手元のパス〉`");
    expect(item).toContain("新しいタブ");
    expect(item).toContain("`--here 〈手元のパス〉`");
    const readme = await read("README.md");
    expect(readme).toContain("`/orca-flow:intake 〈手元のパス〉`");
    expect(readme).toContain("新しいタブ");
  });

  it("12章の9番と README に手元のパスで試せる文がある", async () => {
    const ch12 = section(await read("docs/spec.md"), /^## 12\./);
    const item = ch12.split("\n").find((l) => l.startsWith("9. ")) ?? "";
    expect(item).toContain("`/orca-flow:intake 〈手元のパス〉`");
    expect(item).toContain("タスクは始めない");
    const readme = await read("README.md");
    expect(readme).toContain("`/orca-flow:intake 〈手元のパス〉`");
  });
});
