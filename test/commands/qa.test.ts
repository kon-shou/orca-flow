import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { leasesPath } from "../../src/lib/qa/leases.ts";
import { git, makeRepo, tempDir } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

interface Seen {
  method: string;
  headers: http.IncomingHttpHeaders;
  form: URLSearchParams;
}

let server: http.Server;
let seen: Seen[];
let reply: { status: number; body: string };
let baseUrl: string;

beforeEach(async () => {
  seen = [];
  reply = { status: 200, body: "<p>queued OK</p>" };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        headers: req.headers,
        form: new URLSearchParams(Buffer.concat(chunks).toString()),
      });
      res.statusCode = reply.status;
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
});

const qaConfig = (extra: Record<string, unknown> = {}) => ({
  url: baseUrl,
  envs: [1, 2],
  envField: "env_no",
  successText: "queued OK",
  branchFields: { app_branch: "main", api_branch: "develop" },
  selfField: "app_branch",
  fields: { mode: "qa" },
  databaseField: "reset_db",
  appUrl: "https://qa{env}.example.test/",
  ...extra,
});

interface Setup {
  root: string;
  head: string;
  env: NodeJS.ProcessEnv;
}

/** origin つきのリポジトリを作り、タスクのブランチ T01 を push する */
async function setup(
  qa: unknown = qaConfig(),
  pushBranch = true,
): Promise<Setup> {
  const root = await makeRepo(qa === null ? {} : { qa });
  const origin = await tempDir("orca-flow-qa-origin-");
  await git(origin, "init", "--bare", "--quiet", "-b", "main");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "branch", "task/T01-demo");
  let head = "";
  if (pushBranch) {
    await git(root, "push", "--quiet", "origin", "task/T01-demo");
    head = await git(root, "rev-parse", "task/T01-demo");
  }
  const state = await tempDir("orca-flow-qa-state-");
  return {
    root,
    head,
    env: { ...process.env, XDG_STATE_HOME: state, QA_AUTH: "user1:pass1" },
  };
}

async function qa(s: Setup, argv: string[], env = s.env) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["qa", ...argv], {
    cwd: s.root,
    runner: testRunner,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const leaseFile = async (s: Setup) =>
  JSON.parse(await readFile(leasesPath(s.env), "utf8")) as {
    urls: Record<string, Record<string, { id: string }>>;
  };

describe("qa plan", () => {
  it("一番小さい空き番号を選び、次に打つ deploy の1行を出す", async () => {
    const s = await setup();
    const r = await qa(s, ["plan", "T01"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`orca-flow qa deploy T01 --env 1 --head ${s.head}`);
    expect(r.out).toContain("app_branch = task/T01-demo");
    expect(seen).toHaveLength(0);
  });

  it("すでに借りていればその番号を選ぶ", async () => {
    const s = await setup(qaConfig({ authEnv: undefined }));
    await qa(s, ["deploy", "T01", "--env", "2", "--head", s.head]);
    const r = await qa(s, ["plan", "T01"]);
    expect(r.out).toContain(`--env 2 --head ${s.head}`);
  });

  it("設定に qa がなければ終了コード2で送らない", async () => {
    const s = await setup(null);
    expect((await qa(s, ["plan", "T01"])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("タスクのブランチがなければ終了コード1、2つあっても1で送らない", async () => {
    const s = await setup();
    expect((await qa(s, ["plan", "T09"])).code).toBe(1);
    await git(s.root, "branch", "task/T01-other");
    expect((await qa(s, ["plan", "T01"])).code).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("origin にブランチがなければ終了コード2で送らない", async () => {
    const s = await setup(qaConfig(), false);
    expect((await qa(s, ["plan", "T01"])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("空きがなければ終了コード2で、新しく送らない", async () => {
    const s = await setup(qaConfig({ envs: [1] }));
    await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    await git(s.root, "branch", "task/T02-demo");
    await git(s.root, "push", "--quiet", "origin", "task/T02-demo");
    expect((await qa(s, ["plan", "T02"])).code).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("--json の出力は JSON として読める", async () => {
    const s = await setup();
    const r = await qa(s, ["plan", "T01", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id: "T01", env: 1 });
  });
});

describe("qa deploy", () => {
  it("欄が決まりどおりに届き、貸し出しを記録して終了コード0", async () => {
    const s = await setup();
    const r = await qa(s, [
      "deploy",
      "T01",
      "--env",
      "2",
      "--head",
      s.head,
      "--branch",
      "api_branch=feature/x",
      "--database",
    ]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(Object.fromEntries(seen[0]!.form)).toEqual({
      mode: "qa",
      app_branch: "task/T01-demo",
      api_branch: "feature/x",
      env_no: "2",
      reset_db: "1",
    });
    expect((await leaseFile(s)).urls[baseUrl]!["2"]!.id).toBe("T01");
  });

  it("--database なしでは databaseField を送らず、--branch は繰り返せる", async () => {
    const s = await setup(
      qaConfig({ branchFields: { app_branch: "main", a: "x", b: "y" } }),
    );
    await qa(s, [
      "deploy",
      "T01",
      "--env",
      "1",
      "--head",
      s.head,
      "--branch",
      "a=one",
      "--branch",
      "b=two",
    ]);
    const form = Object.fromEntries(seen[0]!.form);
    expect(form).toMatchObject({ a: "one", b: "two" });
    expect(form).not.toHaveProperty("reset_db");
  });

  it("不正な引数は終了コード1で送らない", async () => {
    const s = await setup(qaConfig({ databaseField: undefined }));
    const base = ["deploy", "T01", "--env", "1", "--head", s.head];
    for (const extra of [
      ["--branch", "unknown=x"],
      ["--branch", "app_branch=x"],
      ["--branch", "api_branch=../x"],
      ["--branch", "api_branch"],
      ["--database"],
    ])
      expect((await qa(s, [...base, ...extra])).code).toBe(1);
    expect(
      (await qa(s, ["deploy", "T01", "--env", "9", "--head", s.head])).code,
    ).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("--head が origin の先頭と違えば終了コード1で送らない", async () => {
    const s = await setup();
    const r = await qa(s, [
      "deploy",
      "T01",
      "--env",
      "1",
      "--head",
      "0".repeat(40),
    ]);
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(0);
  });

  const noSend = ["deploy", "T01", "--env", "1", "--head", "a"];

  it("設定に qa がなければ終了コード2で送らない", async () => {
    const s = await setup(null);
    expect((await qa(s, noSend)).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("origin にブランチがなければ終了コード2で送らない", async () => {
    const s = await setup(qaConfig(), false);
    expect((await qa(s, noSend)).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("番号をほかが借りていれば終了コード2で、新しく送らない", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(seen).toHaveLength(1);
    await git(s.root, "branch", "task/T02-demo");
    await git(s.root, "push", "--quiet", "origin", "task/T02-demo");
    const head2 = await git(s.root, "rev-parse", "task/T02-demo");
    expect(
      (await qa(s, ["deploy", "T02", "--env", "1", "--head", head2])).code,
    ).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("authEnv の環境変数がなければ終了コード2で送らない", async () => {
    const s = await setup(qaConfig({ authEnv: "QA_AUTH" }));
    const env = { ...s.env };
    delete env.QA_AUTH;
    const r = await qa(
      s,
      ["deploy", "T01", "--env", "1", "--head", s.head],
      env,
    );
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("タスクのブランチがない・2つあるときは終了コード1で送らない", async () => {
    const s = await setup();
    expect(
      (await qa(s, ["deploy", "T09", "--env", "1", "--head", s.head])).code,
    ).toBe(1);
    await git(s.root, "branch", "task/T01-other");
    expect(
      (await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head])).code,
    ).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("使えない形のブランチ名は終了コード1で送らない", async () => {
    const s = await setup();
    await git(s.root, "branch", "task/T05-a;b");
    const r = await qa(s, ["deploy", "T05", "--env", "1", "--head", "a"]);
    expect(r.code).toBe(1);
    expect((await qa(s, ["plan", "T05"])).code).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("--json 付きは位置に関係なく終了コード1で、送らず借りない", async () => {
    const s = await setup();
    const argv = ["deploy", "T01", "--env", "1", "--head", s.head];
    expect((await qa(s, ["--json", ...argv])).code).toBe(1);
    expect((await qa(s, [...argv, "--json"])).code).toBe(1);
    expect(seen).toHaveLength(0);
    const file = await readFile(leasesPath(s.env), "utf8").catch(() => "{}");
    expect(file).not.toContain("T01");
  });

  it("--branch なしでは、各欄に設定の既定のブランチが届く", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(Object.fromEntries(seen[0]!.form)).toEqual({
      mode: "qa",
      app_branch: "task/T01-demo",
      api_branch: "develop",
      env_no: "1",
    });
  });

  it("管理画面につながらなければ終了コード1で、新しい貸し出しは残らず、届いていないと出る", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const s2 = await setup(qaConfig({ url: `http://127.0.0.1:${port}/admin` }));
    const r = await qa(s2, ["deploy", "T01", "--env", "1", "--head", s2.head]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("要求は届いていません");
    expect(r.err).not.toContain("要求は送っています");
    expect(r.err).toContain("外しました");
    const file = await readFile(leasesPath(s2.env), "utf8").catch(() => "{}");
    expect(file).not.toContain("T01");
    expect(seen).toHaveLength(0);
  });

  it("要求を読んでから切られたときは、届いていないと言い切らず、新しい貸し出しは外す", async () => {
    const cut = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => res.socket?.destroy());
    });
    await new Promise<void>((r) => cut.listen(0, "127.0.0.1", r));
    const port = (cut.address() as AddressInfo).port;
    try {
      const s2 = await setup(
        qaConfig({ url: `http://127.0.0.1:${port}/admin` }),
      );
      const r = await qa(s2, [
        "deploy",
        "T01",
        "--env",
        "1",
        "--head",
        s2.head,
      ]);
      expect(r.code).toBe(1);
      expect(r.err).not.toContain("要求は届いていません");
      expect(r.err).toContain("届いたか分かりません");
      expect(r.err).toContain("外しました");
    } finally {
      cut.closeAllConnections();
      await new Promise((r) => cut.close(r));
    }
  });

  it("応答の本文の途中で切られたときは、届いていないと言わず、状態を保つ", async () => {
    const cut = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-length": "100" });
        res.write("queued");
        setTimeout(() => res.socket?.destroy(), 20);
      });
    });
    await new Promise<void>((r) => cut.listen(0, "127.0.0.1", r));
    const port = (cut.address() as AddressInfo).port;
    try {
      const s2 = await setup(
        qaConfig({ url: `http://127.0.0.1:${port}/admin` }),
      );
      const r = await qa(s2, [
        "deploy",
        "T01",
        "--env",
        "1",
        "--head",
        s2.head,
      ]);
      expect(r.code).toBe(1);
      expect(r.err).not.toContain("要求は届いていません");
      expect(r.err).toContain("要求は送っています");
      expect(r.err).toContain("200");
    } finally {
      cut.closeAllConnections();
      await new Promise((r) => cut.close(r));
    }
  });

  it("応答の状態の番号は1回だけ出る", async () => {
    const s = await setup();
    reply = { status: 500, body: "" };
    const r = await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(r.err).toContain("要求は送っています");
    expect(r.err.match(/500/g)).toHaveLength(1);
  });

  it("成功の印がない・2xx でない応答は終了コード1で、新しい貸し出しが残らない", async () => {
    const s = await setup();
    reply = { status: 200, body: "something else SECRET-BODY" };
    const r1 = await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(r1.code).toBe(1);
    expect(r1.out + r1.err).not.toContain("SECRET-BODY");
    reply = { status: 500, body: "queued OK" };
    const r2 = await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(r2.code).toBe(1);
    expect(seen).toHaveLength(2);
    const file = await readFile(leasesPath(s.env), "utf8").catch(() => "{}");
    expect(file).not.toContain("T01");
  });

  it("前から借りていた分は、送りが落ちても残る", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    reply = { status: 500, body: "" };
    expect(
      (await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head])).code,
    ).toBe(1);
    expect((await leaseFile(s)).urls[baseUrl]!["1"]!.id).toBe("T01");
  });

  it("authEnv があれば basic 認証の頭が届き、値はどの出力にも出ない", async () => {
    const s = await setup(qaConfig({ authEnv: "QA_AUTH" }));
    const r = await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(r.code).toBe(0);
    expect(seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("user1:pass1").toString("base64")}`,
    );
    const all = r.out + r.err;
    expect(all).not.toContain("user1");
    expect(all).not.toContain("pass1");
    expect(all).not.toContain(Buffer.from("user1:pass1").toString("base64"));
  });

  it("壊れた記録では終了コード1で送らず、ファイルを変えない", async () => {
    const s = await setup();
    const file = leasesPath(s.env);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "oops");
    const r = await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("oops");
  });
});

describe("qa list と qa release", () => {
  it("番号ごとの空きと貸し出しを出す（--json も）", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "2", "--head", s.head]);
    const text = await qa(s, ["list"]);
    expect(text.out).toContain("環境 1：空き");
    expect(text.out).toContain("環境 2：T01");
    const json = JSON.parse((await qa(s, ["list", "--json"])).out) as {
      envs: { env: number; free: boolean; lease: { id: string } | null }[];
    };
    expect(json.envs.map((e) => [e.env, e.free])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(json.envs[1]!.lease!.id).toBe("T01");
  });

  it("release の ID と --env で空きに戻り、返すものがなくても終了コード0", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    const byId = await qa(s, ["release", "T01"]);
    expect(byId.code).toBe(0);
    expect(byId.out).toContain("空きに戻しました");
    await qa(s, ["deploy", "T01", "--env", "2", "--head", s.head]);
    expect((await qa(s, ["release", "--env", "2"])).code).toBe(0);
    const none = await qa(s, ["release", "--env", "2"]);
    expect(none.code).toBe(0);
    expect(none.out).toContain("返すものはありません");
    expect(
      JSON.parse((await qa(s, ["list", "--json"])).out).envs.every(
        (e: { free: boolean }) => e.free,
      ),
    ).toBe(true);
  });

  it("ID も --env もない・両方ある release は終了コード1", async () => {
    const s = await setup();
    expect((await qa(s, ["release"])).code).toBe(1);
    expect((await qa(s, ["release", "T01", "--env", "1"])).code).toBe(1);
  });

  it("使い方の文は、ワークスペースのフォルダではブランチ名で打ち ID では打てないと書く", async () => {
    const s = await setup();
    const r = await qa(s, ["release"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ワークスペースのフォルダでは");
    expect(r.err).toContain("組のブランチ名");
    expect(r.err).toContain("ID では打てません");
    expect(r.err).not.toContain("ブランチ名も受けます");
  });

  it("文字の出力にリポジトリ・ブランチ・環境の画面の URL が出る", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "2", "--head", s.head]);
    const out = (await qa(s, ["list"])).out;
    expect(out).toContain("環境 1：空き https://qa1.example.test/");
    expect(out).toContain("main");
    expect(out).toContain("task/T01-demo");
    expect(out).toContain("https://qa2.example.test/");
  });

  it("release の --json の出力は JSON として読める", async () => {
    const s = await setup();
    await qa(s, ["deploy", "T01", "--env", "1", "--head", s.head]);
    const r = await qa(s, ["release", "T01", "--json"]);
    expect(JSON.parse(r.out)).toEqual({ released: [{ env: 1, id: "T01" }] });
  });
});

describe("持ち主の見分け", () => {
  it("タスクの worktree から借りた番号を、メインの作業ツリーの plan が使い直し、release で空きに戻る", async () => {
    const s = await setup();
    const base = await tempDir("orca-flow-qa-wt-");
    const wt = path.join(base, "wt");
    await git(s.root, "worktree", "add", "--quiet", wt, "task/T01-demo");
    const r = await qa({ ...s, root: wt }, [
      "deploy",
      "T01",
      "--env",
      "2",
      "--head",
      s.head,
    ]);
    expect(r.code).toBe(0);
    const plan = await qa(s, ["plan", "T01"]);
    expect(plan.out).toContain("使い直し");
    expect(plan.out).toContain(`--env 2 --head ${s.head}`);
    expect((await qa(s, ["release", "T01"])).out).toContain("空きに戻しました");
    const json = JSON.parse((await qa(s, ["list", "--json"])).out) as {
      envs: { free: boolean }[];
    };
    expect(json.envs.every((e) => e.free)).toBe(true);
  });
});
