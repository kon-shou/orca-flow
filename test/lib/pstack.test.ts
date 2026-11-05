import { describe, expect, it } from "vitest";
import {
  TRUSTED_PSTACK_SOURCES,
  PSTACK_INSTALL_SOURCE,
  classifyPstack,
  githubRepoOf,
  selectPstack,
} from "../../src/lib/pstack.ts";

const plugin = (id: string, installPath: string | null, enabled = true) => ({
  id,
  enabled,
  scope: "user",
  ...(installPath === null ? {} : { installPath }),
});
const gh = (name: string, repo: string) => ({ name, source: "github", repo });
const git = (name: string, url: string) => ({ name, source: "git", url });

describe("githubRepoOf", () => {
  it.each([
    ["https://github.com/Cursor/plugins", "cursor/plugins"],
    ["https://github.com/cursor/plugins.git", "cursor/plugins"],
    ["https://github.com/cursor/plugins/", "cursor/plugins"],
    ["git@github.com:cursor/plugins.git", "cursor/plugins"],
    ["ssh://git@github.com/cursor/plugins.git", "cursor/plugins"],
  ])("%s", (url, repo) => expect(githubRepoOf(url)).toBe(repo));

  it.each([
    "https://gitlab.com/cursor/plugins",
    "https://github.com.evil.example/cursor/plugins",
    "https://evil.example/github.com/cursor/plugins",
    "/home/u/plugins",
    "https://github.com/cursor",
  ])("github.com でない・形が違う：%s", (url) =>
    expect(githubRepoOf(url)).toBeNull(),
  );
});

describe("selectPstack", () => {
  it("github の repo が正なら通り、source は正の綴りで返す", () => {
    expect(
      selectPstack(
        [plugin("pstack@pstack", "/p")],
        [gh("pstack", "PainHardCore/pstack")],
      ),
    ).toEqual({
      kind: "ok",
      plugin: "pstack@pstack",
      installPath: "/p",
      source: "painhardcore/pstack",
      warning: null,
    });
  });

  it("git の url が github.com の同じリポジトリなら通る", () => {
    const r = selectPstack(
      [plugin("pstack@cursor-plugins", "/p")],
      [git("cursor-plugins", "git@github.com:cursor/plugins.git")],
    );
    expect(r).toMatchObject({ kind: "ok", source: "cursor/plugins" });
  });

  it("別の repo・フォルダ・一覧にないマーケットプレイス・別ホストの git は untrusted", () => {
    for (const markets of [
      [gh("m", "evil/pstack")],
      [{ name: "m", source: "directory", path: "/home/u/pstack" }],
      [],
      [git("m", "https://gitlab.com/cursor/plugins")],
    ])
      expect(selectPstack([plugin("pstack@m", "/p")], markets).kind).toBe(
        "untrusted",
      );
  });

  it("pstack がない・pstack という名前でない・enabled でないものだけなら none", () => {
    const markets = [gh("m", "cursor/plugins")];
    expect(selectPstack([], markets).kind).toBe("none");
    expect(selectPstack([plugin("other@m", "/p")], markets).kind).toBe("none");
    expect(selectPstack([plugin("my-pstack@m", "/p")], markets).kind).toBe(
      "none",
    );
    expect(selectPstack([plugin("pstack@m", "/p", false)], markets).kind).toBe(
      "none",
    );
    expect(selectPstack("x", null).kind).toBe("none");
  });

  it("別の入手元のほうだけが enabled なら untrusted、正のほうだけが enabled なら ok", () => {
    const markets = [gh("good", "cursor/plugins"), gh("bad", "evil/pstack")];
    expect(
      selectPstack(
        [plugin("pstack@good", "/g", false), plugin("pstack@bad", "/b")],
        markets,
      ).kind,
    ).toBe("untrusted");
    expect(
      selectPstack(
        [plugin("pstack@good", "/g"), plugin("pstack@bad", "/b", false)],
        markets,
      ),
    ).toMatchObject({ kind: "ok", installPath: "/g" });
  });

  it("正の候補の installPath が2つ違えば untrusted、同じなら ok", () => {
    const markets = [gh("a", "cursor/plugins"), gh("b", "painhardcore/pstack")];
    expect(
      selectPstack(
        [plugin("pstack@a", "/1"), plugin("pstack@b", "/2")],
        markets,
      ).kind,
    ).toBe("untrusted");
    expect(
      selectPstack(
        [plugin("pstack@a", "/1"), plugin("pstack@b", "/1")],
        markets,
      ).kind,
    ).toBe("ok");
  });

  it("installPath がなければ untrusted", () => {
    expect(
      selectPstack([plugin("pstack@m", null)], [gh("m", "cursor/plugins")])
        .kind,
    ).toBe("untrusted");
  });

  it("正と別の入手元が両方 enabled なら、正のほうを返し、別のほうを warning に書く。片方だけなら warning は null", () => {
    const markets = [gh("good", "cursor/plugins"), gh("bad", "evil/pstack")];
    const both = selectPstack(
      [plugin("pstack@bad", "/b"), plugin("pstack@good", "/g")],
      markets,
    );
    expect(both).toMatchObject({ kind: "ok", installPath: "/g" });
    if (both.kind !== "ok") throw new Error("ok のはず");
    expect(both.warning).toMatch(/^注意：/);
    expect(both.warning).toContain("pstack@bad");
    expect(both.warning).not.toContain("\n");
    // 一覧にないマーケットプレイスも別の入手元の候補
    const missing = selectPstack(
      [plugin("pstack@good", "/g"), plugin("pstack@gone", "/x")],
      markets,
    );
    expect(missing).toMatchObject({ kind: "ok" });
    expect(missing.kind === "ok" && missing.warning).toContain("pstack@gone");
    // enabled でない別の入手元は候補ではない
    const off = selectPstack(
      [plugin("pstack@good", "/g"), plugin("pstack@bad", "/b", false)],
      markets,
    );
    expect(off).toMatchObject({ kind: "ok", warning: null });
  });

  it("@ のない ID（pstack・pstackx）は候補にならない", () => {
    const markets = [gh("m", "cursor/plugins")];
    expect(selectPstack([plugin("pstack", "/p")], markets).kind).toBe("none");
    expect(selectPstack([plugin("pstackx", "/p")], markets).kind).toBe("none");
    expect(selectPstack([plugin("pstackx@m", "/p")], markets).kind).toBe(
      "none",
    );
  });

  it("ref が空でない文字列なら、正のリポジトリでも untrusted で、理由に ref を書く。ref がない・空なら通る", () => {
    for (const extra of [
      { ref: "master" },
      { ref: "refs/pull/1/head" },
      { ref: " " },
    ]) {
      for (const m of [
        { ...gh("m", "cursor/plugins"), ...extra },
        { ...git("m", "https://github.com/cursor/plugins.git"), ...extra },
      ]) {
        const r = selectPstack([plugin("pstack@m", "/p")], [m]);
        expect(r.kind).toBe("untrusted");
        expect(r.kind === "untrusted" && r.reason).toContain("ref");
      }
    }
    for (const extra of [{}, { ref: "" }, { ref: null }]) {
      expect(
        selectPstack(
          [plugin("pstack@m", "/p")],
          [{ ...gh("m", "cursor/plugins"), ...extra }],
        ).kind,
      ).toBe("ok");
    }
  });

  it("同じ名前の項のどれかに ref があれば untrusted", () => {
    const r = selectPstack(
      [plugin("pstack@m", "/p")],
      [gh("m", "cursor/plugins"), { ...gh("m", "cursor/plugins"), ref: "x" }],
    );
    expect(r.kind).toBe("untrusted");
  });
});

describe("classifyPstack", () => {
  const good = [gh("cursor-plugins", "cursor/plugins")];
  it("入れる入手元は正の入手元の1つ", () => {
    expect(TRUSTED_PSTACK_SOURCES).toContain(PSTACK_INSTALL_SOURCE);
  });
  it("有効・無効・ない", () => {
    expect(
      classifyPstack([plugin("pstack@cursor-plugins", "/p")], good),
    ).toMatchObject({ kind: "enabled", id: "pstack@cursor-plugins" });
    expect(
      classifyPstack([plugin("pstack@cursor-plugins", null, false)], good),
    ).toEqual({ kind: "disabled", id: "pstack@cursor-plugins" });
    expect(classifyPstack([], good)).toEqual({ kind: "missing" });
    expect(classifyPstack([], [])).toEqual({ kind: "missing" });
  });
  it("正でない入手元だけなら、無効でも untrusted", () => {
    const bad = [gh("evil", "evil/p")];
    expect(classifyPstack([plugin("pstack@evil", "/p", false)], bad).kind).toBe(
      "untrusted",
    );
    expect(classifyPstack([plugin("pstack@evil", "/p")], bad).kind).toBe(
      "untrusted",
    );
  });
  it("有効なものが正でなければ、正の無効なものがあっても untrusted", () => {
    const m = [gh("cursor-plugins", "cursor/plugins"), gh("evil", "evil/p")];
    expect(
      classifyPstack(
        [
          plugin("pstack@cursor-plugins", "/g", false),
          plugin("pstack@evil", "/e"),
        ],
        m,
      ).kind,
    ).toBe("untrusted");
  });
  it("cursor-plugins が別の入手元（painhardcore も ref つきも）なら、pstack がなくても untrusted", () => {
    expect(
      classifyPstack([], [gh("cursor-plugins", "painhardcore/pstack")]).kind,
    ).toBe("untrusted");
    expect(
      classifyPstack(
        [],
        [{ ...gh("cursor-plugins", "cursor/plugins"), ref: "dev" }],
      ).kind,
    ).toBe("untrusted");
  });
  it("正の入手元が2つで installPath が違うときは、untrusted ではなく unknown", () => {
    const m = [
      gh("cursor-plugins", "cursor/plugins"),
      gh("ph", "painhardcore/pstack"),
    ];
    const r = classifyPstack(
      [plugin("pstack@cursor-plugins", "/a"), plugin("pstack@ph", "/b")],
      m,
    );
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.reason).toContain("uninstall");
  });
  it("正の pstack に installPath がなければ unknown", () => {
    expect(
      classifyPstack([plugin("pstack@cursor-plugins", null)], good).kind,
    ).toBe("unknown");
  });
  it("正でない pstack が2つあれば、外す id を全部持つ", () => {
    const m = [gh("a", "x/a"), gh("b", "x/b")];
    expect(
      classifyPstack([plugin("pstack@a", "/a"), plugin("pstack@b", "/b")], m),
    ).toMatchObject({
      kind: "untrusted",
      ids: ["pstack@a", "pstack@b"],
      marketplaces: [],
    });
  });
  it("cursor-plugins が原因のときは、外すマーケットプレイスを持つ。名前のぶつかりだけなら ids は空", () => {
    const ref = [{ ...gh("cursor-plugins", "cursor/plugins"), ref: "dev" }];
    expect(
      classifyPstack([plugin("pstack@cursor-plugins", "/p")], ref),
    ).toMatchObject({
      kind: "untrusted",
      ids: ["pstack@cursor-plugins"],
      marketplaces: ["cursor-plugins"],
    });
    expect(
      classifyPstack([], [gh("cursor-plugins", "painhardcore/pstack")]),
    ).toMatchObject({
      kind: "untrusted",
      ids: [],
      marketplaces: ["cursor-plugins"],
    });
  });
});
