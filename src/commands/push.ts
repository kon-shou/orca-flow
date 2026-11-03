import { FlowError, type Command } from "../types.ts";

/** 登録のための仮の中身。中身は push の道を作るタスクが書き換える */
export const run: Command = async () => {
  throw new FlowError(1, "push はまだありません");
};
