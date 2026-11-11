import { describe, expect, it } from "vitest";
import { redact } from "../../src/common/redact.ts";

const marks = { token: "[トークン]", hidden: "[伏せた]" };
const r = (t: string) => redact(t, marks);
const REAL = "Xy7kL9" + "mQ2pZ";

describe("名前の最後が数を表す語のとき伏せない", () => {
  it("秘密の語に count・length・limit・size が付いた名前", () => {
    for (const t of [
      "TOKEN_COUNT: 5",
      "token_count: 5",
      "tokenCount: 5",
      "secret_count: 3",
      "password_length: 12",
      "PASSWORD_MIN_LENGTH=8",
      "API_KEY_LIMIT=100",
      "token_size = 32",
    ])
      expect(r(t)).toBe(t);
  });
  it("len・max・min で終わる名前", () => {
    for (const t of ["password_len: 12", "token_max=5", "secret_min: 1"])
      expect(r(t)).toBe(t);
  });
  it("末尾の区切りのあとの空の単位は飛ばして最後の語を見る", () => {
    for (const t of ["token_count_: 5", "TOKEN_COUNT_=5", "token.count_: 5"])
      expect(r(t)).toBe(t);
  });
});

describe("名前の最後が秘密の語なら伏せる", () => {
  it("最後の単位が秘密の語の名前", () => {
    expect(r("password: 5")).toBe("password: [伏せた]");
    expect(r(`API_TOKEN=${REAL}`)).toBe("API_TOKEN=[伏せた]");
    expect(r(`DB_PASSWORD=${REAL}`)).toBe("DB_PASSWORD=[伏せた]");
    expect(r(`aws_secret_access_key = ${REAL}`)).toBe(
      "aws_secret_access_key = [伏せた]",
    );
    expect(r("token_count_secret: 5")).toBe("token_count_secret: [伏せた]");
  });
});

describe("今も伏せない形", () => {
  it("秘密の名前に当たらない形は変わらない", () => {
    for (const t of ["max_tokens: 1000", "tokens: 5", "TOKEN_COUNT: abc"])
      expect(r(t)).toBe(t);
  });
});
