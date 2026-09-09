# 公開サイトの運用

公開先: https://south-dragons-jbc.sleek-wolf-9937.chatgpt.site

このURLはパソコンの開発サーバーを停止しても利用できます。保護者の出欠入力は既存のGASとスプレッドシートへ保存されます。管理者は既存の共通パスワードでログインします。

## 更新

通常の開発は `npm run dev`、公開用ビルドは `npm run build:sites` を実行します。公開ビルドは `.env.example` を使うため、秘密キーを含みません。Sitesの実行環境に `NUXT_GAS_WEB_APP_URL` と `NUXT_GAS_API_KEY` を秘密値として設定します。

Sitesへの再公開は `.openai/hosting.json` の既存プロジェクトを使用します。公開用出力は `dist/server/index.js` と `dist/client/` です。通常のNodeサーバー用ビルドは引き続き `npm run build` が利用できます。

## 読み込み速度

出欠の取得と保存はGASへの通信完了を待ちます。公開URLの用意だけではGASの処理時間は短縮されません。現在は共有データをキャッシュせず、更新時に取得し直して保存結果を確認できる構成です。

## 端末の選手選択

「自分の選手」の選択はURLごと・端末ごとに記憶されます。公開URLを初めて開いたときは、既に登録済みの選手を選択してください。
