# DBのバックアップと復元

対象：新Supabase `cuhkjnuwozgnqqqvqhnl` のDB
SupabaseのFreeプランには自動バックアップがありません（PITRも無効。2026-10-27に確認）。このページの手順で取るダンプが、唯一のバックアップです。

| 状況 | 使うもの |
|---|---|
| チームコードの反映を元に戻したい | `supabase/rollback/20261023000000_team_code_down.sql`（データは消えない。`docs/team-code-release.md` の4） |
| プロジェクトが使えなくなった。新しいプロジェクトに作り直す | このページの「3. 空のプロジェクトへの復元」（ローカルで訓練済み） |
| 同じプロジェクトの中で、データだけを過去の状態に戻したい | 未検証。必ず先にローカルで訓練する（「4. 未検証の手順」） |

## 1. バックアップの範囲
| 対象 | バックアップに含まれるか | 復元時の扱い |
|---|---|---|
| public・private の表と、そのデータ（選手・予定・出欠・保留中の出欠・申請・端末共有・設定・欠席通知の記録・管理者のログイン状態・入力回数の記録・利用状況・チームコード関連） | 含む（`app.dump`） | そのまま戻る |
| 表の所有者、権限（GRANT）、RLSの有効化、RLSポリシー、DB関数、制約、索引 | 含む（`app.dump`） | 戻る。ただし権限は手順3の通りに戻さないと、余計な権限が付く |
| auth のデータ（匿名ユーザー、ログイン中の端末のセッションと更新用トークン、identities など） | 含む（`auth-data.dump`）。`audit_log_entries` は除く | `auth.schema_migrations` を除いて戻す |
| 件数（数字だけ） | 含む（`counts.txt`） | 復元後の照合に使う |
| ロール `sd_attendance_writer` と、`postgres` をそのメンバーにする設定 | **含まない** | 手順3-1で作る |
| ロールの設定（`authenticator` の `safeupdate`、`anon` / `authenticated` のタイムアウト） | 含まない | Supabaseの初期設定。新しいプロジェクトでも同じか確認する |
| auth の構造、拡張機能（pgcrypto など）、Vault、Storage | 含まない | Supabaseが用意する |
| Edge Function のコードとSecrets（LINEのトークン・送信先、管理用の値、許可するURLなど） | 含まない | コードはGit。Secretsは管理者が別に保管・再登録する |
| Auth の設定（匿名ログインの許可など）、APIキー、JWTの鍵 | 含まない | Dashboardで設定。新しいプロジェクトでは鍵が変わる |
| GitHub の Variables・Secrets、GitHub Pages | 含まない | 新しいプロジェクトのURL・キーに合わせて更新する |

## 2. バックアップを取る（`scripts/db-backup.sh`）
準備：
- `brew install libpq`（`pg_dump` / `pg_restore` / `psql`）
- DBのパスワード（Dashboard → Project Settings → Database）
- Session pooler のホスト名（Dashboard → Connect → Session pooler。`aws-0-ap-southeast-2.pooler.supabase.com` の形）

```bash
cd /Users/kakimoto_mac/my_app/SouthDragons
bash scripts/db-backup.sh before-team-code
```

- 作業名ごとに、`backups/<YYYYMMDD>-<作業名>/` を作ります。同じ名前のフォルダがあれば中止します（上書きしません）。
- ホスト名とパスワードは、画面の質問に入力します（パスワードは表示されず、履歴にも残りません）。
- 接続先は新Supabaseに固定されています。旧Supabase、別の地域のホスト、このアプリのテーブルがないDBは拒否します。
- DBは読み取りだけです。取得前に、各テーブルの件数（数字だけ）を表示します。
- 失敗すると、作りかけのフォルダは削除され、`COMPLETE` は作られません。

取得後と、復元の前に、毎回検証します（DBには接続しません）：
```bash
bash scripts/db-backup.sh --verify backups/<YYYYMMDD>-<作業名>
```
`COMPLETE` があり、新Supabaseのものであり、チェックサムが一致し、`pg_restore --list` で必要なテーブルのデータが読めれば `OK` と表示されます。

保管：
- 個人情報と、ログイン中の端末を乗っ取れる情報（`auth-data.dump`）を含みます。チャット・GitHub・クラウドの共有フォルダには置きません。
- Macのディスクは FileVault で暗号化されています。ファイルは本人だけが読める設定（600）です。
- `backups/` は Time Machine の対象に含まれています。Time Machine のディスクが暗号化されているかは未確認です。暗号化されていなければ、`backups/` を対象から外すか、ディスクを暗号化してください。
- 反映が無事に終わり、不要になったバックアップは削除します（目安：次のバックアップを取り、検証できたら）。

## 3. 空のプロジェクトへの復元（ローカルで訓練済み）
**本番のバックアップをローカルに復元しないでください。** 訓練は、架空のデータで作ったダンプだけで行います（「5. 訓練の記録」）。

前提：
- 復元先は、新しく作った**空の** Supabase プロジェクト（Postgres 17）。今の本番には復元しません。
- 復元先の接続は、バックアップと同じく Session pooler（ユーザー名 `postgres.<復元先のプロジェクトID>`）。パスワードは PGPASSFILE で渡し、コマンドに書きません。

```bash
cd /Users/kakimoto_mac/my_app/SouthDragons && umask 077
B=backups/<YYYYMMDD>-<作業名>
bash scripts/db-backup.sh --verify "$B"
BIN=/opt/homebrew/opt/libpq/bin
read -rp '復元先のプロジェクトID: ' REF
case "$REF" in cuhkjnuwozgnqqqvqhnl|flwwmfehxdmtomgkcdxm|'') echo '中止：今の本番・旧Supabaseには復元しない'; REF=refused ;; esac
read -rp 'Session poolerのホスト名: ' HOST
PASS="$(mktemp "${TMPDIR:-/tmp}/sd-pgpass.XXXXXX")"; trap 'rm -f "$PASS"' EXIT
read -rsp 'DBパスワード: ' PW; echo; PW="${PW//\\/\\\\}"; printf '%s:5432:postgres:postgres.%s:%s\n' "$HOST" "$REF" "${PW//:/\\:}" > "$PASS"; unset PW
export PGPASSFILE="$PASS" PGSSLMODE=require
DB="host=$HOST port=5432 dbname=postgres user=postgres.$REF"
"$BIN/psql" "$DB" -XAt -c "select count(*) from pg_tables where schemaname in ('public','private')"   # 0 でなければ中止（空ではない）
```

続けて、次の順に実行します。どの段階でもエラーが出たら止まります。

1. **ロール**（バックアップに含まれない）
   ```bash
   "$BIN/psql" "$DB" -X -v ON_ERROR_STOP=1 -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='sd_attendance_writer') then
     create role sd_attendance_writer nologin nosuperuser nobypassrls; end if; end \$\$;
     grant sd_attendance_writer to postgres; grant create on schema public to sd_attendance_writer;"
   ```
   `create on schema public` は、関数の所有者を `sd_attendance_writer` にするために一時的に必要です（元のmigrationと同じ）。手順5で外します。
2. **authのデータ**（選手・端末共有・管理者のログイン状態が `auth.users` を参照するので、先に戻す。`auth.schema_migrations` は復元先のものを使う）
   ```bash
   "$BIN/pg_restore" --list "$B/auth-data.dump" | grep -v 'TABLE DATA auth schema_migrations ' > /tmp/auth.list
   "$BIN/pg_restore" -d "$DB" --data-only --single-transaction --exit-on-error -L /tmp/auth.list "$B/auth-data.dump"
   ```
3. **appの表・関数・データ（権限なし）**。`public` スキーマと、`supabase_admin` の既定の権限は、復元先にすでにあるので除く。
   ```bash
   "$BIN/pg_restore" --list "$B/app.dump" | grep -vE '(SCHEMA - public |COMMENT - SCHEMA public |DEFAULT ACL public DEFAULT PRIVILEGES FOR [A-Z]+ supabase_admin$)' > /tmp/app.list
   grep -vE '^[0-9]+; [0-9]+ [0-9]+ (ACL|DEFAULT ACL) ' /tmp/app.list > /tmp/app.objects.list
   grep -E  '^[0-9]+; [0-9]+ [0-9]+ (ACL|DEFAULT ACL) ' /tmp/app.list > /tmp/app.acl.list
   "$BIN/pg_restore" -d "$DB" --single-transaction --exit-on-error -L /tmp/app.objects.list "$B/app.dump"
   ```
4. **権限を、バックアップと同じにする**。★この手順を省くと、Supabaseの既定の権限により、`anon` / `authenticated` が全テーブルと `team_api` を使えてしまう（公開キーだけで、任意の利用者になりすませる）。
   ```bash
   "$BIN/psql" "$DB" -X -v ON_ERROR_STOP=1 -c "revoke all on all tables in schema public, private from anon, authenticated, service_role;
     revoke all on all sequences in schema public, private from anon, authenticated, service_role;
     revoke all on all functions in schema public, private from public, anon, authenticated, service_role;"
   "$BIN/pg_restore" -d "$DB" --single-transaction --exit-on-error -L /tmp/app.acl.list "$B/app.dump"
   ```
5. **後片付け**
   ```bash
   "$BIN/psql" "$DB" -X -v ON_ERROR_STOP=1 -c "revoke create on schema public from sd_attendance_writer; notify pgrst, 'reload schema';"
   rm -f /tmp/auth.list /tmp/app.list /tmp/app.objects.list /tmp/app.acl.list
   ```

### 復元後の確認（読み取りのみ）
```sql
-- 件数：バックアップの counts.txt と一致すること
select 'public.players', count(*) from public.players union all select 'public.events', count(*) from public.events
union all select 'public.attendance', count(*) from public.attendance union all select 'public.player_access', count(*) from public.player_access
union all select 'private.admin_sessions', count(*) from private.admin_sessions union all select 'auth.users', count(*) from auth.users;
-- 権限：すべて false であること
select r, has_function_privilege(r,'public.team_api(uuid,text,jsonb,text)','execute') team_api,
  has_table_privilege(r,'public.players','select') players, has_table_privilege(r,'private.admin_sessions','select') admin_sessions
from unnest(array['anon','authenticated']) r;
-- 必要な権限・RLS：すべて true、所有者は sd_attendance_writer、create は false
select has_function_privilege('authenticated','public.save_own_attendance(text,text,text,text,uuid)','execute') save_own,
  has_function_privilege('service_role','public.team_api(uuid,text,jsonb,text)','execute') team_api_service,
  (select bool_and(relrowsecurity) from pg_class where relnamespace in ('public'::regnamespace,'private'::regnamespace) and relkind='r') rls_all,
  (select pg_get_userbyid(proowner) from pg_proc where oid='public.save_own_attendance(text,text,text,text,uuid)'::regprocedure) writer_owner,
  has_schema_privilege('sd_attendance_writer','public','create') writer_create;
-- safeupdate などのロール設定：今の本番と同じであること（authenticator に safeupdate）
select rolname, rolconfig from pg_roles where rolname in ('authenticator','anon','authenticated');
```

### DBの外で行うこと（新しいプロジェクトの場合）
1. Auth：匿名ログインを有効にする。Site URL を設定する。
2. Edge Functions：`team`、`maintenance`、`attendance-reminder`、`line-test-webhook` を、それぞれ関数名を指定してデプロイする（`--use-api --no-verify-jwt`）。
3. Secrets：管理者が別に保管している値で再登録する（このページには書かない）。名前は `supabase secrets list` の一覧で確認する。
4. GitHub：Variables（`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`）、Secrets（`MAINTENANCE_KEY`、`REMINDER_FUNCTION_URL`、`REMINDER_CRON_SECRET`）を更新する。Pagesを作り直す。
5. LINE：Webhook のURLを使っている場合は、新しい関数のURLに変える。

**未確認**：新しいプロジェクトではURLとJWTの鍵が変わります。保護者の端末に保存されたログイン状態は、前のプロジェクトのものです。そのため、復元しても端末は自動ではつながらず、出欠の入力権限の承認をやり直す必要がある可能性が高いです（実際の端末では確かめていません）。

## 4. 未検証の手順
- **同じプロジェクトの中で、データだけを戻す**：表を空にしてから `pg_restore --data-only` を行う方法が考えられます。ただし、外部キーの順序、auth のデータとの関係、ログイン中の端末への影響を確かめていません。行う前に、必ずローカルで架空のデータを使って訓練してください。
- **本番のPostgresへの復元**：本番は 17.6、訓練に使ったローカルは 17.11、`pg_dump` / `pg_restore` は 18.6 です。版の違いによる問題は、訓練では出ませんでした。本番の版では確かめていません。

## 5. 訓練の記録（2026-10-27、ローカルのみ・架空のデータ）
- 復元元：ローカルの Supabase（migration 7本をすべて適用）。架空の利用者5人、選手3人（1人は退団）、予定2件、出欠3件、端末共有4件、申請2件（承認済み・承認待ち）、管理者のログイン状態1件、チームコード（有効）、閲覧できる端末4台、欠席通知の記録1件。
- バックアップ：`scripts/db-backup.sh` の本体を、ローカルに向けて実行。`COMPLETE` ができ、`--verify` は OK。同じ作業名での再実行は拒否された。新Supabase以外への接続も拒否された。
- 何も準備せずに復元すると、次の5種類のエラー（計26件）が出た：ロールがない（16件）、`supabase_admin` の既定の権限を変えられない（3件）、`public` がすでにある（1件）、`auth.users` より先に戻したため外部キー違反（5件）、`auth.schema_migrations` に書き込めない（1件）。
- 手順3で復元すると、エラーなし。全テーブルのデータ（行ごとのハッシュ）、関数（本体・所有者・設定・権限）、RLS、ポリシー7件、制約、索引、既定の権限、ロールのメンバーシップが、復元元と一致した。違いは、所有者だけの権限が「空」で保存された3つの表と private スキーマのみで、意味は同じ（`acldefault` で確認）。
- 権限の手順4がないと、`anon` / `authenticated` が全テーブル・全関数を使える状態になることを確認した（手順4で解消）。
- 復元後の動作：公開キーでの表・`team_api` へのアクセスは拒否（401）。メンバーの閲覧、管理者のログイン状態、チームコードの確認、共有端末からの出欠入力、別の家庭の選手への入力拒否、バックアップから戻した更新用トークンでのログイン（200）が、すべて期待どおり。
