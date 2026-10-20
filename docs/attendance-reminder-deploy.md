# LINE欠席通知（attendance-reminder）デプロイ手順

対象：Supabaseプロジェクト `cuhkjnuwozgnqqqvqhnl`／ブランチ `feat/attendance-line-reminder-20261019`

この手順は、テスト用LINEで動作を確認するところまでを対象とする。本番LINEへの切り替えと、定時実行の有効化は扱わない。
秘密値は、チャット・コマンド引数・ログ・この文書に書かない。

## 0. 禁止事項

| 禁止 | 理由 |
|---|---|
| `supabase db push` | 過去のmigrationはSQL Editorで適用しており、リモートに適用履歴がない可能性が高い。実行すると、既存のmigration（`20260911000000_v14.sql` など）から再実行しようとする |
| 関数名を付けない `supabase functions deploy` | `team` を含むすべての関数が再デプロイされる |
| `--prune` オプション | 手元にない関数がリモートから削除される |
| `supabase link` | 不要。毎回 `--project-ref` を付けて実行する。リンクしておくと、誤って `db push` してしまう恐れがある |
| `REMINDER_PROD_*`、`REMINDER_PRODUCTION_ENABLED`、GitHubの `REMINDER_SCHEDULE_ENABLED` の登録 | 本番への切り替えは、ユーザーの指示を受けてから行う |

## 1. 事前準備（Supabase CLI）

```bash
brew install supabase/tap/supabase   # 公式のHomebrew tap（2026-10-20に導入済み：v2.121.0）
supabase --version
supabase login
```

`supabase login` を実行するとブラウザで認証する画面が開き、発行されたトークンはmacOSのキーチェーンに保存される。トークンをチャットなどに貼らないこと。
関数のデプロイにはDockerは不要。関数はサーバー側でまとめる（`--use-api` を使う）。
v2.121.0で、`functions deploy` の `--use-api` / `--no-verify-jwt` / `--project-ref`、`secrets set` の `--env-file` / `--project-ref` が使えることを確認済み。

## 2. SQL migrationの影響範囲

`supabase/migrations/20261019000000_attendance_reminder.sql` で新しく作られるもの：

- テーブル `public.attendance_reminder_deliveries` と、その番号用シーケンス `..._id_seq`
- 関数 `public.claim_attendance_reminder(date,text)`
- 関数 `public.finish_attendance_reminder(date,text,uuid,boolean,integer,text)`
- 権限：上の3つは `service_role` だけが使える。`anon`、`authenticated`、`PUBLIC` からは権限を外す。RLSは有効にし、ポリシーは作らない

既存のテーブル（`players`、`events`、`attendance`、`re_registration_requests` など）、既存の関数、既存のRLSポリシーには一切触れない。名前が重なるものがないことは、リポジトリ全体を検索して確認済み。

すべて `IF NOT EXISTS` か `CREATE OR REPLACE` で書かれているため、もう一度実行しても壊れない。全体が `BEGIN … COMMIT` で囲まれているので、途中でエラーが出た場合は何も確定しない。

### 2-1. 適用前の確認（SQL Editor、読み取りのみ）

```sql
-- 新しく作る名前のものが、まだ存在しないこと（0行になるはず）
select 'table' kind, tablename::text name from pg_tables where schemaname='public' and tablename='attendance_reminder_deliveries'
union all
select 'function', proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('claim_attendance_reminder','finish_attendance_reminder');

-- 適用後と比べるための件数（結果をメモしておく）
select (select count(*) from public.players) players,
       (select count(*) from public.events) events,
       (select count(*) from public.attendance) attendance,
       (select count(*) from pg_proc where pronamespace='public'::regnamespace) public_functions,
       (select count(*) from pg_policies where schemaname='public') policies;
```

### 2-2. バックアップ（Freeプランの場合）

前提：
- Supabaseの自動バックアップは、Pro以上のプランだけが対象。Freeプランでは、利用者が自分でエクスポートする必要がある（公式ドキュメントより）。
- 今回のmigrationは新しいものを追加するだけで、既存のデータを書き換えない。そのため、問題が起きたときは2-5のロールバックで元に戻せる。バックアップは万一に備えるためのもの。
- 公式が推奨する `supabase db dump` は、Dockerの中で `pg_dump` を動かし、さらに `supabase link` も必要になる。このMacにはDockerがないため、次のAかBで代用する。

保存先は `backups/`（Git管理外）にする。中身には選手名などの個人情報が含まれるため、チャット・GitHub・クラウドの共有フォルダには置かない。

**A. 追加インストールなし（最低限、推奨）**
Dashboard → Table Editor で、次のテーブルを1つずつ開き「Export → CSV」でダウンロードする。
`players`、`events`、`attendance`、`pending_attendance`、`re_registration_requests`、`player_access`、`settings`
ダウンロードしたファイルは `backups/before-reminder-YYYYMMDD/` に移し、`chmod -R go-rwx backups` を実行して自分以外は読めないようにする。

**B. スキーマとデータを丸ごと保存したい場合（任意）**
`libpq` に含まれる `pg_dump` を使う。DBのパスワードが必要。
接続先は、Dashboard → Connect →「Session pooler」に表示される接続文字列のホストを使う。

```bash
brew install libpq
cd /Users/kakimoto_mac/my_app/SouthDragons && mkdir -p backups && umask 077
read -s "PGPASSWORD?DB password: "; export PGPASSWORD   # 入力した文字は画面に表示されない
/opt/homebrew/opt/libpq/bin/pg_dump \
  "postgresql://postgres.cuhkjnuwozgnqqqvqhnl@<Session poolerのホスト>:5432/postgres" \
  --schema=public --no-owner -f backups/public-before-reminder-YYYYMMDD.sql
unset PGPASSWORD
```

パスワードは、コマンドの引数や接続文字列の中には書かない。

### 2-3. 適用

Dashboard の SQL Editor で新しいクエリを開き、`supabase/migrations/20261019000000_attendance_reminder.sql` の内容をすべて貼り付けて、1回実行する。

### 2-4. 適用後の確認

```sql
select has_table_privilege('anon','public.attendance_reminder_deliveries','select') anon_t,
       has_table_privilege('authenticated','public.attendance_reminder_deliveries','select') auth_t,
       has_function_privilege('anon','public.claim_attendance_reminder(date,text)','execute') anon_f,
       has_function_privilege('authenticated','public.claim_attendance_reminder(date,text)','execute') auth_f,
       has_table_privilege('service_role','public.attendance_reminder_deliveries','insert') svc_t,
       (select relrowsecurity from pg_class where oid='public.attendance_reminder_deliveries'::regclass) rls;
-- 期待値：anon_t / auth_t / anon_f / auth_f がすべて false、svc_t と rls が true
```

続けて2-1の件数を確認するSQLをもう一度実行する。`players`、`events`、`attendance`、`policies` の件数が変わっていないこと、`public_functions` が2つだけ増えていることを確かめる。

### 2-5. ロールバック（必要なときだけ）

```sql
begin;
drop function if exists public.finish_attendance_reminder(date,text,uuid,boolean,integer,text);
drop function if exists public.claim_attendance_reminder(date,text);
drop table if exists public.attendance_reminder_deliveries;  -- 送信履歴も一緒に消える
commit;
```

関数をデプロイ済みの場合は、先にDashboardで `attendance-reminder` 関数を削除するか、Secretsの `REMINDER_CRON_SECRET` を削除して、関数が呼ばれないようにしておく。

## 3. Secretsの登録

使う名前はすべて `REMINDER_*` で、既存の `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_ADMIN_TARGET_ID`、`MAINTENANCE_KEY` などとは別のもの。既存のSecretsは上書きしない。

Git管理外のファイル `.env.reminder` を作る（`.gitignore` の `.env.*` に含まれる）。**このファイルには、次の4つの名前だけを書くこと。**

| 名前 | 値 |
|---|---|
| `REMINDER_CRON_SECRET` | 32文字以上のランダムな文字列（下のコマンドで生成） |
| `REMINDER_DESTINATION` | `test` |
| `REMINDER_TEST_LINE_TOKEN` | テスト用LINEチャネルのアクセストークン |
| `REMINDER_TEST_LINE_TARGET` | テスト送信先のユーザーID |

```bash
cd /Users/kakimoto_mac/my_app/SouthDragons
umask 077
printf 'REMINDER_CRON_SECRET=%s\nREMINDER_DESTINATION=test\n' "$(openssl rand -hex 32)" > .env.reminder
# テスト用のトークンと送信先IDは、エディタで2行追記する（値を画面やチャットに出さない）
open -e .env.reminder
cut -d= -f1 .env.reminder   # 名前だけを表示して、4行あることを確認する
supabase secrets set --project-ref cuhkjnuwozgnqqqvqhnl --env-file .env.reminder
supabase secrets list --project-ref cuhkjnuwozgnqqqvqhnl   # 名前と、値から作ったハッシュだけが表示される
```

`.env.line-test` の値を使う場合も、内容を表示せずにエディタでコピーする。

## 4. 関数のデプロイ（attendance-reminderだけ）

```bash
cd /Users/kakimoto_mac/my_app/SouthDragons
git switch feat/attendance-line-reminder-20261019 && git status --short   # 何も表示されないこと
supabase functions list --project-ref cuhkjnuwozgnqqqvqhnl   # デプロイ前の一覧（team / maintenance / line-test-webhook のバージョンと更新日時）を記録しておく
supabase functions deploy attendance-reminder --project-ref cuhkjnuwozgnqqqvqhnl --no-verify-jwt --use-api
```

- 関数名は必ず付ける。`--prune` は付けない。
- `--no-verify-jwt` を付けて明示的に指定する（`config.toml` に書いた設定と同じ）。デプロイ後、Dashboardの関数設定で「Verify JWT」がOFFになっていることを確認する。
- URL：`https://cuhkjnuwozgnqqqvqhnl.supabase.co/functions/v1/attendance-reminder`
- デプロイ後にもう一度 `supabase functions list --project-ref cuhkjnuwozgnqqqvqhnl` を実行する。`attendance-reminder` が増えていること、既存の3つの関数のバージョンと更新日時が変わっていないことを確認する。

## 5. 動作テスト

ターミナルで秘密値を読み込む（画面には何も表示されない）：

```bash
cd /Users/kakimoto_mac/my_app/SouthDragons
set -a; source .env.reminder; set +a
URL=https://cuhkjnuwozgnqqqvqhnl.supabase.co/functions/v1/attendance-reminder
```

### 5-1. 認証の確認（送信は起きない）

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL"                                        # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" -H 'Authorization: Bearer wrong'        # 401
curl -s -o /dev/null -w '%{http_code}\n' "$URL" -H "Authorization: Bearer $REMINDER_CRON_SECRET" # 405
```

### 5-2. dryRun（LINEへの送信も、履歴の記録もしない）

テストする日付は、欠席者がいる予定の日を選ぶ。SQL Editorで次を実行して探す：

```sql
select e.event_date, count(*) absent from public.events e
join public.attendance a on a.event_id=e.id and a.status='absent'
where e.active group by 1 order by 1 desc limit 5;
```

```bash
curl -s -X POST "$URL" -H "Authorization: Bearer $REMINDER_CRON_SECRET" \
  -H 'Content-Type: application/json' -d '{"testDate":"YYYY-MM-DD","dryRun":true}'
```

- 期待する結果：`{"dryRun":true,"destination":"test",...,"message":"..."}`
- 返ってくる本文には選手名が含まれる。チャットやスクリーンショットで共有しないこと。
- 確認：SQL Editorで `select count(*) from public.attendance_reminder_deliveries;` を実行し、0件のままであること。

### 5-3. テスト用LINEへ1通送る（ユーザーの承認を得てから）

```bash
curl -s -X POST "$URL" -H "Authorization: Bearer $REMINDER_CRON_SECRET" \
  -H 'Content-Type: application/json' -d '{"testDate":"YYYY-MM-DD"}'
```

1. 期待する結果は `{"sent":true,"status":200}`。テスト用LINEのスマホで受信できたことも確認する。
2. 履歴を確認する：`select target_date,destination,state,attempt_count,last_http_status from public.attendance_reminder_deliveries;` で、`test` の行が `sent` になっていること。
3. 同じコマンドをもう一度実行し、`{"skipped":"already sent or processing"}` が返ること（二重送信しないことの確認）。
4. 一度送った日付は、その後のテストでは使えない。次にテストするときは別の日付を選ぶ。

終わったら `unset REMINDER_CRON_SECRET REMINDER_TEST_LINE_TOKEN REMINDER_TEST_LINE_TARGET` を実行してターミナルを閉じる。

## 6. 履歴が「処理中」のまま残ったときの復旧

LINEへの送信は成功したのに、そのあとの記録の更新だけが失敗すると、行が `processing` のまま残る。この状態では二重送信は起きない（5分以内の呼び出しはスキップされる）。

まず状態を確認する：

```sql
select target_date,destination,state,attempt_count,claimed_at,last_http_status,last_error
from public.attendance_reminder_deliveries where state='processing';
```

**A. `claimed_at` から24時間以内の場合（推奨）**
5分以上待ってから、同じリクエストを1回だけ送り直す（テストなら同じ `testDate` を指定する）。
送り直しは同じRetry-Keyで行われる。LINEがすでに受け付けていれば409（受け付け済み）が返り、`sent` として記録される。受け付けていなければ、ここで1通だけ送られる。どちらの場合も二重送信にはならない。
本番の通知は日付を指定できず、「翌日分」を自動で計算する。そのため、送り直しは同じ日の23時59分までに行う必要がある。日付が変わったらBへ進む。

**B. 24時間を過ぎた、または日付が変わった場合**
送り直さない。Retry-Keyの期限（24時間）が切れているため、二重送信になる恐れがある。
LINEで実際に届いたかを目で確認してから、手動で状態を確定させる：

```sql
-- 受信が確認できた場合
update public.attendance_reminder_deliveries
set state='sent', sent_at=coalesce(sent_at, now()), last_error='manual: delivery confirmed'
where target_date='YYYY-MM-DD' and destination='test' and state='processing';
-- 届いていなかった場合は、送り直さずに記録だけ残す
update public.attendance_reminder_deliveries
set state='failed', last_error='manual: not delivered, not retried'
where target_date='YYYY-MM-DD' and destination='test' and state='processing';
```

注意：`failed` の行は、次に呼び出されると再送の対象になる。もう送らない日付であれば、`sent` として確定させるのが安全。

## 7. このあとの段階（今回は行わない）

- GitHub Secretsに `REMINDER_FUNCTION_URL` と `REMINDER_CRON_SECRET` を登録する。`REMINDER_SCHEDULE_ENABLED` は登録しない。
- mainへのPRとマージ。定時実行は、mainにマージされたワークフローでしか動かない。
- 本番LINEへの切り替え：`REMINDER_PROD_*`、`REMINDER_DESTINATION=production`、`REMINDER_PRODUCTION_ENABLED=true` を設定する。
