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
