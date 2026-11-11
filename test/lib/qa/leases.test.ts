import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  borrow,
  groupLeasesOf,
  leasesPath,
  pickEnv,
  readLeases,
  recordLease,
  release,
  type Lease,
} from "../../../src/lib/qa/leases.ts";
import { FlowError } from "../../../src/types.ts";
import { tempDir } from "../../helpers/repo.ts";

const URL_A = "https://qa1.example.test/admin";
const lease = (id: string, repo = "/r/one"): Lease => ({
  repo,
  id,
  branch: `task/${id}-x`,
  head: "a".repeat(40),
  at: "2030-01-01T00:00:00.000Z",
});

async function stateEnv() {
  const dir = await tempDir("orca-flow-qa-state-");
  return { XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
}

describe("貸し出しの記録", () => {
  it("借りる・読む・返すが記録に残る", async () => {
    const env = await stateEnv();
    expect((await readLeases(env, URL_A)).size).toBe(0);
    await borrow(env, URL_A, 2, lease("T01"));
    const read = await readLeases(env, URL_A);
    expect(read.get(2)?.id).toBe("T01");
    const removed = await release(env, URL_A, { env: 2 });
    expect(removed.map((r) => r.env)).toEqual([2]);
    expect((await readLeases(env, URL_A)).size).toBe(0);
  });

  it("url ごとに分かれる", async () => {
    const env = await stateEnv();
    await borrow(env, URL_A, 1, lease("T01"));
    expect((await readLeases(env, "https://qa2.example.test/")).size).toBe(0);
  });

  it("ほかが借りた番号は終了コード2で貸さず、同じタスクは使い直す", async () => {
    const env = await stateEnv();
    await borrow(env, URL_A, 1, lease("T01"));
    await expect(borrow(env, URL_A, 1, lease("T02"))).rejects.toMatchObject({
      code: 2,
    });
    expect(await borrow(env, URL_A, 1, lease("T01"))).toEqual({ reused: true });
  });

  it("2つの借りる処理を同時に流しても同じ番号を2つのタスクに貸さない", async () => {
    const env = await stateEnv();
    const attempt = async (id: string) => {
      const leases = await readLeases(env, URL_A);
      const pick = pickEnv(leases, [1, 2], { repo: "/r/one", id });
      if (!pick) return null;
      try {
        await borrow(env, URL_A, pick.env, lease(id));
        return pick.env;
      } catch (error) {
        // 番号をほかが借りていた失敗（終了コード2）だけは数えない
        if (error instanceof FlowError && error.code === 2) return null;
        throw error;
      }
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => attempt(`T0${i + 1}`)),
    );
    const got = results.filter((n): n is number => n !== null);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(new Set(got).size).toBe(got.length);
    const read = await readLeases(env, URL_A);
    expect(read.size).toBe(got.length);
  });

  it("別のリポジトリが同じ ID で借りても別々で、片方を返してももう片方が残る", async () => {
    const env = await stateEnv();
    await borrow(env, URL_A, 1, lease("T01", "/r/one"));
    await borrow(env, URL_A, 2, lease("T01", "/r/two"));
    const removed = await release(env, URL_A, {
      who: { repo: "/r/one", id: "T01" },
    });
    expect(removed.map((r) => r.env)).toEqual([1]);
    const read = await readLeases(env, URL_A);
    expect(read.get(2)?.repo).toBe("/r/two");
    expect(read.has(1)).toBe(false);
  });

  it("壊れた記録は終了コード1で止まり、中身を変えない", async () => {
    const env = await stateEnv();
    const file = leasesPath(env);
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of [
      "{ not json",
      '{"urls": []}',
      '{"urls":{"u":{"x":{}}}}',
    ]) {
      await writeFile(file, text);
      await expect(borrow(env, URL_A, 1, lease("T01"))).rejects.toMatchObject({
        code: 1,
      });
      await expect(release(env, URL_A, { env: 1 })).rejects.toMatchObject({
        code: 1,
      });
      expect(await readFile(file, "utf8")).toBe(text);
    }
  });

  it("空きの選び方：一番小さい空き番号、借りていればその番号", () => {
    const leases = new Map([[1, lease("T09")]]);
    expect(pickEnv(leases, [3, 2, 1], { repo: "/r/one", id: "T01" })).toEqual({
      env: 2,
      reused: false,
    });
    leases.set(2, lease("T01"));
    expect(pickEnv(leases, [1, 2, 3], { repo: "/r/one", id: "T01" })).toEqual({
      env: 2,
      reused: true,
    });
    expect(pickEnv(leases, [1, 2, 3], { repo: "/r/two", id: "T01" })).toEqual({
      env: 3,
      reused: false,
    });
    expect(pickEnv(leases, [1, 2], { repo: "/r/two", id: "T01" })).toBeNull();
  });

  it("記録の場所は XDG_STATE_HOME、なければ HOME の .local/state", () => {
    expect(leasesPath({ XDG_STATE_HOME: "/s" })).toBe(
      "/s/orca-flow/qa-leases.json",
    );
    expect(leasesPath({ HOME: "/h" })).toBe(
      "/h/.local/state/orca-flow/qa-leases.json",
    );
    expect(leasesPath({ USERPROFILE: "/u" })).toBe(
      "/u/.local/state/orca-flow/qa-leases.json",
    );
  });

  it("組の貸し出し：アプリのリポジトリが借りた番号を組が使い直し、組の記録（アプリごとの中身）も読める", async () => {
    const env = await stateEnv();
    await borrow(env, URL_A, 2, lease("T01", "/r/app"));
    const who = { repo: "/r/ws", id: "T01", also: ["/r/app", "/r/other"] };
    expect(pickEnv(await readLeases(env, URL_A), [1, 2], who)).toEqual({
      env: 2,
      reused: true,
    });
    const group: Lease = {
      ...lease("T01", "/r/ws"),
      apps: [
        {
          name: "web",
          path: "/r/app",
          branch: "task/T01-x",
          head: "b".repeat(40),
        },
      ],
    };
    expect(await borrow(env, URL_A, 2, group, ["/r/app"])).toEqual({
      reused: true,
    });
    await recordLease(env, URL_A, 2, group);
    expect((await readLeases(env, URL_A)).get(2)?.apps?.[0]?.name).toBe("web");
    expect(
      pickEnv(await readLeases(env, URL_A), [1, 2], {
        repo: "/r/ws",
        id: "T01",
      }),
    ).toEqual({ env: 2, reused: true });
    await expect(
      borrow(env, URL_A, 2, lease("T01", "/r/stranger"), ["/r/app"]),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("古い形の記録（apps なし）は読め、apps の形が壊れていれば終了コード1", async () => {
    const env = await stateEnv();
    const file = leasesPath(env);
    await mkdir(path.dirname(file), { recursive: true });
    const old = lease("T01");
    await writeFile(
      file,
      JSON.stringify({ version: 1, urls: { [URL_A]: { "1": old } } }),
    );
    expect((await readLeases(env, URL_A)).get(1)).toEqual(old);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        urls: { [URL_A]: { "1": { ...old, apps: [{ name: 1 }] } } },
      }),
    );
    await expect(readLeases(env, URL_A)).rejects.toMatchObject({ code: 1 });
  });

  it("同じ ID でもブランチ名の違う子の貸し出し・組の貸し出しは、組が使い直さない", () => {
    const groupLease = (branch: string): Lease => ({
      ...lease("T01", "/r/ws"),
      branch,
      apps: [{ name: "web", path: "/r/app", branch, head: "b".repeat(40) }],
    });
    const who = {
      repo: "/r/ws",
      id: "T01",
      also: ["/r/app"],
      branches: ["task/T01-order-limit"],
    };
    const child = { ...lease("T01", "/r/app"), branch: "task/T01-export" };
    expect(pickEnv(new Map([[1, child]]), [1, 2], who)).toEqual({
      env: 2,
      reused: false,
    });
    expect(
      pickEnv(new Map([[1, groupLease("task/T01-export")]]), [1, 2], who),
    ).toEqual({ env: 2, reused: false });
    expect(
      pickEnv(new Map([[1, groupLease("task/T01-order-limit")]]), [1, 2], who),
    ).toEqual({ env: 1, reused: true });
    expect(
      pickEnv(
        new Map([[1, { ...child, branch: "task/T01-order-limit" }]]),
        [1, 2],
        who,
      ),
    ).toEqual({ env: 1, reused: true });
  });

  it("ブランチ名の違う借り手は同じ番号を借りられず、返しでも外さない", async () => {
    const env = await stateEnv();
    await borrow(env, URL_A, 1, { ...lease("T01"), branch: "task/T01-a" });
    await expect(
      borrow(env, URL_A, 1, { ...lease("T01"), branch: "task/T01-b" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(
      await release(env, URL_A, {
        who: { repo: "/r/one", id: "T01", branches: ["task/T01-b"] },
      }),
    ).toEqual([]);
    expect(
      (
        await release(env, URL_A, {
          who: { repo: "/r/one", id: "T01", branches: ["task/T01-a"] },
        })
      ).map((r) => r.env),
    ).toEqual([1]);
  });

  it("ブランチ名のない古い形の記録も読め、ID だけで比べる", async () => {
    const env = await stateEnv();
    const file = leasesPath(env);
    await mkdir(path.dirname(file), { recursive: true });
    const { branch: _branch, ...old } = lease("T01", "/r/app");
    await writeFile(
      file,
      JSON.stringify({ version: 1, urls: { [URL_A]: { "1": old } } }),
    );
    const read = await readLeases(env, URL_A);
    expect(read.get(1)?.id).toBe("T01");
    expect(
      pickEnv(read, [1, 2], {
        repo: "/r/ws",
        id: "T01",
        also: ["/r/app"],
        branches: ["task/T01-order-limit"],
      }),
    ).toEqual({ env: 1, reused: true });
  });

  it("両方にブランチ名があれば ID の欄を見ず、同じリポジトリとブランチ名なら同じ持ち主として使い直し・返す", async () => {
    const env = await stateEnv();
    await borrow(env, URL_A, 1, { ...lease("T01"), branch: "task/T01-a" });
    expect(
      await borrow(env, URL_A, 1, { ...lease("T07"), branch: "task/T01-a" }),
    ).toEqual({ reused: true });
    expect(
      pickEnv(await readLeases(env, URL_A), [1, 2], {
        repo: "/r/one",
        id: "T07",
        branches: ["task/T01-a"],
      }),
    ).toEqual({ env: 1, reused: true });
    await expect(
      borrow(env, URL_A, 1, {
        ...lease("T07", "/r/two"),
        branch: "task/T01-a",
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(
      (
        await release(env, URL_A, {
          who: { repo: "/r/one", id: "T07", branches: ["task/T01-a"] },
        })
      ).map((r) => r.env),
    ).toEqual([1]);
  });

  it("組の借り手と組の貸し出しも、ブランチ名が分かれば ID の欄が違っても同じ持ち主", () => {
    const group: Lease = {
      ...lease("T01", "/r/ws"),
      branch: "task/T01-order-limit",
      apps: [
        {
          name: "web",
          path: "/r/app",
          branch: "task/T01-order-limit",
          head: "b".repeat(40),
        },
      ],
    };
    const who = {
      repo: "/r/ws",
      id: "T02",
      also: ["/r/app"],
      branches: ["task/T01-order-limit"],
    };
    expect(pickEnv(new Map([[1, group]]), [1, 2], who)).toEqual({
      env: 1,
      reused: true,
    });
    expect(
      pickEnv(new Map([[1, group]]), [1, 2], {
        ...who,
        id: "T01",
        branches: ["task/T01-export"],
      }),
    ).toEqual({ env: 2, reused: false });
  });

  it("どちらかにブランチ名がなければ ID で比べる", async () => {
    const env = await stateEnv();
    const file = leasesPath(env);
    await mkdir(path.dirname(file), { recursive: true });
    const { branch: _branch, ...old } = lease("T01");
    await writeFile(
      file,
      JSON.stringify({ version: 1, urls: { [URL_A]: { "1": old } } }),
    );
    const read = await readLeases(env, URL_A);
    expect(
      pickEnv(read, [1, 2], {
        repo: "/r/one",
        id: "T02",
        branches: ["task/T01-x"],
      }),
    ).toEqual({ env: 2, reused: false });
    expect(
      pickEnv(new Map([[1, lease("T01")]]), [1, 2], {
        repo: "/r/one",
        id: "T02",
      }),
    ).toEqual({ env: 2, reused: false });
  });

  it("組の案内の見つけ方は、ブランチ名が分かればアプリのパスとブランチ名で比べ、ID の欄を見ない", () => {
    const group: Lease = {
      ...lease("T01", "/r/ws"),
      apps: [
        {
          name: "web",
          path: "/r/app",
          branch: "task/T01-order-limit",
          head: "b".repeat(40),
        },
      ],
    };
    const leases = new Map([[2, group]]);
    expect(
      groupLeasesOf(leases, "T09", "/r/app", "task/T01-order-limit"),
    ).toHaveLength(1);
    expect(groupLeasesOf(leases, "T09", "/r/app")).toEqual([]);
    expect(
      groupLeasesOf(leases, "T01", "/r/other", "task/T01-order-limit"),
    ).toEqual([]);
  });

  it("組の案内の見つけ方は、そのアプリのブランチ名が違う組の貸し出しを除く", () => {
    const group: Lease = {
      ...lease("T01", "/r/ws"),
      apps: [
        {
          name: "web",
          path: "/r/app",
          branch: "task/T01-export",
          head: "b".repeat(40),
        },
      ],
    };
    const leases = new Map([[2, group]]);
    expect(groupLeasesOf(leases, "T01", "/r/app")).toHaveLength(1);
    expect(
      groupLeasesOf(leases, "T01", "/r/app", "task/T01-export"),
    ).toHaveLength(1);
    expect(
      groupLeasesOf(leases, "T01", "/r/app", "task/T01-order-limit"),
    ).toEqual([]);
  });
});
