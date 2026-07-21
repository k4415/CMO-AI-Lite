export const DEFAULT_STRATEGY_MARKDOWN = `### 仮説\x20

**戦略コンセプト:**


**ターゲット属性:**
-\x20
-\x20

**欲求:**
-\x20
という欲求を満たしたい。

**判断基準:**
-\x20
-\x20
を満たすものがいい。

**想定競合:**
-\x20
-\x20
とは異なり、

**商品コンセプト:**
「」
なら、

**USP:**
-\x20
-\x20
という特徴があるから、

**ベネフィット:**
-\x20
になりそうだし、

**実績:**
実際に
-\x20
-\x20
という実績があるみたいだ。

**オファー:**
-\x20
なら始めてみよう。`;

const REQUIRED_HEADINGS = [
  "戦略コンセプト",
  "ターゲット属性",
  "欲求",
  "判断基準",
  "想定競合",
  "商品コンセプト",
  "USP",
  "ベネフィット",
  "実績",
  "オファー"
];

export function extractStrategyConceptName(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const headingIndex = lines.findIndex((line) => /^\s*\*\*戦略コンセプト[:：]\*\*\s*/.test(line));
  if (headingIndex < 0) return "";

  const inlineValue = lines[headingIndex]
    .replace(/^\s*\*\*戦略コンセプト[:：]\*\*\s*/, "")
    .trim();
  if (inlineValue) return inlineValue;

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^(?:#{1,6}\s+|\*\*[^*]+[:：]\*\*)/.test(line)) return "";
    return line;
  }
  return "";
}

export function validateStrategyMarkdown(markdown) {
  const source = String(markdown || "").replace(/\r/g, "");
  const missingHeadings = REQUIRED_HEADINGS.filter((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^\\s*\\*\\*${escaped}[:：]\\*\\*`, "m").test(source);
  });
  const conceptName = extractStrategyConceptName(source);
  return {
    ok: /^\s*###\s+仮説(?:\s|$)/m.test(source) && Boolean(conceptName) && !missingHeadings.length,
    conceptName,
    missingHeadings
  };
}
