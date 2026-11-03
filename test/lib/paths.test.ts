import { afterEach, describe, expect, it } from "vitest";
import { fromWslUncPath, samePath } from "../../src/lib/paths.ts";

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

// ファイルを読んだときの WSL_DISTRO_NAME（元から値がなければ undefined）
const originalDistro = process.env.WSL_DISTRO_NAME;

describe("fromWslUncPath", () => {
  // 各テストのあと、環境変数が読んだときの値に戻っていることを確かめる
  afterEach(() => {
    if (originalDistro === undefined) {
      expect(process.env.WSL_DISTRO_NAME).toBeUndefined();
      expect("WSL_DISTRO_NAME" in process.env).toBe(false);
    } else {
      expect(process.env.WSL_DISTRO_NAME).toBe(originalDistro);
    }
  });

  it("ディストリビューションを省くと、環境変数 WSL_DISTRO_NAME の UNC の形を Linux の形に戻す", () => {
    const saved = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    try {
      expect(
        fromWslUncPath(
          "\\\\wsl.localhost\\Ubuntu\\home\\u",
          undefined,
          "linux",
        ),
      ).toBe("/home/u");
    } finally {
      if (saved === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = saved;
    }
  });

  it("WSL の中では、今のディストリビューションの UNC の形を Linux の形に戻す", () => {
    expect(
      fromWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\u", "Ubuntu", "linux"),
    ).toBe("/home/u");
    expect(
      fromWslUncPath("\\\\wsl$\\Ubuntu\\home\\u\\", "Ubuntu", "linux"),
    ).toBe("/home/u");
    expect(
      fromWslUncPath(
        "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo",
        "Ubuntu",
        "linux",
      ),
    ).toBe("/home/u/repo");
    expect(
      fromWslUncPath("//wsl.localhost/ubuntu/home/u", "Ubuntu", "linux"),
    ).toBe("/home/u");
    expect(fromWslUncPath("\\\\wsl.localhost\\Ubuntu", "Ubuntu", "linux")).toBe(
      "/",
    );
  });

  it("ほかのディストリビューション・WSL の外・UNC でない形は、そのまま返す", () => {
    const unc = "\\\\wsl.localhost\\Debian\\home\\u";
    expect(fromWslUncPath(unc, "Ubuntu", "linux")).toBe(unc);
    const ubuntu = "\\\\wsl.localhost\\Ubuntu\\home\\u";
    expect(fromWslUncPath(ubuntu, "", "linux")).toBe(ubuntu);
    expect(fromWslUncPath(ubuntu, "Ubuntu", "win32")).toBe(ubuntu);
    expect(fromWslUncPath(ubuntu, "Ubuntu", "darwin")).toBe(ubuntu);
    // 環境変数 WSL_DISTRO_NAME がないとき、ディストリビューションを省いてもそのまま返す
    const saved = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;
    try {
      expect(fromWslUncPath(ubuntu, undefined, "linux")).toBe(ubuntu);
    } finally {
      if (saved === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = saved;
    }
    expect(fromWslUncPath("/home/u", "Ubuntu", "linux")).toBe("/home/u");
    expect(fromWslUncPath("C:\\a\\b", "Ubuntu", "linux")).toBe("C:\\a\\b");
  });
});
