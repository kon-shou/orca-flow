// 他人の文章を囲む「データ」の区切りを作る、共通の部品。Node の標準以外を読み込まない（test/common/common.test.ts が確かめる）。
// 伏せ字は呼ばない。伏せてから escapeData を通す順は呼ぶ側が守る。中身を変えたら manifest.json の版と要約値を直す。

import { randomBytes } from "node:crypto";

/** 区切りに入れる乱数（毎回変える。本文の側から閉じの形を当てられないようにする） */
export const newNonce = (): string => randomBytes(8).toString("hex");

/** 区切りの形（⟦ ⟧）を本文の中で別の字にして、閉じの形を作れないようにする */
export function escapeData(text: string): string {
  return text.replaceAll("⟦", "［").replaceAll("⟧", "］");
}

/** nonce から、データの開きと閉じの形を作る */
export function fenceMarks(nonce: string): { open: string; close: string } {
  return { open: `⟦データ ${nonce}⟧`, close: `⟦/データ ${nonce}⟧` };
}

/** 本文を区切りで囲む。本文の中の区切りの字は逃がす（伏せるのは呼ぶ側で、これより前に済ませる） */
export function fenceData(text: string, nonce: string): string {
  const { open, close } = fenceMarks(nonce);
  return `${open}\n${escapeData(text)}\n${close}`;
}
