import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.ts";
import type { Runner, RunResult } from "../../src/lib/exec.ts";
import { previewDeps } from "../../src/lib/preview.ts";
import { fakeOrca } from "../helpers/fake-orca.ts";
import { addTaskWorktree, makeRepo, tempDir } from "../helpers/repo.ts";

const SAVED = { ...previewDeps };
afterEach(() => Object.assign(previewDeps, SAVED));

const URL_AFTER = "http://localhost:5174/";
const URL_BEFORE = "http://localhost:6200/";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-image"),
]);

const ok = (result: unknown): RunResult => ({
  code: 0,
  stdout: JSON.stringify({ id: "x", ok: true, result }),
  stderr: "",
  timedOut: false,
});

const failed = (text: string): RunResult => ({
  code: 1,
  stdout: JSON.stringify({ ok: false, error: { message: text } }),
  stderr: "",
  timedOut: false,
});

interface Harness {
  runner: Runner;
  orca: string[][];
  /** ページの ID ごとの今の URL */
  pages: Map<string, string>;
  /** screenshot が返す中身。null なら data を返さない */
  shot: { format: string; data: string } | null;
  /** tab show が tab を返さない */
  showBroken: boolean;
  /** screenshot が返す前に、そのページの URL をこれに変える */
  moveOnShot: string | null;
  /** tab create が失敗する */
  createBroken: boolean;
  /** ページの ID ごとについた profile */
  pageProfiles: Map<string, string | null>;
  /** Orca にある profile */
  profiles: Set<string>;
  /** tab profile create が失敗する */
  profileCreateBroken: boolean;
  /** tab profile create が返す ID。null なら新しい ID を作る */
  profileCreateId: string | null;
  /** tab profile delete が失敗する */
  profileDeleteBroken: boolean;
  /** tab profile show が返す result。undefined ならついた profile を返す */
  profileShow: unknown;
}

function harness(): Harness {
  const base = fakeOrca();
  let n = 0;
  const val = (args: readonly string[], name: string) =>
    args[args.indexOf(name) + 1] ?? "";
  const h: Harness = {
    runner: base.runner,
    orca: [],
    pages: new Map(),
    shot: { format: "png", data: PNG.toString("base64") },
    showBroken: false,
    moveOnShot: null,
    createBroken: false,
    pageProfiles: new Map(),
    profiles: new Set(),
    profileCreateBroken: false,
    profileCreateId: null,
    profileDeleteBroken: false,
    profileShow: undefined,
  };
  let profileN = 0;
  h.runner = async (cmd, args, opts) => {
    if (cmd !== "orca") return base.runner(cmd, args, opts);
    const plain = args.filter((a) => a !== "--json");
    h.orca.push(plain);
    const [group, action, sub] = plain;
    if (group === "tab" && action === "profile") {
      if (sub === "create") {
        if (h.profileCreateBroken) return failed("profile create failed");
        if (h.profileCreateId !== null)
          return ok({ profile: { id: h.profileCreateId, scope: "isolated" } });
        const id = `prof-${++profileN}`;
        h.profiles.add(id);
        return ok({ profile: { id, scope: "isolated" } });
      }
      if (sub === "show") {
        if (h.profileShow !== undefined) return ok(h.profileShow);
        const profileId = h.pageProfiles.get(val(plain, "--page"));
        return profileId === undefined ? failed("no tab") : ok({ profileId });
      }
      if (sub === "delete") {
        if (h.profileDeleteBroken) return failed("profile delete failed");
        return ok({ deleted: h.profiles.delete(val(plain, "--profile")) });
      }
    }
    if (group === "tab" && action === "create") {
      if (h.createBroken) return failed("tab create failed");
      const page = `page-${++n}`;
      h.pages.set(page, val(plain, "--url"));
      // Orca は知らない profile の ID を既定の区画に戻す
      const profile = val(plain, "--profile");
      h.pageProfiles.set(
        page,
        plain.includes("--profile") && h.profiles.has(profile) ? profile : null,
      );
      return ok({ browserPageId: page });
    }
    if (group === "tab" && action === "show") {
      if (h.showBroken) return ok({});
      const page = val(plain, "--page");
      const url = h.pages.get(page);
      if (url === undefined) return failed("no tab");
      return ok({ tab: { browserPageId: page, url, title: "t" } });
    }
    if (group === "screenshot") {
      if (h.moveOnShot !== null)
        h.pages.set(val(plain, "--page"), h.moveOnShot);
      return ok(h.shot ?? {});
    }
    if (group === "tab" && action === "close") {
      h.pages.delete(val(plain, "--page"));
      return ok({ closed: true });
    }
    return ok({});
  };
  return h;
}

const answering = (answers = true) => {
  const seen: string[] = [];
  previewDeps.fetch = (async (url: string) => {
    seen.push(String(url));
    if (!answers) throw new Error("refused");
    return { status: 200, body: null };
  }) as unknown as typeof fetch;
  return seen;
};

async function setup() {
  const root = await makeRepo({ idPrefix: "T", preview: { up: "make dev" } });
  const wt = await addTaskWorktree(root, "T7", "shop");
  const common = path.join(root, ".git");
  return { root, wt, common, dir: path.join(common, "orca-flow/qa-checks/T7") };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function writePreview(s: Setup, url: string | null = URL_AFTER) {
  const file = path.join(s.common, "orca-flow/preview/T7.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      id: "T7",
      worktree: s.wt.path,
      terminal: "term_a",
      ...(url === null ? {} : { url }),
      at: "2026-11-01T00:00:00.000Z",
    }),
  );
}

async function writeBase(s: Setup) {
  const file = path.join(s.common, "orca-flow/preview-base/T7.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      id: "T7",
      worktree: "/elsewhere/base",
      taskWorktree: s.wt.path,
      terminal: "term_b",
      commit: "abc",
      url: URL_BEFORE,
      at: "2026-11-01T00:00:00.000Z",
    }),
  );
}

async function run(s: Setup, h: Harness, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["qa-check", "T7", ...argv], {
    cwd: s.wt.path,
    runner: h.runner,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    env: process.env,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const created = (h: Harness) =>
  h.orca.filter((c) => c[0] === "tab" && c[1] === "create");
const profileCalls = (h: Harness, sub: string) =>
  h.orca.filter((c) => c[0] === "tab" && c[1] === "profile" && c[2] === sub);
const closedPages = (h: Harness) =>
  h.orca
    .filter((c) => c[0] === "tab" && c[1] === "close")
    .map((c) => c[c.indexOf("--page") + 1]);
const readJson = async (file: string) =>
  (await exists(file)) ? JSON.parse(await readFile(file, "utf8")) : {};

describe("qa-check --open", () => {
  it("preview の記録がなければタブを作らず、preview の次の手を出して2", async () => {
    const s = await setup();
    const h = harness();
    answering();
    const r = await run(s, h, "--open");
    expect(r.code).toBe(2);
    expect(r.err).toContain("orca-flow preview T7");
    expect(created(h)).toEqual([]);
  });

  it("URL がまだない・答えないときもタブを作らず2", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s, null);
    answering();
    const noUrl = await run(s, h, "--open");
    expect(noUrl.code).toBe(2);
    expect(noUrl.err).toContain("orca-flow preview T7");

    await writePreview(s);
    answering(false);
    const silent = await run(s, h, "--open");
    expect(silent.code).toBe(2);
    expect(silent.err).toContain("orca-flow preview T7");
    expect(created(h)).toEqual([]);
  });

  it("記録の URL をタスクの worktree のタブに開き、ページの ID と URL を出す", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    const seen = answering();
    const r = await run(s, h, "--open", "--json");
    expect(r.code).toBe(0);
    expect(seen).toEqual([URL_AFTER]);
    expect(created(h)).toEqual([
      [
        "tab",
        "create",
        "--url",
        URL_AFTER,
        "--worktree",
        `path:${s.wt.path}`,
        "--profile",
        "prof-1",
      ],
    ]);
    expect(JSON.parse(r.out)).toMatchObject({
      id: "T7",
      page: "page-1",
      url: URL_AFTER,
      base: false,
    });
  });

  it("--base は前の画面の記録の URL だけを開き、タスクのプレビューの URL を使わない", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    await writeBase(s);
    const seen = answering();
    const r = await run(s, h, "--open", "--base", "--json");
    expect(r.code).toBe(0);
    expect(seen).toEqual([URL_BEFORE]);
    expect(created(h)).toEqual([
      [
        "tab",
        "create",
        "--url",
        URL_BEFORE,
        "--worktree",
        `path:${s.wt.path}`,
        "--profile",
        "prof-1",
      ],
    ]);
    expect(JSON.parse(r.out)).toMatchObject({ url: URL_BEFORE, base: true });
  });

  it("--base で前の画面の記録がなければ、preview --base の次の手を出して2", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    const r = await run(s, h, "--open", "--base");
    expect(r.code).toBe(2);
    expect(r.err).toContain("orca-flow preview T7 --base");
    expect(created(h)).toEqual([]);
  });

  it("開き直しでタブを作れなければ、閉じた前のページを残さない", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    expect((await run(s, h, "--open")).code).toBe(0);
    h.createBroken = true;
    expect((await run(s, h, "--open")).code).toBe(1);
    const file = path.join(s.dir, "pages.json");
    const pages = (await exists(file))
      ? JSON.parse(await readFile(file, "utf8"))
      : {};
    expect(pages.after).toBeUndefined();
    const closes = () =>
      h.orca.filter((c) => c[0] === "tab" && c[1] === "close").length;
    const before = closes();
    await run(s, h, "--close");
    expect(closes()).toBe(before);
  });
});

describe("qa-check の isolated の profile", () => {
  const profileFile = (s: Setup) => path.join(s.dir, "profile.json");

  async function opened() {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    await writeBase(s);
    answering();
    return { s, h };
  }

  it("--open は profile を1回だけ作り、--open --base と2回目の --open も同じ profile でタブを作る", async () => {
    const { s, h } = await opened();
    expect((await run(s, h, "--open")).code).toBe(0);
    expect((await run(s, h, "--open", "--base")).code).toBe(0);
    expect((await run(s, h, "--open")).code).toBe(0);
    expect(profileCalls(h, "create")).toEqual([
      [
        "tab",
        "profile",
        "create",
        "--label",
        "orca-flow qa-check T7",
        "--scope",
        "isolated",
      ],
    ]);
    const profiles = created(h).map((c) => c[c.indexOf("--profile") + 1]);
    expect(profiles).toEqual(["prof-1", "prof-1", "prof-1"]);
    expect(profileCalls(h, "show").map((c) => c.at(-1))).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect((await readJson(profileFile(s))).id).toBe("prof-1");
  });

  it("profile を作れなければタブを作らずに1で、Orca の失敗の文を出す", async () => {
    const { s, h } = await opened();
    h.profileCreateBroken = true;
    const r = await run(s, h, "--open");
    expect(r.code).toBe(1);
    expect(r.err).toContain("（Orca が動いているか確かめてください）");
    expect(created(h)).toEqual([]);
    expect(await exists(profileFile(s))).toBe(false);
  });

  it("profile の作成が既定の profile を返せば、タブを作らず、記録を残さず、消しにも行かずに1", async () => {
    const { s, h } = await opened();
    h.profileCreateId = "default";
    const r = await run(s, h, "--open");
    expect(r.code).toBe(1);
    expect(r.err).toContain("既定の profile（default）");
    expect(r.err).toContain("タブは開いていません");
    expect(created(h)).toEqual([]);
    expect(await exists(profileFile(s))).toBe(false);
    expect(profileCalls(h, "delete")).toEqual([]);
  });

  async function defaultRecorded() {
    const { s, h } = await opened();
    await mkdir(s.dir, { recursive: true });
    await writeFile(
      profileFile(s),
      JSON.stringify({ id: "default", at: "2026-11-01T00:00:00.000Z" }),
    );
    return { s, h };
  }

  it("記録の profile が既定なら、--close・--clear は消しに行かず、警告に削除のコマンドを出さない", async () => {
    const { s, h } = await defaultRecorded();
    const close = await run(s, h, "--close");
    expect(close.code).toBe(0);
    const clear = await run(s, h, "--clear");
    expect(clear.code).toBe(0);
    expect(profileCalls(h, "delete")).toEqual([]);
    expect(`${close.err}\n${clear.err}`).not.toContain(
      "orca tab profile delete",
    );
    expect(await exists(s.dir)).toBe(false);
  });

  it("記録の profile が既定なら、--open は記録を使わず新しい isolated の profile でタブを作る", async () => {
    const { s, h } = await defaultRecorded();
    const r = await run(s, h, "--open");
    expect(r.code).toBe(0);
    expect(profileCalls(h, "create")).toHaveLength(1);
    expect(created(h).map((c) => c[c.indexOf("--profile") + 1])).toEqual([
      "prof-1",
    ]);
    expect((await readJson(profileFile(s))).id).toBe("prof-1");
  });

  it("タブを作れないときの文も、Orca の失敗の文の形で出す", async () => {
    const { s, h } = await opened();
    h.createBroken = true;
    const r = await run(s, h, "--open");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /tab create failed（Orca が動いているか確かめてください）/,
    );
  });

  const mismatch: [string, unknown][] = [
    ["別の ID", { profileId: "prof-other" }],
    ["null", { profileId: null }],
    ["default", { profileId: "default" }],
    ["読めない形", { profile: "prof-1" }],
  ];
  for (const [what, show] of mismatch) {
    it(`tab profile show が ${what} を返すと、タブを閉じ、ページを記録せず、profile を消して1`, async () => {
      const { s, h } = await opened();
      h.profileShow = show;
      const r = await run(s, h, "--open");
      expect(r.code).toBe(1);
      expect(closedPages(h)).toEqual(["page-1"]);
      expect((await readJson(path.join(s.dir, "pages.json"))).after).toBe(
        undefined,
      );
      expect(profileCalls(h, "delete")).toEqual([
        ["tab", "profile", "delete", "--profile", "prof-1"],
      ]);
      expect(h.profiles.size).toBe(0);
      expect(await exists(profileFile(s))).toBe(false);
      const shot = await run(s, h, "--shot", "cart");
      expect(shot.code).toBe(1);
      expect(shot.err).toContain("タブがありません");
      expect(h.orca.some((c) => c[0] === "screenshot")).toBe(false);
    });
  }

  it("確かめに落ちたとき、同じ profile を使うもう一方の画面のタブも閉じる。profile を消せなければ警告し、記録は消す", async () => {
    const { s, h } = await opened();
    expect((await run(s, h, "--open", "--base")).code).toBe(0);
    h.profileShow = { profileId: null };
    h.profileDeleteBroken = true;
    const r = await run(s, h, "--open");
    expect(r.code).toBe(1);
    expect(closedPages(h).sort()).toEqual(["page-1", "page-2"]);
    expect(await exists(path.join(s.dir, "pages.json"))).toBe(false);
    expect(r.err).toContain("orca tab profile delete --profile prof-1");
    expect(await exists(profileFile(s))).toBe(false);
  });

  it("記録の profile が Orca 側でなくなっていれば、--open は1で記録を消し、次の --open が profile を作り直す", async () => {
    const { s, h } = await opened();
    expect((await run(s, h, "--open")).code).toBe(0);
    h.profiles.clear();
    const r = await run(s, h, "--open");
    expect(r.code).toBe(1);
    expect(r.err).toContain("orca tab profile delete --profile prof-1");
    expect(await exists(profileFile(s))).toBe(false);
    expect((await run(s, h, "--open")).code).toBe(0);
    expect(created(h).at(-1)).toContain("prof-2");
    expect((await readJson(profileFile(s))).id).toBe("prof-2");
  });

  it("--close はタブを閉じてから profile を消す", async () => {
    const { s, h } = await opened();
    await run(s, h, "--open");
    const r = await run(s, h, "--close");
    expect(r.code).toBe(0);
    const tail = h.orca.slice(-2).map((c) => c.slice(0, 3));
    expect(tail).toEqual([
      ["tab", "close", "--page"],
      ["tab", "profile", "delete"],
    ]);
    expect(h.profiles.size).toBe(0);
    expect(await exists(profileFile(s))).toBe(false);
  });

  it("--close で profile を消せなければ警告して0で、記録を残し、次の --clear が消し直す", async () => {
    const { s, h } = await opened();
    await run(s, h, "--open");
    h.profileDeleteBroken = true;
    const r = await run(s, h, "--close");
    expect(r.code).toBe(0);
    expect(r.err).toContain("prof-1");
    expect(r.err).toContain("orca tab profile delete --profile prof-1");
    expect((await readJson(profileFile(s))).id).toBe("prof-1");
    h.profileDeleteBroken = false;
    expect((await run(s, h, "--clear")).code).toBe(0);
    expect(profileCalls(h, "delete")).toHaveLength(2);
    expect(h.profiles.size).toBe(0);
    expect(await exists(s.dir)).toBe(false);
  });

  it("--clear は profile を消せなくても0で、警告に profile の ID を出して置き場を消す", async () => {
    const { s, h } = await opened();
    await run(s, h, "--open");
    h.profileDeleteBroken = true;
    const r = await run(s, h, "--clear");
    expect(r.code).toBe(0);
    expect(r.err).toContain("orca tab profile delete --profile prof-1");
    expect(await exists(s.dir)).toBe(false);
  });

  it("profile の記録がない古い置き場では、--close・--clear が profile を消しに行かない", async () => {
    const { s, h } = await opened();
    await mkdir(s.dir, { recursive: true });
    await writeFile(
      path.join(s.dir, "pages.json"),
      JSON.stringify({
        after: {
          page: "page-old",
          url: URL_AFTER,
          origin: "http://localhost:5174",
          worktree: s.wt.path,
          at: "2026-11-01T00:00:00.000Z",
        },
      }),
    );
    expect((await run(s, h, "--close")).code).toBe(0);
    expect(closedPages(h)).toEqual(["page-old"]);
    expect((await run(s, h, "--clear")).code).toBe(0);
    expect(profileCalls(h, "delete")).toEqual([]);
  });
});

describe("qa-check --shot", () => {
  it("開いたページを撮り、後の画面は -after.png、前の画面は -before.png で置く", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    await writeBase(s);
    answering();
    expect((await run(s, h, "--open")).code).toBe(0);
    expect((await run(s, h, "--open", "--base")).code).toBe(0);
    const after = await run(s, h, "--shot", "cart-total");
    expect(after.code).toBe(0);
    const before = await run(s, h, "--shot", "cart-total", "--base");
    expect(before.code).toBe(0);
    expect(
      (await readdir(s.dir)).filter((f) => f.endsWith(".png")).sort(),
    ).toEqual(["cart-total-after.png", "cart-total-before.png"]);
    expect(await readFile(path.join(s.dir, "cart-total-after.png"))).toEqual(
      PNG,
    );
    const shots = h.orca.filter((c) => c[0] === "screenshot");
    expect(shots.map((c) => c[c.indexOf("--page") + 1])).toEqual([
      "page-1",
      "page-2",
    ]);
    // 受けるのは PNG だけなので、Orca にも PNG で撮らせる
    expect(shots.map((c) => c[c.indexOf("--format") + 1])).toEqual([
      "png",
      "png",
    ]);
  });

  const elsewhere: [string, string][] = [
    ["別のホスト", "https://example.com/account"],
    ["ポートだけ違う", "http://localhost:5175/"],
    ["スキームだけ違う", "https://localhost:5174/"],
    ["ホストだけ違う", "http://127.0.0.1:5174/"],
  ];
  for (const [what, moved] of elsewhere) {
    it(`今のタブの origin が開いた origin と違えば撮らずに1（${what}）`, async () => {
      const s = await setup();
      const h = harness();
      await writePreview(s);
      answering();
      await run(s, h, "--open");
      h.pages.set("page-1", moved);
      const r = await run(s, h, "--shot", "cart");
      expect(r.code).toBe(1);
      expect(r.err).toContain("開いた origin");
      expect(h.orca.some((c) => c[0] === "screenshot")).toBe(false);
      expect(await exists(path.join(s.dir, "cart-after.png"))).toBe(false);
    });
  }

  it("撮る間に別の origin へ移っていたら画像を置かずに1", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    await run(s, h, "--open");
    h.moveOnShot = "https://example.com/account";
    const r = await run(s, h, "--shot", "cart");
    expect(r.code).toBe(1);
    expect(r.err).toContain("開いた origin");
    expect(h.orca.some((c) => c[0] === "screenshot")).toBe(true);
    expect(await exists(path.join(s.dir, "cart-after.png"))).toBe(false);
  });

  it("タブが閉じられて読めなければ撮らずに1で、開き直す手を出す", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    await writeBase(s);
    answering();
    await run(s, h, "--open");
    await run(s, h, "--open", "--base");
    h.pages.clear();
    for (const extra of [[], ["--base"]]) {
      const r = await run(s, h, "--shot", "cart", ...extra);
      expect(r.code).toBe(1);
      expect(r.err).toContain("タブを読めませんでした");
      expect(r.err).not.toContain("開いた origin");
      expect(r.err).toContain("orca-flow qa-check T7 --open");
      expect(r.err).toContain("--open --base");
    }
    expect(h.orca.some((c) => c[0] === "screenshot")).toBe(false);
    expect(await exists(path.join(s.dir, "cart-after.png"))).toBe(false);
    expect(await exists(path.join(s.dir, "cart-before.png"))).toBe(false);
  });

  it("同じ origin の下の別のパスなら撮る", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    await run(s, h, "--open");
    h.pages.set("page-1", "http://localhost:5174/cart?x=1");
    expect((await run(s, h, "--shot", "cart")).code).toBe(0);
  });

  it("名前の形が外れれば1で、Orca を呼ばない", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    await run(s, h, "--open");
    const before = h.orca.length;
    for (const name of ["Cart", "a_b", "../x", "a.png", "カート", ""]) {
      const r = await run(s, h, "--shot", name);
      expect(r.code, name).toBe(1);
    }
    expect(h.orca.length).toBe(before);
  });

  it("開いていなければ撮らずに1", async () => {
    const s = await setup();
    const h = harness();
    const r = await run(s, h, "--shot", "cart");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--open");
    expect(h.orca).toEqual([]);
  });

  it("tab show の URL を読めなければ撮らずに1", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    await run(s, h, "--open");
    h.showBroken = true;
    const r = await run(s, h, "--shot", "cart");
    expect(r.code).toBe(1);
    expect(h.orca.some((c) => c[0] === "screenshot")).toBe(false);
  });

  it("screenshot の出力が PNG として読めなければ置かずに1", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    answering();
    await run(s, h, "--open");
    h.shot = null;
    expect((await run(s, h, "--shot", "cart")).code).toBe(1);
    h.shot = { format: "jpeg", data: PNG.toString("base64") };
    expect((await run(s, h, "--shot", "cart")).code).toBe(1);
    h.shot = { format: "png", data: Buffer.from("not png").toString("base64") };
    expect((await run(s, h, "--shot", "cart")).code).toBe(1);
    expect(await exists(path.join(s.dir, "cart-after.png"))).toBe(false);
  });
});

async function placeShots(s: Setup, names: string[]) {
  await mkdir(s.dir, { recursive: true });
  for (const n of names) await writeFile(path.join(s.dir, n), PNG);
}

async function input(body: unknown): Promise<string> {
  const dir = await tempDir("orca-flow-qa-input-");
  const file = path.join(dir, "input.json");
  await writeFile(file, JSON.stringify(body));
  return file;
}

const GOOD = {
  items: [
    {
      text: "カートに入れると合計が税込みで出る",
      weight: "必須",
      kind: "事実",
      result: "pass",
      reason: "",
      after: "cart-total",
    },
    {
      text: "カートの見た目がそろっている",
      weight: "できれば",
      kind: "目で見る",
      result: "human",
      before: "cart-look",
      after: "cart-look",
    },
    {
      text: "クーポンの欄で割引が出る",
      weight: "必須",
      kind: "事実",
      result: "unverified",
      reason: "試しのクーポンがない",
    },
  ],
  notices: [{ text: "狭い幅で横にはみ出す", shot: "cart-look" }],
};

describe("qa-check --record", () => {
  it("通ると result.json と result.md を書き、数と result.md の絶対パスを出す", async () => {
    const s = await setup();
    const h = harness();
    await placeShots(s, [
      "cart-total-after.png",
      "cart-look-before.png",
      "cart-look-after.png",
    ]);
    const r = await run(
      s,
      h,
      "--record",
      "--input",
      await input(GOOD),
      "--json",
    );
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.counts).toEqual({ pass: 1, fail: 0, unverified: 1, human: 1 });
    expect(data.resultMd).toBe(path.join(s.dir, "result.md"));
    const md = await readFile(path.join(s.dir, "result.md"), "utf8");
    expect(md).toContain("](cart-look-before.png)");
    expect(md).toContain("](cart-look-after.png)");
    expect(md).toContain("試しのクーポンがない");
    expect(md).toContain("狭い幅で横にはみ出す");
    const json = JSON.parse(
      await readFile(path.join(s.dir, "result.json"), "utf8"),
    );
    expect(json.items).toHaveLength(3);
    expect(json.notices).toHaveLength(1);

    const text = await run(s, h, "--record", "--input", await input(GOOD));
    expect(text.code).toBe(0);
    expect(text.out).toContain(path.join(s.dir, "result.md"));
  });

  const bad: [string, unknown][] = [
    [
      "知らない result",
      { items: [{ ...GOOD.items[0], result: "ok" }], notices: [] },
    ],
    [
      "理由のない fail",
      {
        items: [{ ...GOOD.items[0], result: "fail", reason: " " }],
        notices: [],
      },
    ],
    [
      "理由のない unverified",
      { items: [{ ...GOOD.items[2], reason: undefined }], notices: [] },
    ],
    [
      "置き場にない画像の名前",
      { items: [{ ...GOOD.items[0], after: "missing" }], notices: [] },
    ],
    [
      "置き場にない崩れの画像",
      { items: [GOOD.items[0]], notices: [{ text: "x", shot: "missing" }] },
    ],
    [
      "画像の名前の形が外れる",
      { items: [{ ...GOOD.items[0], after: "../cart-total" }], notices: [] },
    ],
    [
      "知らない weight",
      { items: [{ ...GOOD.items[0], weight: "任意" }], notices: [] },
    ],
    [
      "知らない kind",
      { items: [{ ...GOOD.items[0], kind: "見た目" }], notices: [] },
    ],
  ];
  for (const [what, body] of bad) {
    it(`${what}は1で断り、何も書かない`, async () => {
      const s = await setup();
      const h = harness();
      await placeShots(s, [
        "cart-total-after.png",
        "cart-look-before.png",
        "cart-look-after.png",
      ]);
      const r = await run(s, h, "--record", "--input", await input(body));
      expect(r.code).toBe(1);
      expect(r.err).not.toBe("");
      expect(await exists(path.join(s.dir, "result.json"))).toBe(false);
      expect(await exists(path.join(s.dir, "result.md"))).toBe(false);
    });
  }

  it("JSON として読めない入力は1", async () => {
    const s = await setup();
    const h = harness();
    const dir = await tempDir("orca-flow-qa-input-");
    const file = path.join(dir, "input.json");
    await writeFile(file, "{");
    expect((await run(s, h, "--record", "--input", file)).code).toBe(1);
    expect((await run(s, h, "--record")).code).toBe(1);
  });
});

describe("qa-check --show・--close・--clear", () => {
  it("--show は残した結果を出し、なければ1", async () => {
    const s = await setup();
    const h = harness();
    expect((await run(s, h, "--show")).code).toBe(1);
    await placeShots(s, [
      "cart-total-after.png",
      "cart-look-before.png",
      "cart-look-after.png",
    ]);
    await run(s, h, "--record", "--input", await input(GOOD));
    const r = await run(s, h, "--show", "--json");
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.items).toHaveLength(3);
    expect(data.resultMd).toBe(path.join(s.dir, "result.md"));
    const text = await run(s, h, "--show");
    expect(text.out).toContain("カートに入れると合計が税込みで出る");
  });

  it("--close は開いたタブだけを閉じ、結果と画像は残す", async () => {
    const s = await setup();
    const h = harness();
    await writePreview(s);
    await writeBase(s);
    answering();
    await run(s, h, "--open");
    await run(s, h, "--open", "--base");
    await run(s, h, "--shot", "cart");
    const r = await run(s, h, "--close");
    expect(r.code).toBe(0);
    const closed = h.orca
      .filter((c) => c[0] === "tab" && c[1] === "close")
      .map((c) => c[c.indexOf("--page") + 1])
      .sort();
    expect(closed).toEqual(["page-1", "page-2"]);
    expect(await exists(path.join(s.dir, "cart-after.png"))).toBe(true);
    const again = await run(s, h, "--shot", "cart");
    expect(again.code).toBe(1);
  });

  it("--clear でその ID の置き場が空になり、ほかの ID の置き場は残る", async () => {
    const s = await setup();
    const h = harness();
    await placeShots(s, ["cart-after.png"]);
    const other = path.join(s.common, "orca-flow/qa-checks/T8");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "x-after.png"), PNG);
    const r = await run(s, h, "--clear");
    expect(r.code).toBe(0);
    expect(await exists(s.dir)).toBe(false);
    expect(await exists(path.join(other, "x-after.png"))).toBe(true);
  });

  it("フラグがない・2つ重なる・--base が合わないときは使い方を出して1", async () => {
    const s = await setup();
    const h = harness();
    for (const argv of [
      [],
      ["--open", "--close"],
      ["--record", "--base"],
      ["--clear", "--input", "x.json"],
    ]) {
      const r = await run(s, h, ...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toContain("使い方");
    }
    expect(h.orca).toEqual([]);
  });
});
