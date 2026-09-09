# South Dragons 出欠確認

Nuxt + Tailwind CSS + DaisyUIで構築した、学童野球チームの出欠管理アプリです。
デモUIに加え、Google Apps Script・Googleスプレッドシートへ接続するコードを実装しています。実際のGoogle環境への設定と接続確認はこれからです。

初期設定は [GAS設定手順](docs/gas-setup.md) を参照してください。

## 起動

Node.js 24 LTS推奨（`.nvmrc`）。Node.js 20では最新Nuxtの必要条件を満たしません。

```sh
nvm install
nvm use
npm ci
npm run dev
```

開発URL: http://localhost:3000 （使用中の場合は起動ログのURLを参照）
同じWi-Fiのスマートフォンからは、起動ログのNetwork URLで確認できます。

### このMacでの保存先と起動

現在のプロジェクトは `/Users/kakimoto_mac/my_app/SouthDragons` です。
ソースと依存パッケージをローカルへ移行済みです。共有ボリュームや一時フォルダへのリンクは使用しません。
古い共有フォルダのソースはバックアップとして残しています。今後の編集はこのローカルフォルダで行ってください。

動作確認には同梱のNode.js 24を使用しています。標準シェルのNode.jsが20の場合は、
上記の `nvm install` / `nvm use` で24へ切り替えてください。
このMacのHomebrew版Node.jsを使用する場合は、次のコマンドで起動できます。

```sh
cd /Users/kakimoto_mac/my_app/SouthDragons
PATH="/opt/homebrew/bin:$PATH" npm run dev
```

GASのデプロイURLは `.env` に設定済みです。`NUXT_GAS_API_KEY` にApps Scriptの
スクリプトプロパティ `API_KEY` の値を入力してからサーバーを再起動してください。
秘密キーはチャットやGitに貼り付けないでください。

```sh
npm run typecheck
npm test
npm run build
```

## 実装済み

- スマートフォン対応。選手名列と日程ヘッダーを固定した横スクロール出欠表
- 名前だけの選手登録、兄弟追加、自分の子どもだけの絞り込み
- 全角・半角スペースを除外した重複確認と既存選手の選択
- ボトムシートによる参加・10時参加・欠席・未回答の変更
- 月の切り替え、今後／過去の予定、予定の詳細
- 参加人数（参加＋10時参加）、10時参加、欠席、未回答の集計
- 管理画面：予定の追加・編集・非表示・再表示、名前の編集、退団・復帰
- GAS側のシート初期化、データ保存、管理認証、パスワード初期設定・変更
- Nuxtサーバー経由の接続、管理Cookie、保存中・通信失敗時の表示
- 退団者の回答履歴保持。過去の一覧は閲覧専用
- ブラウザ内への保存、保存／読み込み失敗時の表示
- キーボード操作、モーダルのフォーカス制御・Escapeで閉じる

## デモについて

環境変数 `NUXT_GAS_WEB_APP_URL` と `NUXT_GAS_API_KEY` が両方未設定の場合だけデモモードになります。

初回は架空の選手12名と、直近の土曜から6件の予定を生成します。
変更は `localStorage` の `south-dragons-demo-v1` に保存します。
別の端末・ブラウザとは共有されません。管理画面もデモ用で、認証は行いません。
本番の個人情報やパスワードを入力する運用は、GAS側の認証と保存API接続後に開始してください。

再度初期状態を確認したい場合は、ブラウザのサイトデータからこのサイトの保存データを削除してください。
削除すると、このブラウザで登録した名前・予定・出欠も初期化されます。

## ファイル構成

- `app/app.vue`: 出欠確認・名前登録・管理画面
- `app/components/AppModal.vue`: ネイティブdialog + DaisyUIの共通モーダル
- `app/composables/useTeam.ts`: デモと共有データの切り替え、GAS接続、端末への選手ID保存
- `app/utils/team.ts`: 型に依存しない集計・名前正規化・サンプル生成・保存データ検証
- `app/types/team.ts`: 選手・イベント・出欠データの型
- `app/assets/css/main.css`: DaisyUIテーマとレスポンシブ表示
- `tests/team.test.ts`: 出欠更新・集計・退団履歴などのテスト
- `gas/Code.gs`: Googleに貼り付けるGASコード
- `server/`: GAS中継APIとパスワードの導出処理
- `tests/gas.test.ts`: GAS実コードをGoogleサービスの代替実装で検証
- `docs/gas-setup.md`: 初期設定・デプロイ・接続確認の手順
- `docs/gas-integration.md`: 実装と運用の開発メモ

## 次の段階

1. 作成済みスプレッドシートからApps Scriptを開き、`gas/Code.gs` を貼り付ける
2. `setupSouthDragons` を実行して4シートを作成する
3. GAS WebアプリのデプロイとNuxtの環境変数設定
4. 初回の管理パスワード設定、別端末を使った保存確認
5. 既存LINE Messaging APIとの連携

接続版にはNode.jsサーバーが必要です。`npm run build` で構築し、`node .output/server/index.mjs` で起動します。
本番はHTTPSとホスティング先の環境変数を使用してください。静的生成コマンドは接続版では使用しないため削除しています。

Supabaseは使用しません。Google上での実行・デプロイ、実スプレッドシートへの保存確認、LINEへの接続、外部公開はまだ行っていません。

## 導入時に参照した公式資料

- [Nuxt Installation](https://nuxt.com/docs/4.x/getting-started/installation)
- [daisyUI for Nuxt](https://daisyui.com/docs/install/nuxt/)
