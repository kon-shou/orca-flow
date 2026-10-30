import { describe, expect, it } from "vitest";
import type { Runner, RunResult } from "../../src/lib/exec.ts";
import {
  cardForState,
  createOrca,
  describeSendBlock,
  displayName,
  parseInputBox,
  previewDraft,
  readInputBox,
  sendFailMessage,
} from "../../src/lib/orca.ts";

const lead = { agent: "claude", model: "claude-opus-5-5", effort: "high" };

function scripted(reply: (args: readonly string[]) => RunResult) {
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    expect(cmd).toBe("orca");
    calls.push([...args]);
    return reply(args);
  };
  return { runner, calls };
}

const json = (value: unknown, code = 0): RunResult => ({
  code,
  stdout: JSON.stringify(value),
  stderr: "",
  timedOut: false,
});

describe("orca", () => {
  it("worktree list の本物の形（refs/heads/ つき）を読む", async () => {
    const { runner, calls } = scripted(() =>
      json({
        ok: true,
        result: {
          worktrees: [
            {
              id: "r::/a",
              path: "/a",
              branch: "refs/heads/task/T1-a",
              isMainWorktree: false,
              workspaceStatus: "in-review",
              comment: "設計書のレビュー待ち",
              isUnread: true,
            },
          ],
        },
      }),
    );
    const rows = await createOrca(runner).listWorktrees("/repo");
    expect(calls[0]).toEqual([
      "worktree",
      "list",
      "--repo",
      "path:/repo",
      "--json",
    ]);
    expect(rows[0]).toMatchObject({ branch: "task/T1-a", isUnread: true });
  });

  it("worktree create の結果から場所とブランチを読む（worktree がない古い形も）", async () => {
    const { runner } = scripted(() =>
      json({ ok: true, result: { path: "/w", branch: "refs/heads/T1-a" } }),
    );
    const created = await createOrca(runner).createWorktree({
      repoPath: "/repo",
      name: "T1-a",
      baseBranch: "main",
      lead,
      prompt: "p",
    });
    expect(created).toMatchObject({ path: "/w", branch: "T1-a" });
  });

  it("失敗・見つからない・時間切れは FlowError(1)", async () => {
    for (const result of [
      json({ ok: false, error: { message: "not running" } }, 1),
      { code: 127, stdout: "", stderr: "", timedOut: false },
      { code: 1, stdout: "", stderr: "", timedOut: true },
      json({ ok: false, error: { message: "bad" } }, 0),
    ]) {
      const { runner } = scripted(() => result);
      await expect(createOrca(runner).ping()).rejects.toMatchObject({
        code: 1,
      });
    }
  });

  const lookup = (terminals: Record<string, unknown>[]) => {
    const { runner } = scripted(() =>
      json({ ok: true, result: { terminals } }),
    );
    return createOrca(runner);
  };
  const row = (handle: string, extra: Record<string, unknown> = {}) => ({
    handle,
    title: "Terminal 1",
    connected: true,
    writable: true,
    orphaned: false,
    ...extra,
  });

  it("先頭が Setup、次が agentIdentity が claude で題名が会話の中身のとき、後者を選ぶ", async () => {
    const orca = lookup([
      row("t_setup", { title: "Setup" }),
      row("t_lead", {
        title: "シニアエンジニアのレビュー観点",
        agentIdentity: "claude",
      }),
    ]);
    expect(await orca.findTerminal("/w", "claude")).toMatchObject({
      kind: "found",
      terminal: { handle: "t_lead" },
    });
  });

  it("題名に claude を含んでも agentIdentity がなければ選ばない。Setup だけなら見つからない", async () => {
    expect(
      await lookup([
        row("t_setup", { title: "Setup" }),
        row("t_named", { title: "✳ Claude Code" }),
      ]).findTerminal("/w", "claude"),
    ).toEqual({ kind: "none" });
    expect(
      await lookup([row("t_setup", { title: "Setup" })]).findTerminal(
        "/w",
        "claude",
      ),
    ).toEqual({ kind: "none" });
  });

  it("agentIdentity が claude の候補が2つあれば、決まらない（ハンドルと題名つき）", async () => {
    const result = await lookup([
      row("t_a", { title: "一つめ", agentIdentity: "claude" }),
      row("t_b", { title: "二つめ", agentIdentity: "claude" }),
    ]).findTerminal("/w", "claude");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous")
      expect(result.candidates.map((t) => [t.handle, t.title])).toEqual([
        ["t_a", "一つめ"],
        ["t_b", "二つめ"],
      ]);
  });

  it("つながっていない・書き込めない・orphaned のものは候補に数えない", async () => {
    const result = await lookup([
      row("t_dead", { agentIdentity: "claude", connected: false }),
      row("t_ro", { agentIdentity: "claude", writable: false }),
      row("t_orphan", { agentIdentity: "claude", orphaned: true }),
      row("t_lead", { agentIdentity: "claude" }),
    ]).findTerminal("/w", "claude");
    expect(result).toMatchObject({
      kind: "found",
      terminal: { handle: "t_lead" },
    });
  });

  it("agentIdentity が lead.agent と違うもの（codex）は選ばない", async () => {
    expect(
      await lookup([row("t_x", { agentIdentity: "codex" })]).findTerminal(
        "/w",
        "claude",
      ),
    ).toEqual({ kind: "none" });
  });

  it("cardForState は4つの状態で一言をつけ、一言なしでは今と同じ comment を返す", () => {
    const cases: [Parameters<typeof cardForState>[0], string, string][] = [
      ["designing", "設計中", "設計中：設計書を書いている"],
      [
        "spec-review",
        "設計書のレビュー待ち",
        "設計書のレビュー待ち：設計書を書いている",
      ],
      ["working", "実装中", "実装中：設計書を書いている"],
      ["question", "質問があります", "質問があります：設計書を書いている"],
    ];
    for (const [state, plain, noted] of cases) {
      expect(cardForState(state).comment).toBe(plain);
      expect(cardForState(state, { note: "設計書を書いている" }).comment).toBe(
        noted,
      );
    }
    expect(cardForState("designing")).toEqual({
      workspaceStatus: "in-progress",
      comment: "設計中",
      unread: false,
    });
  });

  it("一言の前後の空白・改行は1行にまとまり、空白だけの一言は一言なしと同じ", () => {
    expect(
      cardForState("working", { note: "  確認役が\n  差分を\t確認中 \n" })
        .comment,
    ).toBe("実装中：確認役が 差分を 確認中");
    expect(cardForState("working", { note: " \n\t " }).comment).toBe("実装中");
    expect(cardForState("question", { note: "" }).comment).toBe(
      "質問があります",
    );
  });

  it("表示名は ID とタスク名を半角の空白1つでつなぐ", () => {
    expect(displayName("T95", "Android 実機での表示確認")).toBe(
      "T95 Android 実機での表示確認",
    );
  });

  it("カードの更新に表示名があると --display-name が渡り、ないと渡らない", async () => {
    const { runner, calls } = scripted(() => json({ ok: true, result: {} }));
    const orca = createOrca(runner);
    await orca.setCard("/w", {
      displayName: "T80 買い物の直し",
      ...cardForState("designing"),
    });
    await orca.setCard("/w", cardForState("working"));
    expect(calls).toEqual([
      [
        "worktree",
        "set",
        "--worktree",
        "path:/w",
        "--display-name",
        "T80 買い物の直し",
        "--workspace-status",
        "in-progress",
        "--comment",
        "設計中",
        "--read",
        "--json",
      ],
      [
        "worktree",
        "set",
        "--worktree",
        "path:/w",
        "--workspace-status",
        "in-progress",
        "--comment",
        "実装中",
        "--read",
        "--json",
      ],
    ]);
  });

  describe("送れない理由の文", () => {
    const tab = (handle: string, title: string) => ({
      handle,
      worktreePath: "/w",
      title,
      connected: true,
      writable: true,
      orphaned: false,
      agentIdentity: "claude",
    });

    it("見つからない：開き直しの一言が入る", () => {
      const text = describeSendBlock({ kind: "none" }, "claude");
      expect(text).toContain("見つかりません");
      expect(text).toContain("開き直してください");
    });

    it("1つに決まらない：題名なしを含め、題名とハンドルが入る", () => {
      const text = describeSendBlock(
        {
          kind: "ambiguous",
          candidates: [tab("t_a", "一つめ"), tab("t_b", "")],
        },
        "claude",
      );
      expect(text).toContain("1つに決まりません");
      expect(text).toContain("「一つめ」（t_a）");
      expect(text).toContain("「（題名なし）」（t_b）");
    });

    it("打ちかけ：入力欄と文が入る", () => {
      const text = describeSendBlock(
        { kind: "draft", draft: "書きかけ" },
        "claude",
      );
      expect(text).toContain("入力欄");
      expect(text).toContain("打ちかけ");
      expect(text).toContain("書きかけ");
    });

    it("bash モード：bash モードのことと、抜けてからの一言が入る", () => {
      expect(describeSendBlock({ kind: "bash" }, "claude")).toContain(
        "bash モード",
      );
      expect(sendFailMessage("T12", { kind: "bash" }, "claude")).toMatch(
        /^T12 のタスク長に送れませんでした：.*bash モード.*。.*抜けてから/,
      );
    });

    it("入力欄を確かめられない：その旨と、入力欄に戻してからの一言が入る", () => {
      expect(
        sendFailMessage("T12", { kind: "unverifiable" }, "claude"),
      ).toMatch(
        /^T12 のタスク長に送れませんでした：入力欄を確かめられません.*。.*入力欄に戻してから/,
      );
    });

    it("打ちかけの文は空白と改行を1つにまとめ、30文字を超えたら切って「…」", () => {
      expect(previewDraft("あ\n\n  い   う")).toBe("あ い う");
      expect(previewDraft("a".repeat(30))).toBe("a".repeat(30));
      expect(previewDraft("a".repeat(31))).toBe(`${"a".repeat(30)}…`);
      // 見た目の1文字（絵文字の合成）を1つに数える
      const family = "👨‍👩‍👧";
      expect(previewDraft(family.repeat(31))).toBe(`${family.repeat(30)}…`);
      const text = describeSendBlock(
        { kind: "draft", draft: `${"あ".repeat(40)}` },
        "claude",
      );
      expect(text).toContain(`「${"あ".repeat(30)}…」`);
      expect(text).not.toContain("あ".repeat(31));
    });

    it("tell・approve の文は「〈ID〉 のタスク長に送れませんでした：〈理由〉。〈どうするか〉」", () => {
      expect(
        sendFailMessage("T12", { kind: "draft", draft: "あ" }, "claude"),
      ).toMatch(
        /^T12 のタスク長に送れませんでした：.*。入力欄の文を送るか消してから/,
      );
    });
  });

  describe("入力欄の読み取り", () => {
    const line = "─".repeat(30);
    const screen = (...rows: string[]) => [
      "● 了解",
      "",
      line,
      ...rows,
      line,
      "  ⏵⏵ bypass",
    ];

    it("空なら空の文字、打ちかけがあれば文、続きの行はつなぐ", () => {
      expect(parseInputBox(screen("❯"))).toBe("");
      expect(parseInputBox(screen("❯\u00a0"))).toBe("");
      expect(parseInputBox(screen("❯ 書きかけ"))).toBe("書きかけ");
      expect(parseInputBox(screen("❯ 長い文", "  続き"))).toBe("長い文 続き");
    });

    it("形がなければ null", () => {
      expect(parseInputBox(["$ ls"])).toBeNull();
      expect(parseInputBox([line, "❯ あ"])).toBeNull();
      expect(parseInputBox(["a", "❯ あ", line])).toBeNull();
    });

    it("readInputBox：空・打ちかけ・bash モード・形なし", () => {
      expect(readInputBox(screen("❯"))).toEqual({ kind: "empty" });
      expect(readInputBox(screen("❯ あ"))).toEqual({
        kind: "draft",
        text: "あ",
      });
      expect(readInputBox(screen("! echo hi"))).toEqual({ kind: "bash" });
      expect(readInputBox(["$ ls"])).toEqual({ kind: "unknown" });
      expect(readInputBox(["a", "❯ あ", line])).toEqual({ kind: "unknown" });
      // 最後の入力欄を見る
      expect(readInputBox([...screen("! x"), ...screen("❯")])).toEqual({
        kind: "empty",
      });
    });

    it("空の入力欄の閉じの横線の下に「!」の行があっても empty。閉じの横線のない「!」は bash としない", () => {
      const below = [...screen("❯"), "! 状態行"];
      expect(readInputBox(below)).toEqual({ kind: "empty" });
      expect(parseInputBox(below)).toBe("");
      // 上に入力欄がない閉じのない「!」は、入力欄の形が見つからないのではなく bash（送らない）
      expect(readInputBox([line, "! ls"])).toEqual({ kind: "bash" });
      expect(readInputBox(["a", line, "! ls"])).toEqual({ kind: "bash" });
      // 閉じの横線がある「!」は、そのうしろに行があっても bash
      expect(readInputBox([...screen("! ls"), "! 状態行"])).toEqual({
        kind: "bash",
      });
    });

    it("閉じの横線のすぐ下の statusLine が「!」で始まる画面：空なら empty、打ちかけなら draft、checkInput は送れる", async () => {
      // 閉じの横線のすぐ下が「!」の行（bypass の行なし）。「!」の行のすぐ上が入力欄の閉じの横線になる
      const under = (rows: string[], ...status: string[]) => [
        "● 了解",
        "",
        line,
        ...rows,
        line,
        ...status,
      ];
      expect(readInputBox(under(["❯"], "! 状態行"))).toEqual({ kind: "empty" });
      expect(readInputBox(under(["❯ あ"], "! 状態行"))).toEqual({
        kind: "draft",
        text: "あ",
      });
      expect(readInputBox(under(["❯ 長い", "  続き"], "! 状態行"))).toEqual({
        kind: "draft",
        text: "長い 続き",
      });
      // statusLine が2行でも同じ
      expect(readInputBox(under(["❯"], "! 状態行", "2行目"))).toEqual({
        kind: "empty",
      });
      expect(readInputBox(under(["❯ あ"], "! 状態行", "2行目"))).toEqual({
        kind: "draft",
        text: "あ",
      });
      const send = (tail: string[]) =>
        createOrca(
          scripted(() => json({ ok: true, result: { terminal: { tail } } }))
            .runner,
        ).checkInput("t", "claude");
      expect(await send(under(["❯"], "! 状態行"))).toBeNull();
      expect(await send(under(["❯"], "! 状態行", "2行目"))).toBeNull();
      expect(await send(under(["❯ あ"], "! 状態行"))).toEqual({
        kind: "draft",
        draft: "あ",
      });
    });

    it("閉じのない「!」の行と上の古い空の入力欄のあいだに別の行があれば bash。checkInput は送らない", async () => {
      const tail = [...screen("❯"), "別の行", line, "! ls"];
      expect(readInputBox(tail)).toEqual({ kind: "bash" });
      // 閉じのない「!」が2行続き、上の入力欄とのあいだに別の行があるときも bash
      expect(
        readInputBox([...screen("❯"), "別の行", line, "! a", "続き"]),
      ).toEqual({ kind: "bash" });
      const orca = createOrca(
        scripted(() => json({ ok: true, result: { terminal: { tail } } }))
          .runner,
      );
      expect(await orca.checkInput("t", "claude")).toEqual({ kind: "bash" });
    });

    it("checkInput：statusLine が「!」で始まる画面でも、空の入力欄なら送れる", async () => {
      const tail = [...screen("❯"), "! 状態行"];
      const orca = createOrca(
        scripted(() => json({ ok: true, result: { terminal: { tail } } }))
          .runner,
      );
      expect(await orca.checkInput("t", "claude")).toBeNull();
    });

    it("read には --screen と10秒の待ち時間を渡す", async () => {
      const seen: { args: readonly string[]; timeoutMs?: number }[] = [];
      const runner: Runner = async (_cmd, args, opts) => {
        seen.push({ args, timeoutMs: opts?.timeoutMs });
        return json({ ok: true, result: { terminal: { tail: screen("❯") } } });
      };
      await createOrca(runner).checkInput("t", "claude");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.args).toContain("--screen");
      expect(seen[0]!.timeoutMs).toBe(10_000);
    });

    it("checkInput：claude は空だけ送れる。ほかのエージェントは打ちかけがなければ送れる", async () => {
      const read = (tail: string[] | null) =>
        createOrca(
          scripted(() =>
            tail === null
              ? json({ ok: false, error: { message: "x" } }, 1)
              : json({ ok: true, result: { terminal: { tail } } }),
          ).runner,
        );
      expect(await read(screen("❯")).checkInput("t", "claude")).toBeNull();
      expect(await read(screen("❯ あ")).checkInput("t", "claude")).toEqual({
        kind: "draft",
        draft: "あ",
      });
      expect(await read(screen("! ls")).checkInput("t", "claude")).toEqual({
        kind: "bash",
      });
      expect(await read(["$ "]).checkInput("t", "claude")).toEqual({
        kind: "unverifiable",
      });
      expect(await read(null).checkInput("t", "claude")).toEqual({
        kind: "unverifiable",
      });
      expect(await read(["$ "]).checkInput("t", "codex")).toBeNull();
      expect(await read(null).checkInput("t", "codex")).toBeNull();
      expect(await read(screen("! ls")).checkInput("t", "codex")).toBeNull();
      expect(await read(screen("❯ あ")).checkInput("t", "codex")).toEqual({
        kind: "draft",
        draft: "あ",
      });
    });

    it("inputDraft：画面の入力欄の文、空か読めなければ null", async () => {
      const read = (reply: RunResult) =>
        createOrca(scripted(() => reply).runner);
      // Orca の draft には Claude Code の入力の候補（薄い字）も入るので見ない（2026-10-23 に、
      // 入力欄が空なのに draft が「/orca-flow:approve T23」になり approve が止まった）
      expect(
        await read(
          json({
            ok: true,
            result: {
              terminal: { tail: screen("❯"), draft: "/orca-flow:approve T23" },
            },
          }),
        ).inputDraft("t"),
      ).toBeNull();
      expect(
        await read(
          json({
            ok: true,
            result: {
              terminal: {
                tail: screen("❯"),
                draft: "Press up to edit queued messages",
              },
            },
          }),
        ).inputDraft("t"),
      ).toBeNull();
      expect(
        await read(
          json({
            ok: true,
            result: { terminal: { tail: [], draft: "下書き" } },
          }),
        ).inputDraft("t"),
      ).toBeNull();
      expect(
        await read(
          json({ ok: true, result: { terminal: { tail: screen("❯ あ") } } }),
        ).inputDraft("t"),
      ).toBe("あ");
      expect(
        await read(
          json({ ok: true, result: { terminal: { tail: screen("❯") } } }),
        ).inputDraft("t"),
      ).toBeNull();
      expect(
        await read(json({ ok: false, error: { message: "x" } }, 1)).inputDraft(
          "t",
        ),
      ).toBeNull();
    });
  });
});

describe("送れなかった警告の文（1か所）", () => {
  it("理由・すること・添えが同じ形で組み立てられる", async () => {
    const { blockedWarning, sendFailedWarning } =
      await import("../../src/lib/orca.ts");
    const text = blockedWarning(
      "T01",
      "main が進んだ知らせ",
      "区切りで rebase をする",
      { kind: "bash" },
      "claude",
      "。統合待ちなら何もしなくてかまいません",
    );
    expect(text).toContain(
      "警告：T01 のタスク長に main が進んだ知らせを送れませんでした：",
    );
    expect(text).toContain("bash モード");
    expect(text).toContain(
      "orca-flow tell T01 で 区切りで rebase をするよう伝えてください",
    );
    expect(text).toContain("統合待ちなら何もしなくてかまいません");
    expect(
      sendFailedWarning(
        "T01",
        "verify のやり直しの知らせ",
        "x",
        new Error("切れた"),
      ),
    ).toContain("Orca の送信が失敗しました（切れた）");
  });
});
