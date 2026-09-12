# LINE通知のテストと本番切り替え

## 今回の進め方（2026年9月12日）

ユーザーの指示により、既存の監督・コーチ向けLINEには接続しない。
テスト専用のLINE公式アカウントとMessaging APIチャネルを使い、最初の送信先は担当者本人の個人LINEとする。
利用者への説明を終え、ユーザーから本番切り替えの指示を受けてから、最後の工程として本番LINEへ切り替える。

## テスト設定

1. テスト専用のLINE公式アカウントを作成する（既存のテスト用アカウントがあれば使用可能）。名称例：South Dragons 出欠テスト。
2. LINE Official Account Managerの設定から、そのアカウントのMessaging APIを有効にする。
3. LINE Developersでテストチャネルを開き、Messaging API設定のチャネルアクセストークンと、チャネル基本設定の「あなたのユーザーID」を取得する。
4. 担当者本人のLINEでテスト公式アカウントを友だち追加する。
5. Git管理外の `.env.line-test` にテスト用のトークンとユーザーIDを保存する。秘密値はチャットやGitHubに貼らない。
6. 接続先がテスト公式アカウントであることをAPIで確認し、担当者本人に「テスト」と明記した通知を送る。APIが受け付けたことと、スマートフォンで受信できたことを別々に確認する。
7. テスト接続先をSupabaseのEdge Function Secretsへ設定する。`LINE_TEST_CHANNEL_ACCESS_TOKEN` は `LINE_CHANNEL_ACCESS_TOKEN` へ、`LINE_TEST_USER_ID` は `LINE_ADMIN_TARGET_ID` へ対応させる。ローカルのテスト設定ファイルをそのままアップロードしない。
8. テスト専用の選手名で再登録申請し、通知・仮回答・承認・却下の動作を確認する。実在する選手の所有権はテスト目的で変更しない。

現在実装されているLINE通知は「再登録申請が届いたときの管理者通知」。通常の出欠変更や一斉リマインドの通知はこの処理には含まれない。
現在の公開アプリとSupabaseで通知連携を試す場合、LINEの接続先のみテスト用になる。アプリ・DB全体を複製した環境ではない。

## 本番切り替え（保留）

テスト完了、利用者への説明、ユーザーからの切り替え指示の順に進める。
その後に本番用のチャネルと送信先を確認し、Secretsの変更、受信確認を行う。
本番のトークンや送信先を先行して登録しない。

## 公式資料

- https://developers.line.biz/ja/docs/messaging-api/getting-started/
- https://developers.line.biz/ja/docs/messaging-api/building-bot/
- https://developers.line.biz/ja/docs/messaging-api/getting-user-ids/

## ユーザーID取得方法の変更（2026年9月12日）

本人のLINEは別のビジネスIDに連携済みで、テスト開発者アカウントにはユーザーIDが表示されない。このため既存連携の解除・変更を行わず、署名検証付きの一時Webhookで取得する。

- 関数：`supabase/functions/line-test-webhook/index.ts`（作成・ローカルテスト・クラウド配置済み）
- 秘密設定：Git管理外の `.env.line-webhook`。`LINE_TEST_CHANNEL_SECRET` だけユーザーが入力。他の値はテストアカウント @603zltgp のAPI情報とランダム確認コードから生成済み。
- 配置時は関数名 `line-test-webhook`、JWT検証OFF。LINEのHMAC署名を関数内で検証する。
- Secrets設定後、テストチャネルのWebhook URLを `https://cuhkjnuwozgnqqqvqhnl.supabase.co/functions/v1/line-test-webhook` に設定する。既存Webhookがあれば用途を確認してから変更する。
- 本人からテスト公式アカウントとの個人トークに確認コードを送ると、IDを非公開settingsの `line_test_capture` に1回だけ保存する。グループ・別コード・別ボット・不正署名は保存しない。メッセージ本文やIDをログに出さず、自動返信もしない。
- 保存後はローカルのservice_roleでIDとbotIdを照合し、`.env.line-test` にIDを設定する。テスト通知の受信を確認する。
- 取得後はWebhook利用をOFFにして一時受信を終了する。設定した期限でも受信を停止する。作業が期限を過ぎた場合は、配置前に期限を更新する。

署名不正・他チャネル・期限切れ・コード不一致・グループ・保存失敗を含むDenoテスト6件が成功。その後、クラウドでのWebhook受信と単体通知送信も確認済み（以下を参照）。

### Webhook受信と単体送信の結果（2026年9月12日）

テスト用Webhookを配置し、有効な署名は200、不正署名は401となることを確認。本人の個別トークから確認コードを受信し、テストボットのIDと受信ユーザーIDを照合した。取得IDはGit管理外の `.env.line-test` に保存済み。テスト通知1通を送信し、LINE APIはHTTP 200で受け付けた。本人端末での受信もユーザーが確認済み。

次の作業：単体通知の受信確認が完了したため、`.env.line-notification-test` の2設定をSupabase Secretsへ追加し、再登録申請による通知を確認する。このファイルのトークンと宛先はテスト用のみ。ユーザーID取得用のWebhook利用はOFFにして終了する。本番LINEへの切り替えは引き続き保留。

### アプリからの申請通知の結果（2026年9月12日）

ユーザーがテスト用LINEの2設定をSupabase Secretsへ登録し、ユーザーID取得用Webhook利用をOFFにしたと報告。
専用のテスト選手と2つの匿名ユーザーを作り、team APIの再登録申請を実行した。通知状態sent、重複申請時の同一申請維持、管理者画面用APIでの申請取得と却下処理が成功。テスト用申請・選手・匿名ユーザーは終了後に削除し、既存のplayers/events/attendanceの全レコードが検証前後で一致することを確認した。

単体通知は本人が受信確認済み。アプリの再登録申請通知については、通知状態sentを確認し、本人の受信確認待ち。本番LINEへは切り替えていない。現在のアプリで再登録申請すると、通知はテスト用公式アカウントから担当者本人へ送られる。
