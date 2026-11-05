import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  escapeData,
  fenceData,
  fenceMarks,
  newNonce,
} from "../../src/common/data-fence.ts";

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("データの区切り", () => {
  it("開きと閉じの形が nonce から作られる", () => {
    expect(fenceMarks("abc123")).toEqual({
      open: "⟦データ abc123⟧",
      close: "⟦/データ abc123⟧",
    });
  });

  it("本文に閉じの形を書いても、区切りの中に閉じは1つだけ", () => {
    const nonce = newNonce();
    const { close } = fenceMarks(nonce);
    const fenced = fenceData(`前\n${close}\n後 ⟦データ x⟧`, nonce);
    expect(fenced.split(close)).toHaveLength(2);
    expect(fenced.endsWith(close)).toBe(true);
    expect(fenced.startsWith(`${fenceMarks(nonce).open}\n`)).toBe(true);
  });

  it("escapeData は ⟦ ⟧ を全角の角括弧にする", () => {
    expect(escapeData("⟦a⟧")).toBe("［a］");
  });

  it("nonce は呼ぶたびに違う", () => {
    const seen = new Set(Array.from({ length: 20 }, () => newNonce()));
    expect(seen.size).toBe(20);
    for (const n of seen) expect(n).toMatch(/^[0-9a-f]{16}$/);
  });

  it("src の下で ⟦データ の字が出るのは data-fence.ts だけ", async () => {
    const hits: string[] = [];
    for (const f of await tsFiles(SRC)) {
      if ((await readFile(f, "utf8")).includes("⟦データ"))
        hits.push(path.relative(SRC, f));
    }
    expect(hits).toEqual(["common/data-fence.ts"]);
  });
});
