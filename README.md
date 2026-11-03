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
2. 統括役のタブで `/orca-flow:new [--auto] 〈やりたいこと〉` を打つ（おまかせにするときだけ頭に `--auto` をつける）と、Orca の左にタスクが増え、設計書が書かれます。
3. 設計書を読み、よければ `/orca-flow:approve 〈ID〉` で承認します。実行はサブエージェントが進めます。
4. 「統合待ち」になったら報告と差分を読み、`/orca-flow:integrate 〈ID〉` で統合します。

Notion の要件から始めるときは、人が Notion の MCP をつないでおき（プラグインには入っていません）、統括役のタブで `/orca-flow:intake 〈開発チケットの URL〉` を打ちます。チケットとイシューを読んで仕様とタスクへの分け方を子ページに書き、人が「よい」と言ったあと、分けた1つずつを `new` で始めます。

設計書・報告・進捗表（タスクの記録）は、既定で公開に出ません。`init` が `.gitignore` に行を足し（`--yes` のとき）、無視された記録はコミットせず、統合でメインの作業ツリーへ写します。記録は手元の clone の中にだけ残ります。config.json で tasksDir・reportsDir・progress.file を直したら、`init --yes` をもう一度流して行を確かめ、`.gitignore` をコミットしてください。移り方は [docs/spec.md](docs/spec.md) の12章を読んでください。

くわしい流れと設定は [docs/spec.md](docs/spec.md) を読んでください。

## Windows で使う

Windows 11 でも、Orca の上で使い、このリポジトリ自体を開発できます。sh の書き方のスキルとフックを動かすため、Git Bash を使うのが前提です。PowerShell だけの環境は範囲の外です。

要るもの：

- Git for Windows（Git Bash が入ります）
- Node 22.18 以上
- pnpm（このリポジトリ自体を開発するときだけ）
- Orca の CLI（`orca`。Windows では `orca.cmd` として呼ばれます）

設定：

- Orca の設定で、ターミナルのシェルを Git Bash にします。Orca は worktree の setup を、ターミナルのシェルが Git Bash のときだけ sh で流します。ほかのシェルだと cmd で流れ、`.orca-flow/setup.sh` が動きません。
- 改行は LF にそろえてあります（`.gitattributes`）。`core.autocrlf` が true でも、clone した `bin/orca-flow` と `setup.sh` は壊れません。

人が試す手順：

1. Git Bash で clone し、`pnpm install` を流します。
2. `pnpm lint`・`pnpm typecheck`・`pnpm test` が通ることを確かめます。
3. Orca でそのリポジトリを開き、Orca のターミナルを Git Bash にして、メインのチェックアウトのタブで `/orca-flow:init` を流します。
4. `/orca-flow:new [--auto] 〈やりたいこと〉` で worktree が増え、設計書が書かれることを確かめます。
5. 落ちたところ（コマンド、出力、使ったシェル）を控えて知らせてください。

### WSL2 で使う

WSL2 の中にリポジトリを置き、Claude Code と orca-flow の CLI も WSL の中で動かす場合の注意です。

- Windows 側の Orca は、場所を `\\wsl.localhost\Ubuntu\home\…` という Windows の形で返します。orca-flow は、WSL の中（Linux で `WSL_DISTRO_NAME` がある）では、今のディストリビューションを指すこの形を `/home/…` に戻して使います。ほかのディストリビューションの場所は戻しません。Mac と Git Bash の動きは変わりません。
- 逆向きの `--repo path:/home/…` は、Orca の WSL の入口が変換しないことがあり、`repo_not_found` になります。orca-flow は変換しないので、`orca` の名前でラッパーを PATH の先頭に置き、`--repo path:/…` だけ `wslpath -w` で Windows の形にして Orca の WSL 用 CLI に渡してください。`--worktree path:/…` は Linux の形のまま通ります。

## ライセンス

MIT。[LICENSE](LICENSE) を見てください。
