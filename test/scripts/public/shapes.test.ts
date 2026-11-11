import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configureIdentity,
  git,
  makeSandbox,
  runScript,
  WORD_1,
  writeRepoFiles,
  writeWords,
  type Sandbox,
} from "./support.ts";

// 秘密・メール・Windows のパス・32桁の16進の形は、このファイル自身が当たらないよう実行時につないで作る
const TOKEN = `${"gh"}${"p_"}${"a1B2c3D4e5F6g7H8i9J0k1L2"}`;
const PAT = `${"github"}_${"pat_"}${"ABCDEFGHIJ0123456789xyz"}`;
const SK = `${"s"}${"k-"}${"proj0123456789abcdefghij"}`;
const SLACK = `${"xo"}${"xb-"}${"0123456789-abcdefghijkl"}`;
const AWS = `${"AK"}${"IA"}${"ABCDEFGHIJ012345"}`;
const KEY_HEAD = `${"-----"}${"BEGIN"} RSA ${"PRIVATE"} KEY-----`;
const PASSWORD = `${"hun"}${"ter2"}`;
const CONN = `postgres://admin:${PASSWORD}@${"db"}.internal/app`;
const CONN_NO_USER = `redis://:${PASSWORD}@${"cache"}.internal:6379`;
const LOCAL_PART = `${"ali"}${"ce"}`;
const REAL_DOMAIN = `${"corp"}${"mail"}.co.jp`;
const REAL_EMAIL = `${LOCAL_PART}@${REAL_DOMAIN}`;
const BS = "\\";
const WIN_USER = `${"C"}:${BS}${"Us"}ers${BS}${LOCAL_PART}${BS}work`;
const WIN_USER_ESCAPED = `${"C"}:${BS}${BS}${"Us"}ers${BS}${BS}${LOCAL_PART}`;
const WSL_LOCALHOST = `${BS}${BS}${"wsl"}.localhost${BS}Ubuntu${BS}home${BS}${LOCAL_PART}`;
const WSL_DOLLAR = `${BS}${BS}${"wsl"}$${BS}Ubuntu${BS}home${BS}${LOCAL_PART}`;
const MNT = `/${"mn"}t/c/${LOCAL_PART}`;
const HEX32 = "0123456789abcdef".repeat(2);
const HEX40 = `${HEX32}${"01234567"}`;
const FAKE_HOME = `/srv/${"fake"}-home/${"owner"}`;

async function box(files: Record<string, string> = {}): Promise<Sandbox> {
  const sandbox = await makeSandbox(files);
  sandbox.env["HOME"] = FAKE_HOME;
  return sandbox;
}

const local = (sandbox: Sandbox) => runScript(sandbox, ["local"]);

/** 出力に値が出ていないこと */
function expectNoValue(stderr: string, ...values: string[]) {
  for (const value of values) expect(stderr).not.toContain(value);
}

describe("公開の確かめ：秘密の形", () => {
  const secrets: Array<[string, string]> = [
    [TOKEN, "トークンの形"],
    [PAT, "トークンの形"],
    [SK, "トークンの形"],
    [SLACK, "トークンの形"],
    [AWS, "トークンの形"],
    [KEY_HEAD, "秘密鍵の頭の行"],
    [CONN, "パスワードつきの接続文字列"],
    [CONN_NO_USER, "パスワードつきの接続文字列"],
  ];

  for (const [value, kind] of secrets) {
    it(`テストでないファイルの${kind}は、終了コード1で「パス：行：種類」を出し、値を出さない`, async () => {
      const b = await box({ "src/conf.txt": `一行目\nx = "${value}"\n` });
      const result = await local(b);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`src/conf.txt：2：${kind}`);
      expectNoValue(result.stderr, value, PASSWORD);
    });
  }

  it("テストのファイルの中では当たらない", async () => {
    const text = `${secrets.map(([v]) => v).join("\n")}\n`;
    const b = await box({
      "test/fixtures/conf.txt": text,
      "src/conf.test.ts": text,
      "lib/__tests__/a.ts": text,
      "src/a.spec.js": text,
      "src/a_test.go": text,
      "tools/test_a.py": text,
    });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });

  it("テストの場所の下でも、秘密を置くファイルの中では当たる", async () => {
    const b = await box({
      "test/fixtures/.env": `TOKEN=${TOKEN}\n`,
      "test/fixtures/.env.local": `TOKEN=${AWS}\n`,
      "test/keys/server.pem": `${KEY_HEAD}\n`,
      "test/keys/a.key": `${KEY_HEAD}\n`,
      "test/keys/id_rsa": `${KEY_HEAD}\n`,
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("test/fixtures/.env：1：トークンの形");
    expect(result.stderr).toContain(
      "test/fixtures/.env.local：1：トークンの形",
    );
    expect(result.stderr).toContain("test/keys/server.pem：1：秘密鍵の頭の行");
    expect(result.stderr).toContain("test/keys/a.key：1：秘密鍵の頭の行");
    expect(result.stderr).toContain("test/keys/id_rsa：1：秘密鍵の頭の行");
    expectNoValue(result.stderr, TOKEN, AWS);
  });

  it("語の途中から始まる形・短い形は当たらない", async () => {
    const b = await box({
      "src/a.txt": `${"ta"}${SK}\n${"gh"}p_short\nx${AWS}\n${AWS}X\n`,
    });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });

  it("パスワードが置き場（〈〉・${}・<>）の接続文字列は、ユーザー名が空でも当たらない", async () => {
    const lines = [
      `postgres://user:〈パスワード〉@${"db"}.internal/x`,
      `https://x-access-token:$\{token}@${"git"}hub.com/o/r`,
      `postgres://user:<password>@${"db"}.internal/x`,
      `redis://:〈パスワード〉@${"cache"}.internal:6379`,
      `redis://:$\{password}@${"cache"}.internal:6379`,
      `redis://:<password>@${"cache"}.internal:6379`,
    ];
    const b = await box({ "src/a.md": `${lines.join("\n")}\n` });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });

  it("置き場の文字が頭にない本物らしいパスワードは、今どおり当たる", async () => {
    const real = [
      `postgres://user:x〈${PASSWORD}@${"db"}.internal/x`,
      `redis://:${PASSWORD}<@${"cache"}.internal:6379`,
    ];
    const b = await box({ "src/a.md": `${real.join("\n")}\n` });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.md：1：パスワードつきの接続文字列");
    expect(result.stderr).toContain("src/a.md：2：パスワードつきの接続文字列");
    expectNoValue(result.stderr, PASSWORD);
  });

  it("check でも当たり、値を出さない", async () => {
    const b = await box();
    await configureIdentity(b);
    await writeWords(b, [WORD_1]);
    const commit = await publicCommit(b, { "src/conf.txt": `${TOKEN}\n` });
    const result = await runScript(b, ["check", commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/conf.txt：1：トークンの形");
    expectNoValue(result.stderr, TOKEN);
  });
});

describe("公開の確かめ：メールの形", () => {
  it("架空でないメールは、テストのファイルの中でも当たり、出力にメールを含まない", async () => {
    const b = await box({
      "src/a.txt": `連絡：${REAL_EMAIL}\n`,
      "test/a.test.ts": `const m = "${REAL_EMAIL}";\n`,
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：1：メールアドレス");
    expect(result.stderr).toContain("test/a.test.ts：1：メールアドレス");
    expectNoValue(result.stderr, REAL_EMAIL, LOCAL_PART, REAL_DOMAIN);
  });

  it("架空のドメイン・ユーザー名が git のもの・URL の認証情報の中は当たらない", async () => {
    const at = (local: string, domain: string) => `${local}@${domain}`;
    const lines = [
      at("a", "example.com"),
      at("a", "example.net"),
      at("a", "example.org"),
      at("a", "sub.example.com"),
      at("a", "host.example"),
      at("a", "host.invalid"),
      at("a", "host.test"),
      at("a", "host.localhost"),
      at("git", "github.com"),
    ];
    // 接続文字列はテストのファイルでは見ないので、メールとして見ないことだけが確かめられる
    const b = await box({
      "src/a.txt": `${lines.join("\n")}\n`,
      "test/a.test.ts": `https://user:${PASSWORD}@github.com/x\n${CONN}\n`,
    });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });

  it("パスワードのない URL の認証情報は、メールにも接続文字列にもならない", async () => {
    const url = `https://${LOCAL_PART}@${"git"}hub.com/x`;
    const b = await box({
      "src/a.txt": `${url}\n`,
      "test/a.test.ts": `const u = "${url}";\n`,
    });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });

  it("local は git の設定の公開用のメールを当てない（なくても止めない）", async () => {
    const b = await box({ "src/a.txt": `${REAL_EMAIL}\n` });
    expect((await local(b)).code).toBe(1);
    await git(b, b.repo, "config", "orca-flow.publicEmail", REAL_EMAIL);
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });

  it("check は公開用のメールを当てず、ほかのメールは当てる", async () => {
    const b = await box();
    await git(b, b.repo, "config", "orca-flow.publicName", "Public Name");
    await git(b, b.repo, "config", "orca-flow.publicEmail", REAL_EMAIL);
    await writeWords(b, [WORD_1]);
    const other = `${"bob"}@${REAL_DOMAIN}`;
    const clean = await publicCommit(
      b,
      { "src/a.txt": `${REAL_EMAIL}\n` },
      { name: "Public Name", email: REAL_EMAIL },
    );
    const ok = await runScript(b, ["check", clean]);
    expect(ok.code, ok.stderr).toBe(0);
    const dirty = await publicCommit(
      b,
      { "src/a.txt": `${other}\n` },
      { name: "Public Name", email: REAL_EMAIL },
    );
    const result = await runScript(b, ["check", dirty]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：1：メールアドレス");
    expectNoValue(result.stderr, other, REAL_EMAIL);
  });
});

describe("公開の確かめ：Windows のパス", () => {
  for (const value of [
    WIN_USER,
    WIN_USER_ESCAPED,
    WSL_LOCALHOST,
    WSL_DOLLAR,
    MNT,
  ]) {
    it(`名前の文字まで続く形は当たる（${JSON.stringify(value.slice(0, 8))}…）`, async () => {
      const b = await box({ "src/a.txt": `場所：${value}\n` });
      const result = await local(b);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("src/a.txt：1：Windows のパス");
      expectNoValue(result.stderr, LOCAL_PART);
    });
  }

  it("… で切れた形と、テストのファイルの中では当たらない", async () => {
    const cut = [
      `${"C"}:${BS}${"Us"}ers${BS}…`,
      `${BS}${BS}${"wsl"}.localhost${BS}〈名前〉${BS}home${BS}…`,
      `/${"mn"}t/c/…`,
      `/${"mn"}t/〈ドライブ〉/`,
    ];
    const b = await box({
      "src/a.txt": `${cut.join("\n")}\n`,
      "test/a.test.ts": `${WIN_USER}\n${MNT}\n`,
    });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });
});

describe("公開の確かめ：32桁の16進", () => {
  it("前後が英数字でない32桁の16進は、テストでないファイルで当たる", async () => {
    const b = await box({
      "src/a.txt": `page ${HEX32}\n`,
      "src/b.txt": `https://www.notion.so/x-${HEX32}?v=1\n`,
    });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/a.txt：1：32桁の16進");
    expect(result.stderr).toContain("src/b.txt：1：32桁の16進");
    expectNoValue(result.stderr, HEX32);
  });

  it("40桁の16進の一部・英数字に続く形・テストのファイルの中では当たらない", async () => {
    const b = await box({
      "src/a.txt": `commit ${HEX40}\nx${HEX32}\n${HEX32}g\n`,
      "test/a.test.ts": `${HEX32}\n`,
    });
    const result = await local(b);
    expect(result.code, result.stderr).toBe(0);
  });
});

describe("公開の確かめ：UTF-8 でないファイル名", () => {
  it("UTF-8 でない名前のファイルでも止まらず、中身の当たりを出す", async () => {
    const b = await box();
    await configureIdentity(b);
    await writeWords(b, [WORD_1]);
    await git(b, b.repo, "rm", "-rq", "--ignore-unmatch", "docs");
    const name = Buffer.concat([
      Buffer.from(path.join(b.repo, "src", "na")),
      Buffer.from([0xff]),
      Buffer.from("me.txt"),
    ]);
    await writeFile(name, `${TOKEN}\n`);
    await git(b, b.repo, "add", "-A");
    await git(
      b,
      b.repo,
      "-c",
      "user.name=Public Name",
      "-c",
      "user.email=public@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "公開用",
    );
    const commit = await git(b, b.repo, "rev-parse", "HEAD");
    const result = await runScript(b, ["check", commit]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("：1：トークンの形");
    expect(result.stderr).not.toContain("読み取り");
    expectNoValue(result.stderr, TOKEN);
  });
});

describe("公開の確かめ：パスを出さないファイル", () => {
  it("パスに語の一覧の語を含むファイルの当たりは、パスを出さず件数だけ出す", async () => {
    const word = "secret-word-5";
    const b = await box({
      [`src/${word}.txt`]: `${TOKEN}\n${REAL_EMAIL}\n${HEX32}\n`,
    });
    await writeWords(b, [word]);
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "パスに語を含むファイルにトークンの形（1 件）",
    );
    expect(result.stderr).toContain(
      "パスに語を含むファイルにメールアドレス（1 件）",
    );
    expect(result.stderr).toContain(
      "パスに語を含むファイルに32桁の16進（1 件）",
    );
    expectNoValue(result.stderr, word, TOKEN, REAL_EMAIL, HEX32);
  });

  it("パスに手元のパスを含むファイルの当たりは、パスを出さず件数だけ出す", async () => {
    const b = await box({ [`src${FAKE_HOME}/m.txt`]: `${WIN_USER}\n` });
    const result = await local(b);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "パスに手元のパスを含むファイルに Windows のパス（1 件）",
    );
    expectNoValue(result.stderr, "fake-home", "owner", "m.txt", LOCAL_PART);
  });
});

/** 抜くパスのない木に files を足し、公開用の作者でコミットして返す（main は進める） */
async function publicCommit(
  b: Sandbox,
  files: Record<string, string>,
  identity: { name: string; email: string } = {
    name: "Public Name",
    email: "public@example.invalid",
  },
): Promise<string> {
  await git(b, b.repo, "rm", "-rq", "--ignore-unmatch", "docs");
  await writeRepoFiles(b.repo, files);
  await git(b, b.repo, "add", "-A");
  await git(
    b,
    b.repo,
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "公開用",
  );
  return git(b, b.repo, "rev-parse", "HEAD");
}
