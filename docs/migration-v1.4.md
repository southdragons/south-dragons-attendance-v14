# 設計書v1.4への移行

対象設計書：South_Dragons_出欠管理システム_設計書_v1.4.docx（2026年9月10日）。

既存の画面を維持し、Supabase Anonymous Auth、所有権付き出欠、再登録申請、仮回答、管理者承認、GitHub Pagesへの静的公開を実装しています。接続先は作成済みです。SQL適用、匿名認証、公開キー、Edge FunctionsとSecretsの登録が完了し、監視APIのDB疎通とteam APIの認証・データ取得を確認済みです。GitHub Pagesの公開、公開URLのHTTP 200とJS/CSS 8ファイルの取得、GitHub Actions経由の稼働監視と月次整理の試行も確認済みです。2026年9月12日に既存データを移行し、実APIから移行前後の全項目の一致と旧管理者パスワードでのログイン・ログアウトを確認しました。テスト用LINEの接続・単体受信を確認し、再登録申請による通知状態sentと管理者処理も確認済みです。申請通知の本人受信確認、保護者・管理者による画面操作確認、本番LINEへの切り替えが残っています。本番LINEは利用者説明後の指示を受けて最後に切り替えます。月次整理の削除は無効で、候補の確認のみです。旧Sitesの公開範囲は変更しません。

## 接続先

- GitHub: https://github.com/southdragons/south-dragons-attendance-v14
- Supabase: https://cuhkjnuwozgnqqqvqhnl.supabase.co
- Supabase管理画面: https://supabase.com/dashboard/project/cuhkjnuwozgnqqqvqhnl
- GitHub Pages公開URL: https://southdragons.github.io/south-dragons-attendance-v14/

SQL Editorから設定する場合は、空の新規プロジェクトで `supabase/setup.sql` を1回実行します。2本のマイグレーションをまとめたファイルです。既存プロジェクトには実行しないでください。

## 1. Supabaseを用意する

1. Supabaseでチーム用プロジェクトを作り、Project URLとpublishable keyを控えます。
2. AuthのAnonymous Sign-Insを有効にします。既存セッションがある場合はSDKが再利用します。公開前にAnonymous Authのレート制限を確認します。CAPTCHAを必須にする場合は、フロント側へのCAPTCHA組み込みも必要です。
3. `supabase/migrations/20260911000000_v14.sql`、`20260911000100_import.sql`の順に適用します。SQL Editor、またはSupabase CLIの`supabase db push`を利用します。既存の同名テーブルがあるDBにはそのまま適用せず、空の移行先を使います。
4. `supabase functions deploy team`と`supabase functions deploy maintenance`でEdge Functionsを配置します。`supabase/config.toml`を使用します。team・maintenanceとも、ダッシュボードの「Verify JWT with legacy secret」はOFFにします。teamは関数内のgetUserで毎回JWTと匿名ユーザーを検証し、maintenanceは専用キーを検証します。旧形式のゲートウェイ検証を無効にしても、関数内の認証は必須です。

Edge FunctionのSecretsに以下を設定します。ローカルで入力する場合はGit管理外の`.env.supabase`を作り、`supabase secrets set --env-file .env.supabase`を実行します。

| 設定 | 内容 |
| --- | --- |
| ADMIN_SETUP_CODE | 初回管理パスワード設定用の十分長いランダム値。管理パスワード移行済みの場合は未使用 |
| MAINTENANCE_KEY | 日次監視・月次整理専用の十分長いランダム値 |
| ALLOWED_ORIGINS | 公開URLのorigin。例 `https://organization.github.io`。複数はカンマ区切り。パス末尾は含めない |
| APP_URL | パスを含む最終公開URL。LINE通知のリンク先 |
| LINE_CHANNEL_ACCESS_TOKEN | 当面はテスト専用LINE Messaging APIのチャンネルアクセストークン |
| LINE_ADMIN_TARGET_ID | 当面はテスト担当者本人のuserId。本番への変更は利用者説明と切り替え指示の後 |

`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`はSupabase Edge環境の予約済み変数です。高権限キーはNuxtの公開設定に入れません。LINEの接続先が未設定でも申請はDBに保存され、管理画面に未処理件数と通知状態が表示されます。

LINEは先にテスト専用アカウントで確認します。本番LINEへの切り替えは利用者への説明後、ユーザーの指示を受けて最後に行います。詳しくは [LINEテスト手順](line-test-setup.md) を参照してください。

## 2. 現在のデータを移す

今回の移行は完了済みです。ローカルの非公開バックアップは `backups/migration-20260912-01.json` に保存しています。再度applyを実行する必要はありません。以下は移行手順の記録です。

移行作業中は旧アプリでの出欠更新を一時停止してもらい、最終エクスポート後に入力が増えないようにします。移行ツールはGASのデータを削除・変更しません（ログインセッションの開始・終了のみ行います）。

Git管理外の`.env.migration`に`GAS_ADMIN_PASSWORD`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`を設定します。GAS URLとAPIキーは既存の`.env`を使います。秘密値をコマンド引数やチャットに貼らないでください。

```sh
node --env-file=.env --env-file=.env.migration scripts/migrate-gas.mjs export backups/snapshot.json
node scripts/migrate-gas.mjs plan backups/snapshot.json
node --env-file=.env.migration scripts/migrate-gas.mjs apply backups/snapshot.json
```

バックアップは選手名と管理パスワードハッシュを含むため、`backups/`はGitから除外し、出力ファイルの権限は600としています。上書きも拒否します。件数と退団者・非表示イベント・過去出欠を確認してから移行します。取り込み先にデータがあれば処理は拒否され、取り込み中に不整合があれば全件をロールバックします。既存IDと管理パスワードを維持します。

GASには端末所有権の記録がありません。移行された選手のowner_idはNULLで開始し、各保護者が名前を入力→再登録申請→管理者承認で端末に紐づけます。誰かが名前を入力しただけで所有権を与えることはしません。承認前も仮回答を保存できます。

## 3. ローカル接続を確認する

`.env`に以下を設定します。値が欠けた本番ビルドは失敗し、実行時にもデモへ自動で切り替わりません。

```dotenv
NUXT_PUBLIC_DATA_BACKEND=supabase
NUXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co
NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NUXT_APP_BASE_URL=/
```

`npm run dev`で動かす場合は`http://localhost:3000`もALLOWED_ORIGINSに追加します。接続先なしで画面を確認するときだけ`NUXT_PUBLIC_DATA_BACKEND=demo`を指定します。旧構成の一時確認には`gas`を指定できますが、GitHub PagesへGASモードを公開するビルドは拒否されます。

## 4. GitHub Pagesを設定する

チームで管理するGitHubリポジトリにソースを配置します。既存`.env`、バックアップ、生成物を含めず、Settings → PagesのSourceをGitHub Actionsにします。

リポジトリのActions Variables：

- `SUPABASE_URL`：Project URL
- `SUPABASE_PUBLISHABLE_KEY`：publishable key（公開前提のクライアントキー）
- `ANON_CLEANUP_ENABLED`：初回確認が済んだら`true`。未設定時の月次処理は候補件数の確認のみ

Actions Secrets：`MAINTENANCE_KEY`。service_roleはPagesのビルドや日次監視に不要です。

`.github/workflows/pages.yml`はmainへのpush時にテスト、型チェック、Nuxt静的生成、Pages公開を実行します。Pagesのbase_pathを使うため、`/repository-name/`以下の公開にも対応します。成果物は`.output/public`のみで、Nuxt server/apiは配置されません。ページ上の通信はSupabase Edge Functionsへ送ります。

旧Sitesの`.openai/hosting.json`は旧公開先の履歴として保持します。最終公開にはSites用ビルドや公開操作を使用しません。GitHubの実URLが確定したらAPP_URLとALLOWED_ORIGINSを設定し、保護者へ新URLを案内します。

## 5. 公開前の確認

ローカルテストはPGlite上のPostgreSQLで、RLSを有効にしanon/authenticated/service_roleを切り替えて実行します。これに加えて、接続後はステージング環境で実APIも確認します。

```sh
npm test
npm run typecheck
npx deno check supabase/functions/team/index.ts supabase/functions/maintenance/index.ts
node --env-file=.env.verification scripts/verify-access.mjs
```

`.env.verification`は`SUPABASE_URL`と`SUPABASE_PUBLISHABLE_KEY`だけを設定します。verify-accessは全6テーブルの直接SELECT/INSERT/UPDATE/DELETEが拒否されることを公開キーと匿名ログイン後の両方で確認し、未参照の匿名テストユーザーを1件作成します。直接テーブル参照は全て禁止し、表示に必要な情報をEdgeから返す方針です。

別ブラウザ2つを使い、次を確認してから切り替えます。

- 初回登録・兄弟登録と、再読み込み後も同じ選手を編集できること
- 他の選手、過去イベント、非表示イベント、退団者を更新できないこと
- 既存名での申請、申請重複の拒否、仮回答と正式回答の分離
- 管理者の承認時に現在・未来の有効な予定だけが反映され、旧端末の更新が拒否されること
- 却下時に正式な回答と所有者が変わらないこと
- 管理ログイン、予定編集、退団・復帰、パスワード変更、既存管理セッションの失効
- LINE通知の受信、失敗時も申請と管理バッジが残ること
- PagesでCSSやアイコンを含めて開き、GASやNuxtサーバーAPIへ通信しないこと

## 6. 定期運用

日次ヘルスチェックは毎日7:17 JSTにEdgeとDBへの到達を1回確認し、失敗時にActionsを失敗扱いにします。最終成功日時はActionsのサマリーで確認します。無料プランの停止回避を保証するものではありません。

月次整理は毎月2日7:37 JSTに、90日以上未使用で現在の選手・申請履歴・管理セッションから参照されない匿名ユーザーを最大100件確認します。初回は候補だけを確認し、`ANON_CLEANUP_ENABLED=true`または手動実行のapply指定で削除を有効にします。候補確定時に新規登録との競合を防ぎ、外部キーでも参照中ユーザーの削除を拒否します。

停止時はSupabase DashboardでResumeし、読み書きと監視を再確認します。Actionsの通知設定とSupabaseの管理者メールを引き継ぎ、プラン条件・規約変更時は監視頻度やプランを見直します。常時可用性が必要になった場合は有料プランを検討します。

## 実装上の判断

- 設計書8.2の直接書き込み禁止と8.5のRLS所有権検証を両立するため、直接DMLはGRANTで拒否し、出欠専用RPCの実行権限だけをauthenticatedへ付与します。RPCは入力検証し、NOBYPASSRLSの専用ロールでauth.uid()を検証します。ブラウザからRPCを直接呼んでも同じ制約を受けます。
- 管理APIと所有権移行はJWT検証済みのEdgeからservice_role専用RPCで行います。管理セッションは1時間、匿名IDにも紐づけます。ブラウザ側管理トークンはメモリのみで、ページの再読み込み時は再ログインします。
- 仮回答は本人画面に承認待ちとして表示し、人数集計には含めません。未回答への変更はNULLの記録で保持し、物理削除を使いません。
- 退団者は現在・未来の一覧から除外し、公開中の過去イベントに回答履歴がある場合だけ履歴表示へ含めます。

参考：[Supabase匿名認証](https://supabase.com/docs/guides/auth/auth-anonymous)、[Edge認証](https://supabase.com/docs/guides/functions/auth)、[GitHub Pagesのカスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Free Planの停止](https://supabase.com/docs/guides/platform/free-project-pausing)。

## 2026年9月12日：画面確認で見つかった保存権限の修正

新規登録した本人の選手でも出欠保存が403となった。専用の検証データで実APIを再現し、`save_own_attendance` が `42501: permission denied for schema auth` を返すことを確認。復旧SQLは `supabase/migrations/20260912000000_writer_auth_permissions.sql`。保存用ロールのauthスキーマUSAGEとauth.uid実行権限のみを補う。テーブル権限・RLS・所有者データは変更しない。

ローカルで同じ権限欠落を再現し、復旧SQL適用後の本人の保存・更新、他人の保存拒否、直接テーブルアクセス拒否、仮回答保存を含むDBテスト17件が成功。クラウドへの修正SQL適用と、その後の実API・画面での再確認は未完了。ユーザーが作成した「画面確認用0912」は操作確認継続用に残している。診断用に追加した別の選手・予定・匿名ユーザーは削除済み。

### 追加診断と代替修正

ユーザーが権限追加を実行した後も、診断SQLでsd_attendance_writerのauth_usage=false、uid_execute=trueを確認。通常のGRANTによる修復が反映されないため、authスキーマへの追加アクセスを必要としない方式へ変更した。`public.attendance_actor_id()` はPostgRESTが認証後に設定するrequest.jwt.claimsのsubのみを参照し、ユーザーIDの引数は受け取らない。関数はSECURITY INVOKER、実行権限は保存用ロールのみ。既存RLSと出欠RPC内のauth.uid呼び出しをこの関数に置き換え、所有者・仮回答・予定・退団の制約を維持する。

適用用ファイル：`supabase/repair-attendance.sql`。全体がトランザクションで、途中失敗時は変更を確定しない。新規環境用setup.sqlにも同じ修正を組み込み済み。既存環境ではsetup.sqlを再実行せず、repair-attendance.sqlのみ使用する。

authスキーマへの保存用ロールのアクセスを明示的に拒否し、PostgREST形式のJWT claimsを使うDBテスト18件が成功。クラウドへの適用と保存再確認は待機中。
