export const regulationExcelFixtures = {
  standardSingleSheet: {
    fixtureFileName: "standard-single-sheet.xlsx",
    fileName: "standard-single-sheet.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sheets: [
      {
        name: "表現レギュレーション",
        rows: [
          ["種別", "NG表現", "推奨表現", "備考"],
          ["NG", "絶対に治る", "改善を目指す", "効果保証を避ける"],
          ["指定", "", "個人差があります", "注記を併記する"]
        ]
      }
    ]
  },
  multipleSheetsAndHeaderVariants: {
    fixtureFileName: "multiple-sheets-header-variants.xlsx",
    fileName: "multiple-sheets-header-variants.xlsx",
    mimeType: "application/vnd.ms-excel.sheet.macroenabled.12",
    sheets: [
      {
        name: "NGワード",
        rows: [
          ["禁止語", "言い換え案", "理由"],
          ["必ず痩せる", "健康的な体づくりを支援", "断定表現を避ける"]
        ]
      },
      {
        name: "必須注記",
        rows: [
          ["分類", "表示文言", "掲載箇所"],
          ["価格", "送料が別途必要です", "価格訴求の近く"]
        ]
      }
    ]
  },
  blankRowsNotesAndNumbers: {
    fixtureFileName: "blank-rows-notes-numbers.xlsx",
    fileName: "blank-rows-notes-numbers.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sheets: [
      {
        name: "料金・注記",
        rows: [
          ["ルール", "値", "注記"],
          ["初回価格", 880, "税込・送料550円は別途"],
          [],
          ["割引率上限", 20, "%表記では条件を併記"],
          ["継続回数", 0, "購入回数の縛りなし"],
          [],
          ["自由記述", "※個人差があります", "画像内にも表示"]
        ]
      }
    ]
  }
};
