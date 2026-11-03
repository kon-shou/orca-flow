import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

/** 正規表現に当たる行を全部返す（なければ空）。 */
function lines(text: string, re: RegExp): string[] {
  return text.split("\n").filter((l) => re.test(l));
}

/** 正規表現に当たる最初の行。なければ失敗させる。 */
function line(text: string, re: RegExp): string {
  const found = lines(text, re)[0];
  expect(found, `${String(re)} に当たる行が見つかりません`).toBeDefined();
  return found ?? "";
}

const INTAKE_LINE =
  "Notion の URL と中身を、決定の記録など公開に出るファイルに書かない";

describe("skills/spec/SKILL.md：スナップショットと画面の記録", () => {
  it("e2e のスナップショットの仕組みがあればテストと更新のコマンドを入れ、なければ「e2e の仕組みがない」と書く", async () => {
    const text = await read("skills/spec/SKILL.md");
    const l = line(text, /^ {3}- スナップショットのテスト：/);
    expect(l).toContain("ウェブの画面を変えるタスク");
    expect(l).toContain("Playwright");
    expect(l).toContain("完了条件");
    expect(l).toContain("更新するコマンド");
    expect(l).toContain("仕組みがなければ");
    expect(l).toContain("「e2e の仕組みがない」");
    expect(l).toContain("別のタスク");
    expect(l).toContain("要点の「気をつけること」");
    // 基準のファイルの場所も書き込んでよい場所に入れる
    expect(l).toContain("-snapshots/");
    expect(l).toContain("「書き込んでよい場所」に入れる");
    expect(l).toContain("既存のテストの基準");
  });

  it("intake の1行があり画面が変わるなら「画面の記録」の節を足し、ウェブでなければ「録らない」と理由を書く", async () => {
    const text = await read("skills/spec/SKILL.md");
    const l = line(text, /^ {3}- 画面の記録：/);
    expect(l).toContain(INTAKE_LINE);
    expect(l).toContain("画面が変わるなら");
    expect(l).not.toContain("ウェブの画面が変わるなら");
    expect(l).toContain("「画面の記録」の節");
    expect(l).toContain("起動のしかた");
    expect(l).toContain("コマンドと開く URL");
    expect(l).toContain("録る流れ");
    expect(l).toContain("1〜3本");
    expect(l).toContain("「録らない」と理由");
  });
});

describe("skills/run/SKILL.md：スナップショットと画面の記録", () => {
  it("スナップショットが落ちたとき、意図どおりなら基準を直して報告に書き、デグレなら担当に戻す", async () => {
    const text = await read("skills/run/SKILL.md");
    const l = line(text, /^ {3}- スナップショットのテストが落ちたとき：/);
    expect(l).toContain("意図どおり");
    expect(l).toContain("更新のコマンドで基準を直し");
    expect(l).toContain("報告に何をなぜ更新したか");
    expect(l).toContain("デグレ");
    expect(l).toContain("担当に戻して直す");
    expect(l).toContain("基準を直したらコミットし、手順5からやり直す");
    expect(l).toContain("更新のコマンドがない");
    expect(l).toContain("「書き込んでよい場所」に入っていないなら");
    expect(l).toContain("`orca-flow status question`");
    expect(l).toContain("人間に聞く");
    // 手順5（verify）の中にある
    const step5 = text.indexOf("\n5. ");
    const step6 = text.indexOf("\n6. ");
    const at = text.indexOf(l);
    expect(at).toBeGreaterThan(step5);
    expect(at).toBeLessThan(step6);
  });

  it("「画面の記録」の節があればレビューの直しのあと報告の前に screen-capture.md を読み、報告のあとに直したら録り直す", async () => {
    const text = await read("skills/run/SKILL.md");
    const l = line(text, /^ {3}- 画面の記録：/);
    expect(l).toContain("「画面の記録」の節");
    expect(l).toContain("「録らない」でなければ");
    expect(l).toContain("レビューの直しが済んだあと");
    expect(l).toContain("報告を書く前");
    expect(l).toContain("skills/run/screen-capture.md");
    expect(l).toContain("読んで");
    expect(l).toContain("報告を書いたあとにコードを直したら、録り直す");
    expect(l).toContain("「録らない」なら screen-capture.md を読まず");
    expect(l).toContain("報告の「画面の記録」の節に理由を書く");
    // 手順6（レビュー）の中、手順7の前にある
    const at = text.indexOf(l);
    expect(at).toBeGreaterThan(text.indexOf("\n6. "));
    expect(at).toBeLessThan(text.indexOf("\n7. "));
  });
});

describe("skills/run/SKILL.md：報告の画面の記録", () => {
  it("手順8の一覧に「画面の記録」（設計書に節があるとき）を入れる", async () => {
    const text = await read("skills/run/SKILL.md");
    const l = line(text, /^8\. /);
    expect(l).toContain("画面の記録（設計書に「画面の記録」の節があるとき");
    expect(l).toContain("「録らない」ならその理由");
  });
});

describe("skills/run/screen-capture.md", () => {
  it("ToolSearch で道具を探し、なければ止めずに報告に書き、GIF を captures の下へ移す", async () => {
    const text = await read("skills/run/screen-capture.md");
    expect(text).toContain("ToolSearch");
    expect(text).toContain("Claude in Chrome");
    expect(text).toContain("gif_creator");
    expect(text).toContain("止めずに");
    expect(text).toContain("録れなかった：道具がない");
    expect(text).toContain("ダウンロード先");
    expect(text).toContain("orca-flow/captures/");
    expect(text).toContain("git-common-dir");
  });

  it("アプリを背景で動かし、新しいタブで録り、終わったら止めて閉じる", async () => {
    const text = await read("skills/run/screen-capture.md");
    expect(text).toContain("背景で動かす");
    expect(text).toContain("新しいタブ");
    expect(text).toContain("アプリを止め");
    expect(text).toContain("タブを閉じる");
  });

  it("試しの値だけでサインインし、秘密が出る流れを録らず、20 MiB を超えたら1回だけ書き出し直す", async () => {
    const text = await read("skills/run/screen-capture.md");
    expect(text).toContain("試しの値だけ");
    const secret = line(text, /本物のアカウント|秘密/);
    expect(secret).toContain("本物のアカウント");
    expect(secret).toContain("秘密");
    expect(secret).toContain("録らない");
    expect(text).toContain("20 MiB");
    expect(text).toContain("1回だけ");
    expect(text).toContain("画質を下げて");
    expect(text).toContain("それでも超えたら");
  });

  it("GIF の名前を決め、ダウンロード先ではその名前ちょうどで録り始めより新しいものだけを移し、2つ以上なら移さない", async () => {
    const text = await read("skills/run/screen-capture.md");
    const named = line(text, /^3\. /);
    expect(named).toContain("`〈ID〉-〈流れの名前〉.gif`");
    expect(named).toContain("道具に渡して決める");
    const find = line(text, /ダウンロード先では/);
    expect(find).toContain("ちょうど");
    expect(find).toContain("録り始めより新しいものだけ");
    const many = line(text, /2つ以上/);
    expect(many).toContain("移さず");
    expect(many).toContain("報告に書く");
    const move = line(text, /名前で移す/);
    expect(move).toContain("`〈流れの名前〉.gif`");
    expect(move).toContain("orca-flow/captures/〈ID〉/");
  });

  it("録る前（録り直しを含む）に記録の場所の GIF を消す", async () => {
    const text = await read("skills/run/screen-capture.md");
    const l = line(text, /^1\. /);
    expect(l).toContain("orca-flow/captures/〈ID〉/");
    expect(l).toContain("録る前に消す");
    expect(l).toContain("録り直しのときも");
  });

  it("起動の待ちに上限をつけ、どの結果でも最後に必ずアプリを止めてタブを閉じる", async () => {
    const text = await read("skills/run/screen-capture.md");
    const wait = line(text, /起動の待ち/);
    expect(wait).toContain("5分");
    expect(wait).toContain("録れなかった：アプリが起動しない");
    const stop = line(text, /最後に必ず/);
    expect(stop).toContain("録れたかどうかに関係なく");
    for (const w of [
      "起動しない",
      "拡張がつながらない",
      "途中で落ちた",
      "録らないと決めた",
    ]) {
      expect(stop).toContain(w);
    }
    expect(stop).toContain("アプリを止め");
    expect(stop).toContain("タブを閉じる");
  });

  it("報告に「画面の記録」の節を書き、パスと Notion の URL を書かず、リポジトリに置かない", async () => {
    const text = await read("skills/run/screen-capture.md");
    expect(text).toContain("報告に「画面の記録」の節");
    expect(text).toContain("録れたか");
    expect(text).toContain("録れなかった理由");
    expect(text).toContain("手元のパスと Notion の URL は書かない");
    expect(text).toContain("リポジトリの中に置かない");
  });
});

describe("skills/integrate/SKILL.md：画面の記録", () => {
  it("intake の1行と GIF があるときだけ spec-page-capture.md を読み、一覧に推奨「載せる」の項目を出す", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const l = line(text, /^ {3}- 画面の記録：/);
    expect(l).toContain(INTAKE_LINE);
    expect(l).toContain("GIF があるときだけ");
    expect(l).toContain("skills/integrate/spec-page-capture.md");
    expect(l).toContain("画面の記録を仕様のページに載せる");
    expect(l).toContain("推奨は「載せる」");
    expect(l).toContain("「載せない」「後で決める」");
    expect(l).toContain("おまかせでは推奨どおり");
    expect(l).toContain("「載せない」なら");
    expect(l).toContain("記録の場所を消す");
    expect(l).toContain(
      "「後で決める」なら、手順5の残りに記録の場所を会話で示す（ファイルには書かない）",
    );
    expect(l).toContain("auto log");
    // 手順4の中にある
    const at = text.indexOf(l);
    expect(at).toBeGreaterThan(text.indexOf("\n4. "));
    expect(at).toBeLessThan(text.indexOf("\n5. "));
  });
});

describe("skills/integrate/spec-page-capture.md", () => {
  it("ToolSearch で file-upload の道具を探し、サーバー名の頭を決め打ちしない", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    expect(text).toContain("ToolSearch");
    expect(text).toContain("`file-upload`");
    expect(text).toContain("サーバー名の頭を決め打ちしない");
    expect(text).toContain("orca-flow の intake が作った仕様のページ");
  });

  it("上げ先のホストが notion.com で終わるときだけ curl で送る", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const l = line(text, /curl/);
    expect(l).toContain("`https://` で始まり");
    expect(l).toContain(
      "`notion.com` そのものか `.notion.com` で終わるときだけ",
    );
    expect(l).toContain("`@` や `:` を含めば送らない");
    expect(l).toContain("`-L` をつけない");
  });

  it("流れの名前は GIF のファイル名から取る", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const l = line(text, /流れの名前は、/);
    expect(l).toContain("`〈流れの名前〉.gif`");
    expect(l).toContain("から取る");
  });

  it("末尾の「実装後の画面」の節に日付・ID・流れの名前と足し、本文とほかのページを変えない", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    expect(text).toContain("suggested_markdown");
    expect(text).toContain("「実装後の画面」");
    expect(text).toContain("日付・タスクの ID・流れの名前");
    expect(text).toContain("本文とほかのページは変えない");
  });

  it("すべて上げたら記録の場所を消し、上げられないときは統合を止めず手順5で人に渡し、選択を決定の記録に足さない", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const done = line(text, /すべて上げられたら/);
    expect(done).toContain("記録の場所");
    expect(done).toContain("消す");
    const fail = line(text, /上げられない/);
    expect(fail).toContain("統合を止めない");
    expect(fail).toContain("手順5の残り");
    expect(fail).toContain("記録の場所を会話で示");
    expect(fail).toContain("ファイルには書かない");
    expect(text).toContain("決定の記録に足さない");
  });
});

describe("共通の決まり", () => {
  const files = [
    "skills/spec/SKILL.md",
    "skills/run/SKILL.md",
    "skills/run/screen-capture.md",
    "skills/integrate/SKILL.md",
    "skills/integrate/spec-page-capture.md",
  ];

  it.each(files)(
    "%s：orca-flow で始まるインラインのコードの二重引用符が偶数",
    async (file) => {
      const text = await read(file);
      for (const m of text.matchAll(/`(orca-flow[^`]*)`/g)) {
        const code = m[1] ?? "";
        expect(code.split('"').length - 1, code).toSatisfy(
          (n: number) => n % 2 === 0,
        );
      }
    },
  );

  it.each([files[2] ?? "", files[4] ?? ""])(
    "%s：パス・ID・Notion の URL を書かない",
    async (file) => {
      const text = await read(file);
      expect(text).not.toMatch(/\/Users\//);
      expect(text).not.toMatch(/\bP\d+\b/);
      expect(text).not.toContain("notion.so");
      expect(text).not.toMatch(/https?:\/\/[^\s`]/);
    },
  );

  it.each(files)("%s：git show main: と書かない", async (file) => {
    expect(await read(file)).not.toContain("git show main:");
  });
});
