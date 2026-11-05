import { describe, expect, it } from "vitest";
import { redact } from "../../src/common/redact.ts";

const marks = { token: "[トークン]", hidden: "[伏せた]" };
const r = (t: string) => redact(t, marks);

describe("型の形の外しは < の直後が名前か括弧のときだけ", () => {
  it("< の直後が数字・記号の値は伏せる", () => {
    expect(r("password=Ab<12345")).toBe("password=[伏せた]");
    expect(r("password: Ab<12345")).toBe("password: [伏せた]");
    expect(r("password=Ab<#x9")).toBe("password=[伏せた]");
  });
  it("型の形は伏せない", () => {
    for (const line of [
      "  token: Record<string, string>;",
      "  password: Promise<string>;",
      "const token=Array<string>",
      "password: Map<K, V>",
      "password: Promise<{ ok: boolean }>",
      "token: Array<[string, number]>",
      "password: Promise<Uint8Array>",
      "password: Promise<(a: string) => void>",
      "token: Box<_T>",
      "token: Box<$T>",
      "  token: Promise<",
      "  credentials: Record<",
      "  password: Cow<'a, str>,",
      "  password: Option<&'a str>,",
      "  token: Promise< string >;",
      '  token: Extract<"a" | "b">;',
    ])
      expect(r(line)).toBe(line);
  });
  it("GitHub Actions の式は伏せない", () => {
    for (const line of [
      "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
    ])
      expect(r(line)).toBe(line);
  });
});
