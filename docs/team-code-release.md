# チームコード 本番反映・復旧手順

対象：`supabase/migrations/20261023000000_team_code.sql` と、`team` 関数・画面のチームコード対応
本番：Supabase `cuhkjnuwozgnqqqvqhnl` / GitHub Pages
運用者向けの操作は `docs/team-code-admin.md`、保護者向けは `docs/team-code-parents.md`。

## 0. 使わないコマンド
| コマンド | 理由 |
|---|---|
| `supabase db push`、`db reset --linked`、`--prune` | 過去のmigrationはSQL Editorで適用している。既存のmigrationから再実行・削除されるおそれがある |
| 関数名を付けない `supabase functions deploy` | `attendance-reminder` などの関数まで再デプロイされる |
| `supabase link` | 不要。毎回 `--project-ref` を付ける |

欠席通知（`attendance-reminder`、GitHub Actions、Secrets）は、この反映では触りません。

## 1. 反映前の準備
1. **今の版を記録する**
   - `git rev-parse main` の結果（マージ前のmainのコミット）を控える。復旧時に、前の `team` 関数と画面をこのコミットから取り出す。
   - `supabase functions list --project-ref cuhkjnuwozgnqqqvqhnl` の結果（各関数のバージョンと更新日時）を控える。
2. **バックアップ**（手順の詳細と範囲は `docs/db-backup-restore.md`）
   - `bash scripts/db-backup.sh before-team-code` で取得し、`bash scripts/db-backup.sh --verify backups/<YYYYMMDD>-before-team-code` が `OK` になることを確認する。
   - `OK` にならない、または `COMPLETE` がないフォルダは不完全なので使わない。反映は中止する。
   - `backups/` はGit管理外。個人情報と認証情報を含むので、チャット・GitHub・共有フォルダに置かない。
3. **本番の定義がリポジトリと一致することを確認する**
   - バックアップから `public.team_api`、`private.snapshot`、`public.save_own_attendance`、`private.cleanup_candidates` の定義を取り出し、`supabase/migrations/20260913000000_multi_device_access.sql` と比べる（関数本体の区切りが `$_$` になる点に注意）。
   - 一致しなければ **中止**。本番だけに入っている変更が、migrationやロールバックSQLで上書きされてしまうため。
4. **safeupdateの確認**：本番では、API経由の `DELETE` / `UPDATE` に `WHERE` が必須（Supabaseの `safeupdate`）。今回のSQLは `tests/sql-safeupdate.test.ts` で確認済み。

## 2. 反映の順序（段階ごとに止めて確認する）
| 段階 | 作業 | 利用者への影響 | 確認すること |
|---|---|---|---|
| 1 | **DB**：`20261023000000_team_code.sql` の内容をSQL Editorに貼り付けて1回実行（全体が1つのトランザクション） | なし（閲覧制限・スパム対策とも無効） | `private.team_code` が `enforcement='off'`、`private.feature_flags` の `abuse_limits` が `false`。今の画面で一覧が表示され、管理画面にログインできる。**「この端末の利用を申請する」は押さない**（2-1） |
| 2 | **関数**：`supabase functions deploy team --project-ref cuhkjnuwozgnqqqvqhnl --use-api --no-verify-jwt` | なし（今の画面は新しい操作を使わない） | 関数一覧で `team` だけバージョンが上がり、他の関数は変わらない。今の画面がそのまま動く |
| 3 | **画面**：`feat/team-code` のPRをmainにマージ → `pages.yml` が公開サイトを作り直す | なし（制限が無効なのでコード入力画面は出ない） | 公開サイトが新しい版になり、通常の画面が動く。管理画面に「チームコード」が出る |
| 4 | **管理者**：コードを発行し、必要ならスパム対策を有効にする | なし | 管理者のテスト端末でコードを入力できる |
| 5 | **閲覧制限を有効にする**（保護者への案内と同時に） | 閲覧だけの端末にコード入力画面が出る。出欠を入力できる端末はそのまま | 保護者の端末で確認。問題があれば、すぐ無効に戻す |

- **DBより先に関数をデプロイしない。** 新しい関数は、新しいDB側の処理を前提にしている。
- 段階3はmainへのマージで自動的に公開される。段階1・2を済ませてからマージする。

### 2-1. LINE通知を送らないための注意
- **端末共有の申請（画面の「この端末の利用を申請する」、`requestRegistration`）を1回行うと、既存の通知の仕組みで、管理者のLINEに1通送られます。** 本番には `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_ADMIN_TARGET_ID` が登録されています（送信先が誰かは未確認）。この仕組みは今回の変更でも変わりません。
- LINEが送られるのは、この申請だけです。次の操作では送られません：チームコードの入力、選手の登録、出欠の入力、申請の承認・却下、端末の取り消し、コードの発行・変更、閲覧制限・スパム対策の切り替え。
- スパム対策を有効にすると、申請の通知は1時間に10件・1日に30件までになり、超えた分は送らずに記録だけします（`throttled`）。
- 欠席通知（`attendance-reminder`）は、この反映では触りません。本番宛ての送信用Secretsは未登録で、定時実行も無効のままです。

本番の通知先に送らずに確かめる方法：
1. **申請と通知の流れは、ローカル環境で確かめる。** ローカルの関数にはLINEのSecretsを入れていないため、申請しても送られず、通知の状態は `unconfigured` になる。申請 → 承認 → 共有端末からの入力までを、ここで確認する。テストも同じ流れ（申請・承認・通知の上限）を確認している（`tests/team-code.test.ts`、`tests/team-code-rollback.test.ts`）。
2. **本番では、申請を伴わない確認だけを行う。** 一覧の表示、管理画面へのログイン、チームコードの入力、閲覧制限の切り替え。承認待ちの本物の申請があれば、承認・却下は通常の運用として行ってよい（LINEは送られない）。
3. **送っていないことの確認。** 段階1の前と、段階5の後に、SQL Editorで次を実行し、`sent` の件数が増えていないことを確かめる（保護者からの本物の申請があった場合を除く）。
   ```sql
   select notification_status, count(*) from public.re_registration_requests group by 1 order by 1;
   ```
4. LINEのSecretsや送信先を、確認のために変更・削除しない。

## 3. 止める条件と復旧
| 段階 | 止める条件 | 復旧 |
|---|---|---|
| 1 | SQLがエラーになる | 何も確定しない（トランザクション）。原因を調べる |
| 1 | 適用後、今の画面で一覧が表示されない、管理画面に入れない | 4のロールバック（手順2だけ） |
| 2 | 関数のデプロイ後に今の画面がエラーになる | 1-1で控えたコミットの `team` 関数を再デプロイ（4の手順3）。DBはそのままでよい |
| 3 | 公開サイトに問題がある | マージを取り消すコミット（revert）で、`pages.yml` を再実行する |
| 4〜5 | 保護者が入れないなど | 管理画面で「閲覧制限を無効にする」。すぐに今までの状態に戻る。たいていはこれで足りる |
| 任意 | 機能そのものを外したい | 4のロールバックを全部 |

## 4. ロールバック（機能を外すとき）
ロールバックSQL：`supabase/rollback/20261023000000_team_code_down.sql`

**データは削除しません。** 選手・予定・出欠・端末共有（`player_access`）・申請・管理者のログイン状態・設定・欠席通知の記録は、そのまま残ります。チームコードの表（`private.team_code` / `team_members` / `feature_flags`）も残し、使わない状態にします。変わるのは次だけです。
- `team_api`、`snapshot`、`save_own_attendance` の3つが、前の版の定義に戻る（`admin_sessions` の削除に `where true` を付けた点だけが違う。safeupdateで失敗しないため）。
- 閲覧制限とスパム対策のスイッチが無効になる。

この順で行います。どの段階でも、出欠の入力は今までどおりできます。
1. 管理画面で「閲覧制限を無効にする」。
2. SQL Editorで、ロールバックSQLを1回実行する（何回実行しても同じ結果）。
3. 前の `team` 関数をデプロイする。
   ```bash
   git worktree add ../sd-previous <1-1で控えたコミット>
   cd ../sd-previous && supabase functions deploy team --project-ref cuhkjnuwozgnqqqvqhnl --use-api --no-verify-jwt
   ```
4. 画面を戻す（マージを取り消すコミットで `pages.yml` を再実行）。

### 戻したあとで、もう一度反映するとき
- migrationをもう一度実行すると、コード・入力済みの端末・取り消した端末の記録が元どおりになり、スイッチは無効の状態で始まる。
- ロールバック中に出欠を入力できるようになった端末（新しく選手を登録した端末など）は、再反映時に「閲覧できる端末」に自動で追加される。
- 前のコードは引き続き有効。漏れた心配があれば、閲覧制限を有効にする前に「新しいコードに変更」する。

## 5. 新しい環境を作るとき
`supabase/setup.sql` は、`supabase/migrations` を順に適用したのと同じ結果になる（`writer_auth_permissions` はSupabaseでは何もしないため省略）。空のプロジェクトにだけ実行する。`tests/setup-sql.test.ts` で一致を確認している。

## 6. 確認済みのこと・未確認のこと
確認済み（ローカルのみ・架空のデータ）：
- PGlite：migration適用 → ロールバック → 全テーブルの内容が一致、前の流れ（閲覧・登録・端末共有・管理者）が動く、再反映で機能が戻る（`tests/team-code-rollback.test.ts`）。
- ローカルのSupabase：前の `team` 関数（mainの版）を、ロールバック後のDBで動かして確認。12テーブルの内容が一致。

未確認：本番の `safeupdate` の設定、本番の関数実行環境とIPヘッダー、実機（iPhoneのホーム画面アプリ、LINEから外部ブラウザ）での動作。
