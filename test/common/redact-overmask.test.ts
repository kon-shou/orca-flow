import { describe, expect, it } from "vitest";
import { redact } from "../../src/common/redact.ts";

const marks = { token: "[トークン]", hidden: "[伏せた]" };
const r = (t: string) => redact(t, marks);
const REAL = "Xy7kL9" + "mQ2pZ";

describe("伏せない形", () => {
  it("引用符で囲んだ変数の参照", () => {
    for (const t of [
      'token: "${TOKEN}"',
      'token: "${{ secrets.NPM_TOKEN }}"',
      'password = "${DB_PASS}"',
    ])
      expect(r(t)).toBe(t);
  });
  it("数字を含まない置き場所の文", () => {
    const t = 'password = "<your password>"';
    expect(r(t)).toBe(t);
  });
  it("決まった普通の語（大文字小文字は問わない）", () => {
    for (const t of [
      'credentials: "include"',
      'password = "TRUE"',
      'token_type = "bearer"',
      'credentials: "same-origin"',
      "secret = 'null'",
    ])
      expect(r(t)).toBe(t);
  });
  it("PWD と OLDPWD", () => {
    expect(r("PWD=/home/u")).toBe("PWD=/home/u");
    expect(r("OLDPWD=/x")).toBe("OLDPWD=/x");
    expect(r("PWD: /home/u")).toBe("PWD: /home/u");
  });
  it("空の値の次の行を伏せない", () => {
    const t = "API_KEY=\nDB_HOST=localhost";
    expect(r(t)).toBe(t);
  });
  it("1行の JSON で URL のあとの別の値まで伏せない", () => {
    const t = '{"a":"https://host:8080","e":"x@y"}';
    expect(r(t)).toBe(t);
  });
});

describe("今までどおり伏せる", () => {
  it("小文字の pwd・DB_PWD・Pwd", () => {
    expect(r(`pwd=${REAL}`)).toBe("pwd=[伏せた]");
    expect(r(`DB_PWD=${REAL}`)).toBe("DB_PWD=[伏せた]");
    expect(r(`Pwd=${REAL}`)).toBe("Pwd=[伏せた]");
  });
  it("数字を含む値・空白ありで引用符なしの値", () => {
    expect(r("password = abc12345")).toBe("password = [伏せた]");
    expect(r(`aws_secret_access_key = ${REAL}`)).toBe(
      "aws_secret_access_key = [伏せた]",
    );
  });
  it("AWS のキーと割った GitHub のトークン", () => {
    expect(r("k AKIA" + "ABCDEFGHIJKLMNOP")).toBe("k [伏せた]");
    const t = "ghp_" + "abcde\u200bfghij1234567890";
    expect(r(t)).toBe("[トークン]");
  });
  it("引用符の本物らしい値と数字を含む <…>", () => {
    expect(r(`password = "${REAL}"`)).toBe("password = [伏せた]");
    expect(r(`password = "<${"Xy7kL9" + "mQ"}>"`)).toBe("password = [伏せた]");
    expect(r('password = "<abc123>"')).toBe("password = [伏せた]");
  });
  it("決まった語の一覧にない語", () => {
    expect(r('credentials: "includes"')).toBe("credentials: [伏せた]");
    expect(r('token: "${TOKEN}x"')).toBe("token: [伏せた]");
  });
  it("API_KEY= の値と、= のあとの空白・タブ", () => {
    expect(r(`API_KEY=${REAL}`)).toBe("API_KEY=[伏せた]");
    expect(r(`API_KEY= ${REAL}`)).toBe("API_KEY= [伏せた]");
    expect(r(`API_KEY=\t${REAL}`)).toBe("API_KEY=\t[伏せた]");
  });
  it("資格情報つきの URL（' を含むパスワードも）", () => {
    expect(r("https://user:pass@host/x")).toBe("https://[伏せた]@host/x");
    expect(r("https://user:p'ss@host")).toBe("https://[伏せた]@host");
  });
});

describe("折られた代入と式の途中の }}", () => {
  it("= のあとで折られた引用符の値を伏せる", () => {
    expect(r(`const stripeSecretKeyForProduction =\n  "${REAL}";`)).toBe(
      "const stripeSecretKeyForProduction =\n  [伏せた];",
    );
    expect(r(`private readonly clientSecret =\n    '${REAL}';`)).toBe(
      "private readonly clientSecret =\n    [伏せた];",
    );
  });
  it("折られても変数の参照・空の値の次の行は変えない", () => {
    for (const t of [
      'password =\n  "${DB_PASS}"',
      "API_KEY=\nDB_HOST=localhost",
    ])
      expect(r(t)).toBe(t);
  });
  it("途中に }} を含む値は伏せる", () => {
    expect(r(`password: "\${{ secrets.U }}:${REAL}\${{ env.X }}"`)).toBe(
      "password: [伏せた]",
    );
    expect(r(`password = "\${{ x }}${REAL}}}"`)).toBe("password = [伏せた]");
  });
});
