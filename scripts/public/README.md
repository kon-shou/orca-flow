# 公開用のスクリプト

このリポジトリを public に上げるための道具。main から `docs/tasks/` などを抜いたコミットを `public` ブランチに作り、push を `public` から GitHub の `main` への1本だけに限る。orca-flow の CLI ではなく、このリポジトリ用の開発の道具。

入口は `node scripts/public/main.ts 〈build|check|pre-push|setup〉`。メッセージは標準エラーに出る。終了コードは 0＝成功、1＝確かめに落ちた・失敗、2＝人の作業が先に要る（名前・語の一覧・フックの衝突など）。

| サブコマンド                                                   | することと、止めるもの                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `setup --name 〈名前〉 --email 〈メール〉 [--remote 〈名前〉]` | 公開用の名前とメールを git の設定に書き、`pre-push` のフックを置き、remote があれば `remote.〈名前〉.push` を設定する |
| `build [--message 〈文〉]`                                     | main の木から抜くパス（`exclude.txt`）を除いて `public` にコミットを作る。check に通ったときだけ `public` を進める    |
| `check [〈コミット〉]`                                         | 抜くパス・語・作者・ID の形を確かめる。既定は `public`。語の当たりは語を出さず、パスと「何番目の語か」だけ出す        |
| `pre-push`                                                     | フックから呼ばれる。`public` を `main` へ送るときだけ通し、送る範囲の全コミットに check をかける                      |

## 初めて公開する手順

1. **語の一覧を作る**：`"$(git rev-parse --git-common-dir)/orca-flow/public-words.txt"`（普通は `.git/orca-flow/public-words.txt`）に、公開してはいけない語を1行1語で書く（`#` はコメント）。git の外に置くので、コミットされない。一覧そのものを文書やメッセージに書かない。ない・空だと build と check は終了コード2で止まる。
2. **setup**：`node scripts/public/main.ts setup --name 〈公開用の名前〉 --email 〈公開用のメール〉`。違うフックがすでにあるか `core.hooksPath` があると、書き換えずに終了コード2で止まる（自分で統合する）。
3. **build**：`node scripts/public/main.ts build`。最初は親のないコミットができる。作業ツリーと index と main は変わらない。build は始めにフックの効きを確かめる（`core.hooksPath` がない、`pre-push` が setup の書いたもので実行できる、フックが指す `main.ts` がある）。1つでも欠けると、`public` を作らず・進めずに終了コード2で止まる（setup の前に build するとここで止まる）。語が見つかると `public` を進めずに終了コード1で止まる。
4. **check**：`node scripts/public/main.ts check`。`public` をもう一度確かめる。
5. **GitHub にリポジトリを作る**：空のリポジトリを作り、下の「ルールセット」を先に設定する。
6. **remote を足して setup をもう一度**：`git remote add origin 〈URL〉` のあと、手順2と同じ setup を流す。`remote.origin.push` が `refs/heads/public:refs/heads/main` になる。
7. **push（人が行う）**：`git push origin`。フックが、送る範囲の全コミットに check をかけてから通す。`git push origin main` や `--all`・`--mirror` はフックが止める。

## GitHub のルールセット

- main への force push を禁止する。
- main 以外のブランチを作らせない（ブランチの作成を制限する）。

## 公開を更新する

1. 手元の main を更新する（普通の開発のとおり）。
2. `node scripts/public/main.ts build`。木が前の `public` と同じなら何も作らず終了コード0。
3. `git push origin`（人が行う）。

### GitHub で入った変更を取り込んだあとの更新

GitHub 側で入った変更（プルリクエストなど）は、手元の main に pull せず、`git cherry-pick` で取り込む。そのあとの更新は次の順で行う。

1. `git fetch origin`
2. `git branch -f public origin/main`（`public` を GitHub の main に合わせる。そうしないと、push が先に進めない形になる）
3. cherry-pick した main で `node scripts/public/main.ts build`
4. `git push origin`

## 守ること

- push に `--no-verify` を使わない。フックは公開用の確かめの最後の砦。
- build はフックの効きを確かめる。setup のあとでフックが外れたり `core.hooksPath` が足されたりすると終了コード2で止まるので、理由を直して setup を流し直す。`--no-verify` だけは確かめられないので、上のとおり使わない。
- フックは setup した時の `main.ts` と node を使う。ブランチを統合して `main.ts` の場所が変わったら、メインの作業ツリーで setup を流し直す。node を入れ替えたときも、setup をもう一度流す（フックの node が見つからないと、push は日本語のメッセージで止まる）。
- 抜くパスは、流した作業ツリーではなく main の `scripts/public/exclude.txt` から読む。変えたら main にコミットしてから build する。

## 抜くパス

main の `scripts/public/exclude.txt` に1行1パスで書く（`#` はコメント、末尾の `/` はディレクトリ）。今は、このリポジトリのタスクと調べた結果（`docs/tasks/`・`docs/public-release-audit/`・`docs/lead-context/`・`docs/orca-highlight/`）と、タスクを測った記録と道具とテスト（`docs/subagent-structure/`・`scripts/review-eval/`・`test/scripts/review-eval/`）。環境ごとのものなので公開しない。check は、これらが木に残っていないことも確かめる。公開の木のファイルは、抜くパスの中のファイルを import しない（テストで確かめる）。

## ID の形

タスクの番号は clone した環境ごとに作られるので、公開の木には出さない。check は、公開の木のパスと中身、コミットのメッセージに「ID の形」があると、終了コード1で止める（build・check・pre-push のどれでも効く）。

- ID の形：main の `.orca-flow/config.json` の `idPrefix`（ファイルがなければ既定値の `T`）のすぐあとに数字が1つ以上、英小文字が0〜1個、そのあとが ASCII の英数字でないもの。前も ASCII の英数字でないこと（行頭は可）。大文字小文字は区別する。`idPrefix` が読めない・形が違うと終了コード2。
- 例（`idPrefix` が `Q` のとき）：`Q12`・`Q12a`・`（Q12）`・`Q12-名前` は当たり、`xQ12`・`Q12X`・`HTTP2`・`…/Q96Sfx` のように英数字が続く形は当たらない。記号に挟まれた並びは当たりうる（下の「ID の形の限界」）。
- 中身は文字のファイルだけ見る（NUL を含むファイルはバイナリとして見ない。`.gitattributes` の binary・-diff では飛ばさない）。シンボリックリンクの行き先も見る。例外のパスの一覧はない。
- 当たりは「ファイル：行：当たった語」で出る。語の一覧の当たりと違い、語を隠さない。パスとメッセージの当たりも語を出す。ただしパスに語の一覧の語を含むファイルの当たりは、件数だけ出す。
- 当たったら、公開に残すファイルなら、番号を中身の言葉に直す（例の ID は仕様の作り物にする）。環境ごとのファイルなら、`exclude.txt` に足して抜く。

## ID の形の限界

ID の形の確かめは、記号に挟まれた並び（例：`integrity: sha512-abc/〈接頭辞〉3+xyz==` の `〈接頭辞〉3`）に当たりうる。例外の一覧はないので、当たったら依存の版を変えてハッシュを変えるか、例外を作るタスクを立てる。

## 限界

check の語の照合には、次の限界がある。語の一覧を作るときに気をつける。

- パスの照合の大文字小文字の区別なしは ASCII だけ。ASCII 以外は、語の元の形・小文字・大文字で一致するものだけ見つかる。大文字小文字が混ざった形は取りこぼすことがある。
- 正規化の形が違うパス（NFD など）は、語が NFC の形だと見つからない。
- 中身の照合は `git grep -F -i` で行う。ASCII 以外の大文字小文字の区別なし、`\E` を含む語は、中身で当たらないことがある。
- シンボリックリンクの行き先は、別に読んで照合する（件数だけ出す）。
