import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function read(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

function lineMatching(text: string, re: RegExp): string | undefined {
  return text.split("\n").find((line) => re.test(line));
}

describe("verify の記録の引き継ぎ（仕様書）", () => {
  it("verify の行の①と③に引き継ぎの言葉がある", async () => {
    const spec = await read("docs/spec.md");
    const row = lineMatching(spec, /^\| `verify` /);
    expect(row).toBeDefined();
    expect(row).toContain("消す前に読んでおく");
    expect(row).toContain("引き継ぎに当たるとき");
    expect(row).toContain("当たる pathVerify のコマンドだけを流す");
  });

  it("段落に条件・流すもの・記録・出力・integrate・after-merge がある", async () => {
    const spec = await read("docs/spec.md");
    const par = lineMatching(spec, /^\*\*verify の記録の引き継ぎ\*\*/);
    expect(par).toBeDefined();
    const start = spec.indexOf("**verify の記録の引き継ぎ**");
    const end = spec.indexOf("**マージのあとの main の確かめ**", start);
    expect(end).toBeGreaterThan(start);
    const body = spec.slice(start, end);
    expect(body).toContain("appendOnlyFiles");
    expect(body).toContain("祖先");
    expect(body).toContain("組み込みの追記だけの確かめ");
    expect(body).toContain("最初の時点を保つ");
    expect(body).toContain("引き継ぎ」の語");
    expect(body).toContain("記録を使う行");
    expect(body).toContain("今までどおり全部のコマンドを流す");
    expect(body).toContain("記録と同じ木とは扱わず「待ち」にして");
  });

  it("main の確かめの同じ木の扱いから、引き継いだ記録を除く", async () => {
    const spec = await read("docs/spec.md");
    const line = lineMatching(
      spec,
      /^- 記録の base が今の main と同じ（木が記録と同じ/,
    );
    expect(line).toBeDefined();
    expect(line).toContain("引き継いだ記録");
    expect(line).toContain("除く");
  });
});

describe("verify の記録の引き継ぎ（run のスキル）", () => {
  it("手順7と手順10に、軽く済むことが書かれている", async () => {
    const run = await read("skills/run/SKILL.md");
    const s7 = lineMatching(run, /このコミットで HEAD が動くので/);
    const s10 = lineMatching(run, /^10\. /);
    expect(s7).toContain("手順10で verify をやり直す");
    expect(s7).toContain("verify は記録を引き継いで軽く済む");
    expect(s10).toContain("`orca-flow verify` をもう一度流す");
    expect(s10).toContain("verify が記録を引き継いで");
  });
});
