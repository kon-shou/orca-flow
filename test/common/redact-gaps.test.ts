import { describe, expect, it } from "vitest";
import { redact } from "../../src/common/redact.ts";

const marks = { token: "[TOKEN]", hidden: "[HIDDEN]" };
const r = (text: string) => redact(text, marks);

describe("伏せ字：括弧などを含む値", () => {
  it("DB_PASSWORD=Xy7(kL9!mQ は印だけになる", () => {
    expect(r("DB_PASSWORD=Xy7(kL9!mQ")).toBe("DB_PASSWORD=[HIDDEN]");
  });
  it("値の途中の ) ` , を含んでも後ろ側が残らない", () => {
    for (const v of ["ab,cd12", "ab)cd12", "ab`cd12", "Xy7(kL9)zz4"]) {
      const out = r(`password=${v} next`);
      expect(out).toBe("password=[HIDDEN] next");
    }
  });
  it("値の終わりの ) と , は値に入れない", () => {
    expect(r("f(password=Xy7kL9mQ)")).toBe("f(password=[HIDDEN])");
    expect(r("password=Xy7kL9mQ, user=u")).toBe("password=[HIDDEN], user=u");
  });
});

describe("伏せ字：カンマでつないだ並び", () => {
  it.each([
    ["user=bob,password=Xy7kL9mQ", "user=bob,password=[HIDDEN]"],
    [
      "host=db1,user=bob,password=Xy7kL9mQ",
      "host=db1,user=bob,password=[HIDDEN]",
    ],
    ["opts(user=bob,password=Xy7kL9mQ)", "opts(user=bob,password=[HIDDEN])"],
    ["x=f(a),token=Xy7kL9mQ", "x=f(a),token=[HIDDEN]"],
  ])("%s", (text, want) => {
    expect(r(text)).toBe(want);
  });
});

describe("伏せ字：値の終わりの記号と省略", () => {
  it.each([
    "`f(password=pw)`",
    "`login(user, password=password)`",
    "`password=password`",
    "see f(password=pw).",
  ])("変わらない：%s", (text) => {
    expect(r(text)).toBe(text);
  });
  it("閉じのバッククォートと文末の . が残る", () => {
    expect(r("`password=Xy7kL9mQ`")).toBe("`password=[HIDDEN]`");
    expect(r("see password=Xy7kL9mQ.")).toBe("see password=[HIDDEN].");
  });
  it("値のあとの省略では伏せ、値の前の省略では伏せない", () => {
    expect(r("password=Xy7kL9mQ,…")).toBe("password=[HIDDEN]");
    expect(r("password=Xy7kL9mQ,ほかは…")).toBe("password=[HIDDEN]");
    expect(r("password=Xy7kL9mQ…")).toBe("password=Xy7kL9mQ…");
    expect(r("password=...")).toBe("password=...");
  });
});

describe("伏せ字：長い入力で遅くならない", () => {
  it.each([",", ")"])("値のあとに %s が6万字続く", (c) => {
    const text = "password=a" + c.repeat(60000) + "x";
    const t = performance.now();
    r(text);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("伏せ字：秘密の語で終わる名前", () => {
  it("PGPASSWORD・clientsecret・accesstoken の値が残らない", () => {
    for (const name of ["PGPASSWORD", "clientsecret", "accesstoken"]) {
      const out = r(`${name}=hunter2xyz`);
      expect(out).toBe(`${name}=[HIDDEN]`);
    }
  });
  it("始まるだけの名前は当てない", () => {
    expect(r("tokenizer=hunter2xyz")).toBe("tokenizer=hunter2xyz");
    expect(r("secretary=hunter2xyz")).toBe("secretary=hunter2xyz");
  });
});

describe("伏せ字：変わらないもの", () => {
  it.each([
    "password = crypto.randomBytes(16);",
    "login(user, password=password)",
    "f(password=pw, user=u)",
    "token = `Bearer ${x}`;",
  ])("%s", (text) => {
    expect(r(text)).toBe(text);
  });
});
