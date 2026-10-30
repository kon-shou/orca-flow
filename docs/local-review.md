# ローカルレビューの実機の手順書

ローカルのモデルを動かす機械が動いたあと、人間が上から順に流すための手順書。仕様は docs/spec.md の 10.3、設定は 6章の `localReview`。ここは「何を流して、何を見て、どう判断するか」だけを書く。

既定の `reviewBackend` は `claude` のまま。`local` にするのは、下の 2 で通ってからにする。

## 0. 守ること

- 本物の API キーやログインのトークンを、ローカルの端点に送らない。orca-flow は `claude` に渡す環境で、キーとトークンを `local` にし、`CLAUDE_CODE_OAUTH_TOKEN` と Bedrock・Vertex・Foundry への切り替えを消す。設定ファイルの `env` が戻さないよう、`--setting-sources ""` で設定を読ませない。手で `claude` を流すときも同じにする。
- 台帳は `〈git の共通ディレクトリ〉/orca-flow/reviews/〈ID〉/stage-〈段〉.json`。worktree の外なのでコミットに混ざらない。
- 手で試すときは、小さな使い捨てのタスクの worktree で行う。

## 1. ローカルのモデルを動かす機械の構築で確かめること

構築そのものはこの手順書の外。構築が済んだら次を確かめる。

| 確かめること                             | 見方                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| OS・カーネル                             | モデルを動かす実行環境が求める版を満たしている         |
| GPU 用のライブラリ                       | 必要な版が入っていて、GPU を認識する                   |
| GPU が使えるメモリ                       | モデルを載せるのに足りている                           |
| モデル                                   | レビューに使うモデルが読み込めている                   |
| `http://localhost:8080` が応答する       | この機械から `curl -s http://localhost:8080/v1/models` |
| Anthropic 互換の `/v1/messages` を扱える | 下の 2 の①                                             |
| Claude Code の tool use を扱える         | 下の 2 の②③                                            |
| `--json-schema` を扱える                 | 下の 2 の③                                             |

## 2. 疎通の確かめ：`orca-flow local-check`

```bash
bin/orca-flow local-check                 # 設定の localReview（baseUrl・model）を使う
bin/orca-flow local-check --base-url http://localhost:8080 --model 〈モデル名〉
bin/orca-flow local-check --json          # 段ごとの名前・結果・理由を JSON で出す
```

3段を順に試し、段ごとに「通った・落ちた・飛ばした」を出す。全部通れば終了コード0、どれか落ちれば1。

| 段            | すること                                                                                                     | 落ちたときに疑うこと                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| ① 入口        | `/v1/messages` に短い文を送り、文が返るか                                                                    | 入口が起動していない・URL やポートの違い・モデル名の違い・`/v1/messages` に未対応      |
| ② tool use    | 道具を1つ渡し、`tool_use` が返るか                                                                           | モデルが道具の呼び出しに未対応（入口が tools を無視している）。③も落ちやすい           |
| ③ Claude Code | review-local と同じ引数と環境で `claude` を流し、一時ディレクトリのファイルを Bash で読ませ、JSON で返させる | Bash が使えない・`--json-schema` の構造化出力に未対応・ストリーミング（SSE）の形の違い |

- ①が落ちたら②③は飛ばす。②が落ちても③は流す（原因の切り分けのため）。
- ③は `claude` を最大5分待つ。①②は1回60秒まで。
- ③が落ちたときは、同じ引数を手で流して画面を見る（`src/lib/local-review.ts` の `claudeArgs`）。引数を自分で変えず、落ちた様子を記録して直すかどうかを決める。
- 扱えなければ、`localReview.runner` を `opencode` にするか、`reviewBackend` を `claude` のままにする（OpenCode は入れてから別タスクで確かめる）。

## 3. 小さい差分のスモークテスト（review-local の1周）

`.orca-flow/config.json` の `reviewBackend` を、試すタスクの worktree だけ一時的に `local` にする。

```bash
orca-flow review-local Txx "main...HEAD" first --stage 1 --cycle 1 --json
orca-flow review-ledger show --stage 1 --json
```

見るもの：

- レビュー結果が JSON で返り、指摘 ID が `F1` から振られる。
- 検証の結果（verdict・severity・evidence）が台帳に入る。
- must-fix の判定が妥当。
- 差分がないときは、空の台帳ができる。
- JSON が壊れたときに、1回だけ再試行する（台帳の周の記録の `retries`）。

## 4. full の通し

見るもの：

- 1段目の 1→2→3 周で、台帳が保持される。
- 2段目が、1段目の指摘を背景に読む。台帳は別ファイル（`stage-2.json`）になる。
- 段末に `stage-verifier` が起動し、`record-opus` が通る。
- `record-finding` が通る。`humanReview: true` の指摘は Sonnet に戻らない。
- `needs_human` で `status question` になる。
- `must_fix` の裁定で `newEvidence` がないと拒否される。
- 前の修正と重なる修正が、`revertJustification` なしだと拒否される。

## 5. light の通し

見るもの：

- 1周で終わる。
- 修正のあとに `redo` が走る。
- `redo` で新しく入った must-fix も拾う。
- Opus の裁定と追加の周回がない。

## 6. 品質と速度の計測

実際に Claude のレビューで must-fix が出た過去のタスクで測る。

目標：

| 項目              | 目標              |
| ----------------- | ----------------- |
| must-fix の再現率 | 80% 以上          |
| 誤 must-fix       | 1件/レビュー 以下 |
| 形式の遵守        | 95% 以上          |
| 1周の時間の中央値 | 10分 以内         |

### 周ごとの記録の読み方

review-local は1周ごとに、台帳の `rounds` 配列に1つ足す。前からある台帳（`rounds` がないもの）も今までどおり読める。

```json
{
  "rounds": [
    {
      "stage": 1,
      "cycle": 1,
      "mode": "first",
      "startedAt": "2026-10-23T12:00:00.000Z",
      "durationMs": 412000,
      "calls": [
        {
          "kind": "reviewer",
          "durationMs": 301000,
          "retries": 0,
          "usage": {
            "inputTokens": 52000,
            "outputTokens": 3100,
            "cacheReadTokens": 0,
            "cacheCreationTokens": 0
          }
        }
      ]
    }
  ]
}
```

- `kind` は `reviewer`・`verifier`・`redo-verifier`。`retries` は1回で通れば0。
- `usage` は `claude -p --output-format json` の結果から取る。取れなければ省かれる（失敗にはしない）。OpenCode の呼び出しにはない。

周ごとの時間と、入力・出力トークンの合計（jq がある場合）：

```bash
F="$(git rev-parse --path-format=absolute --git-common-dir)/orca-flow/reviews/Txx/stage-1.json"
jq '.rounds[] | {cycle, mode, minutes: (.durationMs/60000),
  input: ([.calls[].usage.inputTokens // 0] | add),
  output: ([.calls[].usage.outputTokens // 0] | add),
  retries: ([.calls[].retries] | add)}' "$F"
```

### 数え方

- **再現率**：Claude のレビューで確定した must-fix のうち、ローカルも must-fix として出した数 ÷ 確定した数。
- **誤 must-fix**：ローカルが must-fix にしたが、検証役か人間が wrong・誤りとした指摘の数 ÷ レビューの回数。
- **形式の遵守**：呼び出しのうち、再試行なしで JSON が通った割合（`retries` が0の呼び出し ÷ 全呼び出し）。
- **時間**：`rounds[].durationMs` の中央値。
- ほかに、見逃し、Opus の裁定の妥当性、Sonnet の修正の手戻りも書き留める。

## 7. 設定を戻す判断

品質が目標に届かないとき、上から順に試す。

1. `localReview.model` を替える。
2. プロンプト（`agents/` の定義）を調整する。
3. `fullReviewAt` を増やす。
4. `stageLimits` を増やす。
5. `fallback` を `human` にする。
6. 最終手段として `reviewBackend` を `claude` に戻す。

戻すのは設定の1行（`reviewBackend: "claude"`）だけで済む。台帳は残るので、あとから周の記録を比べられる。
