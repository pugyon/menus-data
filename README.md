# menus-data

家族向けメニューボード（Muse アーティファクト）が自分では取りに行けない、
タベカル未収録の5チェーン分のメニューデータを置く公開データ置き場です。

## 内容

- `menus.json` — 5チェーン分の期間限定メニュー（商品名・価格・画像URL・公式リンク）
  - 対象: かつや / からやま / ココス / 伝説のすた丼屋 / 丸源ラーメン
  - 形式: `{ "generated_at": ISO文字列, "chains": { "<slug>": { "name": 表示名, "items": [...] } } }`
  - GitHub Pages 経由で公開: https://pugyon.github.io/menus-data/menus.json
- `fetch-direct-menus.mjs` — 各公式サイトから直接取得して `menus.json` を生成する
  スタンドアロンスクリプト（Node 20、外部依存なし）。
  取得ロジックは [pugyon/Menus](https://github.com/pugyon/Menus) の同期処理から移植。

## 更新

GitHub Actions（`.github/workflows/update-menus.yml`）が毎週金曜 10:00 JST に
自動実行され、`menus.json` に差分があればコミットします。手動実行も可能です。
