# orca-flow

Claude Code のプラグイン。Orca で、1タスク＝1 worktree の「設計 → 目視レビュー → サブエージェントで実行 → 統合」を回すためのスキル・担当・CLI をまとめたものです。

## 要るもの

- Claude Code
- Orca
- git
- Node 22.18 以上（CLI は型の取り除きで .ts をそのまま動かすので、ビルドは要りません）
- pnpm（このリポジトリ自体を開発するときだけ）

## 入れ方

Claude Code で次を流します。

```
/plugin marketplace add kon-shou/orca-flow
/plugin install orca-flow@orca-flow
```

## 使い始め方

1. リポジトリごとに1回、Orca でそのリポジトリを開き、メインのチェックアウトのタブで `/orca-flow:init` を流します。
2. 統括役のタブで `/orca-flow:new 〈やりたいこと〉` を打つと、Orca の左にタスクが増え、設計書が書かれます。
3. 設計書を読み、よければ `/orca-flow:approve 〈ID〉` で承認します。実行はサブエージェントが進めます。
4. 「統合待ち」になったら報告と差分を読み、`/orca-flow:integrate 〈ID〉` で統合します。

設計書・報告・進捗表（タスクの記録）は、既定で公開に出ません。`init` が `.gitignore` に行を足し（`--yes` のとき）、無視された記録はコミットせず、統合でメインの作業ツリーへ写します。記録は手元の clone の中にだけ残ります。config.json で tasksDir・reportsDir・progress.file を直したら、`init --yes` をもう一度流して行を確かめ、`.gitignore` をコミットしてください。移り方は [docs/spec.md](docs/spec.md) の12章を読んでください。

くわしい流れと設定は [docs/spec.md](docs/spec.md) を読んでください。

## ライセンス

MIT。[LICENSE](LICENSE) を見てください。
