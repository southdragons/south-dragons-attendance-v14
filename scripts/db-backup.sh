#!/usr/bin/env bash
# 新Supabase（cuhkjnuwozgnqqqvqhnl）のDBを、読み取りだけでバックアップする。
#
# 使い方:
#   bash scripts/db-backup.sh <作業名>                  例: bash scripts/db-backup.sh before-team-code
#   bash scripts/db-backup.sh <作業名> --without-auth   authを読めない場合（appだけ）
#   bash scripts/db-backup.sh --verify <バックアップのフォルダ>   取得済みのバックアップを再検証（DBに接続しない）
#
# 保存先: backups/<YYYYMMDD>-<作業名>/ （Git管理外）。同じ名前のフォルダがあれば中止する（上書きしない）。
#
# 含まれるもの（docs/db-backup-restore.md の「バックアップの範囲」も参照）:
#   app.dump        public と private スキーマの構造・データ・所有者・権限（GRANT）・RLSポリシー・関数
#   auth-data.dump  auth スキーマのデータだけ（users、identities、sessions、refresh_tokens など）。
#                   audit_log_entries は除く。★ログイン中の端末を乗っ取れる情報を含む。最も厳重に扱う
#   counts.txt      取得直前の各テーブルの件数（数字だけ）。復元後の照合に使う
#   SHA256SUMS / COMPLETE
# 含まれないもの: ロール（sd_attendance_writer など）とロールの設定（safeupdate など）、auth の構造、
#   拡張機能、Vault、Storage、Edge Function のコードとSecrets、Auth の設定、APIキー・JWTの鍵、GitHubの設定。
#
# 安全対策:
#   - 接続先は新Supabase（ユーザー名 postgres.cuhkjnuwozgnqqqvqhnl）に固定。旧Supabaseは拒否する。
#     ホスト名は ap-southeast-2 の Session pooler だけを受け付ける。
#   - 取得前に、読み取り専用のトランザクションで、このアプリのテーブルがそろっていることを確認する。
#   - パスワードは表示せずに入力し、本人だけが読める一時ファイル（PGPASSFILE）で渡す。
#     引数・環境変数・履歴・ログには残らない。一時ファイルは終了時に必ず削除する。
#   - pg_dump / pg_restore の終了コード、必要なテーブルのデータ、チェックサムをすべて確認してから
#     COMPLETE を作る。途中で失敗したら、作りかけのフォルダを削除する（COMPLETE は作らない）。
#   - DBを変更する処理はない。
set -euo pipefail
umask 077

SD_REF=cuhkjnuwozgnqqqvqhnl
SD_OLD_REF=flwwmfehxdmtomgkcdxm
SD_HOST_PATTERN='^aws-[0-9]+-ap-southeast-2\.pooler\.supabase\.com$'
SD_PG_BIN="${SD_PG_BIN:-/opt/homebrew/opt/libpq/bin}"
# このテーブルのデータが含まれていなければ失敗として扱う
SD_APP_TABLES=(public.players public.events public.attendance public.pending_attendance
  public.re_registration_requests public.settings public.player_access
  public.attendance_reminder_deliveries
  private.admin_sessions private.rate_limits private.user_activity)
SD_AUTH_TABLES=(auth.users auth.identities)

sd_die() { echo "ERROR: $*" >&2; exit 1; }

sd_validate_work_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,39}$ ]] || sd_die '作業名は英小文字・数字・ハイフン（2〜40文字）で指定してください'
}

sd_validate_host() {
  [[ "$1" =~ $SD_HOST_PATTERN ]] || sd_die 'ホスト名の形式が違います（例: aws-0-ap-southeast-2.pooler.supabase.com）'
}

# 接続先の安全装置。ユーザー名にプロジェクトIDが入るので、新Supabase以外には接続できない。
sd_validate_conn() {
  local conn="$1"
  [[ "$SD_REF" == cuhkjnuwozgnqqqvqhnl ]] || sd_die '接続先のプロジェクトIDが変更されています'
  [[ "$conn" != *"$SD_OLD_REF"* ]] || sd_die '旧Supabaseには接続しません'
  [[ "$conn" == *"user=postgres.$SD_REF"* ]] || sd_die '接続先が新Supabaseではありません'
}

sd_psql() { "$SD_PG_BIN/psql" -X -q -A -t -F '|' -v ON_ERROR_STOP=1 --no-password -d "$1" -c "$2"; }

# 読み取り専用で、必要なテーブルがそろっているか確認し、件数（数字だけ）を $2 に書く。
sd_check_target() {
  local conn="$1" out="$2" t list='' missing counts=''
  for t in "${SD_APP_TABLES[@]}" "${SD_AUTH_TABLES[@]}"; do list="$list,('$t')"; done
  missing=$(sd_psql "$conn" "begin transaction read only;
    select string_agg(t, ' ') from (values ${list#,}) v(t) where to_regclass(t) is null; commit;") \
    || sd_die '接続先の確認に失敗しました（接続できない、またはパスワードが違う）'
  [[ -z "$missing" ]] || sd_die "このアプリのDBではありません（見つからないテーブル: $missing）"
  for t in "${SD_APP_TABLES[@]}" "${SD_AUTH_TABLES[@]}"; do counts="$counts union all select '$t', count(*) from $t"; done
  sd_psql "$conn" "begin transaction read only; ${counts# union all }; commit;" > "$out" \
    || sd_die '件数の取得に失敗しました'
  echo '  接続先のテーブルを確認しました（件数）:'
  sed 's/^/    /; s/|/: /' "$out"
}

# dump を pg_restore --list で読み、必要なテーブルのデータがあるか確認する（DBには接続しない）。
sd_verify_dump() {
  local dump="$1" t miss=0; shift
  "$SD_PG_BIN/pg_restore" --list "$dump" > "$dump.list" || { echo "  pg_restore --list が失敗: $(basename "$dump")" >&2; return 1; }
  for t in "$@"; do
    grep -qE "TABLE DATA ${t%%.*} ${t#*.} " "$dump.list" || { echo "  不足: $t のデータがありません" >&2; miss=1; }
  done
  [[ $miss -eq 0 ]] || return 1
  echo "  $(basename "$dump"): データを含むテーブル $(grep -c 'TABLE DATA' "$dump.list") 個。必要なテーブルはすべてあり"
}

sd_checksums_ok() { ( cd "$1" && shasum -a 256 -c SHA256SUMS > /dev/null 2>&1 ); }

# バックアップ本体。$1=保存先の親フォルダ $2=作業名 $3=auth を含めるか(1/0) $4=接続文字列（パスワードなし）
sd_run_backup() {
  local root="$1" name="$2" with_auth="$3" conn="$4" day dest
  day=$(date +%Y%m%d)
  dest="$root/$day-$name"
  SD_WORK=''
  trap 'sd_cleanup' EXIT
  [[ ! -e "$dest" ]] || sd_die "同じ名前のバックアップがあります（上書きしません）: $dest"
  SD_WORK="$root/.inprogress-$day-$name-$$"
  mkdir -p "$root"; chmod 700 "$root"
  mkdir "$SD_WORK"

  echo '[1] 接続先を確認中（読み取りのみ）…'
  sd_check_target "$conn" "$SD_WORK/counts.txt"

  echo '[2] app（public + private）を取得中…'
  "$SD_PG_BIN/pg_dump" --no-password -d "$conn" --format=custom \
    --schema=public --schema=private -f "$SD_WORK/app.dump" || sd_die 'pg_dump（app）が失敗しました'

  if [[ "$with_auth" == 1 ]]; then
    echo '[3] authのデータを取得中…'
    "$SD_PG_BIN/pg_dump" --no-password -d "$conn" --format=custom --data-only \
      --schema=auth --exclude-table-data=auth.audit_log_entries -f "$SD_WORK/auth-data.dump" \
      || sd_die 'pg_dump（auth）が失敗しました'
  else
    echo '[3] authは取得しません（--without-auth）'
  fi

  echo '[4] 中身を検証中（DBには接続しない）…'
  sd_verify_dump "$SD_WORK/app.dump" "${SD_APP_TABLES[@]}" || sd_die 'app.dump の検証に失敗しました'
  if [[ "$with_auth" == 1 ]]; then
    sd_verify_dump "$SD_WORK/auth-data.dump" "${SD_AUTH_TABLES[@]}" || sd_die 'auth-data.dump の検証に失敗しました'
  fi

  ( cd "$SD_WORK" && shasum -a 256 *.dump counts.txt > SHA256SUMS ) || sd_die 'チェックサムを作れませんでした'
  sd_checksums_ok "$SD_WORK" || sd_die 'チェックサムの確認に失敗しました'
  {
    echo "completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "project=$SD_REF"
    echo "work=$name"
    echo "pg_dump=$("$SD_PG_BIN/pg_dump" --version)"
    echo "auth_included=$with_auth"
  } > "$SD_WORK/COMPLETE"
  chmod 600 "$SD_WORK"/*
  [[ ! -e "$dest" ]] || sd_die "同じ名前のバックアップがあります（上書きしません）: $dest"
  mv "$SD_WORK" "$dest"
  SD_WORK=''
  echo '--- 完了 ---'
  ls -l "$dest"
  echo "保存先: $dest"
  echo '注意: 個人情報と認証情報を含みます。共有・コミット・クラウド保存はしないでください。'
}

# 取得済みのバックアップを再検証する（DBには接続しない）。
sd_verify_backup() {
  local dir="${1%/}" auth
  [[ -d "$dir" ]] || sd_die "フォルダがありません: $dir"
  [[ -f "$dir/COMPLETE" ]] || sd_die 'COMPLETE がありません。不完全なバックアップです。使わないでください'
  grep -qx "project=$SD_REF" "$dir/COMPLETE" || sd_die '新Supabaseのバックアップではありません'
  sd_checksums_ok "$dir" || sd_die 'チェックサムが一致しません。ファイルが変わっています'
  sd_verify_dump "$dir/app.dump" "${SD_APP_TABLES[@]}" || sd_die 'app.dump の検証に失敗しました'
  auth=$(sed -n 's/^auth_included=//p' "$dir/COMPLETE")
  if [[ "$auth" == 1 ]]; then
    sd_verify_dump "$dir/auth-data.dump" "${SD_AUTH_TABLES[@]}" || sd_die 'auth-data.dump の検証に失敗しました'
  fi
  rm -f "$dir"/*.list
  echo "OK: $dir"
}

sd_main() {
  local name='' with_auth=1 host pw conn esc
  case "${1:-}" in
    --verify) [[ $# -eq 2 ]] || sd_die '使い方: bash scripts/db-backup.sh --verify <フォルダ>'; sd_verify_backup "$2"; return ;;
    ''|-*) sd_die '使い方: bash scripts/db-backup.sh <作業名> [--without-auth]' ;;
  esac
  name="$1"; shift
  case "${1:-}" in '') ;; --without-auth) with_auth=0 ;; *) sd_die "不明なオプション: $1" ;; esac
  sd_validate_work_name "$name"
  for b in pg_dump pg_restore psql; do [[ -x "$SD_PG_BIN/$b" ]] || sd_die "$b が見つかりません（brew install libpq）"; done
  command -v shasum > /dev/null || sd_die 'shasum が見つかりません'

  SD_PASSFILE=''; SD_WORK=''
  trap 'sd_cleanup' EXIT
  trap 'exit 130' INT TERM

  read -rp 'Session poolerのホスト名（例: aws-0-ap-southeast-2.pooler.supabase.com）: ' host
  sd_validate_host "$host"
  read -rsp 'DBパスワード（入力しても表示されません）: ' pw; echo
  [[ -n "$pw" ]] || sd_die 'パスワードが空です'
  SD_PASSFILE="$(mktemp "${TMPDIR:-/tmp}/sd-pgpass.XXXXXX")"
  esc="${pw//\\/\\\\}"; esc="${esc//:/\\:}"
  printf '%s:5432:postgres:postgres.%s:%s\n' "$host" "$SD_REF" "$esc" > "$SD_PASSFILE"
  unset pw esc
  export PGPASSFILE="$SD_PASSFILE" PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGAPPNAME=southdragons-backup
  conn="host=$host port=5432 dbname=postgres user=postgres.$SD_REF"
  sd_validate_conn "$conn"
  # SD_BACKUP_ROOT はテスト用（保存先の親フォルダだけを変える。接続先は変えられない）
  sd_run_backup "${SD_BACKUP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)/backups}" "$name" "$with_auth" "$conn"
}

sd_cleanup() {
  [[ -n "${SD_PASSFILE:-}" ]] && rm -f "$SD_PASSFILE"
  if [[ -n "${SD_WORK:-}" && -d "$SD_WORK" ]]; then
    rm -rf "$SD_WORK"
    echo 'バックアップは完了していません。作りかけのファイルは削除しました（COMPLETE は作っていません）。' >&2
  fi
  return 0
}

# テストから関数だけを読み込めるよう、直接実行されたときだけ動かす。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then sd_main "$@"; fi
