import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

// 本物の設定（globalSetup・setupFiles）のまま、流すファイルだけ fixtures に替える
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/tmp-cleanup/fixtures/*.fixture.ts"],
  },
});
