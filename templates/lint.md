# lint の決まりの足し方

このファイルは `/orca-flow:to-lint` が読む。人のレビューで見つけた誤りのうち、コードの形で見分けられるものを、lint の決まりにするための手順を書く。各見出しの下の説明と例を、このリポジトリの中身に書き換える。見出しの名前は変えない。

## 道具

使っている lint の道具と、入っているか。入っていなければ「なし」と書く（決まりの前に、道具を入れるタスクが要る）。

例：ESLint（`eslint.config.js`）、ruff（`pyproject.toml`）、semgrep、ast-grep、独自のスクリプト（`scripts/lint-*.mjs`）。

## 決まりの置き場

決まりを書くファイルやディレクトリ。道具が読む場所を、パスで書く。

例：ESLint なら `eslint-rules/` と `eslint.config.js`、ruff なら `pyproject.toml` の `[tool.ruff.lint]`、semgrep なら `.semgrep/`、ast-grep なら `rules/`、独自のスクリプトなら `scripts/lint-*.mjs`。

## 足し方

決まりを1つ足すときの手順。決まりの名前の付け方、登録する場所、メッセージの書き方を書く。メッセージには、決まりの内容と理由を短く入れる（教訓を消したあとも理由が残るため）。

例：ESLint なら「ルールのファイルを足し、`eslint.config.js` の rules で error にする」。ruff なら「`select` に規則の番号を足す」。semgrep なら「`.semgrep/` に yaml を足し、`message` に理由を書く」。

## 確かめ方

足した決まりが効いていることの確かめ方。落ちる例（決まりに反するコード）と通る例（決まりに沿うコード）を、それぞれ1つ以上置く場所と、その流し方を書く。

例：`test/lint-fixtures/bad/` に落ちる例、`test/lint-fixtures/good/` に通る例を置く。`pnpm lint:fixtures` が、bad で落ち、good で通ることを確かめる。ESLint なら RuleTester、semgrep なら `semgrep --test`、ruff なら fixtures を `ruff check` に渡して終了コードを見る。

## 流すコマンド

決まりを全体に流すコマンド。設定の verify か pathVerify に入れて、どのタスクの確認でも流れるようにする。

例：`pnpm lint`、`uv run ruff check .`、`semgrep --config .semgrep/ --error`、`node scripts/lint-rules.mjs`。
