import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { ASK_PERMISSIONS } from "../../src/lib/workspace-setup.ts";
import { ASK_PERMISSIONS as INIT_ASK } from "../../src/commands/init.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import {
  capture,
  git,
  makeRepo,
  tempDir,
  writeFiles,
} from "../init/helpers.ts";

interface Call {
  cmd: string;
  args: string[];
}
const done = (r: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...r,
});

interface Fake {
  /** claude plugin list --json の答え */
  list?: Partial<RunResult>;
  installCode?: number;
  /** pstack の install の終了コード */
  pstackInstallCode?: number;
  /** pstack の install の stderr */
  pstackInstallStderr?: string;
  /** 一覧に足す pstack のプラグイン（既定は正の入手元で有効）。list が配列のときだけ足す */
  pstack?: unknown[];
  /** マーケットプレイスの一覧の答え（既定は cursor-plugins が cursor/plugins） */
  markets?: Partial<RunResult>;
  /** pstack を install したあとの一覧（既定は正の入手元で有効） */
  after?: { pstack?: unknown[]; markets?: Partial<RunResult> };
  /** 子の config --json の答え（cwd のパスで） */
  child?: (cwd: string) => Partial<RunResult>;
}

const goodPstack = {
  id: "pstack@cursor-plugins",
  enabled: true,
  installPath: "/p",
};
const goodMarkets = [
  { name: "cursor-plugins", source: "github", repo: "cursor/plugins" },
];

/** git は本物。claude と node（子の CLI）は偽物。呼び出しを記録する */
function fake(f: Fake = {}) {
  const calls: Call[] = [];
  let pstackInstalled = false;
  const runner: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "claude") {
      if (args[1] === "list") {
        const base = f.list ?? {
          stdout: JSON.stringify([{ id: "orca-flow@x", enabled: true }]),
        };
        let parsed: unknown;
        try {
          parsed = JSON.parse(base.stdout ?? "");
        } catch {
          return done(base);
        }
        if (base.code || !Array.isArray(parsed)) return done(base);
        const ps = pstackInstalled
          ? (f.after?.pstack ?? [goodPstack])
          : (f.pstack ?? [goodPstack]);
        return done({ ...base, stdout: JSON.stringify([...parsed, ...ps]) });
      }
      if (args[1] === "marketplace") {
        const m = pstackInstalled ? (f.after?.markets ?? f.markets) : f.markets;
        return done(m ?? { stdout: JSON.stringify(goodMarkets) });
      }
      if (args[2] === "pstack") {
        pstackInstalled = true;
        return done({
          code: f.pstackInstallCode ?? 0,
          stderr: f.pstackInstallStderr ?? "",
        });
      }
      return done({ code: f.installCode ?? 0 });
    }
    if (cmd === process.execPath)
      return done(
        (f.child ?? (() => ({ stdout: '{"baseBranch":"main"}' })))(opts!.cwd!),
      );
    return realRunner(cmd, args, opts);
  };
  const count = (pred: (c: Call) => boolean) => calls.filter(pred).length;
  return {
    runner,
    calls,
    clones: () => count((c) => c.cmd === "git" && c.args[0] === "clone"),
    installs: () => count((c) => c.cmd === "claude" && c.args[1] === "install"),
    pstackInstalls: () =>
      count(
        (c) =>
          c.cmd === "claude" &&
          c.args[1] === "install" &&
          c.args[2] === "pstack",
      ),
    uninstallsOrEnables: () =>
      count(
        (c) =>
          c.cmd === "claude" &&
          (c.args[1] === "enable" || c.args[1] === "uninstall"),
      ),
  };
}

const repo = (name: string, p: string, role: "common" | "app", extra = {}) => ({
  name,
  path: p,
  role,
  keywords: [name],
  ...(role === "common"
    ? { scope: "s", package: "@d/c", bumpCommand: "pnpm up" }
    : {}),
  ...extra,
});

/** clone 元になる本物のリポジトリ2つと、空のワークスペースのフォルダ、渡す設定のファイル */
function scene(over: { urls?: boolean; paths?: string[] } = {}) {
  const srcCommon = makeRepo();
  const srcApp = makeRepo();
  const root = tempDir("orca-flow-setup-");
  const dir = path.join(root, "ws");
  const given = path.join(root, "given.json");
  const paths = over.paths ?? ["../core", "../app"];
  const config = {
    repos: [
      repo("core", paths[0]!, "common", { url: srcCommon }),
      repo("app", paths[1]!, "app", { url: srcApp }),
    ],
  };
  writeFiles(root, { "given.json": JSON.stringify(config) });
  writeFiles(dir, { ".keep": "" });
  return { root, dir, given, srcCommon, srcApp, config };
}

async function run(dir: string, argv: string[], f: ReturnType<typeof fake>) {
  const io = capture();
  const code = await main(["workspace", ...argv], {
    ...io,
    cwd: dir,
    runner: f.runner,
  });
  return { code, io, all: io.text() + io.errText() };
}

describe("workspace --setup", () => {
  it("--yes なしは計画を出すだけ：clone も install も写しもしない", async () => {
    const s = scene();
    const f = fake({ list: { stdout: "[]" } });
    const r = await run(s.dir, ["--setup", s.given], f);
    expect(r.code).toBe(0);
    expect(f.clones()).toBe(0);
    expect(f.installs()).toBe(0);
    expect(existsSync(path.join(s.root, "core"))).toBe(false);
    expect(existsSync(path.join(s.dir, "orca-flow-workspace.json"))).toBe(
      false,
    );
    expect(r.all).toContain("core");
    expect(r.all).toContain("--yes");
    expect(r.all).toContain("claude plugin install orca-flow");
  });

  it("--yes で、ない子を clone し、設定を写し、プラグインを入れる。init がまだなら2", async () => {
    const s = scene();
    const f = fake({
      list: { stdout: "[]" },
      child: () => ({ code: 2, stderr: "init がまだ" }),
    });
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(f.clones()).toBe(2);
    expect(existsSync(path.join(s.root, "core", ".git"))).toBe(true);
    expect(existsSync(path.join(s.root, "app", ".git"))).toBe(true);
    expect(
      readFileSync(path.join(s.dir, "orca-flow-workspace.json"), "utf8"),
    ).toBe(readFileSync(s.given, "utf8"));
    expect(f.installs()).toBe(1);
    const install = f.calls.find(
      (c) => c.args[1] === "install" && c.args[2] === "orca-flow",
    );
    expect(install?.args).toEqual([
      "plugin",
      "install",
      "orca-flow",
      "--marketplace",
      "kon-shou/orca-flow",
      "--scope",
      "user",
    ]);
    const clone = f.calls.find((c) => c.args[0] === "clone");
    expect(clone?.args.slice(0, 2)).toEqual(["clone", "--"]);
    expect(r.code).toBe(2);
    expect(r.all).toContain("/orca-flow:init");
    expect(r.all).toContain("/orca-flow:intake");
    expect(r.all).toContain("開き直");
  });

  it("--marketplace を渡せばその入手元で入れる", async () => {
    const s = scene();
    const f = fake({ list: { stdout: "[]" } });
    await run(
      s.dir,
      ["--setup", s.given, "--marketplace", "me/mine", "--yes"],
      f,
    );
    expect(
      f.calls.find((c) => c.args[1] === "install" && c.args[2] === "orca-flow")
        ?.args,
    ).toContain("me/mine");
  });

  it("2回目は clone も install も呼ばず、全部済んでいれば0", async () => {
    const s = scene();
    await run(s.dir, ["--setup", s.given, "--yes"], fake());
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(f.clones()).toBe(0);
    expect(f.installs()).toBe(0);
    expect(r.code).toBe(0);
  });

  it("ある子には触らず、ない子だけ clone する", async () => {
    const s = scene();
    const present = makeRepo();
    const config = {
      repos: [
        repo("core", present, "common"),
        repo("app", "../app", "app", { url: s.srcApp }),
      ],
    };
    writeFiles(s.root, { "given.json": JSON.stringify(config) });
    const headBefore = git(present, "rev-parse", "HEAD");
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(0);
    expect(f.clones()).toBe(1);
    expect(git(present, "rev-parse", "HEAD")).toBe(headBefore);
  });

  it("パスがなく url もない子は、1つも clone せず1", async () => {
    const s = scene();
    const config = {
      repos: [
        repo("core", "../core", "common", { url: s.srcCommon }),
        repo("app", "../app", "app"),
      ],
    };
    writeFiles(s.root, { "given.json": JSON.stringify(config) });
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.all).toContain("url");
    expect(f.clones()).toBe(0);
    expect(f.installs()).toBe(0);
  });

  it("まだない子のパスがワークスペースのフォルダの下なら、1で clone しない", async () => {
    const s = scene({ paths: ["core", "../app"] });
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.all).toContain("ワークスペースのフォルダと core が入れ子");
    expect(f.clones()).toBe(0);
    expect(existsSync(path.join(s.dir, "core"))).toBe(false);
  });

  it("まだない子どうしが入れ子なら、1で clone しない", async () => {
    const s = scene({ paths: ["../core", "../core/app"] });
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.all).toContain("core と app が入れ子");
    expect(f.clones()).toBe(0);
  });

  it("url が「-」始まりなら設定の誤りで1", async () => {
    const s = scene();
    const config = {
      repos: [
        repo("core", "../core", "common", { url: "--upload-pack=x" }),
        repo("app", "../app", "app", { url: s.srcApp }),
      ],
    };
    writeFiles(s.root, { "given.json": JSON.stringify(config) });
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(f.clones()).toBe(0);
  });

  it("中身の違う設定が今の場所にあれば1で、上書きしない", async () => {
    const s = scene();
    writeFiles(s.dir, { "orca-flow-workspace.json": '{"repos":[]}' });
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(f.clones()).toBe(0);
    expect(
      readFileSync(path.join(s.dir, "orca-flow-workspace.json"), "utf8"),
    ).toBe('{"repos":[]}');
  });

  it("clone が落ちると、その子の名前を出して1。後ろの子は clone しない", async () => {
    const s = scene();
    const config = {
      repos: [
        repo("core", "../core", "common", {
          url: path.join(s.root, "no-such-origin"),
        }),
        repo("app", "../app", "app", { url: s.srcApp }),
      ],
    };
    writeFiles(s.root, { "given.json": JSON.stringify(config) });
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.all).toContain("core");
    expect(f.clones()).toBe(1);
    expect(existsSync(path.join(s.root, "app"))).toBe(false);
  });

  it("入っていて有効なら install を呼ばない", async () => {
    const s = scene();
    const f = fake();
    await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(f.installs()).toBe(0);
  });

  it("claude が見つからないと2で、案内が出る", async () => {
    const s = scene();
    const f = fake({ list: { code: 127 } });
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(2);
    expect(f.installs()).toBe(0);
    expect(r.all).toContain("claude が見つかりません");
  });

  it("プラグインが無効なら有効にせず2で、claude plugin enable を案内する", async () => {
    const s = scene();
    const f = fake({
      list: { stdout: JSON.stringify([{ id: "orca-flow@x", enabled: false }]) },
    });
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(2);
    expect(f.installs()).toBe(0);
    expect(f.calls.some((c) => c.args[1] === "enable")).toBe(false);
    expect(r.all).toContain("claude plugin enable orca-flow@x");
  });

  it("install が失敗すると1", async () => {
    const s = scene();
    const f = fake({ list: { stdout: "[]" }, installCode: 1 });
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.all).toContain("claude plugin install に失敗");
    expect(f.installs()).toBe(1);
  });

  it("設定のファイルを渡さず、今の場所にもなければ1", async () => {
    const s = scene();
    const r = await run(s.dir, ["--setup"], fake());
    expect(r.code).toBe(1);
    expect(r.all).toContain("orca-flow-workspace.json がありません");
  });

  it("知らない引数は1", async () => {
    const s = scene();
    const r = await run(s.dir, ["--setup", "--nope"], fake());
    expect(r.code).toBe(1);
    expect(r.all).toContain("知らない引数です：--nope");
  });

  it("設定のファイルを渡さず、今の場所の設定で流せる（2回目以降）。clone せず設定も変わらない", async () => {
    const s = scene();
    await run(s.dir, ["--setup", s.given, "--yes"], fake());
    const file = path.join(s.dir, "orca-flow-workspace.json");
    const before = readFileSync(file, "utf8");
    const f = fake();
    const r = await run(s.dir, ["--setup", "--yes"], f);
    expect(r.code).toBe(0);
    expect(f.clones()).toBe(0);
    expect(f.installs()).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("行き先のない symlink の設定があれば1で、リンクの先に何も書かない", async () => {
    const s = scene();
    const outside = path.join(s.root, "outside.json");
    symlinkSync(outside, path.join(s.dir, "orca-flow-workspace.json"));
    const f = fake();
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(existsSync(outside)).toBe(false);
    expect(f.clones()).toBe(0);
  });

  it("確かめたあと写すまでの間に違う設定が置かれても、上書きせず1", async () => {
    const s = scene();
    const file = path.join(s.dir, "orca-flow-workspace.json");
    const inner = fake({ list: { stdout: "[]" } });
    const f = {
      ...inner,
      runner: (async (cmd, args, opts) => {
        if (cmd === "claude" && args[1] === "list")
          writeFileSync(file, '{"repos":[]}');
        return inner.runner(cmd, args, opts);
      }) as Runner,
    };
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe('{"repos":[]}');
    expect(inner.clones()).toBe(0);
    expect(inner.installs()).toBe(0);
  });

  describe("--json の plugin の形", () => {
    const plugin = async (list: Partial<RunResult>, extra: string[]) => {
      const s = scene();
      const f = fake({ list });
      const r = await run(s.dir, ["--setup", s.given, "--json", ...extra], f);
      return (JSON.parse(r.io.text()) as { plugin: unknown }).plugin;
    };

    it("計画で、なければ kind と installed:false の2つだけ", async () => {
      expect(await plugin({ stdout: "[]" }, [])).toEqual({
        kind: "missing",
        installed: false,
      });
    });

    it("計画で、有効なら kind・id・installed:false", async () => {
      expect(
        await plugin(
          { stdout: JSON.stringify([{ id: "orca-flow@x", enabled: true }]) },
          [],
        ),
      ).toEqual({ kind: "enabled", id: "orca-flow@x", installed: false });
    });

    it("計画で、状態が読めなければ kind:unknown・reason・installed:false", async () => {
      const p = (await plugin({ stdout: "not json" }, [])) as Record<
        string,
        unknown
      >;
      expect(Object.keys(p).sort()).toEqual(["installed", "kind", "reason"]);
      expect(p.kind).toBe("unknown");
      expect(p.installed).toBe(false);
      expect(typeof p.reason).toBe("string");
    });

    it("--yes で入れたら kind:enabled・id:orca-flow・installed:true", async () => {
      expect(await plugin({ stdout: "[]" }, ["--yes"])).toEqual({
        kind: "enabled",
        id: "orca-flow",
        installed: true,
      });
    });
  });

  describe("pstack", () => {
    const pl = (id: string, enabled = true, installPath = "/p") => ({
      id,
      enabled,
      installPath,
    });
    const badMarkets = [
      { name: "cursor-plugins", source: "github", repo: "evil/plugins" },
    ];
    const mk = (m: unknown[]) => ({ stdout: JSON.stringify(m) });
    const jsonPstack = async (
      f: ReturnType<typeof fake>,
      extra: string[] = [],
    ) => {
      const s = scene();
      const r = await run(s.dir, ["--setup", s.given, "--json", ...extra], f);
      return {
        r,
        pstack: (JSON.parse(r.io.text()) as { pstack: Record<string, unknown> })
          .pstack,
      };
    };

    it("計画で、ない・有効・無効・正でない・読めないのそれぞれに状態の行が出て、install を呼ばず0", async () => {
      const cases: [Fake, string][] = [
        [{ pstack: [] }, "intake の /how"],
        [{}, "pstack@cursor-plugins は入っていて有効"],
        [
          { pstack: [pl("pstack@cursor-plugins", false)] },
          "claude plugin enable pstack@cursor-plugins",
        ],
        [
          {
            pstack: [pl("pstack@evil")],
            markets: mk([{ name: "evil", source: "github", repo: "evil/p" }]),
          },
          "入手元が正でない",
        ],
        [{ markets: { stdout: "not json" } }, "状態を読めない"],
      ];
      for (const [over, text] of cases) {
        const s = scene();
        const f = fake({ list: { stdout: "[]" }, ...over });
        const r = await run(s.dir, ["--setup", s.given], f);
        expect(r.code, text).toBe(0);
        expect(f.installs(), text).toBe(0);
        expect(r.all, text).toContain("pstack：");
        expect(r.all, text).toContain(text);
      }
    });

    it("--yes で pstack がないとき、orca-flow のあとに pstack の install が決まった引数で1回流れる", async () => {
      const s = scene();
      const f = fake({ list: { stdout: "[]" }, pstack: [] });
      await run(s.dir, ["--setup", s.given, "--yes"], f);
      const installs = f.calls.filter((c) => c.args[1] === "install");
      expect(installs.map((c) => c.args[2])).toEqual(["orca-flow", "pstack"]);
      expect(f.pstackInstalls()).toBe(1);
      expect(installs[1]?.args).toEqual([
        "plugin",
        "install",
        "pstack",
        "--marketplace",
        "cursor/plugins",
        "--scope",
        "user",
      ]);
      expect(f.uninstallsOrEnables()).toBe(0);
    });

    it("--marketplace を渡しても、pstack の入手元は cursor/plugins のまま", async () => {
      const s = scene();
      const f = fake({ pstack: [] });
      await run(
        s.dir,
        ["--setup", s.given, "--marketplace", "me/mine", "--yes"],
        f,
      );
      const p = f.calls.find(
        (c) => c.args[2] === "pstack" && c.args[1] === "install",
      );
      expect(p?.args).toContain("cursor/plugins");
      expect(p?.args).not.toContain("me/mine");
    });

    it("入れたあとの読み直しで正の有効な pstack が見えれば installed:true・enabled で、済んでいれば0", async () => {
      const s = scene();
      await run(s.dir, ["--setup", s.given, "--yes"], fake()); // clone と設定の写しを先に済ませる
      const f = fake({ pstack: [] });
      const r = await run(s.dir, ["--setup", s.given, "--yes", "--json"], f);
      expect(r.code).toBe(0);
      expect((JSON.parse(r.io.text()) as { pstack: unknown }).pstack).toEqual({
        kind: "enabled",
        id: "pstack@cursor-plugins",
        installed: true,
      });
      const r2 = await run(
        s.dir,
        ["--setup", s.given, "--yes"],
        fake({ pstack: [] }),
      );
      expect(r2.all).toContain("開き直");
    });

    it("入れたあとの読み直しで正でない入手元に見えれば installed:false・untrusted で2", async () => {
      const f = () =>
        fake({
          pstack: [],
          after: {
            pstack: [pl("pstack@cursor-plugins")],
            markets: mk(badMarkets),
          },
        });
      const j = await jsonPstack(f(), ["--yes"]);
      expect(j.pstack.kind).toBe("untrusted");
      expect(j.pstack.installed).toBe(false);
      expect(j.r.code).toBe(2);
    });

    it("pstack の install が落ちると1で理由が出る。orca-flow の install が落ちたら pstack は呼ばない", async () => {
      const s = scene();
      const f = fake({ pstack: [], pstackInstallCode: 1 });
      const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
      expect(r.code).toBe(1);
      expect(r.all).toContain("claude plugin install pstack に失敗");
      const s2 = scene();
      const g = fake({ list: { stdout: "[]" }, pstack: [], installCode: 1 });
      const r2 = await run(s2.dir, ["--setup", s2.given, "--yes"], g);
      expect(r2.code).toBe(1);
      expect(g.pstackInstalls()).toBe(0);
    });

    const nextOf = async (f: ReturnType<typeof fake>, extra: string[] = []) => {
      const s = scene();
      const r = await run(
        s.dir,
        ["--setup", s.given, "--json", "--yes", ...extra],
        f,
      );
      return {
        r,
        next: (JSON.parse(r.io.text()) as { next: string[] }).next,
      };
    };
    const twoGood = [
      ...goodMarkets,
      { name: "ph", source: "github", repo: "painhardcore/pstack" },
    ];

    it("両方を入れたとき、開き直しは1行で orca-flow と pstack の両方の名前がある", async () => {
      const { next } = await nextOf(
        fake({ list: { stdout: "[]" }, pstack: [] }),
      );
      const lines = next.filter((n) => n.includes("開き直"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("orca-flow");
      expect(lines[0]).toContain("pstack");
    });

    it("install のあと読み直しで pstack が見えなければ unknown・installed:false・2", async () => {
      const j = await jsonPstack(fake({ pstack: [], after: { pstack: [] } }), [
        "--yes",
      ]);
      expect(j.pstack.kind).toBe("unknown");
      expect(j.pstack.installed).toBe(false);
      expect(j.pstack.reason).toContain("見えません");
      expect(j.r.code).toBe(2);
    });

    it("pstack の install が落ちたとき、stderr の理由が出る。orca-flow を入れた後なら開き直しと流し直しの案内がある", async () => {
      const s = scene();
      const f = fake({
        list: { stdout: "[]" },
        pstack: [],
        pstackInstallCode: 1,
        pstackInstallStderr: "network down",
      });
      const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
      expect(r.code).toBe(1);
      expect(r.all).toContain("network down");
      expect(r.all).toContain(
        "orca-flow は入れました。Claude Code を開き直してください",
      );
      expect(r.all).toContain("workspace --setup --yes");
      // orca-flow を入れていないときは開き直しを言わない
      const s2 = scene();
      const g = fake({ pstack: [], pstackInstallCode: 1 });
      const r2 = await run(s2.dir, ["--setup", s2.given, "--yes"], g);
      expect(r2.code).toBe(1);
      expect(r2.all).not.toContain("開き直");
      expect(r2.all).toContain("workspace --setup --yes");
    });

    it("次の手順：正でないとき、流し直しの案内と正の入手元と外し方が出る", async () => {
      const { next, r } = await nextOf(
        fake({
          pstack: [pl("pstack@evil")],
          markets: mk([{ name: "evil", source: "github", repo: "evil/p" }]),
        }),
      );
      const n = next.find((x) => x.includes("入れ直しません"))!;
      expect(n).toContain("claude plugin uninstall pstack@evil");
      expect(n).not.toContain("marketplace remove");
      expect(n).toContain("workspace --setup --yes を流してください");
      expect(n).toContain("cursor/plugins・painhardcore/pstack");
      // 添える正の入手元は、理由の文（「正の入手元（…）」）と別の綴りで確かめる
      expect(n).toContain(
        "（正の入手元：cursor/plugins・painhardcore/pstack）",
      );
      // 次の手順の中にも理由が入る
      const j = JSON.parse(r.io.text()) as { pstack: { reason: string } };
      expect(n).toContain(`入れ直しません：${j.pstack.reason}`);
    });

    it("次の手順：正でないものが2つあれば、外し方を両方案内する", async () => {
      const { next } = await nextOf(
        fake({
          pstack: [pl("pstack@a", true, "/a"), pl("pstack@b", true, "/b")],
          markets: mk([
            { name: "a", source: "github", repo: "x/a" },
            { name: "b", source: "github", repo: "x/b" },
          ]),
        }),
      );
      const n = next.find((x) => x.includes("入れ直しません"))!;
      expect(n).toContain("claude plugin uninstall pstack@a");
      expect(n).toContain("claude plugin uninstall pstack@b");
    });

    it("次の手順：ref つきの cursor-plugins は、uninstall と marketplace remove の両方を案内し、自分では流さない", async () => {
      const f = fake({
        pstack: [pl("pstack@cursor-plugins")],
        markets: mk([{ ...goodMarkets[0], ref: "dev" }]),
      });
      const { next, r } = await nextOf(f);
      const n = next.find((x) => x.includes("入れ直しません"))!;
      expect(n).toContain("claude plugin uninstall pstack@cursor-plugins");
      expect(n).toContain("claude plugin marketplace remove cursor-plugins");
      // ref つきの理由には正の入手元が入らないので、添える文をここで確かめる
      expect(n).toContain(
        "（正の入手元：cursor/plugins・painhardcore/pstack）",
      );
      expect(r.code).toBe(2);
      expect(
        f.calls.some(
          (c) => c.args[1] === "marketplace" && c.args[2] === "remove",
        ),
      ).toBe(false);
    });

    it("次の手順：名前がぶつかるだけなら、marketplace remove の案内が出る", async () => {
      const { next } = await nextOf(
        fake({ pstack: [], markets: mk(badMarkets) }),
      );
      const n = next.find((x) => x.includes("入れ直しません"))!;
      expect(n).toContain("claude plugin marketplace remove cursor-plugins");
      expect(n).not.toContain("uninstall");
      expect(n).toContain("workspace --setup --yes を流してください");
      expect(n).toContain("painhardcore/pstack");
    });

    it("次の手順：読めないときは理由が出る", async () => {
      const { next } = await nextOf(
        fake({ markets: { code: 1, stderr: "boom" } }),
      );
      const n = next.find((x) =>
        x.startsWith("pstack の状態を読めませんでした"),
      )!;
      expect(n).toContain("boom");
    });

    it("正の pstack が installPath 違いで2つ有効なら unknown で2。外し方は「正でない」と案内せず、次の手順に uninstall の案内", async () => {
      const f = fake({
        pstack: [
          pl("pstack@cursor-plugins", true, "/a"),
          pl("pstack@ph", true, "/b"),
        ],
        markets: mk(twoGood),
      });
      const { next, r } = await nextOf(f);
      const j = JSON.parse(r.io.text()) as { pstack: Record<string, unknown> };
      expect(j.pstack.kind).toBe("unknown");
      expect(Object.keys(j.pstack).sort()).toEqual([
        "installed",
        "kind",
        "reason",
      ]);
      expect(r.code).toBe(2);
      const n = next.find((x) =>
        x.startsWith("pstack の状態を読めませんでした"),
      )!;
      expect(n).toContain("uninstall");
      expect(next.some((x) => x.includes("入手元が正でないため"))).toBe(false);
      expect(f.installs()).toBe(0);
    });

    it("正の pstack が有効で installPath がなければ unknown で2。正でない扱いにしない", async () => {
      const f = fake({
        pstack: [{ id: "pstack@cursor-plugins", enabled: true }],
      });
      const { next, r } = await nextOf(f);
      const j = JSON.parse(r.io.text()) as { pstack: Record<string, unknown> };
      expect(j.pstack.kind).toBe("unknown");
      expect(r.code).toBe(2);
      expect(next.some((x) => x.includes("入手元が正でないため"))).toBe(false);
    });

    it("無効な正の pstack は有効にせず、案内が出て2", async () => {
      const s = scene();
      const f = fake({ pstack: [pl("pstack@cursor-plugins", false)] });
      const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
      expect(r.code).toBe(2);
      expect(f.installs()).toBe(0);
      expect(f.uninstallsOrEnables()).toBe(0);
      expect(r.all).toContain("claude plugin enable pstack@cursor-plugins");
    });

    it.each([true, false])(
      "正でない入手元の pstack だけがある（有効=%s）とき、install も uninstall も呼ばず、理由と外し方が出て2",
      async (enabled) => {
        const s = scene();
        const f = fake({
          pstack: [pl("pstack@evil", enabled)],
          markets: mk([{ name: "evil", source: "github", repo: "evil/p" }]),
        });
        const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
        expect(r.code).toBe(2);
        expect(f.installs()).toBe(0);
        expect(f.uninstallsOrEnables()).toBe(0);
        expect(r.all).toContain("入れ直しません");
        expect(r.all).toContain("claude plugin uninstall pstack@evil");
        expect(r.all).toContain("cursor/plugins");
        expect(r.all).toContain("painhardcore/pstack");
      },
    );

    it("cursor-plugins の名前で別の入手元の項があれば、pstack がなくても install を呼ばず2", async () => {
      const s = scene();
      const f = fake({ pstack: [], markets: mk(badMarkets) });
      const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
      expect(r.code).toBe(2);
      expect(f.pstackInstalls()).toBe(0);
      expect(r.all).toContain("cursor-plugins");
    });

    it("正と別の入手元の pstack が両方有効なら、有効として扱い、注意の1行が出る", async () => {
      const s = scene();
      const f = fake({
        pstack: [pl("pstack@cursor-plugins"), pl("pstack@evil", true, "/e")],
        markets: mk([
          ...goodMarkets,
          { name: "evil", source: "github", repo: "evil/p" },
        ]),
      });
      const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
      expect(r.code).toBe(0);
      expect(r.io.errText()).toContain("注意：");
      expect(r.all).toContain("pstack@evil");
    });

    it("マーケットプレイスの一覧が読めないと unknown で2、claude がないと no-claude", async () => {
      const j = await jsonPstack(
        fake({ markets: { code: 1, stderr: "boom" } }),
        ["--yes"],
      );
      expect(j.pstack.kind).toBe("unknown");
      expect(j.r.code).toBe(2);
      const n = await jsonPstack(fake({ list: { code: 127 } }));
      expect(n.pstack.kind).toBe("no-claude");
    });

    it("--json の pstack が状態ごとに決まったキーだけを持つ", async () => {
      const keys = async (f: ReturnType<typeof fake>, extra: string[] = []) =>
        Object.keys((await jsonPstack(f, extra)).pstack).sort();
      expect(await keys(fake({ pstack: [] }))).toEqual(["installed", "kind"]);
      expect(await keys(fake())).toEqual(["id", "installed", "kind"]);
      expect(
        await keys(fake({ pstack: [pl("pstack@cursor-plugins", false)] })),
      ).toEqual(["id", "installed", "kind"]);
      expect(await keys(fake({ pstack: [], markets: mk(badMarkets) }))).toEqual(
        ["installed", "kind", "reason"],
      );
      expect(await keys(fake({ markets: { stdout: "x" } }))).toEqual([
        "installed",
        "kind",
        "reason",
      ]);
      expect(await keys(fake({ list: { code: 127 } }))).toEqual([
        "installed",
        "kind",
      ]);
      expect((await jsonPstack(fake())).pstack.installed).toBe(false);
    });
  });
});

describe("workspace --setup の settings の ask の案内", () => {
  const askLines = (lines: string[]) =>
    lines.filter((l) => l.includes("permissions.ask"));

  async function nextOf(childCode: number) {
    const s = scene();
    const f = fake({
      list: { stdout: "[]" },
      child: () =>
        childCode === 0
          ? { stdout: '{"baseBranch":"main"}' }
          : { code: 2, stderr: "init がまだ" },
    });
    const r = await run(s.dir, ["--setup", s.given, "--yes", "--json"], f);
    const next = (JSON.parse(r.io.text()) as { next: string[] }).next;
    return { s, f, r, next };
  }

  it("init と同じ3つの値を使う", () => {
    expect(ASK_PERMISSIONS).toEqual(INIT_ASK);
    expect(ASK_PERMISSIONS).toHaveLength(3);
  });

  for (const [label, code] of [
    ["init がまだの子があるとき", 2],
    ["全部済んだとき", 0],
  ] as const) {
    it(`${label}も next にちょうど1行出て、intake の行より前にある`, async () => {
      const { next } = await nextOf(code);
      const ask = askLines(next);
      expect(ask).toHaveLength(1);
      for (const v of ASK_PERMISSIONS) expect(ask[0]).toContain(v);
      expect(ask[0]).toContain(".claude/settings.json");
      expect(ask[0]).toContain("自分では書き換え");
      expect(ask[0]).toContain("読まれません");
      const intake = next.findIndex((l) => l.includes("/orca-flow:intake"));
      expect(next.indexOf(ask[0]!)).toBeLessThan(intake);
    });
  }

  it("文の出力にもちょうど1行出る。終了コードは変わらない", async () => {
    const s = scene();
    const f = fake({
      list: { stdout: "[]" },
      child: () => ({ code: 2, stderr: "init がまだ" }),
    });
    const r = await run(s.dir, ["--setup", s.given, "--yes"], f);
    expect(r.code).toBe(2);
    expect(askLines(r.io.text().split("\n"))).toHaveLength(1);
  });

  it("ワークスペースのフォルダにもホームにも settings.json を書かない", async () => {
    const home = tempDir("orca-flow-home-");
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const { s } = await nextOf(0);
      expect(existsSync(path.join(s.dir, ".claude", "settings.json"))).toBe(
        false,
      );
      expect(existsSync(path.join(home, ".claude", "settings.json"))).toBe(
        false,
      );
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });
});
