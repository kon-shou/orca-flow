#!/usr/bin/env bash
# orca-flow：Orca が新しい worktree を作ったときに流す準備（orca.yaml の scripts.setup から呼ぶ）
# /orca-flow:init が templates/setup.sh から作った。依存の導入の行はリポジトリに合わせて直してよい
set -uo pipefail

say() { printf 'orca-flow setup：%s\n' "$1" >&2; }
fail() {
  say "「$1」の段階で失敗しました（終了コード $2）。直してから、この worktree で bash .orca-flow/setup.sh をもう一度流してください"
  exit 1
}

# 1. メインのチェックアウトの場所を求める。今の場所がメインのチェックアウトなら何もしない
stage="メインのチェックアウトの場所を求める"
common_dir=$(git rev-parse --path-format=absolute --git-common-dir) || fail "$stage" $?
here=$(git rev-parse --show-toplevel) || fail "$stage" $?
main_root=$(cd "$(dirname "$common_dir")" && pwd -P) || fail "$stage" $?
here=$(cd "$here" && pwd -P) || fail "$stage" $?
if [ "$main_root" = "$here" ]; then
  say "メインのチェックアウトなので、準備はしません"
  exit 0
fi
cd "$here" || fail "$stage" $?

# 2. .worktreeinclude に書かれたファイルを、メインのチェックアウトから同じ相対パスにコピーする
#    すでにあれば上書きしない。メインになければ飛ばす。ファイルの中身は出さない
stage=".worktreeinclude のファイルのコピー"
include=""
if [ -f "$here/.worktreeinclude" ]; then
  include="$here/.worktreeinclude"
elif [ -f "$main_root/.worktreeinclude" ]; then
  include="$main_root/.worktreeinclude"
fi
if [ -n "$include" ]; then
  list=$(mktemp) || fail "$stage" $?
  trap 'rm -f "$list"' EXIT
  git -C "$main_root" ls-files -z --others --ignored --exclude-from="$include" >"$list" || fail "$stage" $?
  while IFS= read -r -d '' rel; do
    [ -f "$main_root/$rel" ] || continue
    if [ -e "$here/$rel" ] || [ -L "$here/$rel" ]; then
      say "すでにあるので上書きしません：$rel"
      continue
    fi
    mkdir -p "$(dirname "$here/$rel")" || fail "$stage" $?
    cp -p "$main_root/$rel" "$here/$rel" || fail "$stage" $?
    say "メインのチェックアウトからコピーしました：$rel"
  done <"$list"
fi

# 2b. git で追跡していない orca-flow のファイルを、メインのチェックアウトからコピーする
#     .orca-flow/config.json が無視されているとき（untracked の導入）だけ。あれば上書きしない。中身は出さない
stage="orca-flow のファイルのコピー"
if git check-ignore -q -- .orca-flow/config.json; then
  copy_untracked() {
    local rel=$1
    if ! git check-ignore -q -- "$rel"; then
      say "無視されていないのでコピーしません：$rel"
      return 0
    fi
    if [ -e "$here/$rel" ] || [ -L "$here/$rel" ]; then
      say "すでにあるので上書きしません：$rel"
      return 0
    fi
    mkdir -p "$(dirname "$here/$rel")" || fail "$stage" $?
    cp -p "$main_root/$rel" "$here/$rel" || fail "$stage" $?
    say "メインのチェックアウトからコピーしました：$rel"
  }
  if [ -d "$main_root/.orca-flow" ]; then
    while IFS= read -r -d '' rel; do
      copy_untracked "${rel#"$main_root"/}"
    done < <(find "$main_root/.orca-flow" -type f -print0)
  fi
  if [ -f "$main_root/.claude/settings.local.json" ]; then
    copy_untracked ".claude/settings.local.json"
  fi
fi

# 3. 依存を入れる（init が検出したものだけ）
step() {
  local label=$1
  shift
  say "$label"
  "$@" || fail "$label" $?
}
step_in() {
  local dir=$1 label=$2
  shift 2
  say "$label"
  (cd "$dir" && "$@") || fail "$label" $?
}
# orca-flow:install

say "準備が終わりました"
