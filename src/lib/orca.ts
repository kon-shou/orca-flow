import type { LeadConfig } from "../config.ts";
import { FlowError } from "../types.ts";
import type { Runner } from "./exec.ts";

/** Orca の CLI（1.4.229）の呼び出しをまとめる。Runner を外から渡し、テストでは偽物にする */

export type TaskState =
  | "designing"
  | "spec-review"
  | "working"
  | "question"
  | "integrate-wait"
  | "integrated";

export const TASK_STATES: readonly TaskState[] = [
  "designing",
  "spec-review",
  "working",
  "question",
  "integrate-wait",
  "integrated",
];

export interface CardUpdate {
  /** Orca のサイドバーの表示名。書かなければ変えない */
  displayName?: string;
  /** 書かなければ変えない */
  workspaceStatus?: string;
  comment?: string;
  /** true＝未読の印をつける、false＝外す */
  unread?: boolean;
}

/** 一言をつけられる状態（status --note が使える状態） */
export const NOTE_STATES: readonly TaskState[] = [
  "designing",
  "spec-review",
  "working",
  "question",
];

/** Orca の表示名：`〈ID〉 〈タスク名〉`（3章）。長さは切らない */
export function displayName(id: string, title: string): string {
  return `${id} ${title}`;
}

/** 一言の改行と続く空白を1つの空白にまとめる。空なら undefined */
export function normalizeNote(note: string | undefined): string | undefined {
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

const withNote = (label: string, note: string | undefined) => {
  const text = normalizeNote(note);
  return text ? `${label}：${text}` : label;
};

/** 4章の表：状態 → Orca のカードの更新 */
export function cardForState(
  state: TaskState,
  options: { note?: string; reportPath?: string } = {},
): CardUpdate {
  switch (state) {
    case "designing":
      return {
        workspaceStatus: "in-progress",
        comment: withNote("設計中", options.note),
        unread: false,
      };
    case "spec-review":
      return {
        workspaceStatus: "in-review",
        comment: withNote("設計書のレビュー待ち", options.note),
        unread: true,
      };
    case "working":
      return {
        workspaceStatus: "in-progress",
        comment: withNote("実装中", options.note),
        unread: false,
      };
    case "question":
      return {
        comment: withNote("質問があります", options.note),
        unread: true,
      };
    case "integrate-wait":
      return {
        workspaceStatus: "in-review",
        comment: options.reportPath
          ? `統合待ち：${options.reportPath}`
          : "統合待ち",
        unread: true,
      };
    case "integrated":
      return {
        workspaceStatus: "completed",
        comment: "統合済み",
        unread: false,
      };
  }
}

export interface OrcaWorktree {
  id: string;
  path: string;
  /** refs/heads/ を取ったもの */
  branch: string | null;
  isMainWorktree: boolean;
  workspaceStatus: string | null;
  comment: string;
  isUnread: boolean;
}

export interface OrcaTerminal {
  handle: string;
  worktreePath: string;
  title: string;
  connected: boolean;
  writable: boolean;
  orphaned: boolean;
  /** Orca がそのターミナルで今動いているエージェントにつける名前。シェルにはつかない */
  agentIdentity: string | null;
}

/** findTerminal の結果：1つ・なし・1つに決まらない */
export type TerminalLookup =
  | { kind: "found"; terminal: OrcaTerminal }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: OrcaTerminal[] };

/** 決まらないときの候補を人が見分ける文（題名とハンドル） */
export function describeCandidates(candidates: OrcaTerminal[]): string {
  return candidates
    .map((t) => `「${t.title || "（題名なし）"}」（${t.handle}）`)
    .join("、");
}

/** 送れない理由：見つからない・1つに決まらない・入力欄に打ちかけがある・bash モード・入力欄を確かめられない */
export type SendBlock =
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: OrcaTerminal[] }
  | { kind: "draft"; draft: string }
  | { kind: "bash" }
  | { kind: "unverifiable" };

/** findSendTarget の結果：送れる1つ、または送れない理由 */
export type SendLookup = { kind: "found"; terminal: OrcaTerminal } | SendBlock;

/** 打ちかけの文を人に見せる形：空白と改行を1つの空白にまとめ、30文字を超えたら30文字に切って「…」 */
export const DRAFT_PREVIEW_CHARS = 30;
export function previewDraft(draft: string): string {
  const text = draft.replace(/\s+/g, " ").trim();
  const chars = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (s) => s.segment,
  );
  return chars.length > DRAFT_PREVIEW_CHARS
    ? `${chars.slice(0, DRAFT_PREVIEW_CHARS).join("")}…`
    : text;
}

/** 送れない理由の文（「〜ので」「。」には続けない形） */
export function describeSendBlock(block: SendBlock, agent: string): string {
  switch (block.kind) {
    case "none":
      return `${agent} が動いているターミナルが見つかりません（Orca の更新より前に起動した ${agent} なら、タブで開き直してください）`;
    case "ambiguous":
      return `ターミナルが1つに決まりません（候補：${describeCandidates(block.candidates)}）`;
    case "draft":
      return `入力欄に打ちかけの文があります（「${previewDraft(block.draft)}」）`;
    case "bash":
      return "入力欄が bash モードです（「!」で始まっていて、送った文がシェルのコマンドとして走ります）";
    case "unverifiable":
      return "入力欄を確かめられません（画面を読めないか、入力欄の形が見つかりません。許可を求める画面などかもしれません）";
  }
}

/** 送れない理由ごとの、人がすること */
export function sendBlockRemedy(
  block: SendBlock,
  id: string,
  agent: string,
): string {
  switch (block.kind) {
    case "none":
      return `Orca で ${id} のタブを開いて ${agent} を動かしてから、もう一度呼んでください`;
    case "ambiguous":
      return "余分なタブを閉じてから、もう一度呼んでください";
    case "draft":
      return "入力欄の文を送るか消してから、もう一度呼んでください";
    case "bash":
      return `${id} のタブの bash モードを抜けてから、もう一度呼んでください`;
    case "unverifiable":
      return `${id} のタブを入力欄に戻してから、もう一度呼んでください`;
  }
}

/** tell・approve の「送れませんでした」の文 */
export function sendFailMessage(
  id: string,
  block: SendBlock,
  agent: string,
): string {
  return `${id} のタスク長に送れませんでした：${describeSendBlock(block, agent)}。${sendBlockRemedy(block, id, agent)}`;
}

/** 送れなかった警告の文：警告：〈ID〉 のタスク長に 〈何〉を送れませんでした：〈理由〉。〈すること〉 */
export const notSentWarning = (
  id: string,
  what: string,
  reason: string,
  remedy: string,
) => `警告：${id} のタスク長に ${what}を送れませんでした：${reason}。${remedy}`;

/** 警告の結び：〈直すこと〉から、orca-flow tell 〈ID〉 で〈伝えること〉よう伝えてください〈添え〉 */
export const tellAfter = (
  fix: string,
  id: string,
  tellWhat: string,
  note = "",
) => `${fix}から、orca-flow tell ${id} で ${tellWhat}よう伝えてください${note}`;

/** 送れない理由ごとに、人がすること（直してから tell で伝える） */
export function remedyAfter(
  block: SendBlock,
  id: string,
  agent: string,
  tellWhat: string,
  note = "",
): string {
  switch (block.kind) {
    case "none":
      return tellAfter(
        `Orca で ${id} のタブを開いて ${agent} を動かして`,
        id,
        tellWhat,
        note,
      );
    case "ambiguous":
      return tellAfter("余分なタブを閉じて", id, tellWhat, note);
    case "draft":
      return tellAfter("入力欄の文を送るか消して", id, tellWhat, note);
    case "bash":
      return tellAfter(
        `${id} のタブの bash モードを抜けて`,
        id,
        tellWhat,
        note,
      );
    case "unverifiable":
      return tellAfter(`${id} のタブを入力欄に戻して`, id, tellWhat, note);
  }
}

/** 送れない理由（SendBlock）の警告の文 */
export const blockedWarning = (
  id: string,
  what: string,
  tellWhat: string,
  block: SendBlock,
  agent: string,
  note = "",
) =>
  notSentWarning(
    id,
    what,
    describeSendBlock(block, agent),
    remedyAfter(block, id, agent, tellWhat, note),
  );

/** Orca の送信が失敗したときの警告の文 */
export const sendFailedWarning = (
  id: string,
  what: string,
  tellWhat: string,
  error: unknown,
  note = "",
) =>
  notSentWarning(
    id,
    what,
    `Orca の送信が失敗しました（${error instanceof Error ? error.message : String(error)}）`,
    tellAfter("原因を直して", id, tellWhat, note),
  );

const isBorder = (line: string) => /^\s*─{3,}\s*$/.test(line);

/** 画面の最後の入力欄：空・打ちかけ・bash モード・形が見つからない */
export type InputBox =
  | { kind: "empty" }
  | { kind: "draft"; text: string }
  | { kind: "bash" }
  | { kind: "unknown" };

/**
 * Claude Code の画面（tail）の最後の入力欄（横線の次の行で、「❯」か「!」で始まる）を読む。
 * 「!」は閉じの横線まで読んで bash とする。閉じの横線がない「!」の行は、すぐ上の横線が
 * 上で見つけた入力欄の閉じの横線のとき（statusLine が「!」で始まる）だけ飛ばして、その入力欄を読む。
 * そうでなければ（別の行がある・上に入力欄がない）bash として、上の古い入力欄には送らない。
 * 「❯」は閉じの横線がなければ unknown を返す。「❯」は、うしろと続きの行をつなぐ
 */
export function readInputBox(tail: string[]): InputBox {
  // 閉じのない「!」の行が見つかったとき、その上の入力欄が閉じていなければならない横線の位置
  let mustCloseAt: number | null = null;
  for (let i = tail.length - 1; i >= 1; i--) {
    const line = tail[i]!.trim();
    if (!isBorder(tail[i - 1]!)) continue;
    const bash = line.startsWith("!");
    if (!bash && !line.startsWith("❯")) continue;
    const rows = [line.slice(1).trim()];
    let closeAt = -1;
    for (let j = i + 1; j < tail.length; j++) {
      if (isBorder(tail[j]!)) {
        closeAt = j;
        break;
      }
      rows.push(tail[j]!.trim());
    }
    if (mustCloseAt !== null && closeAt !== mustCloseAt) {
      return { kind: "bash" };
    }
    if (closeAt === -1) {
      if (!bash) return { kind: "unknown" };
      if (mustCloseAt !== null) return { kind: "bash" };
      mustCloseAt = i - 1;
      continue;
    }
    if (bash) return { kind: "bash" };
    const text = rows.join(" ").trim();
    return text === "" ? { kind: "empty" } : { kind: "draft", text };
  }
  return mustCloseAt !== null ? { kind: "bash" } : { kind: "unknown" };
}

/**
 * Claude Code の画面（tail）の入力欄の文。入力欄の形が見つからなければ（bash モードも）null、空なら ""。
 * 最後の「横線・❯の行・…・横線」の、❯のうしろと続きの行をつなぐ
 */
export function parseInputBox(tail: string[]): string | null {
  const box = readInputBox(tail);
  if (box.kind === "empty") return "";
  return box.kind === "draft" ? box.text : null;
}

export interface CreatedWorktree {
  id: string | null;
  path: string;
  branch: string | null;
}

const ORCA_TIMEOUT_MS = 60_000;
/** 送る前の画面の読み取りの待ち時間 */
export const READ_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const stripHeads = (b: string | null) =>
  b === null ? null : b.replace(/^refs\/heads\//, "");

/** `path:〈絶対パス〉` の選び方 */
export const byPath = (p: string) => `path:${p}`;

export interface Orca {
  /** つながるかを確かめる。だめなら FlowError(1) */
  ping(timeoutMs?: number): Promise<void>;
  createWorktree(input: {
    repoPath: string;
    name: string;
    baseBranch: string;
    lead: LeadConfig;
    prompt: string;
  }): Promise<CreatedWorktree>;
  setCard(worktreePath: string, update: CardUpdate): Promise<void>;
  listWorktrees(repoPath?: string, timeoutMs?: number): Promise<OrcaWorktree[]>;
  removeWorktree(worktreePath: string): Promise<void>;
  /** worktree のタブでファイルを開く（--focus なし。人の見ている画面を変えない）。relativePath は worktree からの相対 */
  openFile(worktreePath: string, relativePath: string): Promise<void>;
  listTerminals(worktreePath: string): Promise<OrcaTerminal[]>;
  /**
   * worktree のタスク長のターミナル。つながっていて書き込めて orphaned でなく、
   * agentIdentity が agent と同じものだけを候補にする（題名は見ない）
   */
  findTerminal(worktreePath: string, agent: string): Promise<TerminalLookup>;
  /**
   * 送る直前の入力欄の打ちかけ。なければ null。
   * 読めない・入力欄の形が見つからない（Claude Code 以外など）ときも null
   */
  inputDraft(handle: string): Promise<string | null>;
  /**
   * 送る直前の入力欄の確かめ。送れる（agent が claude なら入力欄が空、ほかなら打ちかけがない）なら null、
   * 送れないならその理由。claude で読めない・形が見つからないときは送れない
   */
  checkInput(
    handle: string,
    agent: string,
  ): Promise<Exclude<SendBlock, { kind: "none" | "ambiguous" }> | null>;
  /** findTerminal に、入力欄の確かめ（checkInput）を足したもの */
  findSendTarget(worktreePath: string, agent: string): Promise<SendLookup>;
  sendText(handle: string, text: string): Promise<void>;
  launchAgent(input: {
    worktreePath: string;
    lead: LeadConfig;
    prompt: string;
  }): Promise<void>;
}

export function createOrca(runner: Runner, cwd?: string): Orca {
  const call = async (
    args: readonly string[],
    what: string,
    timeoutMs = ORCA_TIMEOUT_MS,
  ): Promise<unknown> => {
    const result = await runner("orca", [...args, "--json"], {
      cwd,
      timeoutMs,
    });
    if (result.timedOut)
      throw new FlowError(
        1,
        `Orca の${what}が時間内に終わりませんでした。Orca が動いているか確かめてください`,
      );
    if (result.code === 127)
      throw new FlowError(
        1,
        "orca のコマンドが見つかりません。Orca を入れて起動してください",
      );
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
    const failed =
      result.code !== 0 || (isObject(parsed) && parsed.ok === false);
    if (failed) {
      const error =
        isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
      const detail =
        str(error?.message) ?? (result.stderr || result.stdout).trim();
      throw new FlowError(
        1,
        `Orca の${what}に失敗しました${detail ? `：${detail}` : ""}（Orca が動いているか確かめてください）`,
      );
    }
    return isObject(parsed) && "result" in parsed ? parsed.result : parsed;
  };

  const listWorktrees: Orca["listWorktrees"] = async (repoPath, timeoutMs) => {
    const args = ["worktree", "list"];
    if (repoPath) args.push("--repo", byPath(repoPath));
    const result = await call(args, "worktree の一覧", timeoutMs);
    const rows =
      isObject(result) && Array.isArray(result.worktrees)
        ? result.worktrees
        : Array.isArray(result)
          ? result
          : [];
    return rows.filter(isObject).map((row) => ({
      id: str(row.id) ?? "",
      path: str(row.path) ?? "",
      branch: stripHeads(str(row.branch)),
      isMainWorktree: row.isMainWorktree === true,
      workspaceStatus: str(row.workspaceStatus),
      comment: str(row.comment) ?? "",
      isUnread: row.isUnread === true,
    }));
  };

  const listTerminals: Orca["listTerminals"] = async (worktreePath) => {
    const result = await call(
      ["terminal", "list", "--worktree", byPath(worktreePath)],
      "ターミナルの一覧",
    );
    const rows =
      isObject(result) && Array.isArray(result.terminals)
        ? result.terminals
        : Array.isArray(result)
          ? result
          : [];
    return rows.filter(isObject).map((row) => ({
      handle: str(row.handle) ?? "",
      worktreePath: str(row.worktreePath) ?? "",
      title: str(row.title) ?? "",
      connected: row.connected !== false,
      writable: row.writable !== false,
      orphaned: row.orphaned === true,
      agentIdentity: str(row.agentIdentity),
    }));
  };

  const findTerminal: Orca["findTerminal"] = async (worktreePath, agent) => {
    const candidates = (await listTerminals(worktreePath)).filter(
      (t) =>
        t.handle !== "" &&
        t.connected &&
        t.writable &&
        !t.orphaned &&
        t.agentIdentity === agent,
    );
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length === 1)
      return { kind: "found", terminal: candidates[0]! };
    return { kind: "ambiguous", candidates };
  };

  /** 画面（tail）を読む。読めなければ null。terminal.draft は見ない（Claude Code の入力の候補や案内の文も入るため） */
  const readTail = async (handle: string): Promise<string[] | null> => {
    try {
      const result = await call(
        ["terminal", "read", "--terminal", handle, "--screen"],
        "ターミナルの画面の読み取り",
        READ_TIMEOUT_MS,
      );
      const terminal =
        isObject(result) && isObject(result.terminal) ? result.terminal : null;
      const tail = terminal?.tail;
      if (!Array.isArray(tail)) return null;
      return tail.filter((l) => typeof l === "string");
    } catch {
      return null;
    }
  };

  const inputDraft: Orca["inputDraft"] = async (handle) => {
    const tail = await readTail(handle);
    if (tail === null) return null;
    const text = parseInputBox(tail);
    return text ? text : null;
  };

  const checkInput: Orca["checkInput"] = async (handle, agent) => {
    if (agent !== "claude") {
      const draft = await inputDraft(handle);
      return draft === null ? null : { kind: "draft", draft };
    }
    const tail = await readTail(handle);
    const box: InputBox =
      tail === null ? { kind: "unknown" } : readInputBox(tail);
    switch (box.kind) {
      case "empty":
        return null;
      case "draft":
        return { kind: "draft", draft: box.text };
      case "bash":
        return { kind: "bash" };
      case "unknown":
        return { kind: "unverifiable" };
    }
  };

  return {
    async ping(timeoutMs) {
      await listWorktrees(undefined, timeoutMs);
    },

    async createWorktree({ repoPath, name, baseBranch, lead, prompt }) {
      const result = await call(
        [
          "worktree",
          "create",
          "--repo",
          byPath(repoPath),
          "--name",
          name,
          "--base-branch",
          baseBranch,
          "--no-parent",
          "--setup",
          "run",
          "--agent",
          lead.agent,
          "--model",
          lead.model,
          "--effort",
          lead.effort,
          "--prompt",
          prompt,
        ],
        "worktree の作成",
        300_000,
      );
      const wt =
        isObject(result) && isObject(result.worktree)
          ? result.worktree
          : result;
      const git = isObject(wt) && isObject(wt.git) ? wt.git : null;
      const path = (isObject(wt) && str(wt.path)) || str(git?.path);
      if (!path)
        throw new FlowError(
          1,
          "Orca の worktree の作成の結果から worktree の場所を読めませんでした",
        );
      return {
        id: isObject(wt) ? str(wt.id) : null,
        path,
        branch: stripHeads(
          (isObject(wt) && str(wt.branch)) || str(git?.branch),
        ),
      };
    },

    async setCard(worktreePath, update) {
      const args = ["worktree", "set", "--worktree", byPath(worktreePath)];
      if (update.displayName !== undefined)
        args.push("--display-name", update.displayName);
      if (update.workspaceStatus !== undefined)
        args.push("--workspace-status", update.workspaceStatus);
      if (update.comment !== undefined) args.push("--comment", update.comment);
      if (update.unread === true) args.push("--unread");
      if (update.unread === false) args.push("--read");
      await call(args, "カードの更新");
    },

    listWorktrees,

    async removeWorktree(worktreePath) {
      await call(
        ["worktree", "rm", "--worktree", byPath(worktreePath)],
        "worktree の削除",
        120_000,
      );
    },

    async openFile(worktreePath, relativePath) {
      await call(
        ["file", "open", relativePath, "--worktree", byPath(worktreePath)],
        "ファイルを開く操作",
      );
    },

    listTerminals,

    findTerminal,

    inputDraft,

    checkInput,

    async findSendTarget(worktreePath, agent) {
      const found = await findTerminal(worktreePath, agent);
      if (found.kind !== "found") return found;
      return (await checkInput(found.terminal.handle, agent)) ?? found;
    },

    async sendText(handle, text) {
      await call(
        ["terminal", "send", "--terminal", handle, "--text", text, "--enter"],
        "ターミナルへの送信",
      );
    },

    async launchAgent({ worktreePath, lead, prompt }) {
      await call(
        [
          "agent",
          "launch",
          "--agent",
          lead.agent,
          "--worktree",
          byPath(worktreePath),
          "--model",
          lead.model,
          "--effort",
          lead.effort,
          "--prompt",
          prompt,
        ],
        "エージェントの起動",
        120_000,
      );
    },
  };
}
