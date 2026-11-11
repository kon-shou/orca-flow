import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveBaseAppSource,
  resolveBaseAppSources,
} from "../../src/lib/companion-source.ts";
import { mergeSubject } from "../../src/lib/merge-subject.ts";
import {
  writeStartAfterAt,
  type StartAfterEntry,
} from "../../src/lib/start-after.ts";
import { addTaskWorktree, git, makeRepo } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const common = (root: string) => path.join(root, ".git");

async function setup() {
  const e2e = await makeRepo();
  const appA = await makeRepo();
  const appB = await makeRepo();
  return {
    e2e,
    appA,
    appB,
    a: { name: "app-a", path: appA },
    repoA: { name: "app-a", path: appA },
    repoB: { name: "app-b", path: appB },
  };
}

const mark = (
  root: string,
  id: string,
  after: StartAfterEntry[],
): Promise<void> => writeStartAfterAt(common(root), id, after, T0);

/** baseBranch に統合のマージの件名の行を残す（統合済みにする） */
async function integrate(root: string, id: string) {
  await git(
    root,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    mergeSubject("統括役", id),
  );
}

describe("土台のアプリの出どころ", () => {
  it("前を待つ印がなければ baseBranch", async () => {
    const { e2e, a } = await setup();
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "baseBranch",
      branch: "main",
    });
  });

  it("前にアプリのリポジトリが当たらなければ baseBranch", async () => {
    const { e2e, appB, a, repoB } = await setup();
    await addTaskWorktree(appB, "T7", "b");
    await mark(e2e, "T1", [{ id: "T7", repo: repoB, wait: "implemented" }]);
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "baseBranch",
      branch: "main",
    });
  });

  it("近い前にアプリの作業中のタスクがあれば、そのタスク", async () => {
    const { e2e, appA, a, repoA } = await setup();
    await addTaskWorktree(appA, "T3", "a");
    await mark(e2e, "T1", [{ id: "T3", repo: repoA, wait: "implemented" }]);
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "task",
      id: "T3",
    });
  });

  it("近い前のアプリのタスクが入っていれば baseBranch", async () => {
    const { e2e, appA, a, repoA } = await setup();
    await integrate(appA, "T3");
    await mark(e2e, "T1", [{ id: "T3", repo: repoA, wait: "implemented" }]);
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "baseBranch",
      branch: "main",
    });
  });

  it("リポジトリをまたいで2段たどった先のアプリのタスクを返す", async () => {
    const { e2e, appA, appB, a, repoA, repoB } = await setup();
    await addTaskWorktree(appA, "T3", "a");
    await addTaskWorktree(appB, "T7", "b");
    await addTaskWorktree(appB, "T6", "b0");
    await mark(e2e, "T1", [{ id: "T7", repo: repoB, wait: "implemented" }]);
    await mark(appB, "T7", [{ id: "T6", repo: null, wait: "merged" }]);
    await mark(appB, "T6", [{ id: "T3", repo: repoA, wait: "implemented" }]);
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "task",
      id: "T3",
    });
  });

  it("近いほうの段のアプリの前を選ぶ", async () => {
    const { e2e, appA, appB, a, repoA, repoB } = await setup();
    await addTaskWorktree(appA, "T3", "a");
    await addTaskWorktree(appA, "T4", "a2");
    await addTaskWorktree(appB, "T7", "b");
    await mark(e2e, "T1", [
      { id: "T7", repo: repoB, wait: "implemented" },
      { id: "T4", repo: repoA, wait: "implemented" },
    ]);
    await mark(appB, "T7", [{ id: "T3", repo: repoA, wait: "implemented" }]);
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "task",
      id: "T4",
    });
  });

  it("同じ近さに2つあり、片方が他方の前をたどった先にあれば、新しいほう", async () => {
    const { e2e, appA, a, repoA } = await setup();
    await addTaskWorktree(appA, "T3", "a");
    await addTaskWorktree(appA, "T4", "a2");
    await mark(e2e, "T1", [
      { id: "T3", repo: repoA, wait: "implemented" },
      { id: "T4", repo: repoA, wait: "implemented" },
    ]);
    await mark(appA, "T4", [{ id: "T3", repo: null, wait: "implemented" }]);
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toEqual({
      kind: "task",
      id: "T4",
    });
  });

  it("同じ近さにアプリの前が2つで決めきれなければ、理由つきで決めきれない", async () => {
    const { e2e, appA, a, repoA } = await setup();
    await addTaskWorktree(appA, "T3", "a");
    await addTaskWorktree(appA, "T4", "a2");
    await mark(e2e, "T1", [
      { id: "T3", repo: repoA, wait: "implemented" },
      { id: "T4", repo: repoA, wait: "implemented" },
    ]);
    const source = await resolveBaseAppSource(testRunner, e2e, "T1", a);
    expect(source).toMatchObject({ kind: "undecided" });
    expect(source.kind === "undecided" && source.reason).toMatch(/T3・T4/);
  });

  it("アプリの前が作業中でも入ってもいなければ、理由つきで決めきれない", async () => {
    const { e2e, a, repoA } = await setup();
    await mark(e2e, "T1", [{ id: "T3", repo: repoA, wait: "implemented" }]);
    const source = await resolveBaseAppSource(testRunner, e2e, "T1", a);
    expect(source).toMatchObject({ kind: "undecided" });
    expect(source.kind === "undecided" && source.reason).toMatch(
      /T3 が作業中でも main に入ってもいません/,
    );
  });

  it("壊れた印は投げずに決めきれないとする", async () => {
    const { e2e, a } = await setup();
    const dir = path.join(common(e2e), "orca-flow", "start-after");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "T1.json"), "{");
    expect(await resolveBaseAppSource(testRunner, e2e, "T1", a)).toMatchObject({
      kind: "undecided",
    });
  });

  it("baseApps の並びの順に出どころを返す", async () => {
    const { e2e, appA, a, repoA, repoB } = await setup();
    await addTaskWorktree(appA, "T3", "a");
    await mark(e2e, "T1", [{ id: "T3", repo: repoA, wait: "implemented" }]);
    expect(
      await resolveBaseAppSources(testRunner, e2e, "T1", [a, repoB]),
    ).toEqual([
      { app: a, source: { kind: "task", id: "T3" } },
      { app: repoB, source: { kind: "baseBranch", branch: "main" } },
    ]);
  });
});
