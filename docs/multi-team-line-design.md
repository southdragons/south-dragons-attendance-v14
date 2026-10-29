# 複数チーム化と共通LINE Bot 技術設計書（第4版・設計凍結）

- 状態：**第4版・設計凍結（2026-10-29）**。実装は保留。今後は South Dragons 単独運用の完成を優先する。再開する場合は、9-5 の必須確認事項から始める。migration・デプロイ・LINE送信は行わない。
- 作成日：2026-10-28（第1版）／更新日：2026-10-28（第2版）、2026-10-29（第3版・第4版）
- 対象：新Supabase（`cuhkjnuwozgnqqqvqhnl`）、GitHub Pages、Edge Function `team` / `attendance-reminder` / `maintenance`
- 優先：**2026年12月のSouth Dragons単独運用を優先し、複数チーム対応の実装は別途着手判断する。**
  - この設計書は、着手を決めるための材料であり、実装の開始を意味しない。12月までに必要な作業はない。
  - 着手の判断は、12月の単独運用が安定したことを確かめてから、ユーザーが行う（目安：2027年1月以降）。着手する場合も、9-3の重大な未決事項を先に決める。

## 変更履歴

| 版 | 変更点 | 該当箇所 |
|---|---|---|
| 第1版 | 初版 | 全体 |
| 第2版 | チームの識別を、変更できる表示名ではなく**変更不可の固定slug**にした | 2-1、3-4 |
| 第2版 | URLで指定したチームと、サーバー側で確認した権限の**一致を必須**にした（出欠の書き込み関数にもチームを渡す） | 3-2、3-3、3-4 |
| 第2版 | `team` 指定がないURLだけを South Dragons として扱い、**未知のslugは振り替えずにエラー**にした | 3-4 |
| 第2版 | LINE送信先の用途を「欠席連絡用」「管理者申請用」に分け、用途を表で管理するようにした | 2-1、4-4 |
| 第2版 | LINEグループの登録・承認・解除の安全対策を1つの節にまとめ、操作記録の表を追加した | 4-5（新設） |
| 第2版 | 将来の収益化に備えて、チーム単位の契約プラン・利用状態・通知使用量を管理する拡張方針を追加した（決済は対象外） | 10（新設） |
| 第2版 | グループ人数分の通数を前提に、使用量の監視と上限到達時の動作を設計した | 6-4（全面改訂） |
| 第2版 | 12月の本番LINE切り替えは、実機で送信・受信を確認してから判断する方針にした（第1版の「共通Botを推奨」は取り下げ、未決事項に戻した） | 9-4、U-10 |
| 第2版 | 見積もりに前提条件・不確実性を明記し、第2版で増えた作業を加えた | 9-2 |
| 第2版 | データ混在・LINE誤送信・使用量のテストを追加した | 8-2（28〜48を追加） |
| 第3版 | LINEのグループ人数の取得方法（API・取得の時機・前回値を使える条件）と、取得失敗・人数の急増での**送信停止条件**を明記した | 5-1、6-5（新設） |
| 第3版 | 送信を「宛先の確定」と「枠の確保」の2段階に分け、共通Bot全体・団体・チームの**月間枠を行ロックで確保**してから送るようにした。LINE側の使用量との照合と、ずれたときの扱いを設計した | 2-1、5-1、6-4、6-6（新設） |
| 第3版 | サービス共通名称・チーム表示名・固定slugの役割を分け、通知文・画面・Bot名での使い分けを決めた | 11（新設）、2-1 |
| 第3版 | 団体契約（複数チームをまとめた契約）による無料／有料プランへの拡張方針を追加した（決済は引き続き対象外） | 10-4（新設）、2-1 |
| 第3版 | 人数取得・枠の排他制御・照合・名称・団体契約・ログ・月の境目のテストを追加した | 8-2（49〜70を追加） |
| 第3版 | 見積もり・未決事項を更新した（U-19〜U-25を追加） | 9-2、9-3 |
| 第4版 | 冒頭に「12月のSouth Dragons単独運用を優先し、複数チーム対応の実装は別途着手判断する」を明記した | 冒頭、9-4 |
| 第4版 | グループ人数を取得できない場合、**初期運用では前回の人数を使わず送信を止める**ようにした（第3版の「24時間以内の前回値を使う」を取り下げ、将来の検討は U-20 に残した） | 2-1、6-5 |
| 第4版 | `X-Line-Retry-Key` の有効期限（24時間）と、再試行で送信先・本文を変えないことを明記した。再試行用に、送る内容を一時的に保存するようにした | 2-1、6-3 |
| 第4版 | 結果が分からない送信は、**最初の送信から24時間を超えて自動で再送しない**ことを明記した（再試行の締め切りは23時間） | 6-3、6-6、6-7 |
| 第4版 | 枠の確保と結果の記録を、それぞれ短い独立したトランザクションにし、LINEとの通信中はDBのロックもトランザクションも持たないことを明記した | 6-6 |
| 第4版 | 確保後の異常終了・結果不明・枠の取り残し・月をまたぐ処理の補償と復旧の手順を1つの節にまとめた | 6-7（新設） |
| 第4版 | 人数APIの値は**枠の推定値**であり、実際の通数はLINEの使用量APIの値を正とすることを明記し、差分の扱いを整理した | 6-4、6-6 |
| 第4版 | 再試行・異常終了・ロック・推定と実際の差のテストを追加した | 8-2（43・50を修正、71〜84を追加） |
| 第4版 | 未決事項を整理し、重大度を付けた（U-26〜U-28を追加） | 9-3 |
| 第4版（凍結） | 設計を凍結した。409の解釈・送信先解除との競合・本文の一時保存の個人情報保護を、実装前の必須確認事項としてまとめた | 冒頭、9-5（新設） |

---

## 0. 要約

1. 全テーブルに `team_id` を持たせる。子テーブルは **(team_id, 親id) の複合外部キー**で、別チームの選手・予定を指せないようにする。
2. 管理者パスワード、管理セッション、チームコード、閲覧端末、端末共有申請、レート制限を、すべてチーム単位にする。
3. ブラウザは今までどおり表を直接読めない。Edge Function → `team_api(actor, team_id, …)` の1本の入口で、必ず `team_id` を絞り込む。
4. 【第2版】チームはURLの**固定slug**で指定する。サーバーは slug → `team_id` を解決し、その `team_id` に対する利用権限を毎回確認する。未知のslugはエラーにし、別のチームへ振り替えない。
5. LINE公式アカウントは全チーム共通で1つ。送信先（グループID）は Secrets ではなく **DBにチーム・用途ごとに保存**する。
   - Botをグループに招待しただけでは登録されない。
   - 有効にするには、**ワンタイム登録コード**をそのグループに投稿し、さらに**そのチームの管理者が承認**する。
6. 送信はすべて「通知の送信記録」を先に作ってから行う。LINEの再送防止キーを付け、送信先はその記録の `team_id` と用途からだけ決める。
7. 【第2版】送るたびに、送信先の人数を通数として記録する。チームごと・全体の月間上限を送信前に確認し、上限に達したら送らずに記録する。
   - 【第3版】人数は送る直前にLINEのAPIで取得する。取得できない・急に増えた場合は送らない（6-5）。
   - 【第3版】全体・団体・チームの月間枠は、DBの行ロックで**先に確保してから**送る。複数チームが同時に送っても、確保の合計が枠を超えない（6-6）。
8. 【第3版】サービス共通名称（全チーム共通）・チーム表示名（変更可）・slug（変更不可）を分けて扱う（11章）。将来の団体契約は、チームの上に「団体」を置いて表す（10-4）。
9. South Dragonsの移行は、追加 → 埋める → 制約を締める、の段階に分ける。各段階の前にバックアップを取り、段階ごとに戻せるようにする。

---

## 1. 現在の構成（読み取り調査の結果）

### 1-1. 全体
| 層 | 現在 |
|---|---|
| 画面 | Nuxt 4 SPA（`ssr:false`）。GitHub Pages で公開。URL は1チーム分だけ |
| API | Edge Function `team`（JWT検証あり・匿名認証）→ `public.team_api(actor, action, payload, admin_token)`。service_role だけが実行できる |
| 出欠の書き込み | `public.save_own_attendance(...)`。所有者は `sd_attendance_writer`（NOLOGIN・RLSを迂回しない）。ブラウザから直接呼ぶ唯一の関数 |
| 欠席通知 | Edge Function `attendance-reminder`。service_role で `events` / `attendance` / `players` を**全件**読み、1つの送信先へ送る |
| 申請通知 | `team` 関数の `notifyAdmin`。Secrets の `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_ADMIN_TARGET_ID` へ送る。現在はテスト用公式アカウントからテスト担当者個人へ送る設定 |
| 保守 | Edge Function `maintenance`（health / 匿名ユーザー整理） |
| 直列化 | `pg_advisory_xact_lock(734214)`。全体で1つのロック |

### 1-2. 「チームが1つ」を前提にしている箇所
| 箇所 | 前提の内容 | 複数チームでの問題 |
|---|---|---|
| `players.normalized_name` の **UNIQUE** | 全体で名前が一意 | 別チームに同じ名前の子がいると登録できない。重複判定で別チームの選手が見つかってしまう |
| `settings` の `admin_password_hash` | 管理者は1人分 | チームごとの管理者を持てない |
| `private.admin_sessions` | チームの列がない | A管理者のトークンでBを操作できてしまう |
| `private.team_code`（`id boolean` で1行） | チームコードは1つ | チームごとのコードを持てない |
| `private.team_members`（PK = `user_id`） | 端末は1チームにだけ所属 | 兄弟が別チームにいる端末を扱えない。Aのメンバーが自動でBのメンバー扱いになる |
| `private.feature_flags` | 全体の切り替え | チームごとの切り替えができない（全体の非常停止としては残す） |
| `private.rate_limits` の `admin-global` など | 全体で1つの枠 | 1チームの試行で全チームのログインが止まる |
| `re_registration_requests.notification_status` | 送信状態だけを記録。試行回数・時刻・HTTP状態はない | 未着の原因を追えない（10/27の調査で判明） |
| `attendance_reminder_deliveries` の UNIQUE(target_date, destination) | 1日1通 | 同じ日に複数チームへ送れない |
| `attendance-reminder` の検索 | 全件を読む | **他チームの欠席者が混ざる**（最も重大な混入経路） |
| `snapshot()` | 全件を返す | 他チームの選手・予定が見える |
| Secrets の LINE送信先 | 1つ | チームごとの送信先を持てない |
| `team` 関数の409の扱い | 409をすべて送信済みとみなす | 再送防止キー以外の409も成功と記録される（`attendance-reminder` は本文を確認しており、扱いが違う） |
| 画面の `localStorage` キー `south-dragons-*` | 1チーム | デモ・旧GASモードだけで使用。Supabaseモードでは影響が小さい |

### 1-3. 今のまま使える仕組み
- ブラウザから表を直接読めない構成（anon / authenticated に表の権限がない）。
- 閲覧権（`team_members`）と編集権（`player_access`）の分離。
- 欠席通知の「先に記録を確保してから送る」方式（`claim_attendance_reminder`）と、LINEの再送防止キー（`X-Line-Retry-Key`）の扱い。
- Webhookの署名検証（`line-test-webhook` の実装）。

---

## 2. テーブル設計案

`team_id` は `uuid`。South Dragons には固定のUUIDを割り当てる（移行スクリプトに書く固定値。例：`00000000-0000-4000-8000-000000000001`）。

### 2-1. 新しく作る表
```sql
-- チーム
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  -- 【第2版】URLで使う固定の識別子。作成後は変更不可（トリガーで拒否）。退会後も再利用しない
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{2,29}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),  -- 画面の表示名。変更可（11章の制限あり）
  status text not null default 'active' check (status in ('active','suspended','archived')),
  -- 【第3版】団体契約に属する場合の団体（10-4）。属さないチームは null。データの閲覧権とは無関係
  organization_id uuid references private.organizations(id),
  -- 【第2版】team パラメータのないURLで使うチーム。全体で最大1件（South Dragons）
  legacy_default boolean not null default false,
  notifications_enabled boolean not null default false,             -- チーム単位の送信スイッチ
  created_at timestamptz not null default now()
);
create unique index teams_one_legacy_default on public.teams(legacy_default) where legacy_default;

-- チームごとの管理者認証（settings.admin_password_hash の置き換え）
create table private.team_admin_credentials (
  team_id uuid primary key references public.teams(id) on delete restrict,
  algorithm text not null, salt text not null, hash text not null,
  updated_at timestamptz not null default now()
);

-- 【第2版】通知の用途（欠席連絡用・管理者申請用。将来の追加に備えて表にする）
create table private.notification_purposes (
  code text primary key check (code ~ '^[a-z_]{3,30}$'),   -- 'absence_notice' / 'admin_request'
  label text not null,                                     -- 「欠席連絡用」「管理者申請用」
  contains_personal_data boolean not null,                 -- 本文に選手名・申請者名を含むか
  allowed_source_types text[] not null,                    -- 'group' / 'user'
  max_recipients integer                                   -- 承認時に警告する人数（null=警告なし）。値は未決（U-12）
);

-- LINEの送信先（チーム × 用途ごとに有効なのは1件）
create table private.line_destinations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete restrict,       -- 承認前の「招待されただけ」は null
  purpose text references private.notification_purposes(code),      -- 【第2版】用途の表を参照
  source_type text not null check (source_type in ('group','user')),
  line_id text not null,                                             -- groupId / userId。画面には末尾4文字だけ出す
  group_name text not null default '',                               -- 受信時にAPIで取得した表示名
  last_member_count integer,                                         -- 【第2版】最後に確認した人数（通数の見積もり用）
  member_count_checked_at timestamptz,
  approved_member_count integer,                                     -- 【第3版】承認したときの人数（急増の判定に使う。6-5）
  needs_reconfirm boolean not null default false,                    -- 【第3版】人数の急増などで、管理者の再確認まで送らない
  status text not null check (status in ('joined','pending_approval','active','revoked','left','rejected','expired')),
  registered_by_code uuid,                                           -- 使われた登録コード
  joined_at timestamptz, requested_at timestamptz, approved_at timestamptz, ended_at timestamptz,
  check (status not in ('pending_approval','active') or (team_id is not null and purpose is not null))
);
-- 1つのグループは、同時に1チームにしか結び付かない
create unique index line_dest_one_team on private.line_destinations(line_id) where status in ('pending_approval','active');
-- 1チーム・1用途につき有効な送信先は1件
create unique index line_dest_one_active on private.line_destinations(team_id, purpose) where status = 'active';

-- 【第2版】送信先の操作記録（登録・承認・却下・解除・退出）。LINEのIDや本文は残さない
create table private.line_destination_events (
  id bigint generated always as identity primary key,
  destination_id uuid not null references private.line_destinations(id),
  team_id uuid references public.teams(id),
  action text not null check (action in ('joined','code_accepted','code_rejected','approved','rejected','revoked','left','expired','check_sent')),
  actor uuid,                                  -- 管理者操作のときの端末。Webhook由来は null
  at timestamptz not null default now()
);

-- ワンタイム登録コード
create table private.line_registration_codes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  purpose text not null references private.notification_purposes(code),
  code_hash text not null unique,             -- sha256(コード)。平文は保存しない
  expires_at timestamptz not null,            -- 発行から30分
  used_at timestamptz, used_by_destination uuid,
  created_by uuid not null,                   -- 発行した管理者の端末
  created_at timestamptz not null default now()
);

-- 受信したWebhookイベント（重複受信の排除）
create table private.line_webhook_events (
  webhook_event_id text primary key,
  received_at timestamptz not null default now(),
  kind text not null                           -- join / leave / message など。本文やIDは保存しない
);

-- 全通知の送信記録（欠席通知・申請通知・確認送信の共通）
create table private.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  kind text not null check (kind in ('absence_reminder','device_share_request','destination_check')),
  purpose text not null references private.notification_purposes(code),
  dedupe_key text not null,                    -- 例：'2026-12-05'、申請ID
  destination_id uuid not null references private.line_destinations(id),
  retry_key uuid not null default gen_random_uuid() unique,  -- X-Line-Retry-Key
  state text not null default 'pending' check (state in ('pending','processing','sent','failed','skipped')),
  -- 【第3版】人数取得・枠確保に関する理由を追加（6-5、6-6）
  skip_reason text check (skip_reason in ('no_destination','team_disabled','global_disabled','team_quota','org_quota','global_quota','plan_status',
                                          'member_count_unavailable','member_count_too_large','needs_reconfirm','quota_frozen',
                                          'abandoned')),            -- 【第4版】確保前に処理が止まり、送る時間帯を過ぎた（6-7）
  reserved_units integer not null default 0,   -- 【第3版】枠として確保した通数（6-6）。送信の結果で確定・返却する
  reservation_state text not null default 'none' check (reservation_state in ('none','reserved','consumed','released','uncertain')),
  attempt_count integer not null default 0,
  recipient_count integer,                     -- 【第2版】送信時の人数（=通数の見込み）
  -- 【第4版】recipient_count_estimated は削除（初期運用では前回値を使わないため。6-5、U-20）
  quota_month date,                            -- 【第4版】枠を確保した月。結果の記録・返却は必ずこの月の行に対して行う（6-7）
  first_attempt_at timestamptz,                -- 【第4版】最初にLINEへ送った時刻。再試行の締め切り（+23時間）の基準
  retry_deadline timestamptz,                  -- 【第4版】first_attempt_at + 23時間。これを過ぎたら自動で再送しない
  outbound_request jsonb,                      -- 【第4版】再試行用に、最初に送った宛先IDと本文をそのまま保存する。結果が確定したら消す（6-3）
  outcome_reason text,                         -- 【第4版】'delivered' / 'duplicate_409' / 'rejected_4xx' / 'monthly_limit' / 'unknown_expired' / 'destination_inactive' など
  claimed_at timestamptz, sent_at timestamptz,
  last_http_status integer, last_error text check (char_length(last_error) <= 200),
  message_sha256 text,                         -- 本文は保存しない。同じ内容かどうかの照合用
  created_at timestamptz not null default now(),
  unique (team_id, kind, dedupe_key)
);

-- 【第3版】月間の送信枠（全体・団体・チームの3段）。送る前にここで枠を確保する（6-6）
create table private.line_quota_periods (
  scope_type text not null check (scope_type in ('global','organization','team')),
  scope_id uuid not null,                      -- global は固定値 00000000-0000-0000-0000-000000000000
  month date not null,                         -- 日本時間の月初（LINEの月の区切りは要確認 U-21）
  limit_units integer not null,                -- その月の上限（global は LINE の上限から求めた値）
  reserve_units integer not null default 0,    -- global のみ：管理者申請用などに残す予備枠
  reserved_units integer not null default 0,   -- 確保中（送信中・結果不明を含む）
  consumed_units integer not null default 0,   -- 送信済み
  line_reported_units integer,                 -- global のみ：LINEの使用量APIの最新値
  line_reported_at timestamptz,
  unattributed_units integer not null default 0,  -- 【第4版】global のみ：LINEの実際の値がDBの推定を上回った分（6-6）
  reconciled_final boolean not null default false, -- 【第4版】その月の最終照合を終えたか（6-7）
  frozen_reason text,                          -- null 以外なら、この範囲の送信を止める（上限到達・照合のずれ・運営者の停止）
  primary key (scope_type, scope_id, month),
  check (reserved_units >= 0 and consumed_units >= 0)
);

-- 【第3版】団体（連盟・地域の協会・学校など、複数チームをまとめて契約する単位。10-4）
create table private.organizations (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  status text not null default 'active' check (status in ('active','suspended','archived')),
  created_at timestamptz not null default now()
);
create table private.organization_contracts (
  organization_id uuid primary key references private.organizations(id),
  plan_code text not null references private.plans(code),
  status text not null check (status in ('trial','active','grace','suspended','cancelled')),
  max_teams integer,                           -- 契約に含められるチーム数（null=制限なし）
  pooled_line_units integer,                   -- 団体全体で共有する月間通数（null=チームごとの上限のみ）
  current_period_start date, current_period_end date,
  updated_at timestamptz not null default now(),
  updated_by text not null
);
```
- 【第3版】作る順番：`private.plans`（10-1）と `private.organizations` を `teams` より先に作る（`teams.organization_id` と `organization_contracts.plan_code` が参照するため）。
- 【第3版】サービス共通名称は、チームの表ではなく全体の設定（既存の `settings` に `service_profile` キーを追加）に置く（11章）。

### 2-2. 既存の表の変更
| 表 | 変更 |
|---|---|
| `players` | `team_id` 追加。UNIQUE(`normalized_name`) → **UNIQUE(`team_id`, `normalized_name`)**。UNIQUE(`team_id`, `id`) を追加（複合FKの参照先） |
| `events` | `team_id` 追加。UNIQUE(`team_id`, `id`)。索引を (`team_id`, `event_date`) に |
| `attendance` | `team_id` 追加。FK (`team_id`,`player_id`) → players(`team_id`,`id`)、(`team_id`,`event_id`) → events(`team_id`,`id`) |
| `player_access` | `team_id` 追加。FK (`team_id`,`player_id`) → players |
| `re_registration_requests` / `pending_attendance` | `team_id` 追加と複合FK。`notification_status` は互換のため残し、詳細は `notification_deliveries` に記録 |
| `private.admin_sessions` | `team_id` 追加。照合は (`team_id`, `token_hash`) |
| `private.team_code` | `id boolean` → `team_id uuid primary key` |
| `private.team_members` | PK を (`team_id`, `user_id`) に。`id` はそのまま一意 |
| `private.rate_limits` | 表はそのまま。バケット名に `team_id` を入れる（例 `admin:<team_id>`） |
| `attendance_reminder_deliveries` | 移行後は `notification_deliveries` に置き換え。移行中は読み取り専用で残す |
| `settings` | `admin_password_hash` は `team_admin_credentials` へ移す。`line_test_capture` などの全体設定はそのまま |

`id` は今の `text`（UUID文字列）のまま変えない。画面・保存済みデータとの互換を保つため。

---

## 3. チーム間のデータ分離

分離は4層で行い、どれか1層に不具合があっても他チームのデータが出ないようにする。

### 3-1. 外部キー（DBの構造で防ぐ）
- 子の行は (`team_id`, 親id) で親を参照する。Aチームの出欠行がBチームの選手・予定を指すことは、**DBが拒否する**。
- `team_id` は作成後に変えない（変更を拒否するトリガーを付ける）。

### 3-2. DB関数（入口で絞り込む）
- `team_api(actor uuid, team_id uuid, action text, payload jsonb, admin_token text)` に変える。すべての検索・更新に `where team_id = p_team` を付ける。
- `snapshot(actor, team_id, is_admin)` は、そのチームの行だけを返す。【第2版】返す値に `team: {slug, displayName}` を含める（3-4の照合に使う）。
- 管理者の確認：`admin_sessions` を (`team_id`, `token_hash`) で照合する。**Aのトークンは、Bの `team_id` では無効**。
- 閲覧の確認：`team_members` を (`team_id`, `user_id`) で照合する。
- `payload` に含まれる `playerId` / `eventId` / `requestId` は、必ず「`team_id` が一致すること」も条件にして検索する。一致しなければ `NOT_FOUND`（他チームに存在することを知らせない）。
- 直列化のロックは、当面は今の全体ロック（`734214`）を続ける。利用が増えたら `pg_advisory_xact_lock(734214, hashtext(team_id::text))` のチーム別ロックへ切り替える（`save_own_attendance` と同じ方式にそろえる）。

### 3-3. RLS（書き込みロールの最終防衛）
- `sd_attendance_writer` のポリシーに「選手・予定・権限の `team_id` がすべて同じ」条件を追加する。
- 【第2版】`save_own_attendance` に **`p_team uuid` 引数を追加**する。選手・予定・`player_access`・`team_members` のすべてが `p_team` と一致しなければ `FORBIDDEN`。
  - 第1版では「選手IDからチームを求める」としていたが、それだと**URLで開いているチームと違うチームの選手**にも書けてしまう。URLのチームとの一致を必須にするため変更した。
  - 移行中は、今の引数の関数を「South Dragons 固定で `p_team` を渡す」互換関数として残す（7-2 M3）。
- anon / authenticated には、引き続き表の権限を一切与えない。

### 3-4. 【第2版で全面改訂】チームの指定と、権限との一致
**URL**
- 形式：`https://<公開URL>/?team=<slug>`。
- `slug` はチーム作成時に運営者が決める固定値。**作成後は変更できず、退会後も別のチームに再利用しない**。チームの表示名（`display_name`）は自由に変えてよく、URLには影響しない。
- `slug` は秘密ではない。知っていても、権限がなければ何も見えない（下の「権限との一致」による）。
- GitHub Pages のSPAでパス方式（`/t/<slug>/`）を使うと404対策が必要になるため、クエリ方式にする。

**South Dragons の既存URLとの互換**
| URL | 扱い |
|---|---|
| `team` パラメータが**ない**（今のURL・ホーム画面アプリ） | `legacy_default=true` のチーム（South Dragons）として扱う |
| `?team=<South Dragonsのslug>` | South Dragons |
| `?team=<存在するslug>` | そのチーム |
| `?team=`（空）、形式違い、**存在しないslug**、`archived` のチーム | 「チームが見つかりません。URLを確認してください」と表示する。**South Dragons にも、ほかのチームにも振り替えない** |
| `suspended` のチーム | 「現在ご利用いただけません」と表示する（10章の利用状態による） |

- 今のURLのまま開いた画面で、アドレスを `?team=<slug>` に書き換えるかどうかは決めていない（U-1）。書き換えない場合も動作は変わらない。

**権限との一致（サーバー側で毎回確認）**
1. Edge Function `team` は、リクエストの `team`（slug）を DB で `team_id` に解決する。見つからない場合は `TEAM_NOT_FOUND` で止め、`team_api` を呼ばない。
2. 以降の確認は、すべて**この `team_id` に対して**行う。
   - 閲覧：(`team_id`, 端末) の `team_members`、またはそのチームの閲覧制限がオフ。
   - 編集：(`team_id`, 端末, 選手) の `player_access`。選手もそのチームのもの。
   - 管理：(`team_id`, トークン, 端末) の `admin_sessions`。
3. 画面から送られる `teamId` は使わない。チームを決めるのは slug の解決結果だけ。
4. 出欠の書き込み（`save_own_attendance`）にも、同じ `team_id` を渡す（3-3）。
5. 返した snapshot の `team.slug` が、画面で開いている slug と違う場合、画面はデータを捨ててエラーを出す（キャッシュや取り違えへの備え）。

**画面の状態**
- 画面の状態（選手・予定・出欠・管理者ログイン）は slug ごとに分ける。別のチームのURLを開いたら、前のチームの状態を消してから読み込む。
- 管理者のトークンを端末に保存する場合は、キーに slug を含める。

### 3-5. service_role を使う処理
- `attendance-reminder` と `maintenance` は service_role（RLSを迂回）で動く。表を直接読むのをやめ、**`team_id` を引数に取るDB関数**からだけ読む。
  - 例：`private.absence_summary(p_team uuid, p_date date)`。
- これで「Edge側で `team_id` の絞り込みを書き忘れる」経路をなくす。

---

## 4. LINEグループの登録・承認・変更・解除

### 4-1. 前提
- 共通の LINE公式アカウント（Messaging API チャネル）は1つ。チャネルのアクセストークンとチャネルシークレットは Secrets に置く（チームごとではない）。
- 公式アカウントの設定で「グループ・複数人トークへの参加を許可」「Webhook利用」をオンにする。応答メッセージ（自動応答）はオフにする。
- 新しいEdge Function `line-webhook` を作る。JWT検証はオフにし、LINEの署名（`X-Line-Signature`）を関数内で検証する（`line-test-webhook` の方式を流用）。

### 4-2. 登録の流れ
```
[管理者・管理画面]  「LINE通知先を登録」→ 用途を選ぶ（欠席連絡用／管理者申請用）
                     → ワンタイム登録コードを表示（例 REG-4831-7265、30分有効、1回限り）
[チームのLINEグループ] Botを招待 → (join) 送信先を「joined（チーム未定）」で記録。何も送らない
                     → 管理者がグループにコードを投稿
[line-webhook]       署名・宛先Bot・重複イベントを確認 → コードをハッシュで照合
                     → 有効なら「pending_approval（そのチーム・用途）」に変更し、コードを使用済みにする
                     → グループの人数を取得して記録する（6-5。取得できなければ承認待ちにせず、管理画面に「人数を確認できません」と表示）
                     → グループへの返信（reply）は、チーム名を含まない固定文のみ（任意）
[管理者・管理画面]   承認待ちの送信先を確認：グループ名、人数、末尾4文字、受信日時、用途
                     → 「承認」→ active。同じ用途の以前の送信先は revoked
                     → 任意で「確認メッセージを送る」（個人情報を含まない固定文）
```
- **招待だけでは通知しない**：`joined` の送信先には、何も送らない。
- **コードだけでも通知しない**：`pending_approval` にも、何も送らない。管理者の承認で初めて `active` になる。
- 1対1トーク（管理者個人）も同じ流れで登録できる（`source_type='user'`。Botを友だち追加して、コードを送る）。用途ごとに、登録できる種類を `notification_purposes.allowed_source_types` で制限する。

### 4-3. 変更・解除
| 操作 | 処理 |
|---|---|
| 送信先を変える | 新しいコードで登録 → 承認した時点で、古い送信先は自動で `revoked` |
| 管理者が解除 | `revoked`。以後送らない。任意でBotをグループから退出させる（`/v2/bot/group/{groupId}/leave`） |
| Botがグループから外された（leave イベント） | `left`。以後送らない。管理画面に「通知先がありません」と表示する |
| 管理者が承認を却下 | `rejected`。コードは使用済みのまま（再利用不可） |
| 承認されないまま24時間たった | `expired`。以後は新しいコードからやり直す |
| チームを停止（`teams.status='suspended'`） | 送信しない。送信先の状態は変えない |

### 4-4. 【第2版で改訂】用途別の送信先と、送る内容
送信先は**用途ごと**に登録・承認・解除する。用途は `notification_purposes` で管理し、通知の種類は必ず1つの用途に対応する。

| 用途（コード） | 表示名 | 通知の種類 | 想定する送信先 | 本文 | 個人情報 |
|---|---|---|---|---|---|
| `absence_notice` | 欠席連絡用 | 欠席通知 `absence_reminder` | チームの保護者・指導者のグループ | 翌日の予定と欠席者 | 選手名を含む。チーム内に共有する前提（今の設計と同じ） |
| `admin_request` | 管理者申請用 | 端末共有申請 `device_share_request` | 管理者個人、または管理者だけのグループ | 選手名・申請者名・続柄・日時 | 含む。**保護者全員のグループには送らない** |
| （両方） | — | 確認送信 `destination_check` | 登録した送信先 | 固定文（チーム名だけ） | 含まない |

- ある用途の送信先が未登録・停止中なら、その用途の通知は送らず `skipped`（`no_destination`）を記録する。**別の用途の送信先に代わりに送ることはしない。**
- 申請はこれまでどおりDBに保存され、管理画面に表示される。
- 同じグループを、同じチームの2つの用途に登録してよいかは決めていない（U-13）。管理者申請用の本文には申請者名が含まれるため、案では**欠席連絡用に使っているグループは、管理者申請用に登録できない**ようにする。

### 4-5. 【第2版で新設】登録・承認・解除の安全対策
**登録（コードの発行と受け付け）**
| 対策 | 内容 |
|---|---|
| 発行できる人 | そのチームの管理者ログイン中の端末だけ。発行を操作記録に残す |
| コードの強さ | 推測しにくい長さ（英数字10文字程度）。平文は保存せず sha256 だけを保存 |
| 期限・回数 | 30分、1回限り。チーム・用途ごとに、有効なコードは最大3件 |
| 結び付き | コードは発行したチーム・用途にだけ有効。別チームでは使えない |
| 受け付ける場所 | Botが参加しているグループ（または友だちの1対1トーク）からの投稿だけ。用途が許す種類だけ |
| 誤ったコード | 1つのグループから1時間に5回以上誤ったコードが来たら、そのグループからの受け付けを止める |
| 1グループ1チーム | 別チームで承認待ち・有効のグループには登録できない（索引 `line_dest_one_team`） |
| 返信 | 返信する場合も、チーム名・選手名を含まない固定文だけ。コードが違うときは返信しない |
| ログ | 本文・送信者・グループIDをログに出さない |

**承認**
| 対策 | 内容 |
|---|---|
| 表示する情報 | グループ名、人数、IDの末尾4文字、用途、受信日時、使われたコードの発行日時 |
| 人数の警告 | 管理者申請用で人数が多い場合に警告し、確認のうえで承認させる（人数の基準は未決 U-12） |
| 再確認 | 承認時に管理者パスワードの再入力を求めるか（未決 U-14。案では求める） |
| 置き換え | 承認と同時に、同じ用途の以前の送信先を `revoked` にする（1回のトランザクション） |
| 【第3版】人数の記録 | 承認時の人数を `approved_member_count` に残す。以後、人数が大きく増えたら送信を止めて再確認を求める（6-5） |
| 期限 | 承認待ちは24時間で `expired` |
| 確認送信 | 承認後に固定文を1通送るかは管理者が選ぶ。送った場合は使用量に数える |

**解除・異常時**
| 対策 | 内容 |
|---|---|
| すぐに止まる | 送信の確保（【第3版】枠の確保 `reserve_notification`）は、その時点で送信先が `active` かを同じトランザクションで確認する。解除後に新しく送られることはない。解除の直前に確保済みだった送信は、最大1件だけ完了しうる |
| Botの退出 | leave イベントで `left` にする。管理画面に表示し、再登録は新しいコードと承認からやり直す（自動で戻さない） |
| 再有効化しない | `revoked` / `left` / `rejected` / `expired` を `active` に戻す操作は作らない |
| 操作記録 | 登録・承認・却下・解除・退出・確認送信を `line_destination_events` に残す。管理画面で自チームの分だけ見られる |

---

## 5. 通知の振り分け

### 5-1. 共通の送信手順（全種類で同じ）
【第3版で改訂】人数の取得はLINEへのHTTP通信なので、DBのトランザクションの中では行わない。そのため、第2版の `claim_notification` を「宛先の確定」と「枠の確保」の2段階に分ける。

1. **宛先の確定**：`private.claim_notification(p_team, p_kind, p_dedupe_key)` を呼ぶ。1回のトランザクションの中で次を行う。
   - チームが `active` で、`notifications_enabled` がオンであることを確認する。
   - 全体の非常停止フラグ `line_delivery` がオンであることを確認する。
   - 【第2版】チームの利用状態（10章。団体契約を含む）が送信を許していることを確認する。
   - 通知の種類から用途を決め、その用途の `active` の送信先を、**そのチームの中から**1件選ぶ。`needs_reconfirm` の送信先は選ばない。
   - `notification_deliveries` の行を作る（`state='pending'`）。すでに `sent` なら何もしない。送れない場合は `skipped` と理由を記録する。
   - 送信先の種類と、人数の取得に使うIDを返す（枠はまだ確保しない）。
2. **人数の取得**：Edge Function がLINEのグループ人数APIを呼ぶ（6-5）。1対1トークは呼ばずに1人とする。
3. **枠の確保**：`private.reserve_notification(p_delivery, p_member_count, p_count_source)` を呼ぶ。1回のトランザクションの中で次を行う。
   - 送信先が今も `active` で、`needs_reconfirm` でないことを**もう一度**確認する（手順1のあとに解除された場合に送らないため）。
   - 人数を記録し、6-5の停止条件に当たれば `skipped` にして終える。
   - 全体 → 団体 → チームの順に `line_quota_periods` の行をロックし、枠を確保する（6-6）。足りなければ `skipped`（`global_quota` / `org_quota` / `team_quota`）。
   - `state='processing'`、試行回数を+1、`reservation_state='reserved'` にして、LINEの宛先IDと再送防止キーを返す。
4. 本文は、同じ `team_id` を引数に取るDB関数で作る（例：`absence_summary(p_team, p_date)`）。結果にほかのチームの行が入っていないことを、関数の中で確認する。
5. LINE Push API に送る。`X-Line-Retry-Key` は記録の `retry_key`。
6. `private.finish_notification(id, retry_key, outcome, http_status, error)` で結果を記録し、確保した枠を確定・返却する（6-6）。

Edge Function は、**宛先IDを自分で決めない**。リクエストやSecretsから宛先を受け取らず、手順1・3の結果だけを使う。

### 5-2. 欠席通知
- `attendance-reminder` は、`active` かつ `notifications_enabled` のチームを順に処理する。1チームの失敗が、ほかのチームを止めないようにする。
- `dedupe_key` は対象日（`YYYY-MM-DD`）。1チーム1日1通。
- 送信の曜日・時刻は、当面は全チーム共通（金・土の19時以降）。チームごとの設定は将来の課題（U-5）。

### 5-3. 端末共有申請の通知
- `team_api` の `requestRegistration` が返す `notification` に `team_id` を含める。`team` 関数は `claim_notification(team_id, 'device_share_request', requestId)` を呼んで送る。
- 申請の `notification_status` は互換のために更新を続ける（`sent` / `failed` / `unconfigured` / `throttled`）。

---

## 6. 誤送信防止・通知履歴・重複送信対策・使用量

### 6-1. 誤送信防止
| 対策 | 内容 |
|---|---|
| 宛先はDBだけで決める | Edge・画面・Secrets から宛先を受け取らない |
| 1グループ＝1チーム | 索引で強制。登録の時点でも確認する |
| 用途の取り違え防止 | 通知の種類 → 用途 → 送信先、の対応はDB関数の中だけで決める。別の用途の送信先には送らない |
| 本文と宛先は同じ `team_id` | 送信記録・本文・宛先が同じチームか、関数の中で照合する |
| 二重のスイッチ | 全体の `line_delivery` と、チームの `notifications_enabled`。どちらもオンのときだけ送る |
| テスト用の宛先 | 開発・確認用に、架空データのテスト用チームとテスト用グループを使う。本番チームのデータでは試さない |
| 承認前に送らない | `joined` / `pending_approval` には何も送らない |
| 送信先の表示 | 管理画面にはグループ名と、IDの末尾4文字だけを出す |

### 6-2. 通知履歴
- `notification_deliveries` に、種類・用途・対象（日付や申請ID）・送信先・人数・試行回数・確保日時・送信日時・HTTP状態・エラーの種類・送らなかった理由を残す。**本文は残さない**（`message_sha256` のみ）。
- 管理画面に、自分のチームの直近の履歴（状態と日時）を表示する。他チームの履歴は見えない。
- 10/27の申請通知の調査で困った点（試行回数・時刻・HTTP状態がない）は、これで解消する。

### 6-3. 重複送信対策
- (`team_id`, `kind`, `dedupe_key`) の一意制約で、同じ通知の記録は1件だけ。
- `sent` の記録には二度と送らない。`processing` が5分以上続いた場合だけ、**同じ再送防止キー**で再試行する（今の `claim_attendance_reminder` と同じ）。
- 【第4版】`X-Line-Retry-Key` の扱い（LINEの仕様。最新の公式資料で確認する U-21）：
  - 再送防止キーが働くのは、**最初の要求から24時間**。それを過ぎて同じキーで送ると、LINEは新しい送信として受け付けるおそれがある（二重に届く）。
  - 同じキーで再試行するときは、**送信先と本文を変えてはいけない**。変えた場合、LINEは409を返し、新しい内容は届かない（どちらが届いたか分からなくなる）。
- 【第4版】この設計での決まり：
  - 最初に送る直前に、宛先IDと本文（LINEに送るJSONそのもの）を `outbound_request` に保存し、`first_attempt_at` と `retry_deadline`（+23時間。24時間より1時間早くして余裕を取る）を記録する。
  - 再試行は、`outbound_request` を**そのまま**送る。本文を作り直さない（出欠が変わっていても、最初の内容のまま）。送信先も選び直さない。
  - 再試行の前に、送信先が今も `active` かを確かめる。解除・退出・再確認待ちになっていたら再試行せず、`failed`（`destination_inactive`）にする。届いていたかどうかは分からないため、枠は使ったものとして扱う。
  - `retry_deadline` を過ぎたら、**自動では再送しない**（6-7）。
  - `outbound_request` は結果が確定したら（`sent` / `failed`）すぐに消す。残っているものも、`retry_deadline` から1日たったら保守で消す。本文には選手名が含まれるため、ログには出さず、管理画面にも返さない。
- LINEの409は、本文に「retry key」と書かれている場合だけ「送信済み」とみなす（`attendance-reminder` の実装と同じ。`team` 関数の今の実装は409をすべて成功扱いにしているため、そろえる）。
- Webhookは `webhookEventId` を記録し、同じイベントを2回処理しない。

### 6-4. 【第2版で全面改訂】使用量の監視と上限
**前提（要確認）**
- LINEのグループへのPushは、**グループの人数分**が月の送信数として数えられる。1対1トークは1通。
- 全チームで1つの公式アカウントを共有するため、全チームの合計が、そのアカウントの1つの月間上限にかかる。
- 1回のPushに複数の吹き出しを入れた場合の数え方、上限の値、上限を超えたときの応答（429など）は、**LINEの最新の公式資料で確認してから確定する**（U-3）。この設計では「1回のPush × 人数」で数え、吹き出しは1つにまとめる。

**記録**
- 送信の直前に送信先の人数を取得し（グループの人数取得API）、`recipient_count` に記録する。【第3版】取得の方法と、取得できないときの扱いは 6-5 に定める。
- 【第4版】**人数APIの値は、枠を確保するための推定値**として扱う。実際に何通と数えられたかは、LINEの使用量API（全体の合計だけが分かる）の値を正とする。
  | 値 | 意味 | 使う場所 |
  |---|---|---|
  | `recipient_count`（人数API） | 推定値。送信ごと・チームごとに分かる | 枠の確保（全体・団体・チーム）、チームの使用量の表示 |
  | LINEの使用量 `totalUsage` | 実際の値。公式アカウント全体の合計だけ | 全体の枠の判定（推定より大きいとき）、照合 |
  - チーム・団体の使用量は、最後まで推定値のまま（LINEから送信ごとの実際の数を得る方法は未確認。U-28）。
  - 推定と実際の差は、チームに割り振らず、全体の行の「割り振れない差」として扱う（6-6の照合）。
- 【第3版で改訂】チーム・団体・全体の月ごとの使用量は、`line_quota_periods` の確保・確定の数で管理する（6-6）。`notification_deliveries` が元の記録で、`line_quota_periods` の数は、いつでも `notification_deliveries` から計算し直せる（両者の一致をテストと日次の照合で確認する）。第2版で「必要に応じて作る」としていた `line_usage_monthly` は、この表に置き換える。
- 1日1回、LINEの使用量APIの値を取得し、DBの数と比べる（照合の詳細は 6-6）。

**送信前の確認（`reserve_notification` の中。第2版の `claim_notification` から移した）**
| 確認 | 超えた場合 |
|---|---|
| チームの月間上限（10章のプランで決まる値） | 欠席通知は送らず `skipped`（`team_quota`）。管理者申請用の扱いは未決（U-15。案では、人数が少ないため送る） |
| 【第3版】団体の共有上限（団体契約のチームだけ。10-4） | 欠席通知は送らず `skipped`（`org_quota`）。管理者申請用はチームの上限と同じ扱い（U-15） |
| 全体（公式アカウント）の上限から、予備枠を引いた値 | 全チームの欠席通知を送らず `skipped`（`global_quota`）。予備枠は管理者申請用に残す |
| 【第3版】全体・団体・チームのどれかが `frozen_reason` 付き | 送らず `skipped`（`quota_frozen`） |
| LINEが上限到達を返した | `failed` を記録し、全体の行に `frozen_reason='line_monthly_limit'` を付けて、その月の送信を止める。運営者が確認して解除する |

**知らせ方**
| 段階 | 動作 |
|---|---|
| チームで上限の70%・90% | そのチームの管理画面に表示する |
| チームで100% | 管理画面に「今月の欠席通知は停止中」と表示する |
| 全体で80%・95% | 運営者に知らせる（方法は未決 U-16） |
| 上限で送らなかった通知 | 管理画面の履歴に「上限のため送信していません」と表示する。翌月になっても**さかのぼって送らない** |

### 6-5. 【第3版で新設】グループ人数の取得方法と、送信を止める条件
**取得に使うLINE Messaging APIのエンドポイント（要確認 U-19）**
| 送信先 | 方法 |
|---|---|
| グループ（`source_type='group'`） | `GET https://api.line.me/v2/bot/group/{groupId}/members/count` → 応答 `{"count": 人数}` |
| 複数人トーク（room） | `GET https://api.line.me/v2/bot/room/{roomId}/members/count`。この設計では複数人トークの登録を受け付けないため、使わない |
| 1対1トーク（`source_type='user'`） | 取得しない。1人として数える |

- 認証はチャネルのアクセストークン（Secrets）。Edge Function の中だけで使い、ログに出さない。
- 次の点はLINEの最新の公式資料で確認してから確定する（U-19）：人数に**Bot自身が含まれるか**、通数として数えられる人数と一致するか、このAPIの呼び出し回数の制限、未認証のアカウントでも使えるか。
- 案では、「APIの人数をそのまま通数とみなす」（Botを含む場合は1多く数えることになり、安全側になる）。

**取得する時機**
| 時機 | 目的 |
|---|---|
| コードを受け付けたとき（4-2） | 承認画面に人数を出す。取得できなければ承認待ちにしない |
| 承認するとき | `approved_member_count` に残す（その場でもう一度取得する） |
| 送信の直前（5-1 手順2） | 通数の見込み（`recipient_count`）と停止条件の判定 |
| 1日1回の保守（`maintenance`） | `last_member_count` を更新し、急増を早めに見つける。**送信はしない** |

**取得に失敗したとき・人数がおかしいときの扱い**
| 状況 | 扱い |
|---|---|
| 200で人数が取れた | その人数を使う |
| タイムアウト・5xx・429（呼び出し回数の制限） | 【第4版で変更】1回だけ待って取り直す。それでも失敗したら**送らない**（`member_count_unavailable`）。**前回の人数（`last_member_count`）は使わない**。枠も確保しない |
| 404（Botがそのグループにいない・グループがない） | **送らない**（`member_count_unavailable`）。送信先に `needs_reconfirm=true` を付け、管理画面に「通知先を確認してください」と表示する。leave イベントが届いていれば `left` になる |
| 401・403（トークンが無効・権限がない） | **全体の送信を止める**（全体の行に `frozen_reason='line_auth_error'`）。どのチームの送信先の問題でもないため。運営者が確認して解除する |
| 応答の形が想定と違う・人数が0以下 | **送らない**（`member_count_unavailable`）。運営者に知らせる |
| 管理者申請用で、人数がその用途の `max_recipients` を超えた | **送らない**（`member_count_too_large`）。`needs_reconfirm=true` にする。申請の内容（選手名・申請者名）が、想定より多くの人に届くのを防ぐため |
| 人数が `approved_member_count` から大きく増えた（基準は未決 U-20。案：2倍以上、かつ10人以上の増加） | **送らない**（`needs_reconfirm`）。管理者が人数を確認して「このまま送る」を選ぶと、その時点の人数を新しい `approved_member_count` にして再開する |

- 「送らない」になった通知は、上限で送らなかった場合と同じく、**あとからさかのぼって送らない**。欠席通知は、次の対象日の通知から再開する。
- 【第4版】初期運用では、**人数を送る直前に取得できた場合だけ送る**。`last_member_count` は、急増の早期発見と管理画面の表示にだけ使い、通数の推定には使わない。
- 将来、前回の人数を使って送るか（使う場合の期間・条件）は、未決事項として残す（U-20）。急増の基準も U-20 で決める。
- 人数を取れずに送らなかった欠席通知は、同じ対象日の次の実行（例：19時台の再実行）で、もう一度人数の取得から行う。送る時間帯を過ぎたら `skipped` のまま終える。

### 6-6. 【第3版で新設】共通Bot全体の送信枠の排他制御・枠確保・利用量照合
全チームが1つの公式アカウントの月間上限を分け合う。複数チームが同時に送っても上限を超えないように、**送る前に枠を確保**し、送った結果で確定または返却する。

**枠の3段**
| 段 | 上限の決め方 | 行 |
|---|---|---|
| 全体 | LINEの月間上限（`GET /v2/bot/message/quota` の値。要確認 U-21）から、予備枠を引いた値を欠席通知に使う。予備枠は管理者申請用・確認送信に使う | `scope_type='global'` |
| 団体 | 団体契約の `pooled_line_units`（設定がある場合だけ） | `scope_type='organization'` |
| チーム | プランの `monthly_line_units`（10章） | `scope_type='team'` |

**排他制御（`reserve_notification` の中）**
1. 対象の月（日本時間）の行がなければ作る（`insert … on conflict do nothing`）。
2. **全体 → 団体 → チーム**の順に `select … for update` で行をロックする。どの処理もこの順番を守り、デッドロックを防ぐ。
3. 各段で `reserved_units + consumed_units + 今回の人数 <= 上限`（全体は用途に応じて予備枠を引いた上限）を確かめる。1つでも超えたら、どの段にも足さずに `skipped`。
4. すべての段の `reserved_units` に今回の人数を足し、`notification_deliveries.reserved_units` に同じ数を記録する。
5. トランザクションを終える（ロックは数ミリ秒で外れる）。LINEへの送信は、ロックを持たずに行う。

【第4版】**トランザクションとHTTP通信の分離**（全体の決まり）
| 段階 | DB | LINEとの通信 |
|---|---|---|
| 宛先の確定（`claim_notification`） | 短いトランザクション1つ | なし |
| 人数の取得 | **トランザクションなし** | 人数API |
| 枠の確保（`reserve_notification`） | 短いトランザクション1つ（行ロックはこの中だけ） | なし |
| 送信 | **トランザクションなし・ロックなし** | Push API |
| 結果の記録（`finish_notification`） | 短いトランザクション1つ（同じ順番で行ロック） | なし |

- Edge Function は、DBへの接続を開いたままLINEへ通信しない。各段階は、それぞれ別のDB関数の呼び出し（1回の呼び出し＝1トランザクション）にする。
- 確保・記録の関数には `lock_timeout`（案：2秒）と `statement_timeout`（案：5秒）を付ける。ロックを待ちきれなかった場合は、送らずにそのまま終える（記録は `pending` のまま残り、次の実行か復旧処理で続きから行う。6-7）。
- DB関数の中から外部へHTTP通信をする仕組み（`pg_net` など）は使わない。

- 全体の行のロックで、全チームの枠の確保が1件ずつ順番になる。確保の処理はDBの中だけで短いため、20チーム程度なら待ち時間は問題にならない見込み。利用が大きく増えた場合の分け方は、そのときに検討する。
- 3-2 の `team_api` のロック（`734214`）とは別に、行ロックで守る。`team_api` のロックを取ったまま枠を確保することはしない。

**結果による確定・返却（`finish_notification`）**
| 送信の結果 | 枠の扱い | `reservation_state` |
|---|---|---|
| 200、または409（本文に retry key） | 確保した数を `consumed_units` に移す | `consumed` |
| LINEが「届けていない」ことが確かな失敗（400など、要求の誤り） | 確保した数を返す | `released` |
| 429（月間上限に達した） | 返す。全体の行に `frozen_reason='line_monthly_limit'` を付ける | `released` |
| 429（呼び出し回数の制限）・5xx・タイムアウト | **返さない**（届いたかもしれないため）。`processing` のまま、5分後に同じ再送防止キー・同じ `outbound_request` で再試行する（6-3）。再試行では新しく枠を確保しない | `uncertain` |
| 【第4版で変更】`retry_deadline`（最初の送信から23時間）までに結果が分からなかった | **自動では再送しない**。`failed`（`unknown_expired`）にし、枠は使ったものとして `consumed_units` に移す（安全側）。管理画面に「届いたか確認できません」と表示する | `consumed` |
| 【第4版】再試行の前に送信先が `active` でなくなった | 再試行しない。`failed`（`destination_inactive`）。枠は使ったものとして扱う | `consumed` |

- 429の2種類は、応答の本文で見分ける（月間上限の文言かどうか。文言は要確認 U-21）。見分けられない場合は、月間上限として扱う（安全側）。

**LINE側の使用量との照合（`maintenance` で1日1回、全体の80%を超えたら1時間ごと）**
1. `GET /v2/bot/message/quota/consumption`（当月の使用量 `totalUsage`）と `GET /v2/bot/message/quota`（上限）を取得し、全体の行の `line_reported_units` に記録する。
2. DBの値（全体の `consumed_units + reserved_units`）と比べる。
3. 扱い：
   | 比較 | 扱い |
   |---|---|
   | LINEの値 ≤ DBの値 | 問題なし（LINE側の反映の遅れ、結果不明の分、推定が実際より多い分）。【第4版】**推定の方が多くても、その月の枠は減らさない**（確保した数を返さない。安全側） |
   | LINEの値 > DBの値（差が許容範囲内。案：全体上限の1%か50通の大きい方。U-25） | 【第4版】差を全体の行の「割り振れない差」（`unattributed_units` = LINEの値 − DBの値）として記録し、以後の全体の判定は `consumed + reserved + unattributed` で行う。チーム・団体の数は変えない |
   | LINEの値 > DBの値（差が許容範囲を超えた） | DBの記録にない送信がある可能性がある（記録漏れ・別の仕組みからの送信・誤送信）。全体の行に `frozen_reason='reconcile_mismatch'` を付けて**全体の送信を止め**、運営者に知らせる |
   | LINEの上限の値が変わった | 新しい値で全体の上限を計算し直す。下がった結果、すでに上限を超えている場合は、その月の欠席通知を止める |
4. あわせて、全体・団体・チームの各行の数が、`notification_deliveries` から計算した数と一致するかを確かめる。一致しない場合は運営者に知らせる（自動では直さない）。

- 同じ公式アカウントから、このアプリ以外（LINE公式アカウントの管理画面の一斉配信など）で送ると、照合が合わなくなる。**共通Botからは、このアプリ以外では送らない**運用にする。
- LINEの使用量APIがどれくらい遅れて反映されるかは要確認（U-21）。許容範囲の値は、その結果で決める。
- 月の区切りは日本時間の1日0時とする（LINE側の区切りと合うかは U-21）。月をまたぐ処理の扱いは 6-7 にまとめる。

### 6-7. 【第4版で新設】補償・復旧の手順
送信は「確定 → 人数 → 確保 → 送信 → 記録」の5段階に分かれるため、途中で止まったときの扱いを決めておく。**復旧処理（`maintenance` の中、5分ごと）は、自動では新しい送信先・新しい本文で送らない**。続きができるのは、6-3の決まりの範囲（同じキー・同じ内容・締め切り前）だけ。

| 止まった場所・状況 | 記録の状態 | 復旧の動作 |
|---|---|---|
| 宛先の確定の後、枠の確保の前（人数の取得中に異常終了など） | `pending`、枠なし | 欠席通知：同じ対象日の次の実行で、人数の取得からやり直す。送る時間帯を過ぎたら `skipped`（`abandoned`）。申請通知：作成から1時間以内なら復旧処理が続きから行い、過ぎたら `skipped`（`abandoned`）。管理画面には申請自体が表示されるため、申請は失われない |
| 枠の確保の後、LINEに送る前（異常終了） | `processing`、`reserved`、`first_attempt_at` なし | 5分たったら、復旧処理が送信先の有効性を確かめ、**確保済みの枠のまま**送る（初回の送信として扱う）。確保から1時間を過ぎていたら送らず、枠を返して `failed`（`abandoned`）にする（古い内容を遅れて送らないため） |
| LINEに送った後、結果の記録の前（異常終了・通信切れ） | `processing`、`reserved`、`first_attempt_at` あり | 5分たったら、同じキー・同じ `outbound_request` で再試行する。LINEが受け付け済みなら409が返り、`sent`（`duplicate_409`）として記録する。**二重には届かない** |
| 結果が分からない（タイムアウト・5xx） | `processing`、`uncertain` | 上と同じく再試行する。`retry_deadline` を過ぎたら再送せず `failed`（`unknown_expired`）、枠は使ったものとして扱う |
| 結果の記録が失敗した（DBの一時的な障害） | `processing` のまま | 上と同じ。再試行で409が返れば `sent` になる |
| 枠の取り残し（確保したまま、送信記録が終わっている・見つからない） | 照合で見つかる | 6-6 の照合で、各段の `reserved_units` を、`reservation_state in ('reserved','uncertain')` の送信記録の合計と比べる。合わなければ運営者に知らせる。**自動では直さない**。運営者は手順書に沿って、`private.rebuild_quota_period(月)`（送信記録から数を計算し直す関数。実行は運営者だけ・記録を残す）を使う |
| 月をまたいだ送信（月末に確保し、翌月に結果が出た・再試行した） | `quota_month` が前の月 | 結果の記録・返却・確定は、**`quota_month` の行**に対して行う。翌月の行には足さない。再試行も新しく翌月の枠を確保しない |
| 前の月の最終照合 | — | LINEの使用量APIは当月の値を返すため（要確認 U-27）、各月の最後の照合を月末の23時台（日本時間）に行う。翌月に前の月の `uncertain` が残っていれば、締め切りで確定したあとに `reconciled_final=true` にする。LINEの値と比べられない分は「照合できず」と記録し、運営者に知らせる |
| 全体の送信が止まった（`frozen_reason` 付き） | — | 自動では解除しない。運営者が原因を確かめ、手順書に沿って解除する。止まっていた間の通知は、さかのぼって送らない |

- 復旧処理そのものが重ならないよう、復旧処理は `pg_try_advisory_lock`（専用の番号）で1つだけ動かす。取れなければ何もしないで終える。
- 復旧処理は、1回の実行で扱う件数に上限（案：50件）を付ける。
- 復旧の結果（何件を再試行・確定・返却したか）は件数だけをログに出す。宛先IDや本文は出さない。

---

## 7. South Dragons の移行とロールバック

### 7-1. 方針
- **追加 → 埋める → 締める**の段階に分ける。段階ごとに `scripts/db-backup.sh` でバックアップを取り、戻すSQLを `supabase/rollback/` に用意する。
- 移行中も、今の画面（`team` パラメータなし）とホーム画面アプリは、South Dragonsとしてそのまま動く。
- LINEは最後に切り替える。それまで South Dragons は今の Secrets 方式で送る。

### 7-2. 段階
| 段階 | 内容 | 利用者への影響 | 戻し方 |
|---|---|---|---|
| M1 追加 | `teams` に South Dragons（固定UUID・固定slug・`legacy_default=true`）を作る。新しい表を作る。既存の表に `team_id`（null可・既定値 = South Dragons）を追加 | なし | 追加した列・表を削除（SQLで戻せる） |
| M2 埋める | 既存の行の `team_id` を South Dragons で埋める。管理者パスワード・チームコード・閲覧端末を、チーム別の表へ**複製**（元は残す） | なし | 新しい表の行を削除。元の行はそのまま |
| M3 関数の切り替え | `team_api` / `save_own_attendance` / `snapshot` を、`team_id` 付きの版にする。古い呼び方は South Dragons 固定で動く互換関数で残す。`team` 関数を新しい版にデプロイ | なし（同じ画面） | 関数を前の版に戻す（今の migration の関数定義を再適用）。`team` 関数は前の版を再デプロイ |
| M4 締める | `team_id` を NOT NULL に。複合FKを追加。UNIQUE(`normalized_name`) を UNIQUE(`team_id`,`normalized_name`) に変更。元の単一行の設定を読まないようにする | なし | 制約を元に戻すSQL。データは変えていないので戻せる |
| M5 画面 | `?team=` に対応した画面を公開。指定なしは South Dragons、未知のslugはエラー | なし | 前のコミットで Pages を戻す |
| M6 LINE | 共通Botを South Dragons の欠席連絡用・管理者申請用に登録し、承認。`notifications_enabled` をオン。Secrets の旧送信先は使わない | 送信元のアカウントが変わる場合がある（事前に案内） | `notifications_enabled` をオフ。旧Secrets方式に戻す関数版を再デプロイ |
| M7 片付け | 旧 `settings.admin_password_hash`、`team_code` の旧行、`attendance_reminder_deliveries`、互換関数を削除 | なし | **バックアップからの復元のみ**。そのため、M6のあと1か月以上たってから行う |

- M1〜M4 は、すべて1回の migration ではなく、段階ごとに分ける。各段階のあと、件数とハッシュ（`players` / `events` / `attendance` / `player_access` の件数、`team_api` の定義）を確認してから次へ進む。
- 2つ目以降のチームは、M6 が安定するまで作らない。

### 7-3. 確認すること（各段階の後）
- 全表の件数が変わっていない。
- `team_id` が null の行がない（M2以降）。South Dragons 以外の `team_id` を持つ行がない。
- 今の端末で、閲覧・出欠入力・管理画面ログインができる。

---

## 8. 架空チーム A・B・C を使った分離テスト計画

ローカル（PGlite と Denoテスト）だけで行う。架空データのみ。本番のバックアップはローカルに復元しない。

### 8-1. 準備
| チーム | 設定 |
|---|---|
| A | 選手「架空 一郎」と「A専用 太郎」、予定2件、管理者、欠席連絡用と管理者申請用の送信先が `active` |
| B | **Aと同じ名前**の選手「架空 一郎」と「B専用 次郎」、予定1件、管理者、欠席連絡用のみ `active` |
| C | 選手「C専用 三郎」、送信先なし、`notifications_enabled=false` |
| 端末 | Aの保護者、Bの保護者、A・B両方の保護者（兄弟）、どこにも属さない端末 |
| 【第3版】団体 | 架空の団体O（A・Bが所属、共有枠あり）。Cは団体に属さない。並行テスト用に、同じ形の架空チームを20まで増やす |

- 【第2版】チームごとに**そのチームにしかない目印の名前**（`A専用` / `B専用` / `C専用`）を入れる。送られた本文・返したデータに、ほかのチームの目印が1つも含まれないことを、文字列で検査する。
- LINE API はテスト用の偽の fetch に置き換え、宛先・本文・再送防止キーをすべて記録して検証する。偽のLINEには「宛先ID → 本来のチーム・用途」の対応表を持たせ、送られた宛先が対応表と一致するかを全件で確認する。
- 【第3版】偽のLINEは、人数API・使用量API・上限APIにも答える。応答（人数・使用量・上限・失敗の種類・遅れ）はテストごとに切り替えられるようにする。

### 8-2. テスト項目
**データ分離（DB）**
1. A と B に同じ名前の選手を登録できる。Bで登録しても「すでに登録されています」にならない。
2. Aの端末の `getData` に、Bの選手・予定・出欠・申請が1件も含まれない（件数とIDで確認）。
3. Aの選手IDとBの予定IDを組み合わせた出欠行は、DBが拒否する（複合FK）。
4. `save_own_attendance` で、Aの保護者がBの選手・予定に書き込めない（`FORBIDDEN` / `NOT_EDITABLE`）。
5. 兄弟の端末は、Aでは自分の子だけ、Bでも自分の子だけを編集できる。
6. Aの管理者トークンで、Bの `team_id` の管理操作がすべて `UNAUTHORIZED` になる。
7. Aのチームコードは、Bでは無効。Aで閲覧端末を取り消しても、Bの閲覧権は変わらない。
8. Bの選手IDを、Aの `team_id` で `requestRegistration` / `renamePlayer` / `setPlayerActive` すると `NOT_FOUND` になる。
9. A・B・Cどこにも属さない端末は、閲覧制限オンのチームを見られない。
10. anon / authenticated に表の権限がない。実行できる関数は `save_own_attendance` だけ（今のテストを全チーム分に拡張）。

**LINE登録（Webhook）**

11. 署名が不正なWebhookは401。別Bot宛ては無視。同じ `webhookEventId` は1回だけ処理する。
12. Botの招待（join）だけでは `joined` になり、何も送られない。
13. Aのコードを投稿すると、Aの `pending_approval` になる。承認するまで、何も送られない。
14. 期限切れ・使用済み・形式違いのコードは拒否する。誤ったコードが続いたら受け付けを止める。
15. Aで使用中のグループに Bのコードを投稿すると拒否される。
16. Bの管理者は、Aの承認待ちの送信先を承認できない。
17. 送信先を変えると古い送信先は `revoked`。leave イベントで `left` になり、以後送られない。

**通知の振り分け**

18. 同じ日にAとBに欠席者がいると、Aのグループには Aの欠席者だけ、Bのグループには Bの欠席者だけが送られる。
19. Cは送信先がない・スイッチがオフなので、送られず `skipped` が記録される。
20. Aの申請通知は Aの管理者申請用の送信先にだけ送られる。Bは管理者申請用がないので送られない（欠席連絡用に代わりに送られない）。
21. 同じ通知を2回実行しても、LINEに届くのは1回。`processing` の再試行は同じ再送防止キーを使う。
22. 409（retry key）は送信済み、そのほかの409・500は失敗として記録される。
23. 全体の `line_delivery` をオフにすると、どのチームにも送られない。
24. 履歴は自分のチームの分だけが管理画面に返る。

**移行**

25. 今の migration をすべて適用し、South Dragons 相当の架空データを入れる → M1〜M4 を適用する → 件数・出欠・権限が変わらない。今のテスト（`team-code-permissions.test.ts` など）が通る。
26. M1〜M4 それぞれのロールバックSQLを適用すると、元の構成に戻り、今のテストが通る。
27. `team` パラメータなしのリクエストは South Dragons として動く。

**【第2版で追加】URLのチームと権限の一致**

28. 存在しないslug・空のslug・形式違い・`archived` のチームは `TEAM_NOT_FOUND`。**South Dragons（`legacy_default`）のデータは1件も返らない**。
29. `team` パラメータなしは South Dragons。`legacy_default` のチームがない状態では `TEAM_NOT_FOUND`（ほかのチームに振り替えない）。
30. slug の変更はDBが拒否する。表示名を変えてもURLは変わらず、同じチームが開く。
31. Aのslugを開いた端末が、Bの `team_id` を本文に入れて送っても無視され、Aとして扱われる。
32. Aのslugで、Aの管理者トークンを使ってBの選手IDを操作すると `NOT_FOUND`。Bのslugで、Aの管理者トークンを使うと `UNAUTHORIZED`。
33. 兄弟の端末が、AのslugのままBの選手の出欠を保存しようとすると `FORBIDDEN`（`save_own_attendance` の `p_team` 照合）。
34. 返された snapshot の `team.slug` が開いているslugと違う場合、画面はデータを表示しない（画面のテスト）。
35. Aを開いたあとBを開くと、Aの選手・予定・管理者ログインの状態が残らない（画面のテスト）。

**【第2版で追加】LINE誤送信の防止**

36. A・B・Cの全通知を実行したあと、偽のLINEに記録された全送信について、宛先 → チーム・用途が対応表と一致する。
37. Aへの全送信の本文に `B専用` / `C専用` が含まれない。B・Cも同様。
38. 欠席通知が管理者申請用の送信先に、申請通知が欠席連絡用の送信先に送られることはない。
39. 送信の確保と解除を同時に実行したとき（並行テスト）、解除が確定した後に新しく確保された送信はない。
40. `joined` / `pending_approval` / `revoked` / `left` / `rejected` / `expired` の送信先には、どの経路でも送られない。
41. 欠席連絡用に使っているグループを、管理者申請用として承認できない（U-13で案どおりに決まった場合）。
42. チーム数を増やした並行テスト（例：20チームの欠席通知を同時に実行）でも、36・37が成り立つ。

**【第2版で追加】使用量と上限**

43. 送信ごとに人数が記録され、チーム・月ごとの集計が正しい。【第4版で変更】人数を取得できないときは送られない（前回の値は使わない）。
44. チームの上限を超える送信は `skipped`（`team_quota`）になり、偽のLINEには届かない。翌月になっても、さかのぼって送られない。
45. 全体の上限（予備枠を除く）を超えると、全チームの欠席通知が止まり、管理者申請用は予備枠の範囲で送られる（U-15で案どおりに決まった場合）。
46. 偽のLINEが上限到達の応答を返すと、`failed` が記録され、その月の全体の送信が止まる。
47. 利用状態が `suspended` のチームには送られない（`plan_status`）。
48. 70%・90%・100%の表示が、そのチームの管理画面にだけ返る。

**【第3版で追加】グループ人数の取得と送信停止（6-5）**

偽のLINEに、人数APIの応答（200・404・401・403・429・5xx・タイムアウト・形の違う応答）を返させて確かめる。

49. 200の人数が `recipient_count` に記録される。1対1トークの送信先では人数APIを呼ばず、1人として記録される。
50. 【第4版で変更】タイムアウト・5xx・429では1回だけ取り直し、それでも失敗したら、**前回の人数が記録されていても** `member_count_unavailable` で送らない（偽のLINEのPushに何も届かず、枠も確保されない）。
51. 404では送らず、送信先が `needs_reconfirm` になる。管理者が再確認するまで、そのチーム・用途の通知は送られない。
52. 401・403では全体が `line_auth_error` で止まり、どのチームにも送られない。
53. 人数が0・負の数・形の違う応答では送られない。
54. 管理者申請用で人数が `max_recipients` を超えると `member_count_too_large` で送られない。
55. 人数が承認時から基準以上に増えると `needs_reconfirm` になり、そのチームの管理者が「このまま送る」を選ぶと再開する。**ほかのチームの管理者は再確認できない**。
56. 宛先の確定（手順1）と枠の確保（手順3）の間に送信先を解除すると、送られず、枠も確保されない。

**【第3版で追加】共通Botの送信枠の排他制御・照合（6-6）**

57. 全体の残りが1チーム分しかない状態で、2チームが同時に枠を確保すると、片方だけが送られ、もう片方は `global_quota` になる。確保と送信済みの合計が上限を超えない。
58. 20チーム（団体に属するチームと属さないチームを混ぜる）が同時に送る並行テストを、順番を変えて繰り返しても、デッドロックが起きず、どの段の合計も上限を超えない。
59. 送信の結果ごとに、枠が正しく扱われる：200・409（retry key）は確定、400は返却、429（月間上限）は返却して全体が止まる、5xx・タイムアウトは `uncertain` のまま同じ再送防止キーで再試行し、**再試行で枠を二重に確保しない**。期限を過ぎると確定扱いになる。
60. 全体の枠が予備枠だけになると、欠席通知は送られず、管理者申請用は予備枠の範囲で送られる（U-15で案どおりに決まった場合）。欠席通知が予備枠を使うことはない。
61. 同じ団体のチームは団体の共有枠を分け合い、チームごとの上限も同時に守られる。別の団体・団体に属さないチームの枠には影響しない。
62. 57〜61のあと、`line_quota_periods` の各段の数が、`notification_deliveries` から計算し直した数と一致する。
63. 照合：LINEの使用量がDB以下なら何もしない。少し多ければ大きい方の値で判定する。許容範囲を超えて多ければ全体が `reconcile_mismatch` で止まり、運営者への知らせが記録される。LINEの上限の値が下がれば、新しい値で判定される。
64. 月の境目（日本時間）：月末23時59分に確保して翌月0時以降に結果が出た送信は、確保した月の数に入る。翌月の数は0から始まる。

**【第3版で追加】名称の分離と団体契約（10-4、11章）**

65. チームの表示名を変えると、次の通知から新しい表示名で送られ、slug・URLは変わらない。AとBが同じ表示名でも、Aへの通知はAの `team_id` から作られる（36・37の検査に表示名の目印も加える）。
66. 表示名の制限（サービス名と同じ名前、URL・メールアドレス・電話番号の形、改行・制御文字、41文字以上）が、DBと画面の両方で拒否される。
67. South Dragons の画面のタイトル・見出しと、申請通知・欠席通知の文面が、今と同じになる（画面と文面の比較テスト）。
68. 未知のslugのエラー画面と、Webhookの固定の返信文に、どのチームの表示名も含まれない。
69. 適用されるプラン：団体契約が有効なら団体のプラン、団体契約が停止されると所属チームも送信が止まる、団体から外すとチームの契約（なければ `free`）になる。`max_teams` を超えて団体に入れられない。**同じ団体のチーム同士でも、選手・予定・出欠・送信先・送信記録は見えない**（2・6・24を団体に属するチームでも行う）。

**【第3版で追加】ログ**

70. 8-2のすべてのテストで、Edge Function とDB関数が出したログ（テストで記録したもの）に、LINEのID・トークン・登録コード・選手名・申請者名が含まれない。

**【第4版で追加】再送防止キーと再試行（6-3）**

偽のLINEは、再送防止キーごとに最初の要求を覚え、24時間以内の同じキーには409を返す。24時間を過ぎた同じキーは新しい送信として数える（実際のLINEの動きに合わせる。U-21）。

71. 再試行で送られる宛先・本文が、最初の送信とバイト単位で同じになる。最初の送信のあとに出欠を変えても、再試行の本文は変わらない。
72. 再試行の前に送信先を解除すると、再試行されず `failed`（`destination_inactive`）になる。
73. 結果が分からない送信は、`retry_deadline`（23時間）までだけ再試行され、過ぎると `failed`（`unknown_expired`）になり、**その後どの処理からも送られない**（時刻を進めて確かめる）。偽のLINEで、同じ通知が2回数えられることがない。
74. 結果が確定すると `outbound_request` が消える。残っていたものも、締め切りから1日後に保守で消える。管理画面の履歴とログに本文が出ない。

**【第4版で追加】異常終了と復旧（6-7）**

処理を各段階の間で止める（テスト用の割り込み）ことで確かめる。

75. 枠の確保の後・送る前に止めると、復旧処理が確保済みの枠のまま1回だけ送る。確保から1時間を過ぎていれば送らず、枠が返る。
76. 送った後・記録の前に止めると、復旧処理の再試行で409が返り `sent` になる。偽のLINEに届くのは1回だけ。
77. 確保の前に止めた欠席通知は、同じ対象日の次の実行で人数の取得からやり直され、時間帯を過ぎると `abandoned` になる。
78. 復旧処理を2つ同時に動かしても、片方は何もせずに終わり、二重に再試行されない。
79. 月末に確保し翌月に結果が出た送信・再試行は、前の月の行で確定・返却され、翌月の行の数は変わらない（64を再試行と復旧まで広げる）。
80. 枠の数を人工的にずらすと、照合で見つかって運営者への知らせが記録され、自動では直らない。`rebuild_quota_period` で正しい数に戻る。

**【第4版で追加】ロックと通信の分離（6-6）**

81. 偽のLINEの応答を10秒遅らせても、その間にほかのチームの枠の確保が待たされない。通信中に、そのEdge処理のDBトランザクション・行ロックが残っていない（`pg_locks` と `pg_stat_activity` で確かめる）。
82. 枠の行のロックを別の処理で持ち続けると、確保は `lock_timeout` で諦めて送らずに終わり、あとで続きから送られる（二重に確保されない）。

**【第4版で追加】推定値と実際の値（6-4、6-6）**

83. LINEの使用量がDBの推定より少ないとき、その月の枠は減らない（返却されない）。
84. LINEの使用量がDBの推定より多いとき（許容範囲内）、差が `unattributed_units` に入り、全体の判定に使われる。チーム・団体の数は変わらない。許容範囲を超えると全体が止まる（63と合わせて確かめる）。

---

## 9. 変更点・開発規模・未決事項

### 9-1. 変更が必要なもの
| 対象 | 変更 |
|---|---|
| DB | 新しい表14（第1版の6つに、第2版で用途・操作記録・プラン・契約・契約履歴、第3版で送信枠・団体・団体契約を追加）、`settings.service_profile`、既存の表9つに `team_id`、複合FK、索引、`team_api` / `snapshot` / `save_own_attendance` / RLS の全面改修、通知用の関数（宛先の確定・枠の確保・結果の記録の3つ）、`effective_plan`、照合用の関数 |
| Edge `team` | slug → `team_id` の解決と未知slugのエラー、`team_api` の新しい引数、申請通知を `claim_notification` → 人数取得 → `reserve_notification` 経由に、表示名からの通知文 |
| Edge `attendance-reminder` | チームごとの処理、表を直接読まずDB関数から、共通の送信記録、人数の取得 |
| Edge `line-webhook`（新規） | 署名検証、join / leave / message の処理、登録コード照合、グループ名・人数の取得 |
| Edge `maintenance` | 匿名ユーザー整理の条件にチーム関連の表を追加。LINE使用量・上限の照合（1日1回、80%超で1時間ごと）、グループ人数の更新、結果不明の送信の期限処理 |
| 画面 | `?team=` の扱いと未知slugのエラー画面、slugごとの状態、チーム名の表示、管理画面に「LINE通知先」（用途別のコード発行・承認・解除・確認送信・履歴・使用量・人数の再確認）、サービス名と表示名からのタイトル・見出し、表示名の制限 |
| テスト・CI | 分離テスト一式、Webhookテスト、誤送信・使用量のテスト、移行・ロールバックのテスト |
| 文書 | 管理者向け手順（LINE登録）、保護者向け案内、運用手順（運営者による上限・利用状態・団体の変更、送信停止の解除、照合のずれの調べ方） |

### 9-2. 【第2版で改訂】開発規模（目安）
**前提条件**
- 今のコードを理解している開発者1人が、AIの支援を受けて作業する。
- 作業日は実際に手を動かす日数。**レビュー待ち・利用者への案内・LINEの審査や設定待ち・実機確認の日程調整は含まない**。
- 未決事項（9-3）は、作業を始める前に決まっている。
- 運営者向けの画面は作らず、チーム作成・プラン・利用状態の変更はSQLの手順書で行う。
- 決済機能は作らない（10章）。
- 画面のデザインは今の部品を使い、大きく作り直さない。
- 本番移行は、今回と同じく段階ごとにバックアップと確認を行う。

| 作業 | 第1版 | 第2版 | 第3版 | 第4版 |
|---|---|---|---|---|
| DB設計の確定と migration（M1〜M4、ロールバックSQL） | 5〜7日 | 5〜7日 | 5〜7日 | 5〜7日 |
| `team_api` / RLS / 書き込み関数の改修（第2版：`p_team` の照合を含む） | 5〜7日 | 6〜8日 | 6〜8日 | 6〜8日 |
| LINE Webhook・登録・承認（第2版：用途別・操作記録・安全対策） | 4〜5日 | 5〜7日 | 5〜7日 | 5〜7日 |
| 通知の共通化（欠席・申請） | 3〜4日 | 3〜4日 | 4〜5日（2段階の送信手順） | 5〜6日（再試行の内容保存・締め切り） |
| 使用量の記録・上限・照合（第2版で追加） | — | 3〜4日 | 5〜7日（人数取得・停止条件・枠の確保・照合） | 6〜8日（復旧処理・月をまたぐ処理・差の扱い） |
| プラン・利用状態の表と判定（第2版で追加。画面なし） | — | 1〜2日 | 2〜3日（団体契約・`effective_plan`） | 2〜3日 |
| 画面（チーム切り替え・未知slug・LINE通知先・使用量の表示） | 4〜6日 | 5〜7日 | 6〜8日（名称の組み立て・表示名の制限・再確認） | 6〜8日 |
| 分離テスト・誤送信テスト・移行テスト | 5〜7日 | 7〜9日 | 9〜12日（49〜70の追加、並行テスト） | 11〜14日（71〜84の追加、割り込み・時刻を進めるテスト） |
| 本番移行（M1〜M6、確認を含む。数週間に分けて実施） | 3〜5日 | 3〜5日 | 3〜5日 | 3〜5日 |
| **合計** | **29〜41日** | **38〜53日** | **45〜62日** | **49〜66日** |

**不確実性（見積もりが増える可能性が高い順）**
| 要因 | 内容 | 影響 |
|---|---|---|
| LINEの仕様 | 通数の数え方、上限の値と応答、グループ人数APIの条件（Botを含むか・呼び出し制限）、使用量APIの反映の遅れ、Webhookの細かい動き（U-3・U-19・U-21） | 確認の結果しだいで、6-4・4章の作り直しが発生しうる |
| RLSと関数の改修の波及 | `team_api` は1本の大きな関数で、全操作に `team_id` を通す必要がある | 見落としがテストで見つかるたびに手戻りが出る |
| 移行の予行演習 | 本番と同じ形の架空データで M1〜M4 とロールバックを試す回数 | 問題が出れば1回につき1〜2日増える |
| 実機確認 | LINEグループでの登録・承認・受信の確認（iPhone / Android） | 日程によって期間が延びる（作業日は大きく増えない） |
| 並行処理 | 枠の確保の行ロックと、送信・再試行・照合が重なったときの動き | 並行テスト（57〜59）で問題が出ると、関数の作り直しが出る |
| 未決事項 | 決まらないまま始めると手戻りになる | U-1・U-3・U-12〜U-16・U-19〜U-21 は特に影響が大きい |

- 以上から、**49〜66日（第4版）は下限寄りの目安**として扱い、計画では2〜3割の余裕を見込むことを勧める。
- 【第4版】**最終見積もり：作業日 49〜66日、余裕を含めた計画値 60〜85日程度**（作業日のみ。レビュー待ち・LINEの確認・実機確認の日程は含まない）。
- 【第3版】団体契約の表と判定は、販売を始めるまで使わない。最初の複数チーム化では表だけを作り、判定とテスト69を後回しにすれば、2日程度減らせる。
- 第1版の29〜41日には、第2版で増えた範囲（用途別管理、安全対策、使用量、プラン、追加テスト）が含まれていなかった。

### 9-3. 未決事項
| ID | 内容 | 状態 |
|---|---|---|
| U-1 | 【第2版で更新】URL方式は「`?team=<固定slug>`」に決定（案）。残る点：South Dragons の slug の値、今のURLで開いたときにアドレスを `?team=` 付きに書き換えるか | 一部未決 |
| U-2 | チームの作り方：誰がチームを作るか（運営者専用の画面、またはSQLの手順）。運営者（全チームの管理者）の権限を持たせるか | 未決 |
| U-3 | 【第2版で更新】LINEの料金と上限：通数の数え方（グループ人数・吹き出しの数）、月間上限の値、上限到達時の応答、有料プランの費用を誰が負担するか。**LINEの最新の公式資料で確認が必要**。【第3版】APIの細かい点は U-19・U-21 に分けた | 未決 |
| U-4 | 管理者申請用の送り先：管理者個人のトークか、管理者だけのグループか | 未決 |
| U-5 | 欠席通知の曜日・時刻をチームごとに変えられるようにするか | 未決 |
| U-6 | 共通Botの名前・アイコン（特定のチーム名を含めない）。【第3版】名前はサービス共通名称にそろえる（U-22） | 未決 |
| U-7 | 利用規約・プライバシーポリシー（複数チームのデータを預かる場合） | 未決 |
| U-8 | 1チームに管理者を複数置くか（今はパスワード1つを共有） | 未決 |
| U-9 | Supabase のプラン（ログ保存期間、Edge Function の実行回数） | 未決 |
| U-10 | 【第2版で更新】12月の South Dragons 本番LINEをどのアカウントから送るか。**実機で送信・受信を確認してから判断する**（9-4）。第1版の「共通Botを推奨」は取り下げ | 未決 |
| U-11 | チームの退会・データ削除の手順と保存期間 | 未決 |
| U-12 | 【第2版で追加】管理者申請用の送信先で、承認時に警告する人数の基準 | 未決 |
| U-13 | 【第2版で追加】同じグループを、同じチームの欠席連絡用と管理者申請用の両方に登録してよいか（案：不可） | 未決 |
| U-14 | 【第2版で追加】送信先の承認時に、管理者パスワードの再入力を求めるか（案：求める） | 未決 |
| U-15 | 【第2版で追加】上限到達時に、管理者申請用の通知を送り続けるか（案：送る。予備枠の範囲で） | 未決 |
| U-16 | 【第2版で追加】運営者への知らせ方（メール、運営者用LINE、画面のみ） | 未決 |
| U-17 | 【第2版で追加】プランの種類・上限値・利用状態ごとの動作（10章の表の値）。【第3版】団体プランの値と、移行時の South Dragons のプラン（案：運営者設定・チームの上限なし） | 未決 |
| U-18 | 【第2版で追加】チーム別の月間上限と、全体の予備枠の割合 | 未決 |
| U-19 | 【第3版で追加】グループ人数API：人数にBot自身が含まれるか、通数の人数と一致するか、呼び出し回数の制限、未認証アカウントで使えるか（案：APIの人数をそのまま通数とみなす） | 未決（LINE公式資料で確認） |
| U-20 | 【第4版で更新】初期運用では人数の前回値を使わない（決定）。残る点：**将来、前回値（キャッシュ）を使って送るか**、使う場合の期間・条件。急増とみなす基準（案：承認時の2倍以上かつ10人以上の増加） | 一部決定 |
| U-21 | 【第3版で追加】上限API・使用量APIの値の意味と反映の遅れ、月間上限到達時の429の本文、月の区切り（日本時間か）。【第4版】`X-Line-Retry-Key` の有効期限（24時間）と、同じキーで内容を変えたときの動き | 未決（LINE公式資料で確認） |
| U-22 | 【第3版で追加】サービス共通名称（商標の確認を含む）と、表示名に使えない言葉の一覧 | 未決 |
| U-23 | 【第3版で追加】団体契約：団体契約の停止時に所属チームをどう扱うか（案：同じ状態にする）、団体の担当者に所属チームのデータを見せるか（案：見せない）、チームを団体に入れる手続き | 未決 |
| U-24 | 【第3版で追加】無料プランの内容（欠席通知を含めるか、上限の通数、選手数の上限） | 未決 |
| U-25 | 【第4版で更新】結果不明の送信の再試行の締め切りは23時間に決定（案から確定。LINEの仕様確認 U-21 が前提）。残る点：照合の許容範囲（案：全体上限の1%か50通の大きい方）、確保後に送らずに枠を返すまでの時間（案：1時間） | 一部決定 |
| U-26 | 【第4版で追加】再試行用の本文の保存方法（案：送信記録に一時保存し、確定後すぐ消す）。暗号化して保存するか | 未決 |
| U-27 | 【第4版で追加】前の月の最終照合の方法（LINEの使用量APIで前の月の値を得られるか） | 未決（LINE公式資料で確認） |
| U-28 | 【第4版で追加】送信ごとの実際の通数をLINEから得る方法があるか（なければチーム・団体の使用量は推定値のまま） | 未決（LINE公式資料で確認） |

**【第4版】重大度による整理**
| 重大度 | 未決事項 | 理由 |
|---|---|---|
| 着手前に必ず決める | U-3、U-19、U-21、U-27、U-28（LINEの仕様）、U-1（slugの値）、U-13、U-14、U-15 | 送信枠・再試行・照合・安全対策の作りが、この結果で変わる |
| 着手前に決めるのが望ましい | U-2、U-4、U-8、U-12、U-16、U-18、U-20、U-25、U-26 | 決まらないと手戻りが出るが、案のままでも作り始められる |
| 販売の前までに決める | U-6、U-7、U-11、U-17、U-22、U-23、U-24、U-9 | 最初の複数チーム化には影響が小さい |
| 12月の運用で決める | U-10 | 9-4の手順で判断する |
| 当面不要 | U-5 | 共通の曜日・時刻で始める |

### 9-4. 【第2版で改訂】12月の単独運用との関係
- **2026年12月のSouth Dragons単独運用を優先し、複数チーム対応の実装は別途着手判断する。**この設計の作業は、12月の運用には不要。12月までは、今の構成に手を加えない。
- 12月の South Dragons の LINE 通知は、**今の Secrets 方式のまま**とする。
- 本番LINEへの切り替え（送信元のアカウント・送信先の変更）は、次の順に進め、**実機での送信・受信を確認してから判断する**。
  1. 今のテスト用公式アカウントで、10/27の申請通知が届いているかを確認する（未着の調査は未完了）。
  2. 本番で使うアカウントと送信先を決める（U-10）。
  3. 決めたアカウントから、個人情報を含まない固定文を1通だけ送り、実機（iPhone / Android）で受信を確認する。送る日時と送信先は事前に決め、ユーザーの承認を得てから行う。
  4. 結果を見て、切り替えるかどうかをユーザーが判断する。切り替えない場合は、テスト用の送信先のまま運用する。
- 12月までにできる準備（任意・本番に影響しない）：この文書のレビュー、未決事項の決定、ローカルでの試作。

### 9-5. 【第4版・凍結時に追加】実装前の必須確認事項
実装を再開する前に、次の3点を確認し、結果をこの文書に追記する。設計の内容そのものは 6-3・6-6・6-7 にあり、ここでは**確認すべき点だけ**をまとめる。

**A. LINEの409応答の解釈**（関係：6-3、6-6、テスト22・59・76）
- [ ] 再送防止キーの重複で返る409の、本文・応答ヘッダーの形をLINEの最新の公式資料で確認する（キーの重複だと判別できる情報があるか。U-21）。
- [ ] 「同じキーで内容が違う要求」「キーの有効期限（24時間）切れ後」の応答を確認する。
- [ ] キーの重複だと確認できた409だけを「送信済み」とし、それ以外の409は「失敗・再試行しない」とする方針でよいかを決める。
- [ ] 今の `team` 関数（409をすべて成功扱い）を、単独運用のうちに直すかどうかを別に判断する（この設計の実装とは切り離す）。

**B. 送信先の解除と送信の競合**（関係：4-5、5-1、6-3、テスト39・56・72）
- [ ] 「解除の直前に枠を確保済みだった送信は、最大1件届きうる」という設計上の限界を受け入れるかを決め、受け入れる場合は管理画面の解除の確認文に書く。
- [ ] 送る直前（HTTP通信の直前）に、ロックなしで送信先の状態をもう一度読み、すき間を狭めるかを決める。
- [ ] 再試行の前に送信先が解除されていたら再試行しない（`destination_inactive`）方針で、届いていない通知が出ることを受け入れるかを決める。
- [ ] 並行テスト（39・56・72）を、実装の最初の段階で通す。

**C. 通知本文の一時保存（`outbound_request`）の個人情報保護**（関係：6-3、6-7、U-26、テスト70・74）
- [ ] 保存先は `private` スキーマの送信記録だけにし、`team_api` / `snapshot` / 管理画面のどの応答にも含まれないことを、テストで確かめる。
- [ ] 保存期間（確定後すぐ消す・残りは締め切りの1日後に消す）を守る保守処理の動きを確かめる。
- [ ] バックアップ（`scripts/db-backup.sh`）に、保存中の本文が入ることの扱いを決める（バックアップの保管期間・保管場所との関係）。
- [ ] 暗号化して保存するか、本文の代わりに「作り直すための参照と `message_sha256`」だけを保存して、照合が合うときだけ再試行する方式にするかを決める（U-26）。
- [ ] ログ・エラー文・Supabaseの関数ログに本文や宛先IDが出ないことを、テスト70で確かめる。

---

## 10. 【第2版で新設】契約プラン・利用状態・使用量の拡張方針

将来の収益化に備えて、チーム単位で「どのプランか」「使える状態か」「どれだけ使ったか」を持てるようにしておく。**決済（カード登録・請求・入金確認）は対象外**。状態の変更は、当面は運営者がSQLの手順書で行う。

### 10-1. 表（案）
```sql
-- プランの定義（値は未決 U-17）
create table private.plans (
  code text primary key,                       -- 例 'free' / 'standard'
  label text not null,
  monthly_line_units integer,                  -- 月間の通知通数の上限（null=全体上限のみ）
  max_players integer,                         -- 選手数の上限（null=制限なし）
  features jsonb not null default '{}',        -- 例 {"absence_notice":true}
  active boolean not null default true
);

-- チームの契約（1チーム1行。履歴は下の表）
create table private.team_subscriptions (
  team_id uuid primary key references public.teams(id),
  plan_code text not null references private.plans(code),
  status text not null check (status in ('trial','active','grace','suspended','cancelled')),
  current_period_start date, current_period_end date,
  updated_at timestamptz not null default now(),
  updated_by text not null                      -- 運営者の作業名（個人名は書かない）
);
create table private.team_subscription_history (
  id bigint generated always as identity primary key,
  team_id uuid not null references public.teams(id),
  plan_code text not null, status text not null,
  changed_at timestamptz not null default now(), reason text not null default ''
);
```
- 【第3版で改訂】使用量は `line_quota_periods` で管理する（6-6）。第2版の `line_usage_monthly` は作らない。
- `teams.status`（運用上の停止・退会）と `team_subscriptions.status`（契約の状態）は別に持つ。どちらかが送信を許さなければ送らない。【第3版】団体契約に属するチームは、団体の `organizations.status` と `organization_contracts.status` も確認する（10-4）。

### 10-2. 利用状態ごとの動作（案。値は未決 U-17）
| 状態 | 閲覧・出欠入力 | 管理画面 | LINE通知 |
|---|---|---|---|
| `trial` / `active` | できる | できる | プランの上限まで |
| `grace`（支払い遅れなどの猶予） | できる | できる（お知らせを表示） | プランの上限まで |
| `suspended` | 閲覧のみ（案） | ログインのみ | 送らない（`plan_status`） |
| `cancelled` | できない | できない | 送らない |

### 10-3. 将来、決済を入れる場合の方針
- 外部の決済サービスの通知（Webhook）を受けて、`team_subscriptions` の状態だけを変える。アプリ本体・出欠のデータには触れない。
- カード情報などはこのアプリのDBに保存しない。
- この章の表は、決済がなくても運営者の手作業で使えるようにしておく。

### 10-4. 【第3版で新設】団体契約による無料／有料プランへの拡張方針
将来の販売では、チームが個別に申し込む形のほかに、**団体（連盟・地域の協会・学校など）が複数チームをまとめて契約する形**を想定する。どちらも決済は対象外で、状態の変更は運営者の手作業とする。

**プランの考え方（案。種類・値は未決 U-17、U-24）**
| プラン | 申し込みの単位 | LINE通知 | 想定 |
|---|---|---|---|
| 無料（`free`） | チーム | 少ない月間上限（または欠席通知なし） | 試用・小規模のチーム。新しいチームの初期値 |
| 有料・チーム（`team_standard` など） | チーム | プランの月間上限 | 個別に申し込むチーム |
| 有料・団体（`org_standard` など） | 団体 | 団体で共有する上限（`pooled_line_units`）と、チームごとの上限の両方 | 連盟・協会が所属チームの分をまとめて契約 |

**チームに適用されるプランの決め方**（DB関数 `private.effective_plan(p_team)` で1か所にまとめる）
1. チームが団体に属し、団体と団体契約がどちらも送信を許す状態なら、**団体契約のプラン**。
2. そうでなければ、チーム自身の `team_subscriptions` のプラン。
3. どちらもなければ `free`。
- 団体契約が `suspended` / `cancelled` になった場合、所属チームを自動でチームの契約に切り替えることはしない（案：所属チームも同じ状態として扱い、運営者が個別に判断する。U-23）。
- チームを団体に入れる・外すのは運営者だけが行い、`team_subscription_history` と同じ形の履歴を残す。団体の `max_teams` を超えて入れることはDB関数で拒否する。

**団体とデータの分離**
- 団体に属することは、**ほかのチームのデータを見る権限にはならない**。団体の担当者が所属チームの選手・出欠を見る機能は作らない（作る場合は別に設計する。U-23）。
- 団体の単位で共有するのは、プランとLINE通知の枠だけ。LINEの送信先・送信記録・登録コードは、引き続きチームごとに分ける。
- 団体の共有枠は、6-6 の3段の「団体」として確保する。1つのチームが団体の枠を使い切らないよう、チームごとの上限も同時に確認する。

**12月の運用・移行との関係**
- South Dragons は団体に属さない。移行時は、今と同じく欠席通知・申請通知を使える運営者設定のプラン（チームの上限なし・全体の上限だけ）で始める案とする（U-17）。`free` の内容によって欠席通知が止まることがないようにする。
- 団体の表は M1 で空のまま作っておき、使うのは販売を始めてからとする。

---

## 11. 【第3版で新設】サービス共通名称・チーム表示名・固定slugの分離

将来の販売を考え、「サービスの名前」と「チームの名前」と「URLの識別子」を別のものとして扱う。今のアプリは South Dragons の名前が画面・通知文に直接書かれているため、これを分ける。

### 11-1. 3つの名前の役割
| 名前 | 例 | 持つ場所 | 変更 | 使う場所 |
|---|---|---|---|---|
| サービス共通名称 | （未決 U-22） | 全体の設定 `settings.service_profile`（名称・短い名称・問い合わせ先の表示文） | 運営者だけ。変更は全チームに影響する | 共通BotのLINE上の名前・アイコン、画面のタイトルの後半、利用規約、Webhookの固定の返信文 |
| チーム表示名 | `South Dragons` | `teams.display_name` | そのチームの管理者が変更できる（案。U-2） | 画面の見出し、通知文の見出し、管理画面 |
| 固定slug | 例 `south-dragons`（値は U-1） | `teams.slug` | **変更不可**・再利用しない | URL（`?team=`）、画面の状態・保存のキー。人に見せる名前としては使わない |

- チームの内部の識別は、どこでも `team_id`（UUID）を使う。slugはURLとの対応だけ、表示名は表示だけに使い、**表示名やslugで権限やデータを探さない**。
- 今のコード上の名前（リポジトリ名、`south-dragons-*` の `localStorage` キー、関数名など）は利用者に見えないため、名前の分離のために変えない。

### 11-2. 画面・通知文での使い分け
| 場所 | 形（案） |
|---|---|
| 画面のタイトル（ブラウザのタブ・ホーム画面アプリ） | `<チーム表示名> 出欠 - <サービス名>`。今のホーム画面アプリの名前は変えない（South Dragons の互換） |
| 未知のslugのエラー画面 | サービス名だけを出す（どのチームの名前も出さない） |
| 欠席通知 | 見出しに `【<チーム表示名>】`。末尾に小さく `<サービス名>` |
| 端末共有申請の通知 | `【<チーム表示名> 端末追加申請】`（今の `【South Dragons 端末追加申請】` と同じ形） |
| 確認送信・Webhookの返信 | 確認送信は `<チーム表示名>` だけ。Webhookの返信は**サービス名だけの固定文**（4-5。コードの段階ではどのチームか分からせない） |
| 共通BotのLINE上の名前 | サービス名だけ。特定のチーム名を含めない（U-6） |

- 通知文の表示名は、送る時点の `teams.display_name` を、送信記録と**同じ `team_id`** から読む（6-1の照合の対象に含める）。
- 表示名を変えた場合、それより前に送った通知は書き換わらない（LINEのメッセージは送ったまま残る）。

### 11-3. 表示名の制限
- 1〜40文字。前後の空白は除く。改行・制御文字は不可。
- サービス共通名称と同じ名前、運営者を思わせる名前（例「運営」「公式」「サポート」だけの名前）は不可（案。一覧は U-22 と一緒に決める）。
- URL・メールアドレス・電話番号の形の文字列は不可（通知文を使った誘導を防ぐため）。
- 同じ表示名のチームが複数あってもよい（区別はslugと `team_id` で行う）。そのため、管理画面のLINE通知先の承認画面などでは、表示名と一緒にslugも出す。

### 11-4. 移行
- M1 で `settings.service_profile` を作り、名称は決まるまで空にしておく。空のあいだは、画面・通知文は今と同じ表示（South Dragons のみ）にする。
- M5（画面）で、画面と通知文の名前を `team.displayName` と `service_profile` から組み立てるように変える。South Dragons の表示が今と変わらないことを、画面のテストで確認する（テスト67）。
