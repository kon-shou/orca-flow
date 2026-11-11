import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type RunResult, type Runner } from "../../src/lib/exec.ts";
import {
  borrow,
  leasesPath,
  recordLease,
  release,
  type Lease,
} from "../../src/lib/qa/leases.ts";
import { git, makeRepo, tempDir, writeFiles } from "../helpers/repo.ts";
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

const qaFor = (selfField: string, extra: Record<string, unknown> = {}) => ({
  url: baseUrl,
  envs: [1, 2],
  envField: "env_no",
  successText: "queued OK",
  branchFields: { web_branch: "main", api_branch: "main", batch_branch: "dev" },
  selfField,
  fields: { mode: "qa" },
  databaseField: "reset_db",
  appUrl: "https://qa{env}.example.test/",
  authEnv: "QA_AUTH",
  ...extra,
});

interface Repo {
  name: string;
  path: string;
  origin: string;
}

async function repoWithOrigin(config: Record<string, unknown>): Promise<Repo> {
  const path = await makeRepo(config);
  const origin = await tempDir("orca-flow-qa-origin-");
  await git(origin, "init", "--bare", "--quiet", "-b", "main");
  await git(path, "remote", "add", "origin", origin);
  return { name: "", path, origin };
}

/** タスクのブランチを切り、files を載せて push する */
async function taskBranch(
  repo: Repo,
  branch: string,
  files: Record<string, string> = {},
  push = true,
): Promise<string> {
  await git(repo.path, "branch", branch);
  if (Object.keys(files).length > 0) {
    await git(repo.path, "switch", "--quiet", branch);
    await writeFiles(repo.path, files);
    await git(repo.path, "add", "-A");
    await git(repo.path, "commit", "--quiet", "-m", "files");
    await git(repo.path, "switch", "--quiet", "main");
  }
  if (push) await git(repo.path, "push", "--quiet", "origin", branch);
  return git(repo.path, "rev-parse", branch);
}

interface Group {
  dir: string;
  env: NodeJS.ProcessEnv;
  common: Repo;
  web: Repo;
  api: Repo;
  /** 番号だけ同じで短い名前の違うブランチを持つアプリ（admin を立てたときだけ） */
  admin?: Repo;
  /** 子の config --json の答え（パス → 答え）。差し替えて使う */
  answers: Map<string, { code: number; body: unknown }>;
  calls: { cmd: string; args: string[]; cwd?: string }[];
  headWeb: string;
  headApi: string;
}

async function setup(
  options: {
    webFiles?: Record<string, string>;
    apiQa?: Record<string, unknown> | null;
    /** 組の外のアプリを足す（同じ ID で短い名前の違うブランチを持つ） */
    admin?: boolean;
  } = {},
): Promise<Group> {
  const web = await repoWithOrigin({ qa: qaFor("web_branch") });
  const api = await repoWithOrigin(
    options.apiQa === null ? {} : { qa: qaFor("api_branch") },
  );
  const common = await repoWithOrigin({});
  web.name = "demo-web";
  api.name = "demo-api";
  common.name = "demo-core";
  const headWeb = await taskBranch(
    web,
    "task/T01-order-limit",
    options.webFiles,
  );
  const headApi = await taskBranch(api, "task/T01-order-limit");
  const admin = options.admin
    ? await repoWithOrigin({ qa: qaFor("batch_branch") })
    : undefined;
  if (admin) {
    admin.name = "demo-admin";
    await taskBranch(admin, "task/T01-member-export");
  }
  const dir = await tempDir("orca-flow-qa-ws-");
  await writeFiles(dir, {
    "orca-flow-workspace.json": JSON.stringify({
      repos: [
        {
          name: common.name,
          path: common.path,
          role: "common",
          keywords: ["共通"],
          scope: "共通の処理",
          package: "orca/core",
          bumpCommand: "composer update orca/core",
        },
        { name: web.name, path: web.path, role: "app", keywords: ["画面"] },
        { name: api.name, path: api.path, role: "app", keywords: ["API"] },
        ...(admin
          ? [
              {
                name: admin.name,
                path: admin.path,
                role: "app",
                keywords: ["管理"],
              },
            ]
          : []),
      ],
    }),
  });
  const state = await tempDir("orca-flow-qa-state-");
  const answers: Group["answers"] = new Map([
    [web.path, { code: 0, body: { qa: qaFor("web_branch") } }],
    [
      api.path,
      {
        code: 0,
        body: options.apiQa === null ? {} : { qa: qaFor("api_branch") },
      },
    ],
    [common.path, { code: 0, body: {} }],
    ...(admin
      ? [
          [admin.path, { code: 0, body: { qa: qaFor("batch_branch") } }] as [
            string,
            { code: number; body: unknown },
          ],
        ]
      : []),
  ]);
  return {
    dir,
    env: { ...process.env, XDG_STATE_HOME: state, QA_AUTH: "user1:pass1" },
    common,
    web,
    api,
    admin,
    answers,
    calls: [],
    headWeb,
    headApi,
  };
}

/** git は本物、子の CLI（node）は answers の答えを返す Runner */
function runnerOf(g: Group): Runner {
  return async (cmd, args, opts) => {
    g.calls.push({ cmd, args: [...args], cwd: opts?.cwd });
    if (cmd === process.execPath) {
      const answer = g.answers.get(opts?.cwd ?? "");
      const done = (r: Partial<RunResult>): RunResult => ({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...r,
      });
      if (!answer || args[2] !== "config") return done({ code: 1 });
      return done({
        code: answer.code,
        stdout: answer.code === 0 ? JSON.stringify(answer.body) : "",
        stderr: answer.code === 0 ? "" : "子の失敗",
      });
    }
    return realRunner(cmd, args, opts);
  };
}

async function qa(g: Group, argv: string[], cwd = g.dir) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["qa", ...argv], {
    cwd,
    runner: runnerOf(g),
    env: g.env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const GROUP_BRANCH = "task/T01-order-limit";

const deployArgs = (g: Group, env = "1", target = GROUP_BRANCH) => [
  "deploy",
  target,
  "--env",
  env,
  "--head",
  `demo-web=${g.headWeb}`,
  "--head",
  `demo-api=${g.headApi}`,
];

const leaseFile = async (g: Group) =>
  JSON.parse(await readFile(leasesPath(g.env), "utf8")) as {
    urls: Record<
      string,
      Record<string, { id: string; repo: string; apps?: { name: string }[] }>
    >;
  };

describe("組の qa plan", () => {
  it("子の設定を読み、アプリごとのブランチと先頭・欄の表・次の1行を出す", async () => {
    const g = await setup();
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `demo-web：task/T01-order-limit（origin の先頭 ${g.headWeb}）`,
    );
    expect(r.out).toContain(
      `demo-api：task/T01-order-limit（origin の先頭 ${g.headApi}）`,
    );
    expect(r.out).toContain("web_branch = task/T01-order-limit");
    expect(r.out).toContain("api_branch = task/T01-order-limit");
    expect(r.out).toContain("batch_branch = dev");
    expect(r.out).toContain(
      `orca-flow qa deploy ${GROUP_BRANCH} --env 1 --head demo-web=${g.headWeb} --head demo-api=${g.headApi}`,
    );
    expect(seen).toHaveLength(0);
    const configCalls = g.calls.filter(
      (c) => c.cmd === process.execPath && c.args.includes("config"),
    );
    expect(configCalls.length).toBeGreaterThanOrEqual(2);
    expect(configCalls.every((c) => c.args.includes("--json"))).toBe(true);
  });

  it("--json は今と同じ形にアプリごとの中身が足される", async () => {
    const g = await setup();
    const r = await qa(g, ["plan", GROUP_BRANCH, "--json"]);
    const data = JSON.parse(r.out);
    expect(data).toMatchObject({ id: "T01", env: 1, reused: false });
    expect(data.fields).toMatchObject({
      web_branch: "task/T01-order-limit",
      api_branch: "task/T01-order-limit",
    });
    expect(data.apps).toEqual([
      expect.objectContaining({ name: "demo-web", head: g.headWeb }),
      expect.objectContaining({ name: "demo-api", head: g.headApi }),
    ]);
  });

  it("タスクのブランチのないアプリは組に入れない", async () => {
    const g = await setup();
    await git(g.api.path, "branch", "-D", "task/T01-order-limit");
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("demo-api：");
    expect(r.out).toContain("api_branch = main");
  });
});

describe("組の読み取りの終了コード", () => {
  it("子の qa が selfField 以外で違えば1で、違う子とキーを出す", async () => {
    const g = await setup();
    g.answers.set(g.api.path, {
      code: 0,
      body: { qa: qaFor("api_branch", { successText: "other" }) },
    });
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("demo-api");
    expect(r.err).toContain("successText");
  });

  it("selfField が重なれば1", async () => {
    const g = await setup();
    g.answers.set(g.api.path, { code: 0, body: { qa: qaFor("web_branch") } });
    expect((await qa(g, ["plan", GROUP_BRANCH])).code).toBe(1);
  });

  it("qa のある子がなければ2", async () => {
    const g = await setup();
    g.answers.set(g.web.path, { code: 0, body: {} });
    g.answers.set(g.api.path, { code: 0, body: {} });
    expect((await qa(g, ["plan", GROUP_BRANCH])).code).toBe(2);
  });

  it("組のアプリがなければ1", async () => {
    const g = await setup();
    expect((await qa(g, ["plan", "task/T09-nothing"])).code).toBe(1);
  });

  it("ブランチがあって qa のないアプリがあれば1", async () => {
    const g = await setup({ apiQa: null });
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("demo-api");
  });

  it("子の設定を読めなければ1", async () => {
    const g = await setup();
    g.answers.set(g.web.path, { code: 1, body: null });
    expect((await qa(g, ["plan", GROUP_BRANCH])).code).toBe(1);
  });

  it("組のアプリの1つが origin になければ2で、何も送らない", async () => {
    const g = await setup();
    await git(
      g.api.path,
      "push",
      "--quiet",
      "origin",
      "--delete",
      "task/T01-order-limit",
    );
    expect((await qa(g, ["plan", GROUP_BRANCH])).code).toBe(2);
    expect((await qa(g, deployArgs(g))).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("枝の取り込みの確かめ", () => {
  const composer = (ref: string) => ({
    "composer.json": `{"require": {"orca/core": "${ref}"}}\n`,
  });

  it("枝の名前が残り、共通の枝が origin になければ2で止める", async () => {
    const g = await setup({ webFiles: composer("dev-task/T01-order-limit") });
    await git(g.common.path, "branch", "task/T01-order-limit");
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "demo-web は demo-core を枝 task/T01-order-limit で取り込んだままで、その枝が origin にありません",
    );
    expect((await qa(g, deployArgs(g))).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("共通の枝が origin にあれば通し、その旨を1行出す", async () => {
    const g = await setup({ webFiles: composer("dev-task/T01-order-limit") });
    await taskBranch(g.common, "task/T01-order-limit");
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("task/T01-order-limit");
    expect(r.out).toContain("origin にあるので通します");
    const sent = await qa(g, deployArgs(g));
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("origin にあるので通します");
    expect(seen).toHaveLength(1);
  });

  it("origin の先頭が手元になく確かめられなければ、plan も deploy も1で送らない", async () => {
    const g = await setup({ webFiles: composer("^1.2") });
    await git(g.common.path, "branch", "task/T01-order-limit");
    const other = await tempDir("orca-flow-qa-clone-");
    await git(other, "clone", "--quiet", g.web.origin, "w");
    const clone = `${other}/w`;
    await git(clone, "config", "user.name", "テスト");
    await git(clone, "config", "user.email", "test@example.com");
    await git(clone, "switch", "--quiet", "task/T01-order-limit");
    await writeFiles(clone, { "composer.json": "{}\n" });
    await git(clone, "commit", "--quiet", "-am", "more");
    await git(clone, "push", "--quiet", "origin", "task/T01-order-limit");
    g.headWeb = await git(clone, "rev-parse", "HEAD");
    const plan = await qa(g, ["plan", GROUP_BRANCH]);
    const deploy = await qa(g, deployArgs(g));
    for (const r of [plan, deploy]) {
      expect(r.code).toBe(1);
      expect(r.err).toContain("確かめられません");
    }
    expect(seen).toHaveLength(0);
  });

  it("枝の名前が残っていなければ共通の origin を見ない", async () => {
    const g = await setup({ webFiles: composer("^1.2") });
    await git(g.common.path, "branch", "task/T01-order-limit");
    expect((await qa(g, ["plan", GROUP_BRANCH])).code).toBe(0);
    expect(
      g.calls.some(
        (c) => c.args.includes("ls-remote") && c.cwd === g.common.path,
      ),
    ).toBe(false);
  });

  it("共通に同じ ID のブランチがなければ確かめない", async () => {
    const g = await setup({ webFiles: composer("dev-task/T01-order-limit") });
    expect((await qa(g, ["plan", GROUP_BRANCH])).code).toBe(0);
  });
});

describe("組の qa deploy", () => {
  it("組のアプリの各欄にブランチ、ほかに既定を入れた1回の POST を送り、組の貸し出しを記録する", async () => {
    const g = await setup();
    const r = await qa(g, deployArgs(g, "2"));
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
    expect(Object.fromEntries(seen[0]!.form)).toEqual({
      mode: "qa",
      web_branch: "task/T01-order-limit",
      api_branch: "task/T01-order-limit",
      batch_branch: "dev",
      env_no: "2",
    });
    const lease = (await leaseFile(g)).urls[baseUrl]!["2"]!;
    expect(lease.id).toBe("T01");
    expect(lease.repo).not.toBe(g.web.path);
    expect(lease.apps?.map((a) => a.name)).toEqual(["demo-web", "demo-api"]);
    expect(r.out + r.err).not.toContain("user1");
    expect(r.out + r.err).not.toContain("queued OK");
  });

  it("組のアプリでない欄の --branch と --database は受ける", async () => {
    const g = await setup();
    const r = await qa(g, [
      ...deployArgs(g),
      "--branch",
      "batch_branch=feature/x",
      "--database",
    ]);
    expect(r.code).toBe(0);
    expect(Object.fromEntries(seen[0]!.form)).toMatchObject({
      batch_branch: "feature/x",
      reset_db: "1",
    });
  });

  it("--head が足りない・余る・先頭が違う・形が違うは1で送らない", async () => {
    const g = await setup();
    const base = ["deploy", GROUP_BRANCH, "--env", "1"];
    const web = `demo-web=${g.headWeb}`;
    const api = `demo-api=${g.headApi}`;
    const cases = [
      ["--head", web],
      ["--head", web, "--head", api, "--head", `demo-core=${g.headApi}`],
      ["--head", web, "--head", `demo-api=${"0".repeat(40)}`],
      ["--head", web, "--head", web],
      ["--head", g.headWeb],
      [],
    ];
    for (const extra of cases)
      expect((await qa(g, [...base, ...extra])).code).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("組のアプリの欄への --branch と --json は1で送らない", async () => {
    const g = await setup();
    expect(
      (await qa(g, [...deployArgs(g), "--branch", "web_branch=x"])).code,
    ).toBe(1);
    expect(
      (await qa(g, [...deployArgs(g), "--branch", "api_branch=x"])).code,
    ).toBe(1);
    expect((await qa(g, [...deployArgs(g), "--json"])).code).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("認証の環境変数がなければ2で送らない", async () => {
    const g = await setup();
    g.env.QA_AUTH = undefined;
    expect((await qa(g, deployArgs(g))).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("組の貸し出し", () => {
  it("組のアプリのリポジトリが借りていれば、plan はその番号を選び、成功で組の貸し出しに書き直す", async () => {
    const g = await setup();
    await borrow(g.env, baseUrl, 2, {
      repo: g.api.path,
      id: "T01",
      branch: "task/T01-order-limit",
      head: g.headApi,
      at: "2030-01-01T00:00:00.000Z",
    });
    const plan = await qa(g, ["plan", GROUP_BRANCH]);
    expect(plan.out).toContain("--env 2 ");
    expect(plan.out).toContain("使い直し");
    expect((await qa(g, deployArgs(g, "2"))).code).toBe(0);
    const lease = (await leaseFile(g)).urls[baseUrl]!["2"]!;
    expect(lease.apps).toHaveLength(2);
    expect(lease.repo).not.toBe(g.api.path);
  });

  it("失敗のとき、使い直しの貸し出しは残り、新しく借りた分は消える", async () => {
    const g = await setup();
    await borrow(g.env, baseUrl, 2, {
      repo: g.api.path,
      id: "T01",
      branch: "task/T01-order-limit",
      head: g.headApi,
      at: "2030-01-01T00:00:00.000Z",
    });
    reply = { status: 500, body: "boom" };
    const reused = await qa(g, deployArgs(g, "2"));
    expect(reused.code).toBe(1);
    expect((await leaseFile(g)).urls[baseUrl]!["2"]!.repo).toBe(g.api.path);
    const fresh = await qa(g, deployArgs(g, "1"));
    expect(fresh.code).toBe(1);
    expect((await leaseFile(g)).urls[baseUrl]!["1"]).toBeUndefined();
    expect(reused.out + reused.err + fresh.out + fresh.err).not.toContain(
      "boom",
    );
  });

  it("別のタスクが借りた番号は2で使わない", async () => {
    const g = await setup();
    await qa(g, deployArgs(g, "1"));
    await git(g.web.path, "branch", "task/T02-web");
    await git(g.web.path, "push", "--quiet", "origin", "task/T02-web");
    const head = await git(g.web.path, "rev-parse", "task/T02-web");
    const r = await qa(g, [
      "deploy",
      "task/T02-web",
      "--env",
      "1",
      "--head",
      `demo-web=${head}`,
    ]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("list がアプリごとのブランチを出し、release が組の分を返す", async () => {
    const g = await setup();
    await qa(g, deployArgs(g, "1"));
    const list = await qa(g, ["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("demo-web：task/T01-order-limit");
    expect(list.out).toContain("demo-api：task/T01-order-limit");
    expect(list.out).toContain("環境 2：空き");
    const released = await qa(g, ["release", GROUP_BRANCH]);
    expect(released.code).toBe(0);
    expect(released.out).toContain("QA 環境 1");
    expect((await qa(g, ["list"])).out).toContain("環境 1：空き");
  });

  it("release --env で返せる", async () => {
    const g = await setup();
    await qa(g, deployArgs(g, "2"));
    const r = await qa(g, ["release", "--env", "2"]);
    expect(r.out).toContain("QA 環境 2");
  });

  it("子の release は組の貸し出しを返さず、組で返す案内を出す。plan は番号を変えず1行添える", async () => {
    const g = await setup();
    await qa(g, deployArgs(g, "2"));
    const plan = await qa(g, ["plan", "T01"], g.web.path);
    expect(plan.code).toBe(0);
    expect(plan.out).toMatch(/組（.+）が QA 環境 2 で借りています/);
    expect(plan.out).toContain("--env 1 ");
    const r = await qa(g, ["release", "T01"], g.web.path);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QA 環境 2 は組（");
    expect(r.out).toContain(
      "ワークスペースのフォルダで `orca-flow qa release task/T01-order-limit`",
    );
    expect(r.out).toContain("orca-flow qa release --env 2");
    expect(r.out).not.toContain("返すものはありませんでした");
    expect((await leaseFile(g)).urls[baseUrl]!["2"]).toBeDefined();
  });

  it("子の手元に同じ ID のブランチが1つに決まらなければ、組の release の案内は --env だけで、ID で打つ1行を出さない", async () => {
    const g = await setup();
    await qa(g, deployArgs(g, "2"));
    await git(g.web.path, "branch", "task/T01-member-export");
    const r = await qa(g, ["release", "T01"], g.web.path);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QA 環境 2 は組（");
    expect(r.out).toContain("`orca-flow qa release --env 2`");
    expect(r.out).not.toContain("orca-flow qa release T01");
    expect(r.out).not.toContain("ワークスペースのフォルダで");
  });

  it("子の qa list は組の貸し出しを読める", async () => {
    const g = await setup();
    await qa(g, deployArgs(g, "1"));
    const out: string[] = [];
    const code = await main(["qa", "list"], {
      cwd: g.web.path,
      runner: testRunner,
      env: g.env,
      stdout: (t) => out.push(t),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("T01");
  });
});

describe("組をブランチ名で見分ける", () => {
  it("plan はそのブランチ名のあるアプリだけを組にし、番号だけ同じアプリの欄は既定のまま", async () => {
    const g = await setup({ admin: true });
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`demo-web：${GROUP_BRANCH}`);
    expect(r.out).toContain(`demo-api：${GROUP_BRANCH}`);
    expect(r.out).not.toContain("demo-admin：");
    expect(r.out).not.toContain("task/T01-member-export");
    expect(r.out).toContain("batch_branch = dev");
    expect(r.out).toContain(
      `orca-flow qa deploy ${GROUP_BRANCH} --env 1 --head demo-web=${g.headWeb} --head demo-api=${g.headApi}`,
    );
    expect(seen).toHaveLength(0);
  });

  it("deploy はそのブランチ名のアプリの欄だけを送り、組の貸し出しを書く", async () => {
    const g = await setup({ admin: true });
    const r = await qa(g, deployArgs(g, "1", GROUP_BRANCH));
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]!.form)).toEqual({
      mode: "qa",
      web_branch: GROUP_BRANCH,
      api_branch: GROUP_BRANCH,
      batch_branch: "dev",
      env_no: "1",
    });
    const lease = (await leaseFile(g)).urls[baseUrl]!["1"]!;
    expect(lease.id).toBe("T01");
    expect(lease.apps?.map((a) => a.name)).toEqual(["demo-web", "demo-api"]);
  });

  it("release はブランチ名で組の貸し出しを返す", async () => {
    const g = await setup({ admin: true });
    await qa(g, deployArgs(g, "2", GROUP_BRANCH));
    const r = await qa(g, ["release", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QA 環境 2");
    expect((await leaseFile(g)).urls[baseUrl]).toBeUndefined();
  });

  it("組の貸し出しは、ID の欄が違っても同じワークスペースとブランチ名なら同じ持ち主として使い直し・返す", async () => {
    const g = await setup({ admin: true });
    expect((await qa(g, deployArgs(g, "2"))).code).toBe(0);
    const held = (await leaseFile(g)).urls[baseUrl]!["2"]! as unknown as Lease;
    await recordLease(g.env, baseUrl, 2, { ...held, id: "T07" });
    const plan = await qa(g, ["plan", GROUP_BRANCH]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("--env 2 ");
    expect(plan.out).toContain("使い直し");
    const r = await qa(g, ["release", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QA 環境 2（T07）を空きに戻しました");
    expect((await leaseFile(g)).urls[baseUrl]).toBeUndefined();
  });

  it("release はブランチ名で比べ、同じ ID でもブランチ名の違う組の貸し出しは返さない", async () => {
    const g = await setup({ admin: true });
    expect((await qa(g, deployArgs(g, "2", GROUP_BRANCH))).code).toBe(0);
    const held = (await leaseFile(g)).urls[baseUrl]!["2"]! as unknown as Lease;
    await recordLease(g.env, baseUrl, 2, {
      ...held,
      apps: held.apps!.map((a) => ({ ...a, branch: "task/T01-member-export" })),
    });
    const r = await qa(g, ["release", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("空きに戻しました");
    expect((await leaseFile(g)).urls[baseUrl]!["2"]).toBeDefined();
  });

  it("組のブランチを消したあとも、ブランチ名の release は記録のアプリのブランチ名と照らして返す", async () => {
    const g = await setup({ admin: true });
    expect((await qa(g, deployArgs(g, "2", GROUP_BRANCH))).code).toBe(0);
    await git(g.web.path, "branch", "-D", GROUP_BRANCH);
    await git(g.api.path, "branch", "-D", GROUP_BRANCH);
    const r = await qa(g, ["release", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QA 環境 2（T01）を空きに戻しました");
    expect((await leaseFile(g)).urls[baseUrl]).toBeUndefined();
  });

  it("どのアプリにもなく貸し出しにもないブランチ名の release は1。同じ ID の組の貸し出しがあれば番号と --env を案内する", async () => {
    const g = await setup({ admin: true });
    const none = await qa(g, ["release", "task/T09-nothing"]);
    expect(none.code).toBe(1);
    expect((await qa(g, deployArgs(g, "2", GROUP_BRANCH))).code).toBe(0);
    const before = await readFile(leasesPath(g.env), "utf8");
    const r = await qa(g, ["release", "task/T01-nothing"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QA 環境 2");
    expect(r.out).toContain("orca-flow qa release --env 2");
    expect(r.out).not.toContain("借りている環境はありません");
    expect(await readFile(leasesPath(g.env), "utf8")).toBe(before);
  });

  it("ブランチ名の形が外れる・どのアプリにもない引数は1で何も送らない", async () => {
    const g = await setup({ admin: true });
    for (const target of [
      "feature/order-limit",
      "task/T09-nothing",
      "task/T01-",
    ]) {
      expect((await qa(g, ["plan", target])).code).toBe(1);
      expect((await qa(g, deployArgs(g, "1", target))).code).toBe(1);
    }
    expect(seen).toHaveLength(0);
  });

  it("共通の枝の取り込みは、組と同じ短い名前の枝だけを見る", async () => {
    const g = await setup({
      webFiles: {
        "composer.json":
          '{"require": {"orca/core": "dev-task/T01-member-export"}}\n',
      },
    });
    await git(g.common.path, "branch", "task/T01-member-export");
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(0);
    expect(
      g.calls.some(
        (c) => c.args.includes("ls-remote") && c.cwd === g.common.path,
      ),
    ).toBe(false);
  });

  it("組の空きの選び方は、同じ ID でもブランチ名の違う組の貸し出しと子の貸し出しを使い直さない", async () => {
    const g = await setup({ admin: true });
    expect((await qa(g, deployArgs(g, "1", GROUP_BRANCH))).code).toBe(0);
    const held = (await leaseFile(g)).urls[baseUrl]!["1"]! as unknown as Lease;
    await release(g.env, baseUrl, { env: 1 });
    await borrow(g.env, baseUrl, 1, {
      ...held,
      apps: held.apps!.map((a) => ({ ...a, branch: "task/T01-member-export" })),
    });
    await borrow(g.env, baseUrl, 2, {
      repo: g.api.path,
      id: "T01",
      branch: "task/T01-member-export",
      head: g.headApi,
      at: "2030-01-01T00:00:00.000Z",
    });
    const r = await qa(g, ["plan", GROUP_BRANCH]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("使い直し");
  });

  it("子の plan・release の組の案内は、ブランチ名の違う組の貸し出しには出ない", async () => {
    const g = await setup();
    expect((await qa(g, deployArgs(g, "2", GROUP_BRANCH))).code).toBe(0);
    const held = (await leaseFile(g)).urls[baseUrl]!["2"]! as unknown as Lease;
    await recordLease(g.env, baseUrl, 2, {
      ...held,
      apps: held.apps!.map((a) => ({ ...a, branch: "task/T01-member-export" })),
    });
    const plan = await qa(g, ["plan", "T01"], g.web.path);
    expect(plan.code).toBe(0);
    expect(plan.out).not.toContain("組（");
    const r = await qa(g, ["release", "T01"], g.web.path);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("組（");
    expect(r.out).toContain("返すものはありませんでした");
  });
});

describe("組を ID で打つと止まる", () => {
  const idCases = (g: Group) =>
    [
      [["plan", "T01"], "plan"],
      [deployArgs(g, "1", "T01"), "plan"],
      [["release", "T01"], "release"],
    ] as const;

  it("短い名前がそろっていても plan・deploy・release は1で候補と打ち直しの1行を出し、送らず借りず返さない", async () => {
    const g = await setup();
    expect((await qa(g, deployArgs(g, "2"))).code).toBe(0);
    seen = [];
    const before = await readFile(leasesPath(g.env), "utf8");
    for (const [argv, sub] of idCases(g)) {
      const r = await qa(g, [...argv]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`demo-web：${GROUP_BRANCH}`);
      expect(r.err).toContain(`demo-api：${GROUP_BRANCH}`);
      expect(r.err).toContain(
        `ブランチ名で打ち直してください（例：orca-flow qa ${sub} ${GROUP_BRANCH}）`,
      );
    }
    expect(seen).toHaveLength(0);
    expect(await readFile(leasesPath(g.env), "utf8")).toBe(before);
  });

  it("短い名前が混ざれば plan・deploy・release は1で子ごとの候補と打ち直しの1行を出し、送らず借りず返さない", async () => {
    const g = await setup({ admin: true });
    expect((await qa(g, deployArgs(g, "2"))).code).toBe(0);
    seen = [];
    const before = await readFile(leasesPath(g.env), "utf8");
    for (const [argv, sub] of idCases(g)) {
      const r = await qa(g, [...argv]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`demo-web：${GROUP_BRANCH}`);
      expect(r.err).toContain(`demo-api：${GROUP_BRANCH}`);
      expect(r.err).toContain("demo-admin：task/T01-member-export");
      expect(r.err).toContain(
        `ブランチ名で打ち直してください（例：orca-flow qa ${sub} ${GROUP_BRANCH}）`,
      );
    }
    expect(seen).toHaveLength(0);
    expect(await readFile(leasesPath(g.env), "utf8")).toBe(before);
  });

  it("組のブランチを消したあとも、ID の release は番号だけ同じブランチを組に選ばず1で、貸し出しを残す", async () => {
    const g = await setup({ admin: true });
    expect((await qa(g, deployArgs(g, "2"))).code).toBe(0);
    await git(g.web.path, "branch", "-D", GROUP_BRANCH);
    await git(g.api.path, "branch", "-D", GROUP_BRANCH);
    const before = await readFile(leasesPath(g.env), "utf8");
    const r = await qa(g, ["release", "T01"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("demo-admin：task/T01-member-export");
    expect(r.out).not.toContain("空きに戻しました");
    expect(await readFile(leasesPath(g.env), "utf8")).toBe(before);
  });

  it("どのアプリの子にも ID のブランチがなければ1で、ブランチ名で打つよう案内し例の行を出さない", async () => {
    const g = await setup();
    for (const argv of [
      ["plan", "T09"],
      deployArgs(g, "1", "T09"),
      ["release", "T09"],
    ]) {
      const r = await qa(g, argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain("ブランチ名");
      expect(r.err).not.toContain("例：");
    }
    expect(seen).toHaveLength(0);
  });
});
