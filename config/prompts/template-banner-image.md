
タスク:
添付画像のバナー広告を分析し、そのビジュアルを再現するための画像生成プロンプトテンプレートをJSON形式で直接出力してください。

処理フロー（内部で実行、中間出力は不要）:
1. 画像の構成要素（レイアウト色彩人物テキスト配置エフェクト等）を読み取る
2. 固有情報をプレースホルダーに置換し、レイアウト設計図とコピー設計図を分離して抽出する
3. 以下のJSON構造で出力する

変数化ルール(最重要: 商品固有の具体情報は漏れなく変数化する):
テキスト要素(content)内の「別商品に差し替えたら変わる具体情報」はすべて置換する。
特に見落としがちな **固有名詞・成果・価格・割引** を必ず変数化すること。
- 商品・サービス・提供元: {商品名} {サービス名} {ブランド名} {会社名}
- 固有名詞(人名地名施設名媒体名受賞名): {固有名詞}(役割が明確なら {権威者} {媒体名} {地名})
- ターゲット・悩み: {ターゲット} {悩み}
- 成果・実績値(「累計◯万本」「満足度98%」等): {成果} {実績数}
- 数値全般: {数値}。期間は {期間}
- 価格・オファー: {価格} {通常価格} {割引率} {割引額} {特典} {保証}
- 商品の特徴・成分・機能・利用場面: {特徴} {成分} {機能} {利用場面}
- ベネフィット・欲求・不安・比較対象・選定理由: {ベネフィット} {欲求} {不安} {比較対象} {選定理由}
- 権威性・社会的証明・口コミ: {権威者} {受賞名} {メディア名} {口コミ} {評価}

単に文字列を置換するだけでなく、各要素が広告内で果たす役割を抽出すること。
- コピーは hook/problem/empathy/solution/benefit/reason-to-believe/proof/offer/cta/disclaimer のいずれかを中心役割として付ける。
- 画像は product/usage-scene/person/result-metaphor/authority/logo/decoration のいずれかを中心役割として付ける。
- 「なぜこの位置・大きさ・順序なのか」「次に何を読ませるか」をcontentArchitectureに記録する。
- variableDefinitionsには、画像内で使った全プレースホルダーを重複なく列挙し、差し替え元と制約を記録する。
- zones の text 要素には必ず charCount を入れる。charCount は、画像内でその要素が実際に持っていた元画像の原文の文字数（改行・空白除く）。プレースホルダー置換後のcontentの文字数ではない。
- zones の text 要素には originalText と copyPattern も入れる。originalTextは元画像に見えている文言、copyPatternは固有語をプレースホルダー化した構文。
- sourceCategoryProfileには、元バナーのカテゴリ、想定顧客、悩み、解決策タイプ、購買文脈を記録する。不明な項目は空文字にする。
- copyBlueprintは、文言そのものとは別に、心理メカニズム、修辞、メッセージ順、各コピー枠の文字数を記録する。
- copyBlueprint.slotsには required / sourcePolicy / emptyPolicy を必ず入れる。hook/problem/solution/benefit等の中核枠は原則 required=true, emptyPolicy=block。proof/offer/cta/disclaimer等は、生成先WHO-WHATに対応情報がない場合に埋め草を作らないよう原則 required=false, emptyPolicy=allow とする。
- sourcePolicyは、WHO-WHATだけを使う枠は strategy_required、追加指示の明示内容を優先できるoffer/cta等は instruction_or_strategy とする。

維持するもの(変数化しない):
- CTA（コメント保存いいね等）はそのまま残す
- 感情を動かすフレーズ言い回しは維持
- 構成流れは完全に維持
- 画像構成レイアウトは設計図として記録する。色彩は参照元の観察値として記録するが、生成先へ引き継ぐ前提にしない

出力フォーマット:
冒頭に導入文や説明文は一切不要。JSON本体のみを出力。
画像に存在しない要素は省略し、存在する要素はすべて記載すること。
zonesは画像の実際のレイアウトに合わせて必要な数だけ作成すること。
各zone内のelementsも画像内の要素数に忠実に従うこと。

必須JSON構造:
{
  "basic": { "aspectRatio": "", "size": "" },
  "contentArchitecture": {
    "appealType": "",
    "messageFlow": [],
    "primaryHook": { "role": "", "pattern": "", "targetResponse": "" },
    "proofStrategy": { "type": "", "placement": "", "purpose": "" },
    "offerStrategy": { "type": "", "urgencyDevice": "", "ctaRole": "" },
    "visualHierarchy": [],
    "eyeFlow": ""
  },
  "sourceCategoryProfile": {
    "category": "", "subcategory": "", "audience": "", "problem": "",
    "solutionType": "", "purchaseContext": "", "keywords": []
  },
  "layoutBlueprint": {
    "visualHierarchy": [], "eyeFlow": "", "zones": []
  },
  "copyBlueprint": {
    "sourceCategoryProfile": {},
    "persuasionMechanism": {
      "appealType": "", "primaryHookMechanism": "", "targetResponse": "",
      "messageFlow": [], "proofRole": "", "offerRole": ""
    },
    "slots": [
      {
        "slotId": "z1e1", "role": "headline", "messageRole": "hook", "charBudget": 18,
        "required": true, "sourcePolicy": "strategy_required", "emptyPolicy": "block",
        "originalText": "元画像に見える原文", "pattern": "{他の解決策}で満足していませんか？",
        "variables": ["{他の解決策}"], "rhetoricalDevice": "問いかけ",
        "psychologicalMechanism": "現状手段への不満を自覚させる"
      }
    ]
  },
  "variableDefinitions": [
    {
      "placeholder": "{ベネフィット}",
      "category": "strategy",
      "role": "benefit",
      "source": "選択WHO-WHAT",
      "constraints": "元要素と同程度の文字数。選択WHO-WHATにない断定をしない",
      "exampleOriginal": "画像内に存在した原文"
    }
  ],
  "globalDesign": {
    "style": "", "tone": "", "targetImpression": "",
    "fontPolicy": { "primary": "", "secondary": "", "note": "" },
    "spacingPolicy": { "overall": "", "margin": "", "elementGap": "" },
    "contrastPolicy": { "level": "", "note": "" },
    "visualStyle": { "type": "", "mood": "", "note": "" },
    "gridAlignment": { "horizontal": "", "vertical": "", "note": "" },
    "designRationale": ""
  },
  "colorScheme": {
    "main": "#XXXXXX", "sub": "#XXXXXX", "accent": "#XXXXXX", "background": "#XXXXXX",
    "usage": { "main": "", "accent": "", "background": "" },
    "designNote": ""
  },
  "zones": [
    {
      "name": "",
      "position": "",
      "purpose": "",
      "background": "",
      "elements": [
        {
          "type": "text",
          "role": "",
          "messageRole": "hook/problem/empathy/solution/benefit/reason-to-believe/proof/offer/cta/disclaimer",
          "content": "",
          "originalText": "",
          "copyPattern": "",
          "charCount": 0,
          "position": { "top": "", "left": "" },
          "size": "",
          "font": "",
          "color": "#XXXXXX",
          "effect": ""
        },
        {
          "type": "image",
          "role": "",
          "messageRole": "product/usage-scene/person/result-metaphor/authority/logo/decoration",
          "description": "",
          "position": { "top": "", "left": "" },
          "size": "",
          "effect": ""
        },
        {
          "type": "shape",
          "role": "",
          "description": "",
          "position": { "top": "", "left": "" },
          "size": ""
        }
      ]
    }
  ],
  "reproduction": { "keyPoints": [], "colorToneNote": "", "layoutNote": "" }
}

zonesの各elementはtype(text/image/shape)ごとに上記の項目のみを使うこと。roleは見た目上の役割、messageRoleは広告メッセージ上の役割を表す。roleはtextなら headline/subheadline/body/cta/caption/label等、imageなら photo/icon/illustration/logo/decoration等、shapeなら border/separator/badge/frame等から画像の実態に合わせて選ぶこと。
