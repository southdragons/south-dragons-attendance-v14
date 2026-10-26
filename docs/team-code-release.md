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
2. **バックアップ**
   - `backups/pg-dump-before-reminder.sh` と同じ方式で取得する。保存先だけ新しいフォルダ（例：`backups/before-team-code-YYYYMMDD/`）に変える。
   - `app.dump` と `auth-data.dump` がそろい、`COMPLETE` と `SHA256SUMS` が作られ、`pg_restore --list` で中身が読めることを確認する。`COMPLETE` がないフォルダは不完全なので使わない。
   - `backups/` はGit管理外。個人情報を含むので、チャット・GitHub・共有フォルダに置かない。
3. **本番の定義がリポジトリと一致することを確認する**
   - バックアップから `public.team_api`、`private.snapshot`、`public.save_own_attendance`、`private.cleanup_candidates` の定義を取り出し、`supabase/migrations/20260913000000_multi_device_access.sql` と比べる（関数本体の区切りが `$_$` になる点に注意）。
   - 一致しなければ **中止**。本番だけに入っている変更が、migrationやロールバックSQLで上書きされてしまうため。
4. **safeupdateの確認**：本番では、API経由の `DELETE` / `UPDATE` に `WHERE` が必須（Supabaseの `safeupdate`）。今回のSQLは `tests/sql-safeupdate.test.ts` で確認済み。

## 2. 反映の順序（段階ごとに止めて確認する）
| 段階 | 作業 | 利用者への影響 | 確認すること |
|---|---|---|---|
| 1 | **DB**：`20261023000000_team_code.sql` の内容をSQL Editorに貼り付けて1回実行（全体が1つのトランザクション） | なし（閲覧制限・スパム対策とも無効） | `private.team_code` が `enforcement='off'`、`private.feature_flags` の `abuse_limits` が `false`。今の画面で、出欠の入力と申請の承認ができる |
| 2 | **関数**：`supabase functions deploy team --project-ref cuhkjnuwozgnqqqvqhnl --use-api --no-verify-jwt` | なし（今の画面は新しい操作を使わない） | 関数一覧で `team` だけバージョンが上がり、他の関数は変わらない。今の画面がそのまま動く |
| 3 | **画面**：`feat/team-code` のPRをmainにマージ → `pages.yml` が公開サイトを作り直す | なし（制限が無効なのでコード入力画面は出ない） | 公開サイトが新しい版になり、通常の画面が動く。管理画面に「チームコード」が出る |
| 4 | **管理者**：コードを発行し、必要ならスパム対策を有効にする | なし | 管理者のテスト端末でコードを入力できる |
| 5 | **閲覧制限を有効にする**（保護者への案内と同時に） | 閲覧だけの端末にコード入力画面が出る。出欠を入力できる端末はそのまま | 保護者の端末で確認。問題があれば、すぐ無効に戻す |

- **DBより先に関数をデプロイしない。** 新しい関数は、新しいDB側の処理を前提にしている。
- 段階3はmainへのマージで自動的に公開される。段階1・2を済ませてからマージする。

## 3. 止める条件と復旧
| 段階 | 止める条件 | 復旧 |
|---|---|---|
| 1 | SQLがエラーになる | 何も確定しない（トランザクション）。原因を調べる |
| 1 | 適用後、今の画面で出欠の入力・承認ができない | 4のロールバック（手順2だけ） |
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
