import { describe, expect, it } from "vitest";
import { samePath } from "../../src/lib/paths.ts";

describe("samePath", () => {
  it("Windows の形では、区切りと大文字小文字の違いを同じと見なす", () => {
    expect(samePath("C:/a/b", "c:\\a\\b", "win32")).toBe(true);
    expect(samePath("C:/a/b/", "c:\\a\\b", "win32")).toBe(true);
  });

  it("Windows の形でも、違う場所は違う", () => {
    expect(samePath("C:/a/b", "C:/a/c", "win32")).toBe(false);
    expect(samePath("C:/a/b", "D:/a/b", "win32")).toBe(false);
  });

  it("macOS の形では、大文字小文字を区別する", () => {
    expect(samePath("/no/such/A", "/no/such/a", "darwin")).toBe(false);
    expect(samePath("/no/such/a", "/no/such/a", "darwin")).toBe(true);
    expect(samePath("/no/such/a", "/no/such/b", "darwin")).toBe(false);
  });

  it("プラットフォームを省略しても同じ場所は同じ", () => {
    expect(samePath(".", process.cwd())).toBe(true);
  });
});
