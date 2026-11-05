import { describe, expect, it } from "vitest";
import { run } from "../../../scripts/public/main.ts";
import { testRunner } from "../../helpers/runner.ts";

describe("このリポジトリの公開に出るファイル", () => {
  it("ID の形と手元のパスがない（当たりがあれば一覧をそのまま出す）", async () => {
    let stderr = "";
    const code = await run(["local"], {
      runner: testRunner,
      cwd: process.cwd(),
      env: process.env,
      io: {
        stdin: async () => "",
        stderr: (text) => {
          stderr += text;
        },
      },
    });
    expect(code, stderr).toBe(0);
  }, 60_000);
});
