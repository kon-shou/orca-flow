# orca-flow の開発

Claude Code のプラグイン orca-flow のリポジトリ。仕様は docs/spec.md が正。タスクの指示は docs/tasks/P〇.md。

設計の前に、docs/spec.md の3章（役割）・6章（リポジトリごとの設定）・7章（競合を防ぐ決まり）を読む。ほかの章は、依頼と元の報告が指す章と、目次から選んで読む（全文は読まない）。

## コマンド

- 依存の導入：pnpm install
- テスト：pnpm test
- 型チェック：pnpm typecheck
- 整形の確認：pnpm lint（直すときは pnpm format）
- プラグインの検証：claude plugin validate .
- CLI を手で動かす：bin/orca-flow <サブコマンド>

## 決まり

- 人間への返答、CLI のメッセージ、スキルと担当の定義は日本語で書く。
- 実行時の依存を足さない（Node の標準ライブラリだけ）。開発用の依存の追加は統括役が行う。
- CLI は Node の型の取り除きでそのまま動かす。import は拡張子 `.ts` まで書く。enum・namespace・コンストラクタの引数プロパティを使わない（tsconfig の erasableSyntaxOnly）。
- git と orca などの外のコマンドは、必ず src/lib/exec.ts の Runner を通して呼ぶ。テストでは偽物に差し替え、本物の Orca を触らない。git は一時ディレクトリの本物のリポジトリで確かめる。
- 契約のファイル（src/cli.ts、src/main.ts、src/types.ts、src/config.ts、src/lib/exec.ts、package.json、tsconfig.json、.claude-plugin/）は統括役だけが変える。変更が要れば報告に「契約の変更の依頼」として書く。
- 完了条件のテストを先に書く。テストを消したり弱めたりして通さない。
- 仕様と違う判断をしたら、報告に理由を書く。
- コミットは小さく、メッセージは「P〇: 何をしたか」。
- 秘密情報や .env の値を出力しない。
