import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { readAuto, newRecord, writeAuto } from "../../src/lib/auto.ts";
import { readReviewed, writeReviewed } from "../../src/lib/rebase-review.ts";
import {
  createLedger,
  readLedger,
  reviewLedgerPath,
  writeLedger,
} from "../../src/lib/review-ledger.ts";
import {
  appendStage,
  listStageIds,
  readStages,
} from "../../src/lib/stage-log.ts";
import {
  outboxTaskIds,
  readItem,
  readItems,
  writeItem,
  type OutboxItem,
} from "../../src/lib/outbox.ts";
import { readPushRecord, writePushRecord } from "../../src/lib/finish.ts";
import { reportPath, taskDocPath } from "../../src/lib/tasks.ts";
import { commonRecordPath } from "../../src/lib/task-id.ts";
import {
  clearRecord,
  readRecord,
  writeRecord,
} from "../../src/lib/verified.ts";
import { FlowError } from "../../src/types.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const BAD = "../x1";

/** 木の中の全ファイルと、その中身（変わったかを見るため） */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        out[`${path.relative(dir, full)}/`] = "";
        await walk(full);
      } else out[path.relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
}

const outboxItem = (taskId: string): OutboxItem =>
  ({
    id: "push-v1",
    taskId,
    kind: "push",
    version: 1,
    body: "b",
    head: "h",
    state: "queued",
    target: {},
  }) as unknown as OutboxItem;

const rejects = async (run: () => unknown) => {
  const error = await Promise.resolve()
    .then(run)
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(FlowError);
  expect((error as FlowError).code).toBe(1);
  expect((error as FlowError).message).toContain("ID の形が正しくありません");
};

describe("ID で組む記録の場所：形の外れた ID は読まず書かず消さない", () => {
  it("共通ディレクトリの下の各場所が FlowError(1) で、何も作らず消さない", async () => {
    const root = await makeRepo();
    const common = (
      await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim();
    // 外れた ID が指しうる場所に、先にファイルと中ごと消されうる入れ物を置く
    await writeFiles(common, {
      "orca-flow/x1.md": "依頼",
      "orca-flow/x1.json": "{}",
      "orca-flow/x1/keep.gif": "gif",
      "orca-flow/captures/T01/a.gif": "gif",
      "orca-flow/verified/T01.json": "{}",
      "outside.txt": "外",
    });
    const before = await snapshot(common);

    await rejects(() => commonRecordPath(common, "requests", BAD, ".md"));
    await rejects(() => commonRecordPath(common, "captures", BAD, ""));
    await rejects(() => readReviewed(testRunner, root, BAD));
    await rejects(() =>
      writeReviewed(testRunner, root, {
        id: BAD,
        head: "a",
        fingerprint: "b",
        at: "c",
      }),
    );
    await rejects(() => readRecord(testRunner, root, BAD));
    await rejects(() =>
      writeRecord(testRunner, root, {
        id: BAD,
        head: "a",
        base: "b",
        commands: [],
        at: "c",
      }),
    );
    await rejects(() => clearRecord(testRunner, root, BAD));
    await rejects(() => reviewLedgerPath(testRunner, root, BAD, 1));
    await rejects(() => readLedger(testRunner, root, BAD, 1));
    await rejects(() =>
      writeLedger(
        testRunner,
        root,
        createLedger({
          taskId: BAD,
          stage: 1,
          baseBranch: "main",
          range: "main...HEAD",
          now: "t",
        }),
      ),
    );
    await rejects(() =>
      writeAuto(common, newRecord(BAD, new Date("2026-01-01T00:00:00Z"))),
    );
    // 読むだけの auto は、これまでどおり読まずに null
    expect(await readAuto(common, BAD)).toBeNull();
    // push の記録：書くのは FlowError(1)、読むのは null
    await rejects(() => writePushRecord(testRunner, root, BAD, { id: BAD }));
    expect(await readPushRecord(testRunner, root, BAD)).toBeNull();
    // 段の記録
    const entry = { at: "t", state: "s", note: null, command: "c" };
    await rejects(() => appendStage(common, BAD, entry));
    await rejects(() => readStages(common, BAD));
    // outbox
    await rejects(() => readItem(common, BAD, "push-v1"));
    await rejects(() => readItems(common, BAD));
    await rejects(() => writeItem(common, outboxItem(BAD)));

    expect(await snapshot(common)).toEqual(before);
  });

  it("形の合う ID では、同じ場所を使える", async () => {
    const root = await makeRepo();
    await writeRecord(testRunner, root, {
      id: "T12",
      head: "a",
      base: "b",
      commands: [],
      at: "c",
    });
    expect(await readRecord(testRunner, root, "T12")).not.toBeNull();
    await writeReviewed(testRunner, root, {
      id: "ISS-3",
      head: "a",
      fingerprint: "b",
      at: "c",
    });
    expect(await readReviewed(testRunner, root, "ISS-3")).not.toBeNull();
    const common = (
      await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim();
    for (const id of ["T12", "ISS-3"]) {
      await writePushRecord(testRunner, root, id, {
        id,
        pushedHead: "h",
      });
      expect((await readPushRecord(testRunner, root, id))?.pushedHead).toBe(
        "h",
      );
      await appendStage(common, id, {
        at: "2026-01-01T00:00:00.000Z",
        state: "s",
        note: null,
        command: "c",
      });
      expect((await readStages(common, id))?.entries).toHaveLength(1);
      await writeItem(common, outboxItem(id));
      expect((await readItem(common, id, "push-v1"))?.taskId).toBe(id);
    }
  });

  it("段の記録と outbox の一覧は、形の合う名前だけを返す", async () => {
    const root = await makeRepo();
    const common = (
      await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim();
    await writeFiles(common, {
      "orca-flow/stages/foo.jsonl": "",
      "orca-flow/stages/T12.jsonl": "",
      "orca-flow/outbox/foo/a.json": "{}",
      "orca-flow/outbox/T12/a.json": "{}",
      "orca-flow/outbox/.hidden/a.json": "{}",
    });
    expect(await listStageIds(common)).toEqual(["T12"]);
    expect(await outboxTaskIds(common)).toEqual(["T12"]);
  });

  it("outbox の案の ID の誤りに制御文字が入らない", async () => {
    const root = await makeRepo();
    const common = (
      await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim();
    const error = await readItem(common, "T12", "a\u001bb\u202e").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FlowError);
    const message = (error as FlowError).message;
    expect(message).toContain("\\u{1b}");
    expect(message).toContain("\\u{202e}");
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u001b\u202e]/);
  });
});

describe("設計書と報告の場所", () => {
  it("形の合う ID で組み、外れた ID は FlowError(1)", async () => {
    const config = { ...DEFAULT_CONFIG, tasksDir: "docs/t", reportsDir: "r" };
    expect(taskDocPath(config, "T12")).toBe("docs/t/T12.md");
    expect(reportPath(config, "T12")).toBe("r/T12.md");
    for (const bad of [BAD, "T1/x", "12", ""]) {
      await rejects(() => taskDocPath(config, bad));
      await rejects(() => reportPath(config, bad));
    }
  });
});

// ---- src の中で、tasksDir・reportsDir と ID を直接つなぐ所が tasks.ts のほかにないこと ----

/** ID らしい識別子：id、名前が Id で終わるもの（task.id の id も含む） */
const isIdLike = (name: string) => name === "id" || /[a-z0-9]Id$/.test(name);

/**
 * 構文木を読み、marker に当たる語（識別子か文字列）と ID らしい識別子が
 * 同じ「文」（変数の宣言・式の文・return・式だけの矢印関数）の中にある所の文面を返す。
 * 正規表現リテラル・テンプレート・コメントは構文木が読み分ける
 */
export function sameStatementHits(
  source: string,
  isMarker: (node: ts.Node) => boolean,
): string[] {
  const sf = ts.createSourceFile(
    "x.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const isUnit = (n: ts.Node) =>
    ts.isVariableStatement(n) ||
    ts.isExpressionStatement(n) ||
    ts.isReturnStatement(n) ||
    (ts.isArrowFunction(n) && !ts.isBlock(n.body));
  const hasIdLike = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && isIdLike(n.text)) ||
    ts.forEachChild(n, (c) => (hasIdLike(c) ? true : undefined)) === true;
  const units = new Set<ts.Node>();
  const visit = (n: ts.Node) => {
    if (isMarker(n)) {
      for (let p: ts.Node | undefined = n; p; p = p.parent)
        if (isUnit(p)) {
          units.add(p);
          break;
        }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...units].filter(hasIdLike).map((n) => n.getText(sf));
}

/** tasksDir・reportsDir を使う文のうち、ID らしい値も同じ文に出てくるもの */
export function dirIdJoins(source: string): string[] {
  return sameStatementHits(
    source,
    (n) =>
      ts.isIdentifier(n) && (n.text === "tasksDir" || n.text === "reportsDir"),
  );
}

/** "orca-flow" の下の場所を、ID らしい値とつなぐ文 */
export function orcaFlowIdJoins(source: string): string[] {
  return sameStatementHits(
    source,
    (n) => ts.isStringLiteralLike(n) && n.text === "orca-flow",
  );
}

describe("tasksDir・reportsDir と ID を直接つなぐ所", () => {
  it("見つける道具が、つなぐ書き方を見つけ、無関係な所を見つけない", () => {
    const hits = [
      "const p = path.join(config.tasksDir, `${id}.md`);",
      "const p = path.posix.join(config.reportsDir, task.id + '.md');",
      "const p = `${config.tasksDir}/${taskId}.md`;",
      "const p = path.join(\n  config.tasksDir,\n  `${id}.md`,\n);",
      "const { tasksDir } = config;\nconst p = `${tasksDir}/${id}.md`;",
      // 正規表現リテラルの中のバッククォートのあとにつなぐ行
      "const a = /[`*]/g;\nconst p = path.join(config.tasksDir, `${id}.md`);",
      "const a = /^\\s*(```|~~~)/;\nconst p = path.join(config.reportsDir, `${id}.md`);",
      "const a = /```/;\nconst p = `${config.tasksDir}/${taskId}.md`;",
    ];
    for (const code of hits) expect(dirIdJoins(code), code).not.toHaveLength(0);
    const misses = [
      "// path.join(config.tasksDir, `${id}.md`)",
      "/* config.reportsDir ${id} */",
      'const s = "tasksDir と id";',
      "const p = path.join(root, config.tasksDir);",
      "const q = taskDocPath(config, id);",
    ];
    for (const code of misses) expect(dirIdJoins(code), code).toHaveLength(0);
  });

  it("src の中は tasks.ts のほかにない", async () => {
    const srcDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src",
    );
    const files = (await readdir(srcDir, { recursive: true })).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(20);
    const found: string[] = [];
    for (const file of files) {
      const normalized = file.split(path.sep).join("/");
      if (normalized === "lib/tasks.ts") continue;
      const source = await readFile(path.join(srcDir, file), "utf8");
      for (const hit of dirIdJoins(source))
        found.push(`${normalized}: ${hit.trim().slice(0, 100)}`);
    }
    expect(found).toEqual([]);
    // tasks.ts 自身は、確かめを通してから組んでいる
    const own = await readFile(path.join(srcDir, "lib/tasks.ts"), "utf8");
    expect(dirIdJoins(own).length).toBeGreaterThan(0);
  });
});

describe('"orca-flow" の下の場所を ID でつなぐ所', () => {
  it("見つける道具が、つなぐ書き方を見つけ、無関係な所を見つけない", () => {
    expect(
      orcaFlowIdJoins(
        'const p = path.join(common, "orca-flow", "captures", id);',
      ),
    ).toHaveLength(1);
    expect(
      orcaFlowIdJoins(
        "const a = /[`*]/g;\nconst p = path.join(c, 'orca-flow', `${taskId}.md`);",
      ),
    ).toHaveLength(1);
    expect(
      orcaFlowIdJoins('const p = path.join(common, "orca-flow", "auto");'),
    ).toHaveLength(0);
    expect(orcaFlowIdJoins("// path.join(c, 'orca-flow', id)")).toHaveLength(0);
  });

  it("src の中は task-id.ts のほかにない", async () => {
    const srcDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src",
    );
    // 既知の例外はない。task-id.ts の共有の関数だけが組む
    const known = new Set<string>();
    const files = (await readdir(srcDir, { recursive: true })).filter((f) =>
      f.endsWith(".ts"),
    );
    const found: string[] = [];
    for (const file of files) {
      const normalized = file.split(path.sep).join("/");
      if (normalized === "lib/task-id.ts" || known.has(normalized)) continue;
      const source = await readFile(path.join(srcDir, file), "utf8");
      for (const hit of orcaFlowIdJoins(source))
        found.push(`${normalized}: ${hit.trim().slice(0, 100)}`);
    }
    expect(found).toEqual([]);
    const own = await readFile(path.join(srcDir, "lib/task-id.ts"), "utf8");
    expect(orcaFlowIdJoins(own).length).toBeGreaterThan(0);
  });
});
