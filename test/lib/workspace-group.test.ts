import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { writeCompanionAt } from "../../src/lib/companion.ts";
import { realRunner } from "../../src/lib/exec.ts";
import {
  OUTSIDE_GROUP_REASON,
  outsideGroupReason,
} from "../../src/lib/workspace-group.ts";
import type { Workspace, WorkspaceRepo } from "../../src/lib/workspace.ts";
import { git, makeRepo } from "../init/helpers.ts";

const repoOf = (
  name: string,
  dir: string,
  role: "common" | "app",
): WorkspaceRepo => ({
  name,
  path: realpathSync(dir),
  role,
  keywords: [],
});

function setup() {
  const core = makeRepo();
  const other = makeRepo();
  const app = makeRepo();
  const workspace = {
    dir: "/unused",
    repos: [repoOf("core", core, "common"), repoOf("web", app, "app")],
  } as unknown as Workspace;
  return { core, other, app, workspace, web: workspace.repos[1]! };
}

function put(app: string, id: string, text: string) {
  const common = git(
    app,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  const dir = path.join(common, "orca-flow", "cross-depends");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), text);
}

const record = (id: string, repos: { path: string; ids: string[] }[]) =>
  JSON.stringify({
    id,
    at: "2026-01-01T00:00:00.000Z",
    repos: repos.map((r, i) => ({
      name: `dep${i}`,
      path: realpathSync(r.path),
      package: "@demo/dep",
      version: "1.0.0",
      ids: r.ids,
    })),
  });

const none = { kind: "none" } as const;
const GROUP_BRANCH = "task/T1-order-limit";

describe("outsideGroupReason（またぐ依存の記録）", () => {
  const reasonOf = (s: ReturnType<typeof setup>, id = "T1") =>
    outsideGroupReason(realRunner, s.workspace, s.web, id, none, GROUP_BRANCH);

  it("共通の同じ ID への依存があれば組のアプリ", async () => {
    const s = setup();
    put(s.app, "T1", record("T1", [{ path: s.core, ids: ["T1"] }]));
    expect(await reasonOf(s)).toBeNull();
  });

  it("記録がなければ組の外", async () => {
    const s = setup();
    expect(await reasonOf(s)).toBe(OUTSIDE_GROUP_REASON);
  });

  it("共通でない依存先だけなら組の外", async () => {
    const s = setup();
    put(s.app, "T1", record("T1", [{ path: s.other, ids: ["T1"] }]));
    expect(await reasonOf(s)).toBe(OUTSIDE_GROUP_REASON);
  });

  it("共通への依存の ids に ID がなければ組の外", async () => {
    const s = setup();
    put(s.app, "T1", record("T1", [{ path: s.core, ids: ["T2"] }]));
    expect(await reasonOf(s)).toBe(OUTSIDE_GROUP_REASON);
  });

  it("記録が壊れていれば終了コード1の FlowError", async () => {
    const s = setup();
    put(s.app, "T1", "{broken");
    await expect(reasonOf(s)).rejects.toMatchObject({ code: 1 });
  });
});

describe("outsideGroupReason（伴う記録）", () => {
  function companionSetup() {
    const e2e = makeRepo();
    const app = makeRepo();
    const other = makeRepo();
    const workspace = {
      dir: "/unused",
      repos: [
        repoOf("web", app, "app"),
        repoOf("admin", other, "app"),
        {
          ...repoOf("e2e-tests", e2e, "app"),
          companion: {
            apps: ["web"],
            when: "画面の動きが変わるとき",
            command: "run {previewUrl:web}",
          },
        },
      ],
    } as unknown as Workspace;
    const common = git(
      e2e,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ).trim();
    return { app, e2e, workspace, common };
  }

  it("共通がなくても、companion のある子の伴う記録に載ったアプリは組のアプリ", async () => {
    const s = companionSetup();
    await writeCompanionAt(
      s.common,
      "T1",
      {
        command: "run {previewUrl:web}",
        apps: [{ name: "web", path: realpathSync(s.app) }],
      },
      new Date(),
    );
    const [web, admin] = s.workspace.repos;
    const reasonOf = (repo: WorkspaceRepo, id: string) =>
      outsideGroupReason(realRunner, s.workspace, repo, id, none, GROUP_BRANCH);
    expect(await reasonOf(web!, "T1")).toBeNull();
    expect(await reasonOf(admin!, "T1")).toBe(OUTSIDE_GROUP_REASON);
    expect(await reasonOf(web!, "T2")).toBe(OUTSIDE_GROUP_REASON);
  });

  it("伴う記録が壊れていれば終了コード1の FlowError", async () => {
    const s = companionSetup();
    const dir = path.join(s.common, "orca-flow", "companion");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "T1.json"), "{broken");
    await expect(
      outsideGroupReason(
        realRunner,
        s.workspace,
        s.workspace.repos[0]!,
        "T1",
        none,
        GROUP_BRANCH,
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe("outsideGroupReason", () => {
  it("組のブランチがあれば、記録がなくても組のアプリ", async () => {
    const s = setup();
    expect(
      await outsideGroupReason(
        realRunner,
        s.workspace,
        s.web,
        "T1",
        { kind: "branch", branch: GROUP_BRANCH },
        GROUP_BRANCH,
      ),
    ).toBeNull();
  });

  it("短い名前の違うブランチしかなければ、記録があっても組の外で、そのブランチ名を出す", async () => {
    const s = setup();
    put(s.app, "T1", record("T1", [{ path: s.core, ids: ["T1"] }]));
    const reason = await outsideGroupReason(
      realRunner,
      s.workspace,
      s.web,
      "T1",
      {
        kind: "other",
        branches: ["task/T1-member-export"],
      },
      GROUP_BRANCH,
    );
    expect(reason).toContain("組の外");
    expect(reason).toContain("task/T1-member-export");
  });

  it("組の外の理由に出すブランチ名は、制御文字を見える形にする", async () => {
    const s = setup();
    const reason = await outsideGroupReason(
      realRunner,
      s.workspace,
      s.web,
      "T1",
      { kind: "other", branches: ["task/T1-a\u001b[2Jb"] },
      GROUP_BRANCH,
    );
    expect(reason).not.toContain("\u001b");
    expect(reason).toContain("task/T1-a\\u{1b}[2Jb");
  });

  it("ブランチで決まらなければ記録で見る", async () => {
    const s = setup();
    expect(
      await outsideGroupReason(
        realRunner,
        s.workspace,
        s.web,
        "T1",
        none,
        GROUP_BRANCH,
      ),
    ).toBe(OUTSIDE_GROUP_REASON);
    put(s.app, "T1", record("T1", [{ path: s.core, ids: ["T1"] }]));
    expect(
      await outsideGroupReason(
        realRunner,
        s.workspace,
        s.web,
        "T1",
        undefined,
        GROUP_BRANCH,
      ),
    ).toBeNull();
  });
});

describe("outsideGroupReason（記録のタスクのブランチ名）", () => {
  const withBranch = (core: string, taskBranch: string) =>
    JSON.stringify({
      ...JSON.parse(record("T1", [{ path: core, ids: ["T1"] }])),
      taskBranch,
    });

  it("記録のタスクのブランチ名が組のブランチ名と違えば組の外で、そのブランチ名を出す", async () => {
    const s = setup();
    put(s.app, "T1", withBranch(s.core, "task/T1-member-export"));
    const reason = await outsideGroupReason(
      realRunner,
      s.workspace,
      s.web,
      "T1",
      none,
      "task/T1-order-limit",
    );
    expect(reason).toContain("組の外");
    expect(reason).toContain("task/T1-member-export");
  });

  it("記録のタスクのブランチ名が組のブランチ名と同じなら組のアプリ", async () => {
    const s = setup();
    put(s.app, "T1", withBranch(s.core, "task/T1-order-limit"));
    expect(
      await outsideGroupReason(
        realRunner,
        s.workspace,
        s.web,
        "T1",
        none,
        "task/T1-order-limit",
      ),
    ).toBeNull();
  });

  it("タスクのブランチ名のない古い記録は ID で当たる", async () => {
    const s = setup();
    put(s.app, "T1", record("T1", [{ path: s.core, ids: ["T1"] }]));
    expect(
      await outsideGroupReason(
        realRunner,
        s.workspace,
        s.web,
        "T1",
        none,
        "task/T1-order-limit",
      ),
    ).toBeNull();
  });

  it("組のブランチ名は省けない（省くと型の誤り）", () => {
    expectTypeOf<
      Parameters<typeof outsideGroupReason>[5]
    >().toEqualTypeOf<string>();
    // 呼ばずに型だけを確かめる。省ける形に戻すと、使われない @ts-expect-error で typecheck が落ちる
    const omitted = (s: ReturnType<typeof setup>) =>
      // @ts-expect-error 組のブランチ名は省けない
      outsideGroupReason(realRunner, s.workspace, s.web, "T1", none);
    expect(omitted).toBeTypeOf("function");
  });

  it("伴う記録のタスクのブランチ名も組のブランチ名と比べる", async () => {
    const e2e = makeRepo();
    const app = makeRepo();
    const workspace = {
      dir: "/unused",
      repos: [
        repoOf("web", app, "app"),
        {
          ...repoOf("e2e-tests", e2e, "app"),
          companion: {
            apps: ["web"],
            when: "画面の動きが変わるとき",
            command: "run {previewUrl:web}",
          },
        },
      ],
    } as unknown as Workspace;
    const common = git(
      e2e,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ).trim();
    await writeCompanionAt(
      common,
      "T1",
      {
        command: "run {previewUrl:web}",
        apps: [{ name: "web", path: realpathSync(app) }],
      },
      new Date(),
      "task/T1-member-export",
    );
    const web = workspace.repos[0]!;
    const reason = await outsideGroupReason(
      realRunner,
      workspace,
      web,
      "T1",
      none,
      "task/T1-order-limit",
    );
    expect(reason).toContain("組の外");
    expect(reason).toContain("task/T1-member-export");
    expect(
      await outsideGroupReason(
        realRunner,
        workspace,
        web,
        "T1",
        none,
        "task/T1-member-export",
      ),
    ).toBeNull();
  });
});
