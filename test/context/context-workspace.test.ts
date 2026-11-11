import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import { realRunner, type Runner } from "../../src/lib/exec.ts";
import { capture, git, tempDir, writeFiles } from "../init/helpers.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FILE = "orca-flow-workspace.json";

async function context(cwd: string) {
  const io = capture();
  const calls: string[] = [];
  const runner: Runner = (cmd, args, opts) => {
    calls.push(cmd);
    return realRunner(cmd, args, opts);
  };
  const code = await main(["context"], { ...io, cwd, runner });
  return { code, io, calls };
}

describe("context の親の役", () => {
  it("設定がある git でないフォルダで、親の統括役の文を出して0", async () => {
    const dir = tempDir("orca-flow-ws-");
    // 設定の確かめはしない（中身が誤りでも出す）
    writeFiles(dir, { [FILE]: "{}" });
    const { code, io, calls } = await context(dir);
    expect(code).toBe(0);
    expect(io.text()).toContain("親の統括役");
    expect(io.text()).toContain("orca-flow workspace");
    expect(calls).not.toContain("orca");
  });

  it("git init したフォルダでも出して0", async () => {
    const dir = tempDir("orca-flow-ws-");
    git(dir, "init", "-q", "-b", "main");
    writeFiles(dir, { [FILE]: "{}" });
    const { code, io } = await context(dir);
    expect(code).toBe(0);
    expect(io.text()).toContain("親の統括役");
  });

  it("設定のない git でないフォルダでは何も出さない", async () => {
    const { code, io } = await context(tempDir("orca-flow-ws-"));
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });

  it("上の階層の設定は探さない", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, { [FILE]: "{}", "sub/x.txt": "x\n" });
    const { code, io } = await context(`${dir}/sub`);
    expect(code).toBe(0);
    expect(io.text()).toBe("");
  });

  it("子へ流せるものと、組の qa の動きを文に含める", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, { [FILE]: "{}" });
    const { io } = await context(dir);
    const text = io.text();
    expect(text).toContain(
      "子へ流せるのは config・active・merged・new・preview だけ",
    );
    expect(text).toContain("orca-flow qa は組のモードで動き");
    expect(text).toContain("組のブランチ名のブランチを持つアプリ");
    expect(text).toContain("組の qa と workspace --preview はブランチ名で打つ");
    expect(text).not.toContain("同じ ID のブランチを持つアプリ");
    expect(text).toContain("QA の貸し出しの記録");
    expect(text).toContain("qa deploy は人がこのタブで頼んだときだけ");
  });

  it("仕様10.4 のワークスペースのフォルダの行の引用が、出力と同じ", async () => {
    const dir = tempDir("orca-flow-ws-");
    writeFiles(dir, { [FILE]: "{}" });
    const { io } = await context(dir);
    const spec = readFileSync(path.join(ROOT, "docs/spec.md"), "utf8");
    const at = spec.indexOf("### 10.4 ");
    const section = spec.slice(at, spec.indexOf("\n## ", at));
    const line = section
      .split("\n")
      .find((l) => l.includes("**ワークスペースのフォルダ**"));
    const quoted = /「([^」]*)」/.exec(line ?? "")?.[1];
    expect(quoted).toBeDefined();
    expect(io.text().trim()).toBe(quoted);
  });
});
