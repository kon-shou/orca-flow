import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../../src/lib/exec.ts";
import { CLAUDE_TIMEOUT_MS } from "../../src/lib/pstack.ts";
import { runCli } from "../helpers/fake-orca.ts";
import { tempDir } from "../helpers/repo.ts";

const REL = "skills/how/SKILL.md";

interface Setup {
  plugins?: unknown;
  markets?: unknown;
  pluginsRaw?: string;
  marketsRaw?: string;
  codes?: { list?: number; market?: number };
  timedOut?: boolean;
}

function fakeClaude(s: Setup) {
  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    timeouts.push(opts?.timeoutMs);
    const isMarket = args.includes("marketplace");
    const code = (isMarket ? s.codes?.market : s.codes?.list) ?? 0;
    const body = isMarket
      ? (s.marketsRaw ?? JSON.stringify(s.markets ?? []))
      : (s.pluginsRaw ?? JSON.stringify(s.plugins ?? []));
    return {
      code,
      stdout: code === 0 ? body : "",
      stderr: code === 0 ? "" : "boom",
      timedOut: s.timedOut ?? false,
    };
  };
  return { runner, calls, timeouts };
}

async function installed(withHarness = false) {
  const dir = await tempDir();
  await mkdir(path.join(dir, "skills/how"), { recursive: true });
  await writeFile(path.join(dir, REL), "x\n");
  if (withHarness) {
    await mkdir(path.join(dir, "docs/harness"), { recursive: true });
    await writeFile(path.join(dir, "docs/harness/claude-code.md"), "h\n");
  }
  return dir;
}

const entry = (id: string, installPath: string, enabled = true) => ({
  id,
  enabled,
  scope: "user",
  installPath,
});
const gh = (name: string, repo: string) => ({ name, source: "github", repo });

const pstack = async (s: Setup, args: string[] = [REL, "--json"]) => {
  const c = fakeClaude(s);
  const cwd = await tempDir(); // .orca-flow/config.json も git もない場所
  const r = await runCli(["pstack", ...args], { cwd, runner: c.runner });
  return { ...r, calls: c.calls, timeouts: c.timeouts };
};

describe("pstack", () => {
  it("github の repo が正：0 で file・harness・plugin・source を返す", async () => {
    const dir = await installed(true);
    const r = await pstack({
      plugins: [entry("pstack@pstack", dir)],
      markets: [gh("pstack", "painhardcore/pstack")],
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      file: path.join(dir, REL),
      harness: path.join(dir, "docs/harness/claude-code.md"),
      plugin: "pstack@pstack",
      source: "github:painhardcore/pstack",
      warning: null,
    });
    expect(r.calls).toEqual([
      ["claude", "plugin", "list", "--json"],
      ["claude", "plugin", "marketplace", "list", "--json"],
    ]);
    expect(r.timeouts).toEqual([CLAUDE_TIMEOUT_MS, CLAUDE_TIMEOUT_MS]);
    expect(JSON.parse(r.out).warning).toBeNull();
    expect(r.err).toBe("");
  });

  it("git の url が github.com の正のリポジトリ：0。harness がなければ null。--json なしは絶対パスだけ", async () => {
    const dir = await installed();
    const s = {
      plugins: [entry("pstack@cp", dir)],
      markets: [
        {
          name: "cp",
          source: "git",
          url: "https://github.com/cursor/plugins.git",
        },
      ],
    };
    const r = await pstack(s);
    expect(JSON.parse(r.out)).toMatchObject({
      harness: null,
      source: "github:cursor/plugins",
    });
    const plain = await pstack(s, [REL]);
    expect(plain.code).toBe(0);
    expect(plain.out).toBe(path.join(dir, REL));
  });

  it("別の入手元・フォルダ・一覧にない：2。ファイルの絶対パスを出さず、理由の1行を標準エラーに出す", async () => {
    const dir = await installed();
    for (const markets of [
      [gh("pstack", "evil/pstack")],
      [{ name: "pstack", source: "directory", path: dir }],
      [],
    ]) {
      const r = await pstack({
        plugins: [entry("pstack@pstack", dir)],
        markets,
      });
      expect(r.code).toBe(2);
      expect(r.out).not.toContain(dir);
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).not.toBe("");
    }
  });

  it("別の入手元のほうだけ enabled：2。正のほうだけ enabled：0", async () => {
    const dir = await installed();
    const markets = [gh("good", "cursor/plugins"), gh("bad", "evil/pstack")];
    const bad = await pstack({
      plugins: [entry("pstack@good", dir, false), entry("pstack@bad", dir)],
      markets,
    });
    expect(bad.code).toBe(2);
    const good = await pstack({
      plugins: [entry("pstack@good", dir), entry("pstack@bad", dir, false)],
      markets,
    });
    expect(good.code).toBe(0);
    expect(JSON.parse(good.out).warning).toBeNull();
    expect(good.err).toBe("");
  });

  it("正と別の入手元が両方 enabled：0 で正のほうを返し、warning と標準エラーに注意の1行", async () => {
    const good = await installed();
    const bad = await installed();
    const s = {
      plugins: [entry("pstack@bad", bad), entry("pstack@good", good)],
      markets: [gh("good", "cursor/plugins"), gh("bad", "evil/pstack")],
    };
    const r = await pstack(s);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.file).toBe(path.join(good, REL));
    expect(data.warning).toMatch(/^注意：.*pstack@bad/);
    expect(r.err.trim()).toBe(data.warning);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    const plain = await pstack(s, [REL]);
    expect(plain.code).toBe(0);
    expect(plain.out).toBe(path.join(good, REL));
    expect(plain.err).toMatch(/^注意：/);
  });

  it("正の候補の installPath が2つ違えば2、同じなら0", async () => {
    const a = await installed();
    const b = await installed();
    const markets = [gh("a", "cursor/plugins"), gh("b", "painhardcore/pstack")];
    expect(
      (
        await pstack({
          plugins: [entry("pstack@a", a), entry("pstack@b", b)],
          markets,
        })
      ).code,
    ).toBe(2);
    expect(
      (
        await pstack({
          plugins: [entry("pstack@a", a), entry("pstack@b", a)],
          markets,
        })
      ).code,
    ).toBe(0);
  });

  it("入っていない・claude がない(127)・失敗・打ち切り・JSON が読めない・ファイルがない：1 で場合ごとの理由を標準エラーに1行", async () => {
    const dir = await installed();
    const ok = {
      plugins: [entry("pstack@pstack", dir)],
      markets: [gh("pstack", "cursor/plugins")],
    };
    const cases: [string, Setup, string[], RegExp][] = [
      ["入っていない", { plugins: [], markets: [] }, [REL], /入っていません/],
      ["127(list)", { ...ok, codes: { list: 127 } }, [REL], /見つかりません/],
      [
        "127(market)",
        { ...ok, codes: { market: 127 } },
        [REL],
        /見つかりません/,
      ],
      ["失敗", { ...ok, codes: { market: 1 } }, [REL], /失敗しました：boom/],
      ["打ち切り", { ...ok, timedOut: true }, [REL], /時間内に終わりません/],
      [
        "list が壊れた JSON",
        { ...ok, pluginsRaw: "not json" },
        [REL],
        /読めません/,
      ],
      [
        "marketplace が壊れた JSON",
        { ...ok, marketsRaw: "{" },
        [REL],
        /marketplace.*読めません/,
      ],
      ["ファイルがない", ok, ["skills/none.md"], /ファイルがありません/],
    ];
    for (const [name, s, args, re] of cases) {
      const r = await pstack(s, args);
      expect(r.code, name).toBe(1);
      expect(r.err.trim().split("\n"), name).toHaveLength(1);
      expect(r.err, name).toMatch(re);
    }
  });

  it("相対パスが空・絶対・.. を含む・個数が違う：1 で claude を流さない", async () => {
    const dir = await installed();
    const s = {
      plugins: [entry("pstack@pstack", dir)],
      markets: [gh("pstack", "cursor/plugins")],
    };
    for (const args of [
      [""],
      ["/etc/passwd"],
      ["C:\\x\\y"],
      ["../x"],
      ["skills/../../x"],
      ["skills\\..\\x"],
      [],
      [REL, "other"],
    ]) {
      const r = await pstack(s, args);
      expect(r.code).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.err.trim()).not.toBe("");
      expect(r.err.trim().split("\n")).toHaveLength(1);
    }
  });

  it("シンボリックリンクで installPath の外に出るなら1", async () => {
    const dir = await installed();
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.md"), "s\n");
    await symlink(path.join(outside, "secret.md"), path.join(dir, "link.md"));
    const r = await pstack(
      {
        plugins: [entry("pstack@pstack", dir)],
        markets: [gh("pstack", "cursor/plugins")],
      },
      ["link.md"],
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/pstack の外に出る/);
  });

  it("入手元が違うとき、ファイルがなくても外に出るリンクでも、先に分かるのは入手元の2", async () => {
    const dir = await installed();
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.md"), "s\n");
    await symlink(path.join(outside, "secret.md"), path.join(dir, "link.md"));
    for (const rel of ["skills/none.md", "link.md"]) {
      const r = await pstack(
        {
          plugins: [entry("pstack@pstack", dir)],
          markets: [gh("pstack", "evil/x")],
        },
        [rel],
      );
      expect(r.code, rel).toBe(2);
      expect(r.err, rel).toMatch(/入手元/);
      expect(r.err, rel).not.toMatch(/ファイル|外に出る/);
    }
  });

  it("マーケットプレイスの項に ref がある：正のリポジトリでも2。理由に ref。ref がない・空なら0", async () => {
    const dir = await installed();
    for (const ref of ["master", "refs/pull/1/head"]) {
      const r = await pstack({
        plugins: [entry("pstack@pstack", dir)],
        markets: [{ ...gh("pstack", "painhardcore/pstack"), ref }],
      });
      expect(r.code, ref).toBe(2);
      expect(r.out, ref).not.toContain(dir);
      expect(r.err, ref).toContain("ref");
      expect(r.err.trim().split("\n"), ref).toHaveLength(1);
    }
    for (const extra of [{}, { ref: "" }]) {
      const r = await pstack({
        plugins: [entry("pstack@pstack", dir)],
        markets: [{ ...gh("pstack", "painhardcore/pstack"), ...extra }],
      });
      expect(r.code).toBe(0);
    }
  });

  it("harness が pstack の外を指すリンク：1 で、本体のファイルの場所を出さない。中を指すリンクは今までどおり返す", async () => {
    const s = (dir: string) => ({
      plugins: [entry("pstack@pstack", dir)],
      markets: [gh("pstack", "cursor/plugins")],
    });
    const outside = await tempDir();
    await writeFile(path.join(outside, "h.md"), "evil\n");
    const bad = await installed();
    await mkdir(path.join(bad, "docs/harness"), { recursive: true });
    await symlink(
      path.join(outside, "h.md"),
      path.join(bad, "docs/harness/claude-code.md"),
    );
    const r = await pstack(s(bad));
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(bad);
    expect(r.err).toMatch(/harness/);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    const plain = await pstack(s(bad), [REL]);
    expect(plain.code).toBe(1);
    expect(plain.out).toBe("");

    const good = await installed();
    await mkdir(path.join(good, "docs/harness"), { recursive: true });
    await writeFile(path.join(good, "docs/real.md"), "h\n");
    await symlink(
      path.join(good, "docs/real.md"),
      path.join(good, "docs/harness/claude-code.md"),
    );
    const ok = await pstack(s(good));
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out).harness).toBe(
      path.join(good, "docs/harness/claude-code.md"),
    );
  });

  it("2つの一覧のどちらかが配列でない JSON：1 で「配列」を理由に出し、「入っていません」と出さない", async () => {
    const dir = await installed();
    const okPlugins = [entry("pstack@pstack", dir)];
    const okMarkets = [gh("pstack", "cursor/plugins")];
    const cases: [string, Setup][] = [
      ["plugins がオブジェクト", { pluginsRaw: "{}", markets: okMarkets }],
      ["plugins が null", { pluginsRaw: "null", markets: okMarkets }],
      ["markets がオブジェクト", { plugins: okPlugins, marketsRaw: '{"a":1}' }],
      ["markets が文字列", { plugins: okPlugins, marketsRaw: '"x"' }],
    ];
    for (const [name, s] of cases) {
      const r = await pstack(s);
      expect(r.code, name).toBe(1);
      expect(r.err, name).toContain("配列");
      expect(r.err, name).not.toContain("入っていません");
      expect(r.err.trim().split("\n"), name).toHaveLength(1);
      expect(r.out, name).not.toContain(dir);
    }
  });
});
