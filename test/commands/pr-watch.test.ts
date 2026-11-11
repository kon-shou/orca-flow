import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/commands/pr-watch.ts";
import { watchPrecheck } from "../../src/lib/watch-automation.ts";
import { updateState } from "../../src/lib/pr-watch/store.ts";
import { watchAutomationName } from "../../src/lib/watch-automation.ts";
import { FlowError } from "../../src/types.ts";
import { addTaskWorktree } from "../helpers/repo.ts";
import { precheckRun, type FakeAutomationRun } from "../helpers/fake-orca.ts";
import { harness } from "../lib/pr-watch/helpers.ts";

describe("pr-watch コマンド", () => {
  beforeEach(() => {
    vi.stubEnv("WSL_DISTRO_NAME", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("引数なしは見張りの1回で、gh が失敗してもいつも0以外で終わる", async () => {
    const h = await harness();
    h.gh.failStderr = "boom";
    const result = await run(h.ctx(["--root", h.root]));
    expect(result.code).not.toBe(0);
    expect(h.orca.calls).toEqual([]);
    expect(h.orca.launches).toEqual([]);
  });

  it("--root を渡さなければ呼ばれた場所のリポジトリを見る", async () => {
    const h = await harness();
    h.gh.add({ number: 1, branch: "task/T01-x" });
    const result = await run(h.ctx([]));
    expect(result.code).not.toBe(0);
    expect(h.gh.stage1).toBe(1);
  });

  it("usage は、まだ回がなくても0で終わる", async () => {
    const h = await harness();
    const result = await run(h.ctx(["usage"]));
    expect(result.code).toBe(0);
    expect(h.out.join("\n")).toContain("まだありません");
  });

  it("install は automation を作り、2回目は2つ目を作らず直す。uninstall で消える", async () => {
    const h = await harness({ prWatch: { intervalMinutes: 10 } });
    const first = await run(h.ctx(["install"]));
    expect(first.data).toMatchObject({ action: "created" });
    expect(h.orca.automations).toHaveLength(1);
    expect(h.orca.automations[0]!.trigger).toBe("*/10 * * * *");
    const create = h.orca.callsOf("automations", "create")[0]!;
    expect(create).not.toContain("--workspace");
    expect(create).not.toContain("--reuse-session");
    const second = await run(h.ctx(["install"]));
    expect(second.data).toMatchObject({ action: "updated" });
    expect(h.orca.automations).toHaveLength(1);
    const removed = await run(h.ctx(["uninstall"]));
    expect(removed.code).toBe(0);
    expect(h.orca.automations).toHaveLength(0);
    const none = await run(h.ctx(["uninstall"]));
    expect(none.data).toMatchObject({ id: null });
  });

  it("install の precheck に --root とメインの作業ツリーが入る。タスクの worktree から打っても同じ", async () => {
    const h = await harness();
    const wt = await addTaskWorktree(h.root, "T01", "x");
    await run({ ...h.ctx(["install"]), cwd: wt.path });
    const create = h.orca.callsOf("automations", "create")[0]!;
    const precheck = create[create.indexOf("--precheck") + 1]!;
    expect(precheck).toContain("--root");
    expect(precheck).toContain(h.root);
    expect(precheck).not.toContain(wt.path);
  });

  it("知らない使い方と余分な引数は断る", async () => {
    const h = await harness();
    await expect(run(h.ctx(["nothing"]))).rejects.toBeInstanceOf(FlowError);
    await expect(run(h.ctx(["usage", "x"]))).rejects.toBeInstanceOf(FlowError);
  });

  describe("usage の見張りの automation の行", () => {
    const RAN = "2026-11-04T00:50:00.000Z";
    const STUCK = "見張りの automation が落ち続けています";

    async function withAutomation(
      h: Awaited<ReturnType<typeof harness>>,
      extra: Record<string, unknown>,
    ) {
      h.orca.automations.push({
        id: "auto-1",
        name: watchAutomationName(h.root),
        ...extra,
      } as never);
    }

    it("ない・確かめられない・ある、を1行で出す", async () => {
      const none = await harness();
      const r1 = await run(none.ctx(["usage"]));
      expect(none.out.join("\n")).toContain("見張りの automation：ありません");
      expect(r1.data).toMatchObject({ automation: { state: "missing" } });

      const unsure = await harness();
      unsure.orca.automationsListFails = true;
      await run(unsure.ctx(["usage"]));
      expect(unsure.out.join("\n")).toContain(
        "見張りの automation：確かめられません",
      );

      const found = await harness();
      await withAutomation(found, {});
      await run(found.ctx(["usage"]));
      expect(found.out.join("\n")).toContain("見張りの automation：あります");
      expect(found.out.join("\n")).not.toContain(STUCK);
    });

    it("回の記録がなく Orca が流していれば、落ち続けの文と打ち直しの直し方を出す。--json にも入る", async () => {
      const h = await harness();
      await withAutomation(h, {
        enabled: true,
        lastRunAt: RAN,
        precheck: "old",
      });
      h.orca.automationRuns["auto-1"] = [precheckRun(RAN)];
      const r = await run(h.ctx(["usage"]));
      const text = h.out.join("\n");
      expect(text).toContain(
        `${STUCK}（Orca は ${RAN} に流しましたが、pr-watch の回の記録がありません）。`,
      );
      expect(text).toContain("orca-flow pr-watch install を打ち直すと");
      expect(
        (r.data as { automation: { stuck: string } }).automation.stuck,
      ).toContain(STUCK);
    });

    it("precheck が今の形なら、出力を読む直し方を出す。回が続いていれば出さない", async () => {
      const h = await harness();
      await withAutomation(h, {
        enabled: true,
        lastRunAt: RAN,
        precheck: watchPrecheck(h.root),
      });
      h.orca.automationRuns["auto-1"] = [precheckRun(RAN)];
      await run(h.ctx(["usage"]));
      expect(h.out.join("\n")).toContain(
        "precheck の出力を orca automations runs --id auto-1 --json で読んでください",
      );

      const ok = await harness();
      await withAutomation(ok, {
        enabled: true,
        lastRunAt: RAN,
        precheck: "old",
      });
      await updateState(ok.dir, (st) => {
        st.lastRun = {
          at: "2026-11-04T00:49:00.000Z",
          result: "success",
          reason: null,
        } as never;
      });
      await run(ok.ctx(["usage"]));
      expect(ok.out.join("\n")).not.toContain(STUCK);
    });
    it("間隔の設定が判定に渡る。30分なら差が20分では出ず、61分では出る", async () => {
      const run30 = async (gapMinutes: number) => {
        const h = await harness({ prWatch: { intervalMinutes: 30 } });
        await withAutomation(h, {
          enabled: true,
          lastRunAt: RAN,
          precheck: "old",
        });
        h.orca.automationRuns["auto-1"] = [precheckRun(RAN)];
        await updateState(h.dir, (st) => {
          st.lastRun = {
            at: new Date(Date.parse(RAN) - gapMinutes * 60_000).toISOString(),
            result: "success",
            reason: null,
          } as never;
        });
        await run(h.ctx(["usage"]));
        return h.out.join("\n");
      };
      expect(await run30(20)).not.toContain(STUCK);
      expect(await run30(61)).toContain(STUCK);
    });

    it("無効の automation には落ち続けの文を出さない", async () => {
      const h = await harness();
      await withAutomation(h, {
        enabled: false,
        lastRunAt: RAN,
        precheck: "old",
      });
      const r = await run(h.ctx(["usage"]));
      expect(h.out.join("\n")).not.toContain(STUCK);
      expect(
        (r.data as { automation: { stuck: string | null } }).automation.stuck,
      ).toBeNull();
    });

    describe("落ち続けの決め直し（precheck を流した回の時刻）", () => {
      const MIN = 60_000;
      const ranMs = Date.parse(RAN);
      const roundAt = (ms: number) => ({
        at: new Date(ms).toISOString(),
        result: "success",
        reason: null,
      });
      async function stuckHarness(
        runs: FakeAutomationRun[] | undefined,
        roundMs: number | null,
      ) {
        const h = await harness();
        await withAutomation(h, {
          enabled: true,
          lastRunAt: RAN,
          precheck: "old",
        });
        if (runs) h.orca.automationRuns["auto-1"] = runs;
        if (roundMs !== null)
          await updateState(h.dir, (st) => {
            st.lastRun = roundAt(roundMs) as never;
          });
        return h;
      }

      it("lastRunAt は新しくても、precheck を流した直近の回が回の記録の近くなら言わない。逃した回は飛ばす", async () => {
        const h = await stuckHarness(
          [
            { status: "skipped", startedAt: ranMs, precheckResult: null },
            { status: "missed", scheduledFor: ranMs - MIN },
            precheckRun(ranMs - 40 * MIN),
          ],
          ranMs - 45 * MIN,
        );
        await run(h.ctx(["usage"]));
        expect(h.out.join("\n")).not.toContain(STUCK);
        const call = h.orca.callsOf("automations", "runs")[0]!;
        expect(call).toContain("--id");
        expect(call).toContain("auto-1");
        expect(call).toContain("--limit");
      });

      it("precheck を流した直近の回が回の記録より間隔の2回分を超えて新しければ言う。時刻はその回の始まり", async () => {
        const startedAt = ranMs - 30 * MIN;
        const h = await stuckHarness(
          [
            { status: "skipped", startedAt: ranMs, precheckResult: null },
            precheckRun(startedAt),
          ],
          startedAt - 11 * MIN,
        );
        await run(h.ctx(["usage"]));
        const text = h.out.join("\n");
        expect(text).toContain(
          `${STUCK}（Orca は ${new Date(startedAt).toISOString()} に流しましたが`,
        );
        expect(text).not.toContain(`Orca は ${RAN} に`);
      });

      it("回の記録がなく、precheck を流した回があれば言う。数のミリ秒の startedAt も読む", async () => {
        const h = await stuckHarness([precheckRun(ranMs - MIN)], null);
        await run(h.ctx(["usage"]));
        expect(h.out.join("\n")).toContain(STUCK);
      });

      it("読んだ範囲に precheck を流した回がない・履歴が空・読みが失敗する、のどれでも言わない", async () => {
        const none = await stuckHarness(
          [{ status: "ok", startedAt: ranMs, precheckResult: null }],
          null,
        );
        await run(none.ctx(["usage"]));
        expect(none.out.join("\n")).not.toContain(STUCK);

        const empty = await stuckHarness([], null);
        await run(empty.ctx(["usage"]));
        expect(empty.out.join("\n")).not.toContain(STUCK);

        const failing = await stuckHarness([precheckRun(ranMs)], null);
        failing.orca.automationRunsFail = true;
        await run(failing.ctx(["usage"]));
        expect(failing.out.join("\n")).not.toContain(STUCK);
        expect(failing.orca.callsOf("automations", "runs")).toHaveLength(1);
      });

      it("lastRunAt の判定で落ちていない・無効・lastRunAt なしのときは、回の履歴を読まない", async () => {
        const fine = await stuckHarness([precheckRun(ranMs)], ranMs - MIN);
        await run(fine.ctx(["usage"]));
        expect(fine.orca.callsOf("automations", "runs")).toHaveLength(0);

        const off = await harness();
        await withAutomation(off, { enabled: false, lastRunAt: RAN });
        await run(off.ctx(["usage"]));
        expect(off.orca.callsOf("automations", "runs")).toHaveLength(0);

        const noRun = await harness();
        await withAutomation(noRun, { enabled: true });
        await run(noRun.ctx(["usage"]));
        expect(noRun.orca.callsOf("automations", "runs")).toHaveLength(0);
      });

      it("履歴は --limit で切る。新しい順の先頭から数件の外にある precheck の回は読まない", async () => {
        const runs: FakeAutomationRun[] = Array.from({ length: 60 }, () => ({
          status: "skipped",
          startedAt: ranMs,
          precheckResult: null,
        }));
        runs.push(precheckRun(ranMs - MIN));
        const h = await stuckHarness(runs, null);
        await run(h.ctx(["usage"]));
        expect(h.out.join("\n")).not.toContain(STUCK);
      });

      it("install の直後（一覧の precheck は入れ物の形）に落ち続けの場面を作ると、出力を読む直し方で、打ち直しの案内は出ない", async () => {
        const h = await harness();
        await run(h.ctx(["install"]));
        expect(h.orca.automations[0]!.precheck).toMatchObject({
          command: watchPrecheck(h.root),
        });
        Object.assign(h.orca.automations[0]!, {
          enabled: true,
          lastRunAt: RAN,
        });
        h.orca.automationRuns[h.orca.automations[0]!.id] = [
          precheckRun(ranMs - MIN),
        ];
        h.out.length = 0;
        await run(h.ctx(["usage"]));
        const text = h.out.join("\n");
        expect(text).toContain(STUCK);
        expect(text).toContain("precheck の出力を orca automations runs --id");
        expect(text).not.toContain("打ち直すと");
      });
    });

    it.runIf(process.platform === "linux")(
      "WSL の形で PATH だけ違う precheck は、出力を読む直し方を出す",
      async () => {
        vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu-24.04");
        vi.stubEnv("PATH", "/opt/a/bin:/usr/bin");
        const h = await harness();
        const installed = watchPrecheck(h.root);
        vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");
        await withAutomation(h, {
          enabled: true,
          lastRunAt: RAN,
          precheck: installed,
        });
        h.orca.automationRuns["auto-1"] = [precheckRun(RAN)];
        await run(h.ctx(["usage"]));
        const text = h.out.join("\n");
        expect(text).toContain(
          "precheck の出力を orca automations runs --id auto-1",
        );
        expect(text).not.toContain("打ち直すと");
      },
    );
  });
});
