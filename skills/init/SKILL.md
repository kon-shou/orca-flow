---
name: init
description: このリポジトリに orca-flow を入れる。設定・worktree の準備・設計書のテンプレートを置き、人間と設定を決めてコミットする。統括役のタブ（メインのチェックアウト）で人間が打つ。
argument-hint: ""
disable-model-invocation: true
---

あなたは統括役として、このリポジトリに orca-flow を入れる。メインのチェックアウトで、baseBranch にいることを確かめてから始める。

CLI は `orca-flow` で呼ぶ（プラグインの bin が PATH に入っている）。見つからなければ `"${CLAUDE_PLUGIN_ROOT}/bin/orca-flow"` で呼ぶ。終了コードは 0＝成功、1＝失敗、2＝人間か統括役の作業が先に要る、3＝git の競合。

## 手順

1. `orca-flow init` を流す。置くもの（config.json・setup.sh・spec-template.md・orca.yaml・.gitattributes の行）と、検出した verify・sharedPaths の一覧を、そのまま人間に見せる。終了コードが0でなければ、メッセージを人間に伝えて止まる。
2. リポジトリに合わせて直すところを、人間と1つずつ決める。リポジトリの CLAUDE.md・README・docs を読み、案を添えて聞く。
   - readFirst：タスク長が設計の前に必ず読むファイル（既定は `CLAUDE.md`）
   - progress：進捗表を使うか。使うならファイルのパス、列の見出し（id・title・depends・state・branch）、状態の言葉
   - appendOnlyFiles：どのタスクも追記するファイル（決定の記録など）
   - reviewerAgent：確認役。リポジトリに確認役の定義（例：`.claude/agents/reviewer.md` なら `reviewer`）があれば、それを使うか
   - pathVerify：特定の場所が変わったときだけ流すテスト
   - verify・sharedPaths：検出の結果で足りないもの、余計なもの
   - 設計書のテンプレートに足す節（リポジトリの決まりなど）
3. `orca-flow init --yes` で置く。そのあと、決めたとおりに直す。
   - `.orca-flow/config.json`：決めたキーだけを書き換える。
   - `.orca-flow/spec-template.md`：足す節を書き足す。「要点」「書き込んでよい場所」「担当の分け方」「作業中のほかのタスクとの重なり」「main への事前変更」の5つの節は消さない。
   - 手順2で appendOnlyFiles を決めたときは、config.json を直したあとに `orca-flow init --yes` をもう一度流す（ないファイルだけを置き、`.gitattributes` に `〈パス〉 merge=union` の行を足す）。足されたことを確かめる。
   - orca.yaml がすでにあって CLI が書き換えなかったときは、CLI が出した `scripts.setup` を足してよいかを人間に聞いてから足す。
4. `orca-flow config --json` を流し、終了コード0で、決めたとおりの値が出ることを確かめる。
5. CLI が出した settings の許可（`Bash(orca *)`、`Bash(orca-flow *)`）を `.claude/settings.json` に足すかを人間に聞く。よいと言われたときだけ、`permissions.allow` に足す。ほかのキーは変えない。
6. 置いたファイルと直したファイルだけを `git add` し、`〈integratorName〉: orca-flow を導入する` でコミットする（integratorName は config の値。既定は「統括役」）。push はしない。
7. 人間に、置いたもの・決めた設定・次の手順（`/orca-flow:new 〈やりたいこと〉` でタスクを始める）を短く伝える。

## 守ること

- 人間に聞かずに既存のファイル（orca.yaml・`.claude/settings.json`・CLAUDE.md）を書き換えない。
- `.env` などの秘密情報の中身を出力しない。
