# menus-data

家族向けメニューボード（Muse アーティファクト）が自分では取りに行けない、
全13チェーン分のメニューデータを置く公開データ置き場です。
タベカル系の8チェーンはタベカルAPIで商品を取得し公式画像を付与、
タベカル未収録の5チェーンは各公式サイトから直接取得します。

## 内容

- `menus.json` — 13チェーン分の期間限定メニュー（商品名・価格・画像URL・公式リンク）
  - 対象: びっくりドンキー / マクドナルド / ガスト / バーミヤン / ジョイフル /
    なか卯 / スシロー / 夢庵 / かつや / からやま / ココス / 伝説のすた丼屋 / 丸源ラーメン
  - 形式: `{ "generated_at": ISO文字列, "chains": { "<slug>": { "name": 表示名, "items": [...] } } }`
  - GitHub Pages 経由で公開: https://pugyon.github.io/menus-data/menus.json
- `fetch-direct-menus.mjs` — タベカルAPIと各公式サイトから取得して `menus.json` を生成する
  スタンドアロンスクリプト（Node 20、外部依存なし）。
  取得ロジックは [pugyon/Menus](https://github.com/pugyon/Menus) の同期処理から移植。
  画像は前回生成された `menus.json` をキャッシュとして引き継ぎ、不足分だけを新規に解決する。

## 更新

GitHub Actions（`.github/workflows/update-menus.yml`）が毎週金曜 10:00 JST に
自動実行され、`menus.json` に差分があればコミットします。手動実行も可能です。
