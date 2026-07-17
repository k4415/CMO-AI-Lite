import test from "node:test";
import assert from "node:assert/strict";

import { checkBannerStrategyAlignment } from "../src/core/banner-strategy-check.js";

test("選択WHO-WHAT内の数値主張はpassedになる", () => {
  const result = checkBannerStrategyAlignment({
    banner: { copyBrief: { mainHook: "制作時間を5分の1に" } },
    strategy: { markdown: "## ベネフィット\n制作時間を5分の1にする" }
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.warnings, []);
});

test("選択WHO-WHATにない数値主張はwarningになる", () => {
  const result = checkBannerStrategyAlignment({
    banner: { copyBrief: { slotTexts: [{ slotId: "z1e1", text: "満足度98%" }] } },
    strategy: { markdown: "## ベネフィット\n制作判断を早める" }
  });

  assert.equal(result.status, "warning");
  assert.match(result.warnings[0], /98%/);
});

test("WHO-WHAT外の数値でも追加指示原文に明示されていればpassedになる", () => {
  const result = checkBannerStrategyAlignment({
    banner: {
      additionalInstruction: "漫画家依頼だと1ヶ月かかる比較を入れてください",
      copyBrief: { mainHook: "漫画家依頼だと1ヶ月" }
    },
    strategy: { markdown: "漫画広告を今週中に検証したい" }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.findings[0].supportedBy, "additional_instruction");
});

test("AuthorizedClaimSetの許可主張にある数値はStage 2再検査を通る", () => {
  const result = checkBannerStrategyAlignment({
    banner: {
      copyBrief: {
        mainHook: "7日無料で試す",
        authorizedClaimSet: {
          claims: [{ text: "7日無料で試せる", numericTokens: ["7日"], sourceType: "additional_instruction" }]
        }
      }
    },
    strategy: { markdown: "漫画広告を早く検証したい" }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.findings[0].supportedBy, "authorized_claim_set");
});

test("レイアウト上の座標や色コードは戦略範囲外warningにしない", () => {
  const result = checkBannerStrategyAlignment({
    banner: {
      copyBrief: { mainHook: "判断を早める" },
      promptJson: { zones: [{ position: "top 5%", elements: [{ type: "shape", color: "#FFFFFF" }] }] }
    },
    strategy: { markdown: "判断を早める" }
  });

  assert.equal(result.status, "passed");
});
