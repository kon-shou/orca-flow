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

  it("録る前（録り直しを含む）に、道具を探すより前に記録の場所の GIF を消す", async () => {
    const text = await read("skills/run/screen-capture.md");
    const l = line(text, /GIF が残っていれば/);
    expect(l).toContain("orca-flow/captures/〈ID〉/");
    expect(l).toContain("録り直しのときも");
    expect(l).toContain("道具がなくても");
    const del = text.indexOf(l);
    expect(del).toBeGreaterThanOrEqual(0);
    expect(del).toBeLessThan(text.indexOf("ToolSearch"));
    expect(del).toBeLessThan(text.indexOf("録れなかった：道具がない"));
  });

  it("GIF を探すとき、決めた名前ちょうどと「 (数字)」つきの名前の両方を、録り始めより新しいものだけ探す", async () => {
    const text = await read("skills/run/screen-capture.md");
    const find = line(text, /ダウンロード先では/);
    expect(find).toContain("ちょうど");
    expect(find).toContain(" (数字)");
    expect(find).toContain("録り始めより新しいものだけ");
    expect(line(text, /2つ以上/)).toContain("移さず");
  });

  it("起動の前に URL へつないで答えがあれば録らず、プロファイル・片付け・status working を書く", async () => {
    const text = await read("skills/run/screen-capture.md");
    const port = line(text, /録れなかった：ポートがほかに使われている/);
    expect(port).toContain("つなぎ");
    expect(port).toContain("答えがあれば録らず");
    const step = text.indexOf(port);
    expect(step).toBeLessThan(text.indexOf("背景で動かす"));
    const prof = line(text, /ふだんのプロファイル/);
    expect(prof).toContain("本物のサインイン");
    expect(prof).toContain("開かない");
    const clean = line(text, /worktree に残した/);
    expect(clean).toContain("片づける");
    expect(text).toContain("`orca-flow status working");
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

  it("片づけは新しく出た追跡外のファイルだけを1つずつ消し、前からあるものに触れず、分からなければ消さない", async () => {
    const text = await read("skills/run/screen-capture.md");
    expect(text).toContain("--untracked-files=all");
    expect(text).toContain("`--ignored` はつけない");
    expect(text).toContain("新しく出た `??` の行");
    expect(text).toContain("rm -- ");
    expect(text).toContain("フォルダごと消さない");
    expect(text).toContain("`git clean` を使わない");
    expect(text).toContain("無視されたファイル");
    expect(text).toContain("起動の前からあったファイル");
    expect(text).toContain("追跡中のファイルには触れない");
    expect(text).toContain("消してよいか分からないとき");
    expect(text).toContain("消さず・戻さず、報告に書く");
    // 出力は起動の前に残し、止めたあとに比べる
    expect(text.indexOf("--untracked-files=all")).toBeLessThan(
      text.indexOf("背景で動かす"),
    );
  });

  it("止めるのは自分が動かしたものだけで、ポートが使われていて録らないときは何も止めず片づけもしない", async () => {
    const text = await read("skills/run/screen-capture.md");
    const stop = line(text, /最後に必ず/);
    expect(stop).toContain("手順2で自分が動かした");
    expect(stop).toContain("その子プロセス");
    expect(stop).toContain("ほかのプロセスは止めない");
    const port = line(text, /録れなかった：ポートがほかに使われている/);
    expect(port).toContain("何も止めず");
    expect(port).toContain("片づけもしないで終わる");
  });

  it("ポートの確かめは時間の上限つきの curl で、終了コード7のときだけ進み、4xx・5xx・時間切れは録らない", async () => {
    const text = await read("skills/run/screen-capture.md");
    const port = line(text, /録れなかった：ポートがほかに使われている/);
    expect(port).toContain("curl");
    expect(port).toContain("--max-time 5");
    expect(port).toContain("終了コード7のときだけ進む");
    expect(port).toContain("4xx・5xx・時間切れ");
    expect(port).toContain("録らず");
    expect(port).toContain("curl -q -g");
  });

  it("終了コードで分ける：答えや何かが待ち受けているものは「ポートがほかに使われている」、そのほかは「ポートの確かめが失敗した（終了コード〇）」", async () => {
    const text = await read("skills/run/screen-capture.md");
    const port = line(text, /録れなかった：ポートがほかに使われている/);
    for (const c of ["終了コード0", "28", "52", "56", "35", "60"]) {
      expect(port).toContain(c);
    }
    expect(port).toContain(
      "録れなかった：ポートの確かめが失敗した（終了コード〇）",
    );
  });

  it("起動のあと自分のプロセスが生きていてそのポートで答えるかを確かめ、死んでいれば「録れなかった：アプリが起動しない」と書く", async () => {
    const text = await read("skills/run/screen-capture.md");
    const l = line(text, /自分が動かしたプロセスが生きて/);
    expect(l).toContain("起動のあと");
    expect(l).toContain("そのポートで答える");
    expect(l).toContain("死んでいれば");
    expect(l).toContain("録れなかった：アプリが起動しない");
    expect(l).toContain("録らず");
    // ポートで待ち受ける PID が自分のプロセスかその子孫かを確かめる
    expect(l).toContain("PID");
    expect(l).toContain("ss -ltnp");
    expect(l).toContain("lsof -nP -iTCP:〈ポート〉 -sTCP:LISTEN -t");
    expect(l).toContain("子孫");
    expect(l).toContain("録れなかった：ポートがほかに使われている");
    expect(l).toContain("確かめられないときも録らず");
    // 背景で動かす手順のあと、録る手順の前にある
    const at = text.indexOf(l);
    expect(at).toBeGreaterThan(text.indexOf("\n2. "));
    expect(at).toBeLessThan(text.indexOf("\n3. "));
  });

  it("録り始めの前に時刻の印を残し、ダウンロード先ではそれより新しいものだけ探す", async () => {
    const text = await read("skills/run/screen-capture.md");
    const mark = line(text, /時刻の印/);
    expect(mark).toContain("録り始めの前");
    expect(mark).toContain("残す");
    const find = line(text, /ダウンロード先では/);
    expect(find).toContain("印より新しいものだけ");
    expect(text.indexOf(mark)).toBeLessThan(text.indexOf(find));
  });

  it("片づけの rm は worktree の一番上で流す", async () => {
    const text = await read("skills/run/screen-capture.md");
    const l = line(text, /一番上で流す/);
    expect(l).toContain("rm -- ");
    expect(l).toContain("worktree の一番上");
    expect(l).toContain("--show-toplevel");
  });

  it("Chrome が付ける同じ名前の形は、まだ確かめていないと読み取れる", async () => {
    const text = await read("skills/run/screen-capture.md");
    const l = line(text, /まだ確かめていない/);
    expect(l).toContain("同じ名前");
    expect(l).toContain("見つからなければ");
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
    expect(l).toContain("載せる・載せないの選択は決定の記録に足さない");
    // 手順4の中にある
    const at = text.indexOf(l);
    expect(at).toBeGreaterThan(text.indexOf("\n4. "));
    expect(at).toBeLessThan(text.indexOf("\n5. "));
  });
});

describe("skills/integrate/SKILL.md：統合のときの選択", () => {
  it("統合のときの選択を決定の記録に足す箇条に、載せる・載せない、戻す・戻さないを足さないと書く", async () => {
    const text = await read("skills/integrate/SKILL.md");
    const l = line(text, /^ {3}- 統合のときに決まった選択/);
    expect(l).toContain("載せる・載せないの選択");
    expect(l).toContain("戻す・戻さないの選択");
    expect(l).toContain("足さない");
  });
});

describe("skills/run/SKILL.md：ローカルレビューのあと", () => {
  it("「終わったあと」の節で画面の記録を通ってから手順7へ進む", async () => {
    const text = await read("skills/run/SKILL.md");
    const from = text.indexOf("### 終わったあと");
    expect(from).toBeGreaterThan(0);
    const rest = text.slice(from);
    const next = rest.indexOf("\n### ", 5);
    const sec = next < 0 ? rest : rest.slice(0, next);
    expect(sec).toContain("画面の記録");
    expect(sec).toContain("screen-capture.md");
    expect(sec).toContain("手順6");
    expect(sec.indexOf("画面の記録")).toBeLessThan(sec.indexOf("手順7へ進む"));
  });
});

describe("skills/integrate/spec-page-capture.md", () => {
  it("ToolSearch で file-upload の道具を探し、サーバー名の頭を決め打ちしない", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    expect(text).toContain("ToolSearch");
    expect(text).toContain("`file-upload`");
    expect(text).toContain("サーバー名の頭を決め打ちしない");
    expect(text).toContain("要件から自動で作った仕様のページ");
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
    expect(l).toContain("一重引用符で囲み");
    expect(l).toContain("`'\\''`");
    expect(l).toContain("`--form-string`");
    expect(l).toContain("`@` で始まるヘッダー");
    expect(l).toContain("改行を含む値");
  });

  it("上げ先の URL とヘッダーを、ファイル・報告・決定の記録に書かない。会話に出るのは避けられないと言い、出さないとは言わない", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const l = line(text, /秘密/);
    expect(l).toContain("URL");
    expect(l).toContain("ヘッダー");
    expect(l).toContain("ファイル・報告・決定の記録に書かない");
    expect(l).toContain("会話に出るのは避けられない");
    expect(text).not.toContain("会話にもファイルにも出さない");
    expect(text).not.toMatch(/会話に(は)?出さない/);
  });

  it("curl は GIF 本体だけ -F の @、道具が返した欄は --form-string で渡し、-q と -g をつけ、状態の番号が 2xx のときだけ進む", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const l = line(text, /curl/);
    expect(l).toContain("GIF 本体だけ");
    expect(l).toContain("`-F`");
    expect(l).toContain("`@`");
    expect(l).toContain("道具が返した欄は `--form-string`");
    expect(l).toContain("`curl -q` で始める");
    expect(l).toContain("最初の引数でないと効かない");
    expect(l).toContain("`-g`");
    expect(l).toMatch(/`curl -q -g [^`]*`/);
    expect(l).toContain("状態の番号");
    expect(l).toContain("2xx のときだけ");
    expect(l).toContain("上げられなかったもの");
  });

  it("上げ先のホストの条件と許可の確認が、まだ確かめていないと読み取れ、許可で止まったときのおまかせの扱いがある", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const l = line(text, /ホストの条件/);
    expect(l).toContain("まだ確かめていない");
    expect(l).toContain("送らず");
    expect(l).toContain("上げられなかったものにして手順5の残りに入れる");
    expect(l).toContain("URL・ホストの値は出さない");
    expect(l).not.toContain("報告に理由を書く");
    const perm = line(text, /許可が得られなかった/);
    expect(perm).toContain("断られた・拒まれた");
    expect(perm).toContain("おまかせ");
    expect(perm).toContain("止めず");
    expect(perm).toContain("手順5の残り");
    expect(perm).toContain("止まり続けることがあるかは、まだ確かめていない");
    expect(perm).not.toContain("許可の確認で止まったとき");
  });

  it("仕様のページは依頼の「仕様」の URL だけを読み、印とこのタスクの ID がそろうときだけ載せ、〈ID〉が空なら消さない", async () => {
    const text = await read("skills/integrate/spec-page-capture.md");
    const l = line(text, /^- 仕様のページは/);
    expect(l).toContain("「仕様」の URL だけ");
    expect(l).toContain("要件から自動で作った仕様のページ");
    expect(l).toContain("orca-flow の intake が作った仕様のページ");
    expect(l).toContain("このタスクの ID");
    expect(l).toContain("2つ以上");
    expect(l).toContain("載せず");
    const del = line(text, /すべて上げられたら/);
    expect(del).toContain("〈ID〉が空");
    expect(del).toContain("消さない");
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

describe("docs/spec.md：13章", () => {
  it("書き出し先と上げ方の行に、日付（2026- で始まる）がある", async () => {
    const text = await read("docs/spec.md");
    const from = text.indexOf("## 13. ");
    const to = text.indexOf("## 14. ");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const sec = text.slice(from, to);
    const row = line(sec, /拡張の GIF の書き出し先/);
    expect(row).toMatch(/2026-\d{2}-\d{2}/);
    expect(row).toContain("まだ確かめていない");
  });

  it("拡張を2つのタスクで同時に使えるかの行があり、代わりの扱いが書いてある", async () => {
    const text = await read("docs/spec.md");
    const sec = text.slice(text.indexOf("## 13. "), text.indexOf("## 14. "));
    const row = line(sec, /拡張を2つのタスクで同時に使えるか/);
    expect(row).toContain("ポート");
    expect(row).toContain("録らない");
  });
});
