import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORCA_FLOW_MAIN } from "../../src/lib/background.ts";
import { FlowError } from "../../src/types.ts";
import {
  cleanPath,
  findWatchAutomation,
  judgeWatchStuck,
  stuckMessage,
  type WatchEnv,
  installWatchAutomation,
  removeWatchAutomation,
  watchCron,
  watchPrecheck,
} from "../../src/lib/watch-automation.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";

const ROOT = "/work/repo";
const OPTS = { root: ROOT, intervalMinutes: 5 };

describe("watch-automation", () => {
  beforeEach(() => {
    vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.stubEnv("PATH", "/usr/bin");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ない・ある・分からないを分ける", async () => {
    const orca = fakeOrca();
    expect(await findWatchAutomation(orca.runner, ROOT)).toEqual({
      state: "missing",
    });
    await installWatchAutomation(orca.runner, OPTS);
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe("found");
    orca.automationsListFails = true;
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe(
      "unknown",
    );
    orca.automationsListFails = false;
    orca.unavailable = true;
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe(
      "unknown",
    );
  });

  it("install は precheck と5分おきの cron を渡し、--workspace・--reuse-session を渡さない", async () => {
    const orca = fakeOrca();
    const r = await installWatchAutomation(orca.runner, OPTS);
    expect(r.action).toBe("created");
    const call = orca.callsOf("automations", "create")[0]!;
    expect(call).toContain("--precheck");
    expect(call[call.indexOf("--trigger") + 1]).toBe("*/5 * * * *");
    expect(call).not.toContain("--workspace");
    expect(call).not.toContain("--reuse-session");
    expect(call[call.indexOf("--repo") + 1]).toBe(`path:${ROOT}`);
    expect(call[call.indexOf("--precheck") + 1]).toBe(watchPrecheck(ROOT));
  });

  it("precheck は PATH の orca-flow に頼らず、node と main.ts の絶対パスと --root で呼ぶ", () => {
    const text = watchPrecheck(ROOT, "linux");
    expect(text).toContain(`'${process.execPath}'`);
    expect(text).toContain(`'${ORCA_FLOW_MAIN}'`);
    expect(text).toContain(`'pr-watch' '--root' '${ROOT}'`);
    expect(text).not.toMatch(/(^|\s)'?orca-flow'?\s/);
    expect(text).not.toContain("--workspace");
  });

  it("2回目の install は2つ目を作らず、今の中身に直す", async () => {
    const orca = fakeOrca();
    await installWatchAutomation(orca.runner, OPTS);
    orca.automations[0]!.precheck = "古い precheck";
    const r = await installWatchAutomation(orca.runner, {
      root: ROOT,
      intervalMinutes: 10,
    });
    expect(r.action).toBe("updated");
    expect(orca.automations).toHaveLength(1);
    expect(orca.callsOf("automations", "create")).toHaveLength(1);
    expect(orca.automations[0]!.trigger).toBe("*/10 * * * *");
    expect(orca.automations[0]!.precheck).toBe(watchPrecheck(ROOT));
    const edit = orca.callsOf("automations", "edit")[0]!;
    expect(edit[edit.indexOf("--precheck") + 1]).toBe(watchPrecheck(ROOT));
  });

  it("一覧が automations の形でも items の形でも読める", async () => {
    for (const key of ["automations", "items"]) {
      const orca = fakeOrca();
      await installWatchAutomation(orca.runner, OPTS);
      const inner = orca.runner;
      const runner: typeof inner = async (cmd, args, opts) => {
        const r = await inner(cmd, args, opts);
        if (args[0] !== "automations" || args[1] !== "list") return r;
        const result = JSON.parse(r.stdout).result;
        return {
          ...r,
          stdout: JSON.stringify({ result: { [key]: result.automations } }),
        };
      };
      expect((await findWatchAutomation(runner, ROOT)).state, key).toBe(
        "found",
      );
    }
  });

  it("分からないときの install は作らずに失敗する", async () => {
    const orca = fakeOrca();
    orca.automationsListFails = true;
    await expect(installWatchAutomation(orca.runner, OPTS)).rejects.toThrow(
      /確かめられません/,
    );
    expect(orca.callsOf("automations", "create")).toHaveLength(0);
  });

  it("remove は消す。なければ何もしない", async () => {
    const orca = fakeOrca();
    expect(await removeWatchAutomation(orca.runner, ROOT)).toEqual({
      id: null,
    });
    await installWatchAutomation(orca.runner, OPTS);
    const r = await removeWatchAutomation(orca.runner, ROOT);
    expect(r.id).not.toBeNull();
    expect(orca.automations).toHaveLength(0);
  });

  it("別のリポジトリの automation は見つけない", async () => {
    const orca = fakeOrca();
    await installWatchAutomation(orca.runner, {
      root: "/work/other",
      intervalMinutes: 5,
    });
    expect((await findWatchAutomation(orca.runner, ROOT)).state).toBe(
      "missing",
    );
  });

  it("cron は間隔に合わせる", () => {
    expect(watchCron(5)).toBe("*/5 * * * *");
    expect(watchCron(120)).toBe("0 */2 * * *");
    expect(watchCron(2000)).toBe("0 0 * * *");
  });

  describe("precheck の形", () => {
    const wsl: WatchEnv = {
      platform: "linux",
      distro: "Ubuntu-24.04",
      path: "/home/u/.local/bin:/usr/bin",
    };
    const odd = "/work/my repo's (x) & y";

    it('WSL の中は wsl.exe で始まり、-e のあとの語が順に " で囲まれる', () => {
      const text = watchPrecheck(ROOT, wsl);
      expect(text.startsWith("wsl.exe -d Ubuntu-24.04 --cd ~ -e ")).toBe(true);
      const tail = text.slice("wsl.exe -d Ubuntu-24.04 --cd ~ -e ".length);
      expect(tail).toBe(
        [
          "/usr/bin/env",
          "PATH=/home/u/.local/bin:/usr/bin",
          process.execPath,
          "--disable-warning=ExperimentalWarning",
          ORCA_FLOW_MAIN,
          "pr-watch",
          "--root",
          ROOT,
        ]
          .map((w) => `"${w}"`)
          .join(" "),
      );
    });

    it("空白・'・かっこ・& を含むパスを、3つの形でそれぞれの囲みで渡す", () => {
      expect(watchPrecheck(odd, wsl)).toMatch(
        / "--root" "\/work\/my repo's \(x\) & y"$/,
      );
      expect(watchPrecheck(odd, { platform: "linux" })).toContain(
        `'--root' '/work/my repo'\\''s (x) & y'`,
      );
      expect(watchPrecheck(odd, { platform: "darwin" })).toContain(
        `'--root' '/work/my repo'\\''s (x) & y'`,
      );
      expect(watchPrecheck("C:\\my repo", { platform: "win32" })).toContain(
        `"--root" "C:\\my repo"`,
      );
    });

    it("WSL でない形は今の文と1文字も変わらない", () => {
      const quoted = (q: string) =>
        [
          process.execPath,
          "--disable-warning=ExperimentalWarning",
          ORCA_FLOW_MAIN,
          "pr-watch",
          "--root",
          ROOT,
        ]
          .map((w) => `${q}${w}${q}`)
          .join(" ");
      for (const env of [
        { platform: "linux" as const, distro: "" },
        { platform: "linux" as const },
        { platform: "darwin" as const, distro: "Ubuntu" },
      ])
        expect(watchPrecheck(ROOT, env)).toBe(quoted("'"));
      expect(watchPrecheck(ROOT, { platform: "win32", distro: "Ubuntu" })).toBe(
        quoted('"'),
      );
    });

    it("CMD で渡せないものがあるときは断る", () => {
      const bad = ['a"b', "a%b", "a\\b", "a\nb"];
      for (const root of bad)
        expect(() => watchPrecheck(root, wsl), root).toThrow(FlowError);
      for (const distro of ["Ubuntu 24", "a;b", "", 'a"b'])
        if (distro !== "")
          expect(() => watchPrecheck(ROOT, { ...wsl, distro })).toThrow(
            FlowError,
          );
      const long = "/" + "a".repeat(8000);
      expect(() => watchPrecheck(long, wsl)).toThrow(/長すぎます/);
    });

    it("断る形の install は automation を作らず終了コード1", async () => {
      const orca = fakeOrca();
      const err = await installWatchAutomation(orca.runner, {
        root: 'a"b',
        intervalMinutes: 5,
        env: wsl,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).code).toBe(1);
      expect(orca.calls).toEqual([]);
      expect(orca.automations).toHaveLength(0);
    });

    it("PATH は同じ場所を1つにまとめ、CMD で渡せない場所を落とし、順を変えない", () => {
      expect(cleanPath('/b:/a:/b:/c%d:/e\\f:/q"r::/a:/z')).toBe("/b:/a:/z");
      expect(cleanPath(undefined)).toBe("");
      const text = watchPrecheck(ROOT, { ...wsl, path: "/x:/bad%:/x:/y" });
      expect(text).toContain('"PATH=/x:/y"');
    });
  });

  describe("落ち続けの判定", () => {
    const ran = "2026-11-05T10:00:00.000Z";
    const base = {
      enabled: true,
      lastRunAt: ran,
      precheck: "same",
      lastRoundAt: null as string | null,
      intervalMinutes: 5,
      expectedPrecheck: "same",
    };
    const minutesBefore = (m: number) =>
      new Date(Date.parse(ran) - m * 60_000).toISOString();

    it("回の記録がないと落ち続けている", () => {
      expect(judgeWatchStuck(base)).toEqual({
        orcaRanAt: ran,
        lastRoundAt: null,
        outdated: false,
      });
    });

    it("差が最低の10分を超えると落ち続け、超えなければ落ちていない", () => {
      expect(
        judgeWatchStuck({ ...base, lastRoundAt: minutesBefore(11) }),
      ).not.toBeNull();
      expect(
        judgeWatchStuck({ ...base, lastRoundAt: minutesBefore(10) }),
      ).toBeNull();
      expect(
        judgeWatchStuck({ ...base, lastRoundAt: minutesBefore(5) }),
      ).toBeNull();
    });

    it("間隔の2回分が10分より長ければそちらを使う", () => {
      const b = { ...base, intervalMinutes: 30 };
      expect(
        judgeWatchStuck({ ...b, lastRoundAt: minutesBefore(59) }),
      ).toBeNull();
      expect(
        judgeWatchStuck({ ...b, lastRoundAt: minutesBefore(61) }),
      ).not.toBeNull();
    });

    it("間隔が短くても最低は10分", () => {
      const b = { ...base, intervalMinutes: 1 };
      expect(
        judgeWatchStuck({ ...b, lastRoundAt: minutesBefore(9) }),
      ).toBeNull();
    });

    it("無効の automation と lastRunAt がない automation は判定しない", () => {
      expect(judgeWatchStuck({ ...base, enabled: false })).toBeNull();
      expect(judgeWatchStuck({ ...base, lastRunAt: undefined })).toBeNull();
    });

    it("precheck が今の形と違うと outdated で、文の直し方が変わる", () => {
      const stuck = judgeWatchStuck({ ...base, precheck: "old" })!;
      expect(stuck.outdated).toBe(true);
      expect(stuckMessage("id-1", stuck)).toContain(
        "orca-flow pr-watch install を打ち直すと、今の形に直ります（あれば今の中身に直すだけです）",
      );
      const same = judgeWatchStuck(base)!;
      const text = stuckMessage("id-1", same);
      expect(text).toContain(
        "見張りの automation が落ち続けています（Orca は " +
          ran +
          " に流しましたが、pr-watch の回の記録がありません）。",
      );
      expect(text).toContain(
        "precheck の出力を orca automations runs --id id-1 --json で読んでください",
      );
      const stopped = judgeWatchStuck({
        ...base,
        lastRoundAt: minutesBefore(30),
      })!;
      expect(stuckMessage("id-1", stopped)).toContain(
        `pr-watch の回の記録が${minutesBefore(30)} で止まっています）。`,
      );
    });
    it("PATH だけ違う WSL の形の precheck は outdated にならず、出力を読む直し方が出る", () => {
      const env = (path: string): WatchEnv => ({
        platform: "linux",
        distro: "Ubuntu-24.04",
        path,
      });
      const installed = watchPrecheck(ROOT, env("/home/a/bin:/usr/bin"));
      const expected = watchPrecheck(ROOT, env("/opt/x:/usr/local/bin"));
      const stuck = judgeWatchStuck({
        ...base,
        precheck: installed,
        expectedPrecheck: expected,
      })!;
      expect(stuck.outdated).toBe(false);
      expect(stuckMessage("id-1", stuck)).toContain(
        "precheck の出力を orca automations runs --id id-1 --json で読んでください",
      );
      // 形・ディストリ・root の違いは今までどおり違う
      const other = (e: WatchEnv, root = ROOT) =>
        judgeWatchStuck({
          ...base,
          precheck: installed,
          expectedPrecheck: watchPrecheck(root, e),
        })!.outdated;
      expect(other({ platform: "linux" })).toBe(true);
      expect(other({ ...env("/usr/bin"), distro: "Debian" })).toBe(true);
      expect(other(env("/usr/bin"), "/work/other")).toBe(true);
    });

    it("lastRunAt が数（エポックのミリ秒）でも文字列と同じ判定になる", () => {
      const ms = Date.parse(ran);
      expect(judgeWatchStuck({ ...base, lastRunAt: ms })).toEqual(
        judgeWatchStuck(base),
      );
      expect(
        judgeWatchStuck({
          ...base,
          lastRunAt: ms,
          lastRoundAt: minutesBefore(11),
        }),
      ).not.toBeNull();
      expect(
        judgeWatchStuck({
          ...base,
          lastRunAt: ms,
          lastRoundAt: minutesBefore(10),
        }),
      ).toBeNull();
    });
  });

  it("一覧から enabled・lastRunAt・precheck を読み、型の違う値は読まない", async () => {
    const orca = fakeOrca();
    await installWatchAutomation(orca.runner, OPTS);
    const read = async (extra: Record<string, unknown>) => {
      Object.assign(orca.automations[0]!, extra);
      return findWatchAutomation(orca.runner, ROOT);
    };
    expect(
      await read({ enabled: false, lastRunAt: 1700000000000, precheck: "p" }),
    ).toMatchObject({
      state: "found",
      enabled: false,
      lastRunAt: 1700000000000,
      precheck: "p",
    });
    expect(await read({ lastRunAt: "2026-11-05T10:00:00.000Z" })).toMatchObject(
      { lastRunAt: "2026-11-05T10:00:00.000Z" },
    );
    const odd = await read({ enabled: "yes", lastRunAt: {}, precheck: 5 });
    expect(odd).toMatchObject({ state: "found" });
    expect(odd).toMatchObject({
      enabled: undefined,
      lastRunAt: undefined,
      precheck: undefined,
    });
  });
});
