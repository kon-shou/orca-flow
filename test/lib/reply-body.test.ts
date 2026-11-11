import { describe, expect, it } from "vitest";
import {
  ancestryOf,
  buildReplyBody,
  fixRangeOf,
  isAncestor,
  resolveCommit,
  type FixRange,
  type ReplyBodyComment,
} from "../../src/lib/reply-body.ts";
import { git, makeRepo, writeFiles } from "../helpers/repo.ts";
import { testRunner } from "../helpers/runner.ts";

const URL = "https://example.test/owner/repo/pull/7";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

const user = (login: string) => ({ login, isBot: false });
const comment = (
  id: string,
  path: string,
  line: number,
  author: ReplyBodyComment["author"],
): ReplyBodyComment => ({ id, path, line, author });

const build = (
  comments: ReplyBodyComment[],
  extra: {
    summary?: string;
    ranges?: Map<string, FixRange>;
    viewer?: string | null;
  } = {},
) =>
  buildReplyBody({
    summary: extra.summary ?? "",
    comments,
    viewer: extra.viewer === undefined ? "me-user" : extra.viewer,
    prUrl: URL,
    ranges: extra.ranges ?? new Map(),
  });

describe("buildReplyBody", () => {
  it("直しのある返信は、場所と範囲の差分の URL が1つ並ぶ", () => {
    const body = build([comment("C1", "a.ts", 3, user("reviewer-a"))], {
      ranges: new Map([["C1", { start: A, end: B }]]),
    });
    expect(body).toBe(
      `@reviewer-a\n- \`a.ts:3\`：直しました（${URL}/files/${A}..${B}）`,
    );
  });

  it("2つの指摘が別の範囲なら、指摘ごとに別の URL が出る", () => {
    const body = build(
      [
        comment("C1", "a.ts", 3, user("reviewer-a")),
        comment("C2", "b.ts", 5, user("reviewer-a")),
      ],
      {
        ranges: new Map([
          ["C1", { start: A, end: B }],
          ["C2", { start: C, end: D }],
        ]),
      },
    );
    expect(body).toContain(`/files/${A}..${B}`);
    expect(body).toContain(`/files/${C}..${D}`);
  });

  it("直しのない返信だけなら、リンクが出ず、メンションと返信しましただけになる", () => {
    const body = build([comment("C1", "a.ts", 3, user("reviewer-a"))]);
    expect(body).toBe("@reviewer-a\n- `a.ts:3`：返信しました");
    expect(body).not.toContain("http");
  });

  it("1人が2つの指摘を書いていても、メンションは1回で、下に2つの項が並ぶ", () => {
    const body = build([
      comment("C2", "b.ts", 1, user("reviewer-a")),
      comment("C1", "a.ts", 3, user("Reviewer-A")),
    ]);
    expect(body.match(/@/g)).toHaveLength(1);
    expect(body.split("\n")).toHaveLength(3);
  });

  it("自分（大小が違っても）と bot には @ が付かず、書き手が読めないものは書き手不明の組に並ぶ", () => {
    const body = build(
      [
        comment("C1", "a.ts", 1, user("ME-USER")),
        comment("C2", "a.ts", 2, { login: "helper", isBot: true }),
        comment("C3", "a.ts", 3, { login: "tool[bot]", isBot: true }),
        comment("C4", "a.ts", 4, null),
      ],
      {},
    );
    expect(body).not.toContain("@");
    expect(body).toContain("ME-USER\n- `a.ts:1`");
    expect(body).toContain("helper\n- `a.ts:2`");
    expect(body).toContain("tool[bot]\n- `a.ts:3`");
    expect(body).toContain("（書き手不明）\n- `a.ts:4`");
    // 書き手の組は空行で分ける
    expect(body.split("\n\n")).toHaveLength(4);
  });

  it("返信の並びを入れ替えても、同じ本文になる", () => {
    const list = [
      comment("C1", "a.ts", 3, user("reviewer-a")),
      comment("C2", "b.ts", 1, user("reviewer-b")),
      comment("C3", "a.ts", 9, user("reviewer-b")),
    ];
    const ranges = new Map([["C2", { start: A, end: B }]]);
    expect(build([...list].reverse(), { ranges })).toBe(
      build(list, { ranges }),
    );
  });

  it("人の本文があれば、人の本文・空行・組み立てた本文の順。返信がなければ人の本文だけ", () => {
    const one = comment("C1", "a.ts", 3, user("reviewer-a"));
    expect(build([one], { summary: "全体の返事\n" })).toBe(
      "全体の返事\n\n@reviewer-a\n- `a.ts:3`：返信しました",
    );
    expect(build([], { summary: "全体の返事" })).toBe("全体の返事");
    expect(build([], { summary: " \n" })).toBe("");
  });
});

describe("直しのコミットの範囲（本物のリポジトリ）", () => {
  async function history() {
    const root = await makeRepo();
    const commit = async (name: string) => {
      await writeFiles(root, { [name]: `${name}\n` });
      await git(root, "add", "-A");
      await git(root, "commit", "--quiet", "-m", name);
      return git(root, "rev-parse", "HEAD");
    };
    const base = await git(root, "rev-parse", "HEAD");
    const c1 = await commit("one");
    const other = await commit("other");
    const c2 = await commit("two");
    return { root, base, c1, other, c2 };
  }

  it("始まりは古いほうの親、終わりは新しいほう（渡す順によらない）。間に挟まったコミットは範囲に入る", async () => {
    // 新しいコミットの SHA が古いものより辞書順で小さくなる（履歴の順と辞書順が食い違う）組になるまで作り直す
    let h = await history();
    for (let i = 0; h.c2 >= h.c1 && i < 200; i++) {
      await git(h.root, "reset", "--quiet", "--hard", h.base);
      await writeFiles(h.root, { [`retry${i}`]: `${i}\n` });
      await git(h.root, "add", "-A");
      await git(h.root, "commit", "--quiet", "-m", `retry ${i}`);
      const newBase = await git(h.root, "rev-parse", "HEAD");
      const again = async (name: string) => {
        await writeFiles(h.root, { [name]: `${name}${i}\n` });
        await git(h.root, "add", "-A");
        await git(h.root, "commit", "--quiet", "-m", `${name} ${i}`);
        return git(h.root, "rev-parse", "HEAD");
      };
      const c1 = await again("one");
      const other = await again("other");
      const c2 = await again("two");
      h = { root: h.root, base: newBase, c1, other, c2 };
    }
    const { root, base, c1, c2 } = h;
    expect(c2 < c1).toBe(true);
    const forward = await fixRangeOf(testRunner, root, [c1, c2]);
    const backward = await fixRangeOf(testRunner, root, [c2, c1]);
    expect(forward).toEqual({ start: base, end: c2 });
    expect(backward).toEqual(forward);
  });

  it("コミット1つなら、その親からそのコミットまで", async () => {
    const { root, other, c2 } = await history();
    expect(await fixRangeOf(testRunner, root, [c2])).toEqual({
      start: other,
      end: c2,
    });
  });

  it("最初のコミットで親がなければ、範囲を決められず止まる", async () => {
    const { root } = await history();
    const first = await git(root, "rev-list", "--max-parents=0", "HEAD");
    await expect(fixRangeOf(testRunner, root, [first])).rejects.toThrow("親");
  });

  it("コミットを解き、たどれるかを調べる", async () => {
    const { root, base, c1, c2 } = await history();
    expect(await resolveCommit(testRunner, root, c1.slice(0, 8))).toBe(c1);
    expect(await resolveCommit(testRunner, root, "zzzzzzz")).toBeNull();
    expect(await resolveCommit(testRunner, root, "1234567")).toBeNull();
    expect(await isAncestor(testRunner, root, c1, c2)).toBe(true);
    expect(await isAncestor(testRunner, root, c2, base)).toBe(false);
    // 手元にない SHA は「たどれない」ではなく解けない（終了コード1以外）
    expect(await ancestryOf(testRunner, root, c1, c2)).toBe("yes");
    expect(await ancestryOf(testRunner, root, c2, base)).toBe("no");
    expect(await ancestryOf(testRunner, root, "9".repeat(40), c2)).toBe(
      "unresolved",
    );
  });
});
