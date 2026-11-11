---
name: init
description: このリポジトリに orca-flow を入れる。設定・worktree の準備・設計書のテンプレートを置き、人間と設定を決めてコミットする。統括役のタブ（メインのチェックアウト）で人間が打つ。
argument-hint: "[--untracked]"
disable-model-invocation: true
---

あなたは統括役として、このリポジトリに orca-flow を入れる。メインのチェックアウトで、baseBranch にいることを確かめてから始める。

CLI は `orca-flow` で呼ぶ（プラグインの bin が PATH に入っている）。見つからなければ `"${CLAUDE_PLUGIN_ROOT}/bin/orca-flow"` で呼ぶ。終了コードは 0＝成功、1＝失敗、2＝人間か統括役の作業が先に要る、3＝git の競合。

## 手順

1. `orca-flow init`（git に残さない導入にするとき、または config が untracked のときは `--untracked` つき）を流す。置くもの（config.json・setup.sh・spec-template.md・orca.yaml・.gitattributes の行・.gitignore の足す行）と、すでに追跡中の記録の知らせ（あれば）と、検出した verify・sharedPaths の一覧を、そのまま人間に見せる。untracked のときは、一覧の `.git/info/exclude` に足す行、すでに追跡中の orca-flow のファイルと行（`trackedFlowFiles`。追跡をやめる手順の文つき）、画面の設定の手順と今の状態も見せる。終了コードが0でなければ、メッセージを人間に伝えて止まる。
2. リポジトリに合わせて直すところを、人間と1つずつ決める。リポジトリの CLAUDE.md・README・docs を読み、案を添えて聞く。
   - readFirst：先に読む文書（既定は `CLAUDE.md`）。intake・how・タスク長・レビュー役などが全文読み、タスク長が担当と確認役にも渡す（担当を起こすたびに読まれる）。ファイルの種類（パターン）ごとに読む決まりは readFirst に入れず、readFirst の文書の側の表から指す（大きな決まりの文書をいくつも入れると、担当を起こすたびに全部が読まれ、文脈が長くなるため）
   - progress：進捗表を使うか。使うならファイルのパス、列の見出し（id・title・depends・state・branch）、状態の言葉
   - appendOnlyFiles：どのタスクも追記するファイル（決定の記録など）
   - reviewerAgent：確認役。リポジトリに確認役の定義（例：`.claude/agents/reviewer.md` なら `reviewer`）があれば、それを使うか
   - pathVerify：特定の場所が変わったときだけ流すテスト
   - verify・sharedPaths：検出の結果で足りないもの、余計なもの
   - 設計書のテンプレートに足す節（リポジトリの決まりなど）
3. `orca-flow init --yes` で置く（untracked のときは `orca-flow init --untracked --yes`。config に untracked が入ったあとは `--untracked` なしでもよい。字のとおり `--untracked` なしで初回に流すと、ふつうの導入になり .gitignore・.gitattributes・orca.yaml が書かれる）。そのあと、決めたとおりに直す。
   - `.orca-flow/config.json`：決めたキーだけを書き換える。
   - `.orca-flow/spec-template.md`：足す節を書き足す。「要点」「書き込んでよい場所」「担当の分け方」「作業中のほかのタスクとの重なり」「main への事前変更」の5つの節は消さない。
   - untracked のときは、config.json を直したら `orca-flow init --untracked --yes` を流し直して、`.git/info/exclude` と `.git/info/attributes` の行を確かめる（.gitignore・.gitattributes は触らず、手でも足さない）。次の行は untracked でないときの話。
   - config.json を直したら、必ず `orca-flow init --yes` をもう一度流して行を確かめる（ないファイルだけを置く）。appendOnlyFiles を決めたなら `.gitattributes` に `〈パス〉 merge=union` の行が、progress や tasksDir・reportsDir を変えたなら `.gitignore` にその記録の行が足されたことを確かめる。
   - `taskEnd` を `"pr"` にしたときは、`orca-flow init --yes` が見張りの automation（リポジトリごとに1つ、5分おきに PR の動きを見る）も作る。CLI の出力の「見張り（automation）」の行を人間に伝える。作れなかったとき（Orca が動いていない）は、Orca を起動してから `orca-flow pr-watch install` を打つよう伝える。`"integrate"` のままのリポジトリで PR の道（push）を使うときも、人間が `orca-flow pr-watch install` を打つ。Orca の画面の「今すぐ実行」は押さない（precheck を飛ばして worktree と会話が1つ増える）。
   - orca.yaml がすでにあって CLI が書き換えなかったときは、CLI が出した `scripts.setup` を足してよいかを人間に聞いてから足す。
   - untracked のときは、流すたびに画面の設定の手順を人に伝えて設定してもらう：Orca の設定画面の「ワークツリーフック」の「セットアップスクリプト」に `bash "$ORCA_ROOT_PATH/.orca-flow/setup.sh"`（空でなければその後ろの行に足す）、「セットアップが完了するまで待ってから Agent を開始」を入にする。そろっていなければ、人が設定したあと `orca-flow init` を流し直して「そろった」ことを確かめる。確かめられない（Orca に聞けない）ときは、Orca を起動してから流し直す。setup.sh に「# 2b.」の段がないと CLI が言ったときは、人に聞いて setup.sh を消し、`init --yes` で作り直す。
4. `orca-flow config --json` を流し、終了コード0で、決めたとおりの値が出ることを確かめる。
5. CLI が出した settings の許可を `.claude/settings.json`（untracked のときは `.claude/settings.local.json`。無視されていなければ CLI が exclude の行に足す）に足すかを人間に聞く。よいと言われたときだけ足す。ほかのキーは変えない。
   - `permissions.allow`：`Bash(orca *)`、`Bash(orca-flow *)`。
   - `permissions.ask`：`Bash(orca-flow send *)`、`Bash(orca-flow merge *)`、`Bash(orca-flow qa deploy *)`。これが GitHub へ送る・QA 環境へ deploy する承認の門なので、外さない（`Bash(orca-flow *)` の allow より ask が先に効き、send と merge と qa deploy だけが許可の画面を出す）。
   - 前から `Bash(orca-flow *)` を allow に入れている人は、allow はそのまま残し、`permissions.ask` に上の3つを足す。足さないと、承認の門を通らずに送れ、マージでき、QA 環境へ deploy できてしまう。足したあと、`/orca-flow:send` と `/orca-flow:merge` の最初の実行で許可の画面が出ることを確かめるよう人間に伝える（`qa deploy` は人がそのタブで頼んだときだけ打つので、最初に頼むときに確かめる）。出ないとき（権限を飛ばす形では、ask に当たる直のコマンドは拒否になる）は、その形では send と merge を使わない（`qa deploy` も同じ）。
   - マージの入口は `orca-flow merge`（`/orca-flow:merge`）の1本。GitHub のブランチの保護（必須レビュー・必須の CI・管理者も含める）を設定するよう人間に勧める。orca-flow は保護の設定を代わりに行わない。レビューを必須にしていないリポジトリは、GitHub の `reviewDecision` が空になり、`merge` は全員 OK にしない。
6. untracked のときは、何もコミットしない（`.orca-flow/` も `.claude/settings.local.json` も無視されている。`git status --porcelain` が空のままか確かめる）。そうでないときは、置いたファイルと直したファイル（`.gitignore` と `.gitattributes` を含む。コミットしないと新しい worktree で記録が無視されない）だけを `git add` し、`〈integratorName〉: orca-flow を導入する` でコミットする（integratorName は config の値。既定は「統括役」）。push はしない。
7. 人間に、置いたもの（untracked のときは、画面の設定がそろったかも）（.gitignore に足した行を含む。untracked では `.git/info/exclude` に足した行）・決めた設定・次の手順を短く伝える。タスクは `/orca-flow:new [--auto] 〈やりたいこと〉` で始める（`--auto` はおまかせの印で、頭に置く）。lint の決まりを足したいときは `/orca-flow:to-lint` から入る（最初の1回で `.orca-flow/lint.md` を人と作る。init は置かない）。

## 守ること

- 人間に聞かずに既存のファイル（orca.yaml・`.claude/settings.json`・CLAUDE.md）を書き換えない。
- `.env` などの秘密情報の中身を出力しない。
