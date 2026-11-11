import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentsDir = path.resolve(import.meta.dirname, "../../agents");

interface AgentDefinition {
  frontmatter: Record<string, string>;
  body: string;
}

/** agents/ の定義（担当・確認役）を読み、frontmatter（`key: value` の行）と本文に分ける */
function readAgent(name: string): AgentDefinition {
  const text = readFileSync(path.join(agentsDir, `${name}.md`), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${name}.md に frontmatter がない`);
  const [, head = "", body = ""] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) {
      const [, key = "", value = ""] = pair;
      frontmatter[key] = value.trim();
    }
  }
  return { frontmatter, body };
}

describe("担当の定義（task-worker）", () => {
  const worker = readAgent("task-worker");

  it("model が opus である", () => {
    expect(worker.frontmatter.model).toBe("opus");
  });

  it("effort が medium である", () => {
    expect(worker.frontmatter.effort).toBe("medium");
  });

  it("本文に「既存のコードの書き方に倣う」がある", () => {
    expect(worker.body).toContain("既存のコードの書き方に倣う");
  });
});

describe("確認役の定義（task-reviewer）", () => {
  const reviewer = readAgent("task-reviewer");

  it("model が inherit のまま（タスク長と同じ）である", () => {
    expect(reviewer.frontmatter.model).toBe("inherit");
  });
});

describe("ほかの役の定義", () => {
  it.each([
    ["code-reviewer", "opus", "high"],
    ["review-verifier", "opus", "high"],
    ["stage-verifier", "opus", "high"],
    ["goldfish-reviewer", "opus", "high"],
    ["task-reviewer", "inherit", "medium"],
  ])("%s は model %s・effort %s のまま", (name, model, effort) => {
    const agent = readAgent(name);
    expect(agent.frontmatter.model).toBe(model);
    expect(agent.frontmatter.effort).toBe(effort);
  });
});
