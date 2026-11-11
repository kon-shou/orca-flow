import type { QaConfig } from "../../config.ts";
import { FlowError } from "../../types.ts";

/** 管理画面への1回の送りを待つ上限 */
export const QA_HTTP_TIMEOUT_MS = 60_000;

export interface QaForm {
  env: number;
  /** 欄の名前 → ブランチの上書き（selfField 以外） */
  overrides: Record<string, string>;
  /** selfField に入れるタスクのブランチ */
  selfBranch: string;
  database: boolean;
}

/** 送る欄を組む。後ろに書いたものが前を上書きする順：fields → branchFields の既定 → 上書き → selfField → envField → database */
export function buildFields(qa: QaConfig, form: QaForm): [string, string][] {
  const fields = new Map<string, string>();
  for (const [k, v] of Object.entries(qa.fields)) fields.set(k, v);
  for (const [k, v] of Object.entries(qa.branchFields)) fields.set(k, v);
  for (const [k, v] of Object.entries(form.overrides)) fields.set(k, v);
  fields.set(qa.selfField, form.selfBranch);
  fields.set(qa.envField, String(form.env));
  if (form.database && qa.databaseField) fields.set(qa.databaseField, "1");
  return [...fields];
}

/** basic 認証の頭。authEnv の環境変数の値は「ユーザー:パスワード」。なければ FlowError(2) */
export function authHeader(
  qa: QaConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!qa.authEnv) return undefined;
  const value = env[qa.authEnv];
  if (!value)
    throw new FlowError(
      2,
      `環境変数 ${qa.authEnv} がありません。管理画面の認証（ユーザー:パスワード）を入れて、やり直してください`,
    );
  return `Basic ${Buffer.from(value).toString("base64")}`;
}

export type SendResult =
  | { ok: true; status: number }
  | {
      ok: false;
      status: number | null;
      reason: string;
      /** 要求が管理画面に届いたか：届いた・届いていない・分からない（打ち切り） */
      delivered: "yes" | "no" | "unknown";
    };

/** フォームの POST を1回送る。応答の本文は返さない（成功の印の有無だけ見る） */
export async function sendForm(
  qa: QaConfig,
  fields: readonly [string, string][],
  authorization: string | undefined,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (authorization) headers.authorization = authorization;
  let response: Response;
  try {
    response = await fetch(qa.url, {
      method: "POST",
      headers,
      body: new URLSearchParams([...fields]).toString(),
      signal: AbortSignal.timeout(QA_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      status: null,
      reason: timeout
        ? `${QA_HTTP_TIMEOUT_MS / 1000}秒以内に答えませんでした`
        : "管理画面につながりませんでした",
      delivered: !timeout && failedBeforeConnect(error) ? "no" : "unknown",
    };
  }
  // 応答の頭を受け取った後は、要求は管理画面に届いている
  const status = response.status;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {
      ok: false,
      status,
      reason: `応答（状態 ${status}）の本文を読み取れませんでした`,
      delivered: "yes",
    };
  }
  if (!response.ok)
    return {
      ok: false,
      status,
      reason: `応答の状態が ${status} でした`,
      delivered: "yes",
    };
  if (!text.includes(qa.successText))
    return {
      ok: false,
      status,
      reason: `応答（状態 ${status}）に成功の印がありませんでした`,
      delivered: "yes",
    };
  return { ok: true, status };
}

/** つながる前に落ちたと言える失敗か。ECONNRESET などは送ったあとでも起きるので含めない */
function failedBeforeConnect(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return (
    code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN"
  );
}
