import { describe, expect, it } from "vitest";
import { redact } from "../../src/common/redact.ts";

const marks = { token: "[T]", hidden: "[H]" };
const r = (text: string, extra: string[] = []) => redact(text, marks, extra);

describe("redact：変わらないもの", () => {
  it("ふつうの文は変わらない", () => {
    for (const text of [
      "token validation を直す",
      "Basic authentication works",
      "ssh://git@github.com/x/y.git",
      "https://github.com/x/y",
      "パスワードの扱いを直す",
      // ふつうのコード
      "if (token == null) return;",
      "if (token === undefined) {}",
      "const token = getToken();",
      "max_tokens=4000",
      "secretary=bob",
      "tokenizer=bpe",
      "passwordField = form.elements[0]",
      "const password = req.body.password;",
      "const cb = (token) => token;",
      "password=$PASSWORD",
      "token=…",
    ])
      expect(r(text)).toBe(text);
  });

  it("伏せないときは幅のない字を消さない", () => {
    const text = "token\u200B validation works";
    expect(r(text)).toBe(text);
    expect(r("Basic\u200B authentication works")).toBe(
      "Basic\u200B authentication works",
    );
  });
});

describe("redact：残らないもの", () => {
  it("パスワードに @ を含む URL・ユーザー名のない URL・postgres の資格情報", () => {
    expect(r("https://user:p@ss@example.com/x")).toBe(
      "https://[H]@example.com/x",
    );
    expect(r("redis://:pw123@cache:6379")).not.toContain("pw123");
    expect(r("postgres://u:p4ss@db/app")).not.toContain("p4ss");
    expect(r("redis://:pw123@cache:6379")).toContain("cache:6379");
  });

  it("秘密鍵の塊", () => {
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nxyz789\n-----END RSA PRIVATE KEY-----";
    const out = r(`前\n${key}\n後`);
    expect(out).not.toMatch(/MIIE|xyz789|PRIVATE KEY/);
    expect(out).toContain("前");
    expect(out).toContain("後");
    // 終わりの行がなくても残らない
    expect(r("-----BEGIN PRIVATE KEY-----\nabcdef123")).not.toContain("abcdef");
  });

  it("password=… と AWS_SECRET_ACCESS_KEY=… の値", () => {
    expect(r("password=hunter2xyz")).not.toContain("hunter2xyz");
    // 数字を含む a.b.c の形は識別子と見ない
    expect(r("password=Tr0ub4dor.and3")).not.toContain("Tr0ub4dor");
    expect(r("access_token=ya29.a0AfH6SMBabc123XYZ")).not.toContain("ya29");
    // Bearer のあとは8字以上を全部伏せる
    expect(r("Authorization: Bearer kubernetes")).not.toContain("kubernetes");
    expect(r("Bearer abcdefghij")).not.toContain("abcdefghij");
    expect(r("bearer kubernetes")).not.toContain("kubernetes");
    expect(r("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG")).not.toContain(
      "wJalr",
    );
    expect(r('{"password": "hunter2xyz"}')).not.toContain("hunter2xyz");
    expect(r("GH_TOKEN=abcdef123456")).not.toContain("abcdef123456");
    expect(r("GH_TOKEN=abc,defXYZ123")).toBe("GH_TOKEN=[H]");
    expect(r('"token": "abc123def456"')).toBe('"token": [H]');
    expect(
      r("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    ).toBe("AWS_SECRET_ACCESS_KEY=[H]");
    expect(r("password=hunter2")).toBe("password=[H]");
    expect(r("文中の password=hunter2xyz と続く")).toBe(
      "文中の password=[H] と続く",
    );
  });

  it("main が伏せていた形", () => {
    expect(r("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [H]",
    );
    expect(r("Bearer abcdefghijKLmn")).toBe("Bearer [H]");
    expect(r("token abcdefghijkl")).toBe("token [H]");
    expect(r("https://user:pa#ss@example.com/x")).toBe(
      "https://[H]@example.com/x",
    );
    expect(r("https://user:pa?ss@example.com/x")).toBe(
      "https://[H]@example.com/x",
    );
    expect(r("x_https://user:pw123@example.com")).toBe(
      "x_https://[H]@example.com",
    );
  });

  it("幅のない字で割った・境目を消した形", () => {
    for (const cp of ["\u2066", "\u202E", "\u180E", "\u{E0001}", "\u00AD"])
      expect(r(`g${cp}hp_abcdefghijklmnop0123`)).toBe("[T]");
    expect(r("x\u200Bghp_abcdefghijklmnop0123")).toBe("x\u200B[T]");
    expect(r("Bearer\uFEFFabc123def456")).toBe("Bearer [H]");
  });

  it("トークンの形。ゼロ幅の字で割っても残らない", () => {
    const plain = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    expect(r(`a ${plain} b`)).toBe("a [T] b");
    const split = "gh​p_abcdefghij‍klmnopqrstuvwxyz0123";
    const out = r(`a ${split} b`);
    expect(out).not.toMatch(/abcdefghij|klmnop/);
    expect(out).toBe("a [T] b");
    expect(r("github_pat_ABCDEFGHIJ0123456789")).toBe("[T]");
  });

  it("Bearer の値・環境変数の値", () => {
    expect(r("Authorization: Bearer abc123def456")).toBe(
      "Authorization: Bearer [H]",
    );
    expect(r("Bearer abcdefghijklmnopqrstu です")).not.toContain("abcdefghij");
    expect(r("a my-own-secret-value b", ["my-own-secret-value"])).toBe(
      "a [H] b",
    );
    expect(r("a short b", ["short"])).toBe("a short b");
  });
});

describe("redact：長い入力でも遅くならない", () => {
  const base64url = () => {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let seed = 12345;
    let s = "";
    for (let i = 0; i < 60000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      s += chars[seed % chars.length];
    }
    return s;
  };
  it.each([
    ["token の繰り返し", () => "token".repeat(13000)],
    ["英数字の列", () => "a".repeat(65000)],
    ["a. の繰り返し", () => "a.".repeat(32000)],
    ["base64url", base64url],
    ["scheme", () => "a://".repeat(16000)],
    ["GH_ の繰り返し", () => "GH_".repeat(20000)],
    ["空白", () => `token${" ".repeat(60000)}x`],
  ])("%s", (_name, make) => {
    const text = make();
    const t = Date.now();
    r(text);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
