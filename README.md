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

くわしい流れと設定は [docs/spec.md](docs/spec.md) を読んでください。

## ライセンス

MIT。[LICENSE](LICENSE) を見てください。
