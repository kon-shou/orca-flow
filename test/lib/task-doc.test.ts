import { describe, expect, it } from "vitest";
import { parseTaskDoc } from "../../src/lib/task-doc.ts";

// 古い書き方の例（バッククォートのない形）
const T96 = `# タスク T96：メモの書き出し

## 目的

メモを書き出す。

## 書き込んでよい場所

- tools/export（新しく作る）
- docs/export/README.md（新しく作る。docs/export/notes.md は読むだけ）
- ルートの package.json の scripts（export:* を足すだけ）と pnpm-lock.yaml
- それ以外は変更しない。lib/common、data/fixtures、config も変更しない

## 完了条件

- テストが通る
`;

// 古い書き方の例（「、」で並べた形）
const T97 = `# タスク T97

## 書き込んでよい場所

- web/front、web/back、e2e、lib/clients
- それ以外（apps、lib/common、data/fixtures、config）は変更しない。要るなら「契約変更の依頼」に書く
`;

const NEW = `# タスク T12：買い物の直し

## 書き込んでよい場所

- \`src/feature-a/\`（新しく作る）
- \`test/feature-a/\`、\`docs/a.md\`
- \`test/\`（\`test/init/\` を除く）
- これ以外のファイルは読むだけにする。

## 担当の分け方

### 担当A：本体

- 書き込む場所：\`src/feature-a/core/\`、\`test/feature-a/core/\`
- 作るもの：1

### 担当B：画面

- 書き込む場所：\`src/feature-a/ui/\`
- 作るもの：2

## 作業中のほかのタスクとの重なり

- なし

## main への事前変更

- \`package.json\` に依存 zod を足す
- \`pnpm-lock.yaml\` を作り直す

## 作るもの

1. 何か
`;

describe("task-doc", () => {
  it("バッククォートのある書き方からパス・担当・事前変更を取る", () => {
    const doc = parseTaskDoc(NEW);
    expect(doc.allowed).toEqual([
      "src/feature-a",
      "test/feature-a",
      "docs/a.md",
      "test",
    ]);
    expect(doc.workers).toEqual([
      {
        name: "担当A：本体",
        paths: ["src/feature-a/core", "test/feature-a/core"],
      },
      { name: "担当B：画面", paths: ["src/feature-a/ui"] },
    ]);
    expect(doc.prechanges).toEqual([
      "`package.json` に依存 zod を足す",
      "`pnpm-lock.yaml` を作り直す",
    ]);
    expect(doc.warnings).toEqual([]);
  });

  it("古い書き方（T96 の形）からパスを取り、読めない行は警告にする", () => {
    const doc = parseTaskDoc(T96);
    expect(doc.allowed).toEqual(["tools/export", "docs/export/README.md"]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toContain("ルートの");
    expect(doc.workers).toEqual([]);
    expect(doc.prechanges).toEqual([]);
  });

  it("古い書き方（T97 の形）の「、」区切りを分け、「/」も「.」もないものは警告にする", () => {
    const doc = parseTaskDoc(T97);
    expect(doc.allowed).toEqual(["web/front", "web/back", "lib/clients"]);
    expect(doc.warnings.join("\n")).toContain("e2e");
  });

  it("「main への事前変更」が「なし」なら空", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- `a/`\n\n## main への事前変更\n\n- なし\n",
    );
    expect(doc.prechanges).toEqual([]);
    const bare = parseTaskDoc(
      "## 書き込んでよい場所\n\n- `a/`\n\n## main への事前変更\n\nなし\n",
    );
    expect(bare.prechanges).toEqual([]);
  });

  it("節がなくても落ちずに警告にする", () => {
    const doc = parseTaskDoc("# 何もない\n");
    expect(doc.allowed).toEqual([]);
    expect(doc.warnings[0]).toContain("書き込んでよい場所");
  });

  it("コードブロックの中の見出しは節にしない", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- `a/`\n\n```\n## main への事前変更\n- `x`\n```\n",
    );
    expect(doc.prechanges).toEqual([]);
  });
});

// Expo Router のグループのフォルダのように、パスそのものにかっこが入る形
const PARENS = `# タスク T93：設定の画面

## 書き込んでよい場所

- \`apps/mobile/app/(core)/settings.tsx\`
- \`apps/mobile/app/(account)/\`
- \`apps/mobile/app/(auth)/\`（新しく作る）
- \`docs/（下書き）/a.md\`
- これ以外のファイルは読むだけにする。

## 担当の分け方

### 担当A：画面

- 書き込む場所：\`apps/mobile/app/(core)/settings.tsx\`、\`apps/mobile/app/(account)/\`（新しく作る）
- 作るもの：1

## main への事前変更

- なし
`;

describe("task-doc のかっこを含むパス", () => {
  it("バッククォートの中のかっこを残し、外の書き添えだけを除く", () => {
    const doc = parseTaskDoc(PARENS);
    expect(doc.allowed).toEqual([
      "apps/mobile/app/(core)/settings.tsx",
      "apps/mobile/app/(account)",
      "apps/mobile/app/(auth)",
      "docs/（下書き）/a.md",
    ]);
    expect(doc.warnings).toEqual([]);
  });

  it("担当の書き込む場所でも、かっこを含むパスをそのまま読む", () => {
    const doc = parseTaskDoc(PARENS);
    expect(doc.workers).toEqual([
      {
        name: "担当A：画面",
        paths: [
          "apps/mobile/app/(core)/settings.tsx",
          "apps/mobile/app/(account)",
        ],
      },
    ]);
  });

  it("外のかっこの中のバッククォートは、今までどおり拾わない", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- `test/`（`test/init/` を除く）\n- `src/(a)/`（`src/(a)/b/` は読むだけ）\n- `lib/`(`lib/x/` を除く)\n",
    );
    expect(doc.allowed).toEqual(["test", "src/(a)", "lib"]);
    expect(doc.warnings).toEqual([]);
  });

  it("バッククォートのないかっこを含むパスは取らず、バッククォートで囲むよう警告する", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- apps/mobile/app/(core)/settings.tsx\n- apps/mobile/app/(account)/（新しく作る）\n- scripts/review（新しく作る）\n- docs/a.md (読むだけ)\n",
    );
    expect(doc.allowed).toEqual(["scripts/review", "docs/a.md"]);
    expect(doc.warnings).toHaveLength(2);
    expect(doc.warnings[0]).toContain("apps/mobile/app/(core)/settings.tsx");
    expect(doc.warnings[0]).toContain("バッククォートで囲んでください");
    expect(doc.warnings[1]).toContain("apps/mobile/app/(account)/");
    expect(doc.warnings[1]).toContain("バッククォートで囲んでください");
  });

  it("バッククォートのない、かっこの中に空白があるパスや、かっこで終わるパスも取らずに警告する", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- apps/(my group)/x.tsx\n- apps/mobile/app/(core)\n- apps/mobile/app/(core（新しく作る）\n- src/a.ts(新しく作る)\n",
    );
    expect(doc.allowed).toEqual(["src/a.ts"]);
    expect(doc.warnings).toHaveLength(3);
    expect(doc.warnings[0]).toContain("apps/(my group)/x.tsx");
    expect(doc.warnings[1]).toContain("apps/mobile/app/(core)");
    expect(doc.warnings[2]).toContain("apps/mobile/app/(core");
    for (const warning of doc.warnings)
      expect(warning).toContain("バッククォートで囲んでください");
  });
});

// バッククォートの中に全角のかっこの書き添えを書いてしまった形
const NOTES = `# タスク T20：書き添え

## 書き込んでよい場所

- \`src/a.ts（新規）\`
- \`src/b/（新しく作る）\`
- \`src/c.ts （新規）\`
- \`docs/（下書き）\`
- これ以外のファイルは読むだけにする。

## 担当の分け方

### 担当A：本体

- 書き込む場所：\`src/b/（新しく作る）\`、\`src/a.ts\`
- 作るもの：1

## main への事前変更

- なし
`;

describe("task-doc のバッククォートの中の全角の書き添え", () => {
  it("書き添えを含めたままパスとして読み、バッククォートの外に書くよう警告する", () => {
    const doc = parseTaskDoc(NOTES);
    expect(doc.allowed).toEqual([
      "src/a.ts（新規）",
      "src/b/（新しく作る）",
      "src/c.ts （新規）",
      "docs/（下書き）",
    ]);
    const allowedWarnings = doc.warnings.filter((w) =>
      w.startsWith("書き込んでよい場所"),
    );
    expect(allowedWarnings).toHaveLength(4);
    expect(allowedWarnings[0]).toContain("src/a.ts（新規）");
    expect(allowedWarnings[1]).toContain("src/b/（新しく作る）");
    expect(allowedWarnings[2]).toContain("src/c.ts （新規）");
    expect(allowedWarnings[3]).toContain("docs/（下書き）");
    for (const warning of allowedWarnings) {
      expect(warning).toContain("書き添えはバッククォートの外に書いてください");
      expect(warning).toMatch(/ディレクトリ.*「\/」/);
    }
  });

  it("担当の書き込む場所の書き添えも警告し、見つけたものを notes に持つ", () => {
    const doc = parseTaskDoc(NOTES);
    expect(doc.workers[0]!.paths).toEqual(["src/b/（新しく作る）", "src/a.ts"]);
    const workerWarnings = doc.warnings.filter((w) =>
      w.startsWith("担当「担当A：本体」"),
    );
    expect(workerWarnings).toHaveLength(1);
    expect(workerWarnings[0]).toContain("src/b/（新しく作る）");
    expect(workerWarnings[0]).toContain(
      "書き添えはバッククォートの外に書いてください",
    );
    expect(doc.notes).toEqual([
      { where: "書き込んでよい場所", content: "src/a.ts（新規）" },
      { where: "書き込んでよい場所", content: "src/b/（新しく作る）" },
      { where: "書き込んでよい場所", content: "src/c.ts （新規）" },
      { where: "書き込んでよい場所", content: "docs/（下書き）" },
      { where: "担当「担当A：本体」", content: "src/b/（新しく作る）" },
    ]);
  });

  it("途中の全角のかっこ、半角のかっこ、バッククォートの外の書き添えは警告しない", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- `docs/（下書き）/a.md`\n- `docs/（下書き）/`\n- `apps/mobile/app/(core)`\n- `src/a.ts`（新規）\n",
    );
    expect(doc.allowed).toEqual([
      "docs/（下書き）/a.md",
      "docs/（下書き）",
      "apps/mobile/app/(core)",
      "src/a.ts",
    ]);
    expect(doc.warnings).toEqual([]);
    expect(doc.notes).toEqual([]);
  });

  it("書き添えの中にさらに全角のかっこがあっても警告する", () => {
    const doc = parseTaskDoc(
      "## 書き込んでよい場所\n\n- `src/a.ts（新規（仮））`\n",
    );
    expect(doc.allowed).toEqual(["src/a.ts（新規（仮））"]);
    expect(doc.notes).toEqual([
      { where: "書き込んでよい場所", content: "src/a.ts（新規（仮））" },
    ]);
  });
});
