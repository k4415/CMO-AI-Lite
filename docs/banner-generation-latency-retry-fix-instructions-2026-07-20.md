# バナー制作レイテンシ・不要再生成 修正指示書

> **対象リポジトリ:** `/Users/koukamiyoshihiko/CMO-AI-Lite-main`
>
> **作成日:** 2026-07-20
>
> **状態:** 実装・実画像検証済み。実装前指示書のセルフレビューは95/100、P0/P1なし。実装結果は「18. 実装・検証結果」に記録する。
> **実装時必須:** `superpowers:test-driven-development` と `implementation-self-review-loop` を適用し、各PhaseをRED→GREEN→自己レビューの順で進める。

## 1. Goal

ユーザーが選択したロゴ・商品画像を必ず画像生成へ渡し、テンプレの閉じた構造とコピー固定を維持したまま、次の不要な待ち時間を削減する。

1. ロゴが生成画像内に存在するのに、固定OCR領域から外れたことだけで画像を丸ごと再生成する。
2. 確定済み`mainHook`がモデル出力のzoneにないとき、同じStage 2設計をAIへ丸ごと再依頼する。
3. 同じ契約情報を文章とJSONで重複送信し、Stage 2入力を過度に肥大化させる。
4. テキスト生成のAPI試行回数が保存されず、1回の遅い応答と内部再試行を区別できない。

目標は、品質条件を緩めず、同等条件の3テンプレ比較で制作時間中央値を現状比20%以上短縮することである。外部APIの変動があるため、絶対時間だけで完了判定しない。

## 2. Architecture

`copyplan → prompt → image` の3ノードは維持する。

```text
copyBrief確定
  → Stage 2入力を正規化・圧縮
  → gpt-5.5を原則1回だけ呼ぶ
  → 既存text slotへ確定コピーを決定論的に再適用
  → promptJson / promptText保存
  → gpt-image-2
  → コピーOCR + ロゴ検証
      ├─ 合格: 完了
      ├─ 確認不能・位置不確定: 警告完了、再生成しない
      └─ ロゴ欠落を確認: 1回だけロゴ特化編集
```

画像への文字・ロゴの後載せや機械合成は行わない。ロゴ修復が必要な場合も、最初の生成画像と選択ロゴ原本を`gpt-image-2`の画像編集入力として渡し、画像生成モデル内で一体生成する。

## 3. 診断根拠

ローカルに保存された直近実行を匿名化して比較した結果、以下を確認した。

- 過去8件の工程時間合計平均は約5分48秒だった。
- 直近3件は約10分09秒〜13分58秒で、約2倍になっていた。
- copyplanは43〜48秒であり、主な遅延箇所ではなかった。
- promptは220〜342秒で、過去平均約104秒より遅かった。
- 直近2件はロゴ判定`missing`により画像生成を2回実行していた。
- 2回生成したケースでは、画像工程だけで約6分15秒、約9分32秒かかった。
- 生成画像を目視すると、選択ロゴは表示されていたが、ロゴ枠なしテンプレ用の固定OCR領域と実配置がずれていた。
- 1件では画像全体OCRに正式ワードマークが存在したが、固定OCR領域だけが不一致となり再生成された。
- 画像レスポンス後のOCR・保存は約1秒程度で、今回の主要な遅延原因ではなかった。
- ローカルUI/APIは即時応答しており、待ち時間の大半は外部AI API応答と不要な再呼び出しだった。

個別案件名、商品名、バナーID、画像、案件JSONは本書へ記載せず、Git管理対象にも追加しない。

## 4. 優先仕様と既存文書との関係

本書は速度改善に関して、次の既存仕様を維持する。

- `docs/superpowers/specs/2026-07-20-selected-assets-template-override-design.md`
  - ユーザー選択素材はテンプレ構造より優先する唯一の例外。
  - 選択素材はすべて画像生成へ渡す。
  - 未選択素材は追加しない。
- `docs/banner-template-closed-structure-fix-instructions-2026-07-20.md`
  - 選択素材以外のtext / image / shape / zoneを追加しない。
- `docs/banner-logo-wordmark-fidelity-fix-instructions-2026-07-20.md`
  - 正式ワードマークを部分語へ短縮しない。
  - 明示的なテンプレlogo slotでは、その領域内で厳格に確認する。

ただし、ロゴ枠のないテンプレへ選択素材例外でロゴを配置した場合に限り、旧来の「単一固定領域だけをOCRし、不一致なら再生成」という規則を本書で更新する。例外配置では生成モデルが位置をずらすことがあるため、単一固定領域をロゴ欠落の十分条件にしない。

文書間の優先順位は次のとおりとする。

1. ユーザーが確定した「選択素材だけをテンプレ構造より優先する例外」
2. `2026-07-20-selected-assets-template-override-design.md`
3. 本書のレイテンシ・検証・retry規則
4. それ以前のclosed-structure / logo指示書

したがって、旧closed-structure指示書にある「画像slotがなければ、選択素材があってもエラー停止する」規則は廃止済みであり、再導入しない。closed-structureは「未選択要素を増やさない」「既存slotの型・数・zoneを変えない」範囲へ適用する。実装時に旧指示書へsuperseded注記を加える。

## 5. Non-negotiable constraints

- `copyplan → prompt → image`の3ノードを増減しない。
- 事実DBをバナー生成時に読み込まない。
- 確定`copyBrief`をStage 2で書き換えない。
- テンプレの閉じた構造を維持し、選択素材以外の要素追加を許可しない。
- 選択したロゴ・商品画像・その他画像はすべて`gpt-image-2`へ渡す。
- 未選択素材を推測生成しない。
- HTML、CSS、Python、Pillow、canvas、スクリーンショット等でロゴや文字を後載せしない。
- gpt-image-2は`quality: "medium"`を維持し、速度目的で画質を下げない。
- デフォルトの`gpt-5.5`を、速度目的だけで別モデルへ変更しない。
- UIの素材選択方法と通常の画面表示を変更しない。
- 個別案件データをGitへ追加しない。
- 外部APIを使う有料実画像テストは、実行前にユーザーの許可を得る。

## 6. Target behavior

### 6.1 ロゴ検証モード

ロゴ検証はバナー単位ではなく、選択ロゴ1件ごとに、テンプレ側の明示logo slotへ割り当てられたかで分ける。テンプレlogo slotはzone順・element順、選択ロゴは`buildBannerInputImageManifest()`のordinal順に並べ、先頭から1対1で割り当てる。slot数を超えた選択ロゴだけを`selected_asset_override`とする。

例: テンプレlogo slotが1件、選択ロゴが2件なら、ordinal 1は`template_slot`、ordinal 2は`selected_asset_override`であり、バナー全体をどちらか一方のモードにしない。

#### A. `template_slot`

テンプレ構造に`type=image`かつ`role/messageRole=logo`のslotが存在する場合。

- そのslot領域を厳格な検証領域とする。同一zone・同一行に、`role/messageRole=logo/brand`の隣接text要素がある場合は、ロゴ画像とブランド名が一体の複合ロゴであるため、両矩形の和集合を1つの検証領域とする。本文や別zoneまでは拡張しない。
- 本文や別領域のブランド名は合格根拠にしない。
- slot領域に正式ワードマークがなく、領域OCRの信頼度が75以上なら`missing`とする。OCR信頼度が75未満の不一致は、生成画像の欠落を確定できないため`not_verifiable`、`reason=template_slot_ocr_low_confidence`とする。
- `missing`の場合のみ、1回だけロゴ特化編集を実行する。

#### B. `selected_asset_override`

テンプレにlogo slotがなく、ユーザー選択素材の例外として配置した場合。

- promptJsonに保存した推奨領域だけでなく、四隅・上端・下端の候補領域を検査する。
- 正式ワードマークが候補領域のいずれかにあれば`verified`とする。
- 候補領域では一致せず、画像全体OCRだけで一致した場合は`present_unlocalized`とする。
- `present_unlocalized`は`completed_with_warnings`とし、自動再生成しない。
- OCR結果が空またはOCR失敗なら`not_verifiable`とし、自動再生成しない。
- 候補領域と画像全体の両方で正式ワードマークが検出されなくても、`selected_asset_override`ではOCR不在だけを根拠に`missing`としない。`not_verifiable`、`reason=ocr_absence_unconfirmed`として警告完了し、自動再生成しない。

画像全体OCR一致だけで`verified`にはしない。本文の商品名をロゴと誤認する可能性があるためである。また、保存済み実例ではロゴが目視できても全体OCRが正式ワードマークを読めないケースがある。したがって、例外配置でOCR不在をロゴ欠落の十分条件にもせず、高コストな誤再生成を避ける。

候補領域は実装者判断で増やさず、次の順で決定論的に作る。

1. `selectedLogoFallbackElements()`がpromptJsonへ保存した推奨領域
2. 左上・右上・左下・右下の4隅
3. 上端・下端の横長領域

同一矩形は座標正規化後に重複排除し、OCR領域は画像全体とは別に最大8件までとする。選択ロゴが複数ある場合は、1領域を複数ロゴの根拠として使い回さず、正式ワードマークごとに異なる一致領域を割り当てる。上限超過時は推奨領域を最優先し、残りを上記順で切り詰める。新しいAI画像認識APIは追加しない。

ここでいう`verified`は「正式ワードマーク全文を、ロゴ候補として妥当な領域でOCR確認できた」という意味であり、原本と生成画像のピクセル同一性、書体、シンボル形状まで保証するものではない。選択素材の忠実性は入力契約で担保し、最終的な造形忠実性は有料実画像テストの目視レビューで確認する。OCRだけで「原本ロゴ完全再現」と過大評価しない。

### 6.2 判定表

| verification mode | region evidence | full OCR | status | 自動再生成 |
| --- | --- | --- | --- | --- |
| template_slot | 全文一致 | 任意 | verified | しない |
| template_slot | 不一致・OCR信頼度75以上 | 任意 | missing | 1回だけ |
| template_slot | 不一致・OCR信頼度75未満 | 任意 | not_verifiable (`template_slot_ocr_low_confidence`) | しない |
| template_slot | OCR不能 | 任意 | not_verifiable | しない |
| selected_asset_override | 候補領域で全文一致 | 任意 | verified | しない |
| selected_asset_override | 候補領域不一致 | 全文一致 | present_unlocalized | しない |
| selected_asset_override | 候補領域不一致 | 全文不一致、OCR有効 | not_verifiable (`ocr_absence_unconfirmed`) | しない |
| selected_asset_override | OCR不能 | 任意 | not_verifiable | しない |

照合は`normalizeLogoWordmark()`によるNFKC・空白・記号除去後の完全包含を使う。短い部分語、編集距離だけの近似一致、商品名の一部一致は合格にしない。

`logoVerification.items[]`へロゴごとの`assetOrdinal`、`mode`、`status`、`reason`、`evidenceRegionIds`を保存する。集約statusは次の優先順位で決める。

1. `template_slot`に`missing`が1件でもあれば`missing`
2. `present_unlocalized`が1件でもあれば`present_unlocalized`
3. `not_verifiable`が1件でもあれば`not_verifiable`
4. 全件が`verified`なら`verified`

`missing`によるロゴ特化編集では、missingとなったロゴordinalを修正対象として明記する。他の選択ロゴ・商品画像は保持対象として入力へ残し、再配置や削除を指示しない。既存の集約フィールド`required`、`expected`、`missing`、`observed`、`regions`は後方互換のため維持する。

### 6.3 ロゴ欠落時の2回目処理

1回目が`template_slot`モードでロゴだけ`missing`となり、コピーがgross mismatchではない場合、2回目はバナー全体の新規生成ではなくロゴ特化編集とする。`selected_asset_override`はOCR不在だけで`missing`を確定できないため、自動の2回目へ進めず、既存のユーザー操作による再生成・修正境界へ残す。

入力順:

1. 1回目の生成画像（編集元）
2. 選択された正式ロゴ原本
3. 必要な場合だけ、元から選択されていた商品・その他素材

編集指示:

- ロゴ以外の文字、人物、商品、背景、レイアウトを維持する。
- 正式ロゴ原本を指定領域または最小限の空き領域へ表示する。
- ロゴを文字で打ち直さず、原本の全文・比率・色を維持する。
- 新しい装飾・アイコン・文字・画像を追加しない。

コピーのgross mismatchが同時に起きている場合は、現行の短縮リカバリープロンプトを維持し、ロゴ特化編集へ分岐しない。

2回目も`missing`なら3回目を実行せず、`completed_with_warnings`で保存する。

実装では`buildLogoRecoveryInputImages()`のような回復専用helperを設ける。1回目出力を`role=current-banner`として先頭へ追加するが、これは2回目の編集元であり、ユーザー選択素材や`selectedAssetPolicy`へ追記しない。2回目以外のprompt生成・画像生成入力にも流さない。1回目の画像は削除せず、既存の生成バージョンとして保持する。監査には編集元画像のhashと、ロゴ原本を含む入力manifestのhashだけを保存し、ローカル絶対パスは保存しない。

回復用入力を組んだ後、`validateLogoRecoveryEditRequest()`でgpt-image-2 Image Editsの現行入力個数・形式・サイズ制約を送信前に検証する。制約値は実装時点の[OpenAI公式Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)とAPI referenceで再確認し、1箇所の定数・validatorへ集約する。1回目出力の追加で上限を超える場合、ユーザー選択素材を落として空きを作ってはならない。自動2回目を実行せず、`completed_with_warnings`、`code=LOGO_RECOVERY_INPUT_LIMIT`として保存する。

### 6.4 Stage 2のAI呼び出し回数

通常のStage 2設計は、1バナーにつきモデル設計呼び出し1回を原則とする。

- `copySlotPlan.slots`に`canonicalField=mainHook`のslotがある場合だけ、mainHook配置を必須にする。
- テンプレにmainHook slotがない場合、mainHook不足を理由にAIを再呼び出ししない。
- mainHook不足が再呼び出しの直接原因だが、補正はmainHookだけへ限定しない。モデル応答の正規化後に、確定`copyBrief.slotTexts`に存在する全slotを、同じ`slotId`の既存text elementへ決定論的に再適用する。
- 新しいtext elementやzoneを追加しない。
- 閉じたテンプレで、`copySlotPlan`上のrequired slot自体が`templateStructureContract`から消えている場合は、AIを再呼び出しせず`PROMPT_TEMPLATE_SLOT_MISSING`で停止する。テンプレ未選択・既存fallback modeにはこのエラー条件をそのまま適用しない。

HTTP 408 / 429 / 5xxに対する`openai-text.js`内部再試行は別枠とし、最大2回の既存予算を維持する。

## 7. 保存する監査データ

### 7.1 `promptGenerationAudit`

`banner-creatives.json`へ任意フィールドとして保存する。

```json
{
  "version": 1,
  "model": "gpt-5.5",
  "startedAt": "...",
  "completedAt": "...",
  "inputChars": 32000,
  "inputHash": "sha256:...",
  "outputChars": 12000,
  "modelDesignCalls": 1,
  "outcome": "completed",
  "httpAttempts": [
    {
      "designCall": 1,
      "httpAttempt": 1,
      "startedAt": "...",
      "completedAt": "...",
      "durationMs": 120000,
      "status": 200,
      "requestId": "req_...",
      "outcome": "response_received",
      "retryReason": ""
    }
  ],
  "deterministicRepairs": ["mainHook_slot_reapplied"]
}
```

保存禁止:

- APIキー
- Authorization header
- プロンプト本文
- AI応答本文
- 商品・戦略の生データ複製

既存の`pipelineNodes.prompt.durationMs`は維持し、`promptGenerationAudit`は内訳として追加する。旧バナーのフィールド未設定を正常値として読み込む。

監査の所有境界を次のように固定する。

- `openai-text.js`: HTTP attemptの開始・終了・status・request ID・retry reasonを通知する。
- `openAiJson()`: HTTP成功後のJSON parse / schema validation結果を`response_received` / `parse_failed` / `completed`として通知する。
- `generateBannerCreativeProposal()`: 1回のStage 2設計呼び出しとdeterministic repairを集約し、成功時はproposalとauditを同じ戻り値で返す。
- `generateBannerPromptWithGuidance()`: 成功時のauditをbanner保存patchへ渡す。
- `banner-store.js`のprompt失敗経路: timeout、最終HTTP失敗、JSON parse失敗でも、それまでに収集したpartial auditをfailure patchへ保存する。

監査収集のためにAI関数を再呼び出してはならない。例外にpartial auditを非列挙プロパティで付ける、または明示的なcollectorを上位から渡すなど、既存の成功戻り値を壊さない方式を採用する。`completedAt`は最終成功時、`failedAt`は失敗時だけ保存し、途中応答を成功扱いしない。

成功時は既存proposalの同階層へ任意の`promptGenerationAudit`を追加し、既存フィールドを包む新しいwrapper型には変更しない。`normalizeBanner()`へ任意objectとして明示追加し、保存→再読込で失われない回帰テストを置く。

### 7.2 `imageGenerationAudit`

既存フィールドを拡張する。

```json
{
  "version": 1,
  "model": "gpt-image-2",
  "selectedAttempt": 1,
  "attempts": [
    {
      "attempt": 1,
      "requestId": "req_...",
      "promptHash": "sha256:...",
      "durationMs": 220000,
      "outcome": "accepted",
      "logoVerificationStatus": "present_unlocalized",
      "logoVerificationItems": [
        {
          "assetOrdinal": 1,
          "mode": "selected_asset_override",
          "status": "present_unlocalized",
          "reason": "full_ocr_only",
          "evidenceRegionIds": []
        }
      ],
      "fullImageWordmarkObserved": true,
      "retryDecision": "skip_present_unlocalized"
    }
  ]
}
```

既存のtop-level `version` / `model` / `selectedAttempt` / `attempts`と、attempt内のrequest ID、prompt hash、試行時間は維持する。ロゴ特化編集時だけ、attemptへ`sourceImageHash`と`inputManifestHash`を追加する。絶対パスや入力画像本体は保存しない。

## 8. Prompt compacting

Stage 2入力は意味を減らさず、重複表現を削減する。

### 8.1 単一入力契約

`buildBannerDesignInput()`を追加し、次だけを1つのJSONとして構築する。

- 商品識別情報
- 選択WHO-WHAT
- 確定copyBrief
- copySlotPlan
- templateStructureContract
- selectedAssetPolicy
- approvedClaimSnapshot参照
- creativeHypothesis
- 表現レギュレーション
- 短縮したdiversity references

閉じたテンプレでは、`templateZones`、`layoutBlueprint.zones`、`templateStructureContract`を同時に重複送信しない。構造の正は`templateStructureContract`へ一本化する。

### 8.2 既存コピーの短縮

`summarizeExistingCopies()`は最大20件のcopyBriefと画像テキストを渡している。Stage 2の重複回避に必要な情報だけへ縮小する。

- 最大8件
- `variationAxis`
- `mainHook`
- 主要なvisual style / image role
- candidate identity

slotTexts全文、proof、disclaimer、長いvisual directionは渡さない。

### 8.3 サイズゲート

固定fixtureで、Stage 2のsystem + user入力文字数を変更前比30%以上削減する。削減のために契約項目を落とさず、同一意味の重複だけを除く。

固定の絶対上限だけに依存しない。テンプレ複雑度で必要量が変わるため、変更前snapshotとの比率をテストする。

## 9. 実装手順

### Phase 0: ベースラインと監査を先に固定する

対象:

- Modify: `src/core/openai-text.js`
- Modify: `src/core/banner-ai.js`
- Modify: `src/core/banner-store.js`
- Modify: `docs/data-model.md`
- Create: `tests/banner-prompt-audit.test.js`
- Modify: `tests/openai-text-retry.test.js`

REDテスト:

1. HTTP 429→200で2試行を監査できる。
2. request ID、status、duration、retry reasonを保存する。
3. 監査へプロンプト本文・APIキーを保存しない。
4. modelDesignCallsとHTTP attemptsを別々に数える。
5. 旧バナーの`promptGenerationAudit`未設定を読み込める。
6. HTTP 200後のJSON parse失敗を`parse_failed`として保存できる。
7. timeout・最終HTTP失敗でもpartial auditがbannerの失敗patchへ残る。

実装:

- `fetchOpenAiTextWithRetry()`へ任意の`onAttempt` callbackを追加する。
- `openAiJson()`へ任意のaudit collectorを渡せるようにする。
- 既存callerの戻り値と挙動を変えない。
- `generateBannerCreativeProposal()`で設計呼び出し単位の監査を集約する。
- `generateBannerPromptWithGuidance()`から成功時auditを返し、`banner-store.js`でbannerへ保存する。
- prompt失敗経路でもpartial auditを保存してから既存のfailed遷移を行う。

Phase 0だけを先に導入する。正式な速度比較を行う場合は、ユーザーから有料API実行の許可を得て、同一条件の3テンプレ×2回、計6枚のbaselineを記録してからPhase 1〜3へ進む。許可を得られない場合もPhase 1〜3の決定論的修正とmockテストは進められるが、速度改善率は「未計測」とし、過去の匿名化3件を正式baselineへ代用しない。

### Phase 1: ロゴ誤再生成を止める

対象:

- Modify: `src/core/logo-identity.js`
- Modify: `src/core/banner-ocr.js`
- Modify: `src/core/openai-image.js`
- Modify: `tests/logo-identity.test.js`
- Modify: `tests/banner-ocr-region.test.js`
- Modify: `tests/openai-image-retry.test.js`
- Modify: `tests/banner-warning-completion.test.js`

REDテスト:

1. 明示logo slotでは、本文に正式名があってもslot不一致なら`missing`。
2. 選択素材例外では、固定推奨領域から外れても別の候補領域で正式名を検出すれば`verified`。
3. 候補領域不一致・全体一致は`present_unlocalized`となり再生成しない。
4. OCR不能は`not_verifiable`となり再生成しない。
5. 選択素材例外では候補領域・全体の両方で読めなくても`not_verifiable`となり、2回目を実行しない。
6. 明示logo slotでロゴだけ欠落した2回目は、1回目生成画像とロゴ原本を使う画像編集になる。
7. gross copy mismatchは従来の全体リカバリーを維持する。
8. 2回目も欠落なら警告完了し、3回目を呼ばない。
9. `present_unlocalized`は既存warning経路を使い、`type=logo_mismatch`、`code=LOGO_LOCATION_UNVERIFIED`として保存する。warning本文で「全文は確認できたがロゴ候補領域で確認できない」と区別し、画面構造や素材選択UIは変えない。
10. 複数ロゴでは、同一OCR領域を2ロゴの合格根拠に使い回さない。
11. 候補領域が8件を超えてもOCR呼び出しが上限内である。
12. `not_verifiable`かつ`reason=ocr_absence_unconfirmed`は警告完了し、ユーザーの再生成・修正操作を妨げない。
13. logo slot 1件・選択ロゴ2件では、1件目が`template_slot`、2件目が`selected_asset_override`となり、ロゴごとに判定される。
14. `present_unlocalized`と`ocr_absence_unconfirmed`のwarning / reviewNotesを「ロゴ欠落」と断定せず、目視確認が必要な状態として保存する。
15. 回復用入力がAPI上限を超える場合、選択素材を削らず、APIを呼ばずに`LOGO_RECOVERY_INPUT_LIMIT`で警告完了する。

互換要件:

- `verified` / `missing` / `not_verifiable`の旧データを読める。
- 既存の`logoVerification.required`、`expected`、`observed`、`regions`を削除しない。
- 新しい`items`未設定の旧データは、従来の集約statusをそのまま利用する。
- UIは既存の警告表示経路を利用し、新しい選択画面を増やさない。

### Phase 2: Stage 2の丸ごと再呼び出しを除去する

対象:

- Modify: `src/core/banner-ai.js`
- Modify: `src/core/banner-copy-slots.js`（必要な純粋helperだけ）
- Modify: `tests/banner-prompt-json.test.js`
- Modify: `tests/banner-diversity.test.js`
- CreateまたはModify: `tests/banner-design-call-count.test.js`

REDテスト:

1. mainHook slotがあるとき、モデルが欠落させても既存slotへ確定文言を再適用する。
2. proposal generatorの呼び出しは1回である。
3. mainHook slotがないテンプレで再呼び出ししない。
4. text element / zone / slotIdの個数を増やさない。
5. required slot自体が欠落した契約不整合は`PROMPT_TEMPLATE_SLOT_MISSING`になる。
6. mainHook以外を含む全`copyBrief.slotTexts`が同じslotIdへ再適用される。
7. copyBrief hashとprompt pipeline hashの整合が維持される。
8. テンプレ未選択のfallback modeへ閉じたテンプレ専用エラーを誤適用しない。

実装:

- 現行`runDesign(retryReason)`によるmainHook再実行分岐を削除する。
- `copyBrief.slotTexts`をslotIdで既存text elementへ再適用する純粋関数を追加する。
- 既存の閉じた構造補正後に実行する。
- 補正内容を`promptGenerationAudit.deterministicRepairs`へ記録する。

### Phase 3A: Stage 2の構造入力を一本化する

対象:

- Modify: `src/core/banner-ai.js`
- Modify: `src/core/banner-store.js`
- Modify: `config/prompts/banner.md`
- Create: `tests/banner-prompt-size.test.js`
- Modify: `tests/banner-prompt-json.test.js`
- Modify: `tests/banner-generation-contract.test.js`（該当テストがある場合）

REDテスト:

1. 閉じた構造の正が1つだけ含まれる。
2. selectedAssetPolicy、copyBrief、WHO-WHAT、表現規制が欠落しない。
3. 正規化後promptJsonのzone / element / slotIdが変更前の契約と一致する。

### Phase 3B: diversity referencesを短縮する

Phase 3Aのテストと全体テストがPASSしてから別コミットで進める。対象ファイルはPhase 3Aと同じとし、次をREDテストへ追加する。

1. 既存コピー参照は8件以下かつ必要な短縮項目だけになる。
2. 固定fixtureの入力文字数がPhase 0で保存した変更前snapshot比30%以上小さい。
3. 同じfixtureで`selectedAssetPolicy`、copyBrief、WHO-WHAT、表現規制、templateStructureContractのhashがPhase 3Aから変わらない。

### Phase 4: 並列数を計測してから決める

コード上の既定値:

```text
CMOAI_PROMPT_CONCURRENCY=10
CMOAI_IMAGE_CONCURRENCY=10
```

実行環境で上書きされる可能性があるため、サーバー起動時にAPIキー等を含まない形で実効prompt/image concurrencyを1回だけログへ記録する。新しい並列制御変数を増やさず、既存環境変数で次を比較する。

| profile | prompt | image |
| --- | ---: | ---: |
| current | 10 | 10 |
| conservative | 3 | 2 |
| balanced | 4 | 3 |

同じ3テンプレ、同じWHO-WHAT、同じ選択素材、同じ追加指示で比較する。外部APIの時間帯変動を抑えるため、profile順を固定せず、`current→balanced→conservative`と逆順を交互に実行する。個別時間だけでなく「3件すべてが完了するまでのbatch makespan」を主指標にし、provider request IDと実効並列数を比較記録へ残す。既定値の変更は、同じ条件の2巡以上でmakespan中央値が改善し、失敗・retry率が悪化しない場合だけ行う。

並列数を下げれば必ず速くなるとはみなさない。結果が同等または悪化なら既定10を維持する。

この比較は3 profile×3テンプレ×2巡で最低18枚の有料生成になるため、6枚の機能smokeとは別の明示承認を得る。承認がない場合はPhase 4をスキップし、既定並列数を変更しない。Phase 4はPhase 0〜3Bの機能完了条件には含めない。

## 10. 自動テストと静的確認

対象テスト:

```bash
node --test \
  tests/logo-identity.test.js \
  tests/banner-ocr-region.test.js \
  tests/openai-image-retry.test.js \
  tests/banner-warning-completion.test.js \
  tests/openai-text-retry.test.js \
  tests/banner-prompt-audit.test.js \
  tests/banner-design-call-count.test.js \
  tests/banner-prompt-size.test.js \
  tests/banner-prompt-json.test.js \
  tests/banner-diversity.test.js
```

全体:

```bash
npm test
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-text.js
node --check src/core/banner-ai.js
node --check src/core/banner-store.js
node --check src/core/banner-ocr.js
node --check src/core/logo-identity.js
node --check src/core/openai-image.js
git diff --check
```

データ汚染確認:

```bash
git status --short
git check-ignore projects/LOCAL_PROJECT_SLUG/data/banner-creatives.json
```

`LOCAL_PROJECT_SLUG`は実際のローカル案件slugへ置き換えて実行する。個別案件JSON、生成画像、APIキー、ローカル設定がGit差分に含まれていないことを確認する。

## 11. 実データ・実画像検証

### 11.1 無料で行う再現テスト

有料APIを呼ぶ前に、正式な自動テストはブランド非依存の合成OCR文字列・合成manifest・最小promptJson fixtureで構成する。個別案件の画像・JSON・ブランド名はfixtureへコピーしない。

加えて、開発者のローカル確認に限り、保存済み成果物のパスを引数で受け取るread-only replayを任意実行できるようにする。replayは入力を変更せず、診断結果を標準出力へ出すだけとし、出力・絶対パス・案件名をGitへ保存しない。次を確認する。

- ロゴが固定推奨領域外にある既存画像で、不要な2回目を選ばない。
- 画像全体だけで正式名が見つかる場合は`present_unlocalized`になる。
- 明示logo slotの不一致は、本文に正式名があっても`missing`のままである。
- 既存の監査データを新しい正規化関数で読める。

### 11.2 有料実画像テスト

ユーザー承認後、修正後の機能smokeとして次の3パターンを各2回、合計6枚生成する。案件固有名は検証記録で匿名化し、画像と案件JSONをコミットしない。これはPhase 4の並列A/Bとは別枠である。

1. 画像枠なし・選択素材なしの文字中心テンプレ
2. 明示logo slotあり・ロゴのみ選択したテンプレ
3. logo slotなし・ロゴ＋商品画像を選択したテンプレ

各生成で確認する。

- 選択ロゴ・商品画像が画像へ反映されている。
- 未選択素材、追加画像、追加アイコン、追加shape、追加textがない。
- zone / element / slotIdが閉じた構造契約と一致する。
- 確定コピーが意図どおり表示される。
- `modelDesignCalls=1`。
- HTTP retriesと画像retryの理由が監査から判別できる。
- ロゴが見えているのに`missing`となる誤再生成がない。
- 警告完了と制作失敗を混同しない。

## 12. Performance evaluation

### 12.1 必須の決定論的ゲート

- Stage 2の通常`modelDesignCalls`が必ず1。
- mainHook不足によるAI再呼び出しが0。
- 保存済み誤再生成ケースで画像retryが0。
- 明示logo slotでロゴの真の欠落を確認したケースだけ画像retryが1。
- 選択素材例外のOCR不在だけを理由にした画像retryが0。
- 画像retry上限が合計2attemptのまま。
- 固定fixtureでStage 2入力が30%以上縮小。
- 選択素材・閉じた構造・コピー固定の全テストがPASS。

### 12.2 実測目標

速度改善率を判定する場合は、Phase 0 baseline 6枚と修正後6枚の計12枚を、同じテンプレ、WHO-WHAT、選択素材、追加指示、batch size、可能な限り同じ時間帯で比較する。修正後6枚だけを実行した場合、機能品質は判定できるが改善率は主張しない。前後比較は外部provider変動を完全には統制できないため、request ID、HTTP attempts、input chars、画像attemptsを併記し、観測値として報告する。比較では次を目標とする。

- end-to-end中央値が変更前同条件比20%以上短縮。
- prompt中央値が180秒以内、または変更前同条件比25%以上短縮。
- 不要な画像2回目が0件。
- 3テンプレすべて品質レビューPASS。

外部API変動により絶対時間を満たさなくても、決定論的ゲートがPASSし、API待機時間が監査で説明できる場合は「機能修正PASS・速度目標は追加観測」と分けて報告する。12枚でもp95改善を主張しない。p95は20件以上蓄積後に評価する。

## 13. Rollout and rollback

変更は1コミットへまとめず、次の単位で検証可能にする。

1. 監査追加のみ
2. ロゴ判定・ロゴ特化編集
3. mainHook決定論補正
4. prompt構造入力の一本化
5. diversity references短縮
6. 実測で有効だった場合だけ並列既定値変更

各Phaseで対象テストと全体テストを通す。問題が出た場合、直前Phaseだけを戻せる状態を維持する。

- 監査フィールドは任意なので、旧コードでも無視できる。
- 新しいlogo statusを旧UIが表示できない場合も、`productionStatus=completed_with_warnings`とwarning本文で確認可能にする。
- prompt圧縮で品質差が出た場合、単一入力契約は維持したまま必要項目だけを戻し、旧プロンプト全文へ一括回帰しない。
- 並列数の変更は環境変数で即時に元へ戻せる。

## 14. Out of scope

- copyplanのコピー品質ロジック変更
- WHO-WHAT生成ロジック変更
- UIの素材選択画面変更
- 画像品質を`low`へ下げる変更
- デフォルトテキストモデルの変更
- ロゴや文字の後処理合成
- 事実DBのバナー生成入力化
- テンプレ構造の緩和
- ロゴ以外の商品画像に対する新しいAI画像認識API追加
- 定期実行、`/loop`、`/schedule`の登録

## 15. Completion criteria

次のすべてを満たした場合だけ実装完了とする。

1. Phase 0〜3BのRED→GREEN記録がある。
2. 対象テスト、全テスト、構文確認、`git diff --check`がPASS。
3. その時点の`data/ad-templates.json`に存在する全テンプレの構造不変テストがPASSし、対象件数を実行結果へ記録している。
4. 保存済み誤再生成ケースの読み取り専用replayがPASS。
5. ユーザー承認後の3テンプレ実画像レビューがPASS。
6. 個別案件データと生成画像がGit差分に含まれない。
7. 実装セルフレビューが90/100以上で、P0/P1が0件。
8. 速度目標を満たすか、未達理由を監査データで説明している。
9. 変更した設計に合わせ、旧文書の「例外ロゴは単一固定領域のみで判定する」記述へ更新注記を追加する。
10. 旧closed-structure文書の「画像slotがなければ選択素材をエラー停止する」記述へ、selected-assets overrideで廃止済みの注記を追加する。

## 16. 指示書セルフレビューループ

本書は一度きりの成果物なので`/loop`や`/schedule`を起動しない。最大3回の有限レビューを行う。

終了条件:

- P0/P1指摘が0件
- 総合90/100以上
- 実装対象、テスト、受入基準、ロールバック、課金境界、データ除外がすべて明記されている

採点:

| 観点 | 配点 |
| --- | ---: |
| 原因と修正の整合 | 20 |
| 既存仕様・品質要件の維持 | 20 |
| 実装可能性 | 20 |
| テスト・検証可能性 | 20 |
| ロールバック・運用安全性 | 10 |
| 明瞭性 | 10 |

レビュー履歴は最終版へ記録する。

## 17. Review history

### Round 1

- 評価: **86/100**
  - 原因と修正の整合 18/20
  - 既存仕様・品質要件の維持 17/20
  - 実装可能性 16/20
  - テスト・検証可能性 17/20
  - ロールバック・運用安全性 9/10
  - 明瞭性 9/10
- P0: 0件
- P1: 4件
  1. 候補OCR領域・複数ロゴ・OCR上限が未定義だった。
  2. ロゴ特化編集の1回目出力を、ユーザー選択素材と混同する余地があった。
  3. prompt監査の成功・parse失敗・最終失敗の保存経路が曖昧だった。
  4. 性能比較が外部APIの時間帯変動を十分統制していなかった。
- 更新:
  - 候補領域の順序、最大8件、複数ロゴの根拠分離、OCRの保証限界を明記した。
  - 回復専用入力manifestと`role=current-banner`の境界を追加した。
  - auditの所有者、outcome、partial audit失敗保存を追加した。
  - Phase 3を3A/3Bへ分離し、baselineと交互順A/Bを追加した。

### Round 2

- 評価: **88/100**
  - 原因と修正の整合 19/20
  - 既存仕様・品質要件の維持 17/20
  - 実装可能性 17/20
  - テスト・検証可能性 18/20
  - ロールバック・運用安全性 9/10
  - 明瞭性 8/10
- P0: 0件
- P1: 3件
  1. 例外配置で全体OCRもロゴを読めない実例に対し、OCR不在を`missing`としており、誤再生成が残っていた。
  2. template logo slot数より選択ロゴ数が多い混在ケースの割当が未定義だった。
  3. 修正後6枚smoke、前後12枚比較、並列18枚A/Bの課金境界が混在していた。
- 更新:
  - 例外配置はOCR不在だけで`missing`にせず、`ocr_absence_unconfirmed`として警告完了するよう変更した。
  - ロゴごとの検証mode、1対1割当、集約status、missing対象ordinalを定義した。
  - image auditを既存の`attempts[]`構造に合わせ、混在ケースの回帰テストを追加した。
  - 機能smoke 6枚、速度前後比較12枚、任意の並列A/B 18枚を分離し、それぞれ事前承認を必須化した。

Round 3では、現行コードの関数名・保存schema・テストコマンドとの機械的整合と、P0/P1が0件であることを最終確認する。

### Round 3（最終）

- 評価: **95/100**
  - 原因と修正の整合 20/20
  - 既存仕様・品質要件の維持 19/20
  - 実装可能性 19/20
  - テスト・検証可能性 19/20
  - ロールバック・運用安全性 9/10
  - 明瞭性 9/10
- P0: 0件
- P1: 0件
- P2（既知の限界）:
  1. OCRは正式ワードマーク文字の観測であり、原本ロゴとのピクセル同一性を保証しない。入力契約と目視smokeを併用する。
  2. 外部AI APIのレイテンシは完全統制できない。決定論的call削減と監査を完了条件にし、速度改善率は承認済み有料前後比較を実行した場合だけ報告する。
- 最終更新:
  - 選択素材overrideと旧closed-structure文書の優先順位を明記した。
  - 回復用入力がImage Edits制約を超える場合の安全停止を追加した。
  - shell placeholderを実行可能な表記へ直し、image auditを現行`attempts[]` schemaへ合わせた。
- 機械確認:
  - 文書内の既存ファイル参照はすべて存在した。
  - Markdown code fenceは偶数で閉じている。
  - `git diff --check`はPASSした。
  - 関連する既存回帰テストは72件PASS、0件失敗だった。
  - 個別案件名、案件slug、バナーID、画像、案件JSONは本書へ含めていない。

終了条件の「90/100以上」「P0/P1なし」「実装対象・テスト・受入基準・ロールバック・課金境界・データ除外の明記」を満たしたため、本版を確定版とする。

## 18. 実装・検証結果

### 18.1 実装した変更

- Stage 2の論理的なAI再呼び出しを廃止し、確定`copyBrief.slotTexts`を既存text slotへ決定論的に再適用するようにした。
- Stage 2入力を単一JSON契約へ集約し、既存コピー参照を最大8件へ短縮した。
- テキストAPIのHTTP試行・request ID・所要時間・parse結果と、画像APIのretry判断を監査データへ保存した。
- 選択ロゴを`template_slot` / `selected_asset_override`へ1対1で割り当て、例外配置のOCR不在では自動再生成しないようにした。
- 真の`template_slot`ロゴ欠落だけを、最初の生成画像と全選択素材を入力にした1回限りのロゴ特化editへ分岐した。
- 同一zoneのロゴ画像枠と隣接ブランド名textを一つの複合検証領域として扱った。
- 複合領域の低信頼OCR誤読は`not_verifiable`へ落とし、高信頼の明確な別表記だけを`missing`とした。
- prompt claim時の開始node未指定と、copyplan失敗時のnode保存にあった実テスト由来の不整合を修正した。

### 18.2 決定論的検証

- `npm test`: **355件PASS、0件FAIL**。
- 全100広告テンプレの閉じた構造テストがPASSした。
- Stage 2は実テスト6案すべて`modelDesignCalls=1`、HTTP attempt 1回だった。
- Stage 2入力は約16,585〜18,507文字で、固定legacy fixture比30%以上の短縮条件を満たした。
- 低信頼OCRの保存済み誤再生成画像を読み取り専用replayし、`confidence=58`、`status=not_verifiable`、`reason=template_slot_ocr_low_confidence`となり、再生成条件から外れることを確認した。
- 高信頼の部分表記`TEETH`は`missing`のまま維持する回帰テストを追加した。

### 18.3 実画像smoke

隔離した検証案件で、次の3パターンから合計6枚のgpt-image-2出力を確認した。検証案件・生成画像はGit管理対象外であり、既存の個別案件データは変更していない。

1. 画像枠なし・選択素材なしのメモ帳風テンプレ: 2枚とも、追加画像・ロゴ・人物・追加装飾なしで、元のメモUI構造と確定コピーを維持した。
2. 明示logo slotあり・ロゴのみ選択したテンプレ: 初回画像と旧判定によるロゴ特化edit画像の2枚とも、正式な全文ロゴと閉じた構造を目視確認した。旧判定の不要edit原因は、ロゴ画像枠だけをOCRして隣接ブランド名textを含めていなかったことと、低信頼誤読を欠落と断定していたことだった。修正後の読み取り専用replayで不要retryが止まることを確認した。
3. logo slotなし・ロゴ＋商品画像を選択したテンプレ: 2枚とも選択ロゴと商品素材を反映し、未選択の人物画像を追加しなかった。OCRではロゴ位置を確定できず`not_verifiable`だったが、仕様どおり各1attemptで警告完了し、目視で正式ロゴを確認した。

有料画像API試行は事前に定めた上限6回で停止した。速度改善率の前後比較12枚は実行していないため、20%以上の改善率は主張しない。今回確認できたのは、不要retryの決定論的排除、Stage 2の1設計call化、監査可能性、3テンプレの生成品質である。外部Anthropicのcopyplan timeoutが1回発生したが、同一入力の再実行で成功し、失敗nodeと再開地点が正しく保存されるよう修正した。

### 18.4 最終セルフレビュー

- 構文確認: `src/server.js`、`src/ui/app.js`、指定AIモジュール、変更したOCR・ロゴ・画像モジュールがすべてPASS。
- `git diff --check`: PASS。
- ローカル確認: このcheckoutを`http://localhost:5175/`で起動し、ルートと`/api/projects`がHTTP 200。
- Claude Review Board smoke: Claude Code 2.1.205は検出できたが、Opus smokeが`401 Invalid authentication credentials`で終了した。認証エラーは再試行対象外のため外部boardをスキップし、correctness / requirements / verification / riskの4観点をCodexで厳格再レビューした。
- 厳格再レビュー: P0/P1 0件。低信頼OCRを欠落扱いしない一方、高信頼の明確な部分表記は不一致のままとし、ロゴ忠実性と課金抑制の境界を維持した。検証案件はignore配下、既存個別案件の最終更新時刻は今回の隔離テスト開始前であり、Git差分にも含まれない。
- 最終スコア: **9.3/10**（correctness 2.8/3、reliability 1.8/2、quality 1.7/2、verification 2.0/2、operability 1.0/1）。外部boardの具体的なskip理由を記録し、必須しきい値8.5を満たした。
