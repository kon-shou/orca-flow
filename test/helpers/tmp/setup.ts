import { afterAll } from "vitest";
import { removeFileScoped } from "./index.ts";

// setupFiles：全テストファイルの終わりに、テストの外で作った一時フォルダを消す
afterAll(async () => {
  await removeFileScoped();
});
