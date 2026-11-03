import path from "node:path";
import { defineConfig } from "vitest/config";

const helpers = path.resolve(import.meta.dirname, "test/helpers/tmp");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // マシンが混んだときの止まりに備えて60秒。短い時間切れを個別に足さない（test/vitest-config.test.ts）
    testTimeout: 60_000,
    // 同時に動かすテストのプロセスは CPU の半分まで
    maxWorkers: "50%",
    // 実行ごとの親フォルダを作り、TMPDIR などをそこへ向ける。終わりに丸ごと消す（test/helpers/tmp）
    globalSetup: [path.join(helpers, "global-setup.ts")],
    // 各ファイルの終わりに、テストの外で作った一時フォルダを消す
    setupFiles: [path.join(helpers, "setup.ts")],
  },
});
