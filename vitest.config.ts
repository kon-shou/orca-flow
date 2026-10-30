import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // マシンが混んだときの止まりに備えて60秒。短い時間切れを個別に足さない（test/vitest-config.test.ts）
    testTimeout: 60_000,
    // 同時に動かすテストのプロセスは CPU の半分まで
    maxWorkers: "50%",
  },
});
