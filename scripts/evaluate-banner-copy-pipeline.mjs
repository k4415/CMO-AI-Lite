import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reviewCopyBriefs } from "../src/core/banner-copy-review.js";
import { reviewOriginality } from "../src/core/banner-originality.js";
import { checkBannerStrategyAlignment } from "../src/core/banner-strategy-check.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function evaluateBannerCopyFixtures(fixture) {
  const cases = Array.isArray(fixture?.cases) ? fixture.cases : [];
  const results = [];
  for (const item of cases) {
    const actual = await evaluateCase(item);
    results.push({
      id: String(item?.id || ""),
      kind: String(item?.kind || ""),
      expected: String(item?.expected || ""),
      actual,
      passed: actual === item?.expected
    });
  }
  return {
    reviewPolicyVersion: "4.1",
    caseCount: results.length,
    results,
    failedCaseIds: results.filter((item) => !item.passed).map((item) => item.id),
    passed: results.length === 5 && results.every((item) => item.passed)
  };
}

async function evaluateCase(item) {
  if (item?.kind === "blind_review") {
    const slotIds = (Array.isArray(item.slotTexts) ? item.slotTexts : []).map((slot) => slot.slotId).filter(Boolean);
    const [review] = await reviewCopyBriefs({
      briefs: [{
        mainHook: String(item?.slotTexts?.[0]?.text || ""),
        readoutText: String(item?.readoutText || ""),
        slotTexts: item.slotTexts || [],
        authorizedClaimSet: {
          audienceAttribute: "広告や商品の選定に関わる担当者",
          purchaseMomentGoal: "自分に合う選択肢を判断できる",
          chosenAngle: "benefit",
          coreMessage: "テスト用の非表示意図",
          whyThisAngle: "回帰テスト用",
          additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
          templateMessagePlan: [{ groupId: "primary", semanticRole: "primary_promise", groupMessage: "非表示", slotIds }],
          claims: [], identityAnchors: [], mandatorySharedAnchors: [], forbiddenClaims: []
        }
      }],
      product: { name: "テスト商品" },
      reviewGenerator: async () => ({ reviews: [item.review] })
    });
    return review.status;
  }
  if (item?.kind === "strategy_alignment") {
    return checkBannerStrategyAlignment({
      banner: {
        additionalInstruction: String(item?.additionalInstruction || ""),
        copyBrief: { mainHook: String(item?.copy || "") }
      },
      strategy: { markdown: String(item?.strategy || "") }
    }).status;
  }
  if (item?.kind === "originality") {
    const brief = {
      mainHook: String(item?.copy || ""),
      candidateIndex: 1,
      authorizedClaimSet: {
        chosenAngle: String(item?.chosenAngle || ""),
        mandatorySharedAnchors: item?.mandatorySharedAnchors || [],
        additionalInstructionIntent: { allowSiblingSimilarity: false }
      }
    };
    return reviewOriginality({
      brief,
      candidateGroupId: "regression-group",
      siblings: [{
        candidateGroupId: "regression-group",
        copyBrief: { ...brief, candidateIndex: 0 }
      }]
    }).status;
  }
  return "unsupported_case";
}

async function main() {
  const fixtureFlag = process.argv.find((item) => item.startsWith("--fixtures="));
  const fixtureIndex = process.argv.indexOf("--fixtures");
  const fixturePath = fixtureFlag
    ? fixtureFlag.slice("--fixtures=".length)
    : (fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : "tests/fixtures/banner-copy-quality-v2.json");
  const absolute = path.resolve(appRoot, fixturePath);
  const fixture = JSON.parse(await fs.readFile(absolute, "utf8"));
  const report = await evaluateBannerCopyFixtures(fixture);
  console.log(JSON.stringify({ ...report, fixture: absolute }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
