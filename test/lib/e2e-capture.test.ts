import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLOW_PATTERN,
  baseReasons,
  findCaptures,
} from "../../src/lib/e2e-capture.ts";
import { makeTmpDir } from "../helpers/tmp/index.ts";

describe("流れの名前", () => {
  it("英小文字・数字・「-」の40文字まで", () => {
    for (const ok of ["login", "a-1", "x".repeat(40)])
      expect(FLOW_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["", "Login", "a_b", "a b", "a/b", "x".repeat(41)])
      expect(FLOW_PATTERN.test(bad), bad).toBe(false);
  });
});

describe("findCaptures", () => {
  it("時刻以降の webm・mp4・gif だけを、下のフォルダまで探す", async () => {
    const root = await makeTmpDir("cap-");
    const put = async (rel: string, at: number) => {
      const file = path.join(root, "out", rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "x");
      await utimes(file, new Date(at), new Date(at));
    };
    await put("old.webm", 1000);
    await put("a/new.WEBM", 5000);
    await put("b/c/new.mp4", 6000);
    await put("new.gif", 6000);
    await put("new.png", 6000);
    await put("new.txt", 6000);
    await mkdir(path.join(root, "out/link"), { recursive: true });
    await symlink(
      path.join(root, "out/new.gif"),
      path.join(root, "out/link/alias.gif"),
    );
    const found = await findCaptures(root, "out", 5000);
    expect(found.map((f) => path.relative(root, f)).sort()).toEqual([
      "out/a/new.WEBM",
      "out/b/c/new.mp4",
      "out/new.gif",
    ]);
    expect(await findCaptures(root, "none", 0)).toEqual([]);
  });
});

describe("baseReasons", () => {
  it("答えないアプリだけ、理由と次の手を出す", () => {
    const reasons = baseReasons(
      [
        { name: "a", url: "u", answered: true, reason: null },
        {
          name: "b",
          url: null,
          answered: false,
          reason: "前の画面の記録がありません",
        },
      ],
      "task/T1-order-limit",
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("b：前の画面の記録がありません");
    expect(reasons[0]).toContain(
      "workspace --preview task/T1-order-limit --base",
    );
  });

  it("ブランチ名が決まらない・そのまま打てない形なら〈ブランチ名〉の字のまま出す", () => {
    const bases = [
      { name: "b", url: null, answered: false, reason: "答えません" },
    ];
    for (const branch of [null, "task/T1-a b", "task/T1-$(x)"]) {
      const [reason] = baseReasons(bases, branch);
      expect(reason).toContain("workspace --preview 〈ブランチ名〉 --base");
      expect(reason).not.toContain("T1");
    }
  });
});
