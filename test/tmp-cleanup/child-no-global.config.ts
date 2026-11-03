import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

// globalSetup を外し、setupFiles（助け）だけで流す。
// 実行ごとの親フォルダがないので、フィクスチャのフォルダは差し替えた TMPDIR の直下にでき、
// 助けが消さなければ残る
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    include: ["test/tmp-cleanup/fixtures/*.fixture.ts"],
  },
});
