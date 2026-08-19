import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addBannerCreative,
  generateBannerPrompt,
  listBannerCreatives,
  updateBannerCreative
} from "../src/core/banner-store.js";
import { hashCopyBrief } from "../src/core/banner-copy-hash.js";

const PROSE = "視線は上部から入り、斜めの帯が商品ゾーンへ誘導する。独立したオーバーレイ文字だけを使う。";
const NOTES = "朝の側光と木目の質感";

test("generateBannerPromptはwrittenImagePromptとstyleNotesを保存し再読込できる", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-writer-persist-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

  const copyBrief = {
    version: 3,
    strategyId: "strategy-1",
    generatedAt: "2026-07-20T00:00:00.000Z",
    model: "test",
    appealAxis: "速度",
    targetMoment: "制作を急ぐ瞬間",
    whyItStops: "課題が短く具体的に伝わる",
    mainHook: "制作を止めない",
    subHook: "次の検証へ",
    slotTexts: [
      { slotId: "default-mainHook", text: "制作を止めない" },
      { slotId: "default-subHook", text: "次の検証へ" }
    ],
    proof: "",
    offerBadge: "",
    cta: "詳しく見る",
    disclaimer: "",
    authorizedClaimSet: {
      audienceAttribute: "広告担当者",
      purchaseMomentGoal: "次の検証へ進む",
      chosenAngle: "benefit",
      coreMessage: "制作を止めない",
      whyThisAngle: "検証に直結するため",
      additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
      templateMessagePlan: [],
      claims: [],
      identityAnchors: [],
      mandatorySharedAnchors: [],
      forbiddenClaims: []
    },
    rejectedAlternatives: []
  };
  copyBrief.copyBriefHash = hashCopyBrief(copyBrief);

  const created = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "散文保存",
    copyBrief,
    productionStatus: "copy_ready"
  });
  const copyBriefGenerator = async ({ banners }) => ({
    results: banners.map((banner, index) => ({
      bannerId: banner.id,
      status: "passed",
      copyBrief,
      reviewHistory: [],
      categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
      bannerGenerationContract: { version: 2 },
      generationRunId: `run-${index}`,
      candidateGroupId: `group-${banner.id}`,
      candidateIndex: index,
      warnings: []
    }))
  });

  const generated = await generateBannerPrompt(projectRoot, created.id, {
    products: [{ id: "product-1", name: "商品" }],
    strategies: [{ id: "strategy-1", markdown: "制作を速めたい" }]
  }, {
    copyBriefGenerator,
    proposalGenerator: async ({ copyBrief: brief }) => ({
      imageText: brief.mainHook,
      copyBrief: brief,
      promptJson: { zones: [{ elements: [{ type: "text", slotId: "default-mainHook", content: brief.mainHook }] }] },
      promptText: "prompt",
      writtenImagePrompt: PROSE,
      styleNotes: NOTES,
      reviewNotes: "",
      selectionReason: ""
    })
  });

  assert.equal(generated.writtenImagePrompt, PROSE);
  assert.equal(generated.styleNotes, NOTES);
  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === created.id);
  assert.equal(stored.writtenImagePrompt, PROSE);
  assert.equal(stored.styleNotes, NOTES);
});

test("ライター失敗の空文字もnullにせず保存する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-writer-empty-persist-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const created = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "空文字保存"
  });
  const saved = await updateBannerCreative(projectRoot, created.id, {
    writtenImagePrompt: "",
    styleNotes: ""
  });
  assert.equal(saved.writtenImagePrompt, "");
  assert.equal(saved.styleNotes, "");
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "writtenImagePrompt"), true);
});
