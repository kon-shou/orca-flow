import { describe, expect, it } from "vitest";
import { redact } from "../../src/common/redact.ts";

const marks = { token: "[トークン]", hidden: "[伏せた]" };
const r = (t: string) => redact(t, marks);
const KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

describe("AWS のアクセスキー", () => {
  it("AKIA と16字のキーを伏せる", () => {
    expect(r(`key ${KEY} です`)).toBe("key [伏せた] です");
    expect(r(`id=${KEY}.`)).not.toContain(KEY);
  });
  it("幅のない字で割っても伏せる", () => {
    const split = `${KEY.slice(0, 6)}​${KEY.slice(6, 12)}­${KEY.slice(12)}`;
    expect(r(`x ${split} y`)).toBe("x [伏せた] y");
  });
  it("15字や語の途中、17字以上は伏せない", () => {
    expect(r(`AKIA${"A".repeat(15)} 終`)).toBe(`AKIA${"A".repeat(15)} 終`);
    expect(r(`X${KEY}`)).toBe(`X${KEY}`);
    expect(r(`${KEY}Z`)).toBe(`${KEY}Z`);
  });
});

describe("YAML の引用符のない値", () => {
  it("行の頭の名前と値を伏せる", () => {
    expect(r("password: hunter2")).toBe("password: [伏せた]");
    expect(r("config:\n  db_password: Tr0ub4dor\n")).toBe(
      "config:\n  db_password: [伏せた]\n",
    );
    expect(r("- token: abc123xyz")).toBe("- token: [伏せた]");
  });
  it("幅のない字で割っても伏せる", () => {
    expect(r("pass​word: hunt​er2")).toBe("password: [伏せた]");
  });
  it("差分の足した行も伏せる", () => {
    expect(r("+password: hunter2")).toBe("+password: [伏せた]");
    expect(r("+  db_password: Tr0ub4dor")).toBe("+  db_password: [伏せた]");
    expect(r("-  password: hunter2")).toBe("-  password: [伏せた]");
  });
  it("ブロックの値の印だけの値は伏せない", () => {
    for (const line of [
      "password: |",
      "password: >",
      "secret: |-",
      "token: >-",
      "password: |2",
    ])
      expect(r(line)).toBe(line);
  });
  it("変数の参照と型の形は伏せない", () => {
    for (const line of [
      "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      "  token: Record<string, string>;",
      "  password: Promise<string>;",
      "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
      "const token=Array<string>",
    ])
      expect(r(line)).toBe(line);
  });
  it("数字を含む名前のあとの < は型の形と見ず伏せる", () => {
    expect(r("password=aB3dE5<fG7")).toBe("password=[伏せた]");
    expect(r("api_key=sk9Qz<1vR")).not.toContain("sk9Qz");
    expect(r("password: Xk9mP2<qL")).toBe("password: [伏せた]");
  });
  it("値に日本語などが入っていれば伏せない", () => {
    for (const line of [
      "- token: 期限切れのときは取り直す",
      "password: 必須",
      "- token: 4時間で切れる",
    ])
      expect(r(line)).toBe(line);
  });
  it("識別子・変数の参照・a.b.c・呼び出しは伏せない", () => {
    for (const line of [
      "password: string",
      "token: ${TOKEN}",
      "password: process.env.PW",
      "password: getPassword()",
    ])
      expect(r(line)).toBe(line);
  });
  it("コロンのあとに空白がない形は伏せない", () => {
    expect(r("password:hunter2")).toBe("password:hunter2");
  });
  it("文の途中の名前は伏せない", () => {
    expect(r("説明 token: abc123xyz")).toBe("説明 token: abc123xyz");
  });
  it("秘密でない名前は伏せない", () => {
    expect(r("name: Tr0ub4dor")).toBe("name: Tr0ub4dor");
  });
  it("長い入力でも遅くならない", () => {
    const t0 = Date.now();
    r(" ".repeat(50000) + "x");
    r("- ".repeat(20000) + "a".repeat(20000));
    r("a".repeat(100000) + ": ");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
