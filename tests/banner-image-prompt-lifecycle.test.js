import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addBannerCreative,
  listBannerCreatives,
  recoverAbandonedBannerJobs,
  updateBannerCreative
} from "../src/core/banner-store.js";
import {
  buildPipelineInputHashes,
  buildPipelineOutputHashes
} from "../src/core/banner-pipeline-state.js";
import { hashCopyBrief } from "../src/core/banner-copy-hash.js";

const OLD_PROSE = "古い完成イメージの散文。視線は上部から入り、木目のテーブルと朝の側光で商品を見せる描写が続く。";
const NEW_PROSE = "新しい完成イメージの散文。視線は左の帯から商品ゾーンへ向かい、独立したオーバーレイ文字だけを使う。";
const OLD_NOTES = "古い質感メモ: 朝の側光";
const NEW_NOTES = "新しい質感メモ: 曇天の拡散光";

function copyBrief() {
  const value = {
    version: 4,
    strategyId: "str_1",
    hypothesisId: "hyp_1",
    hypothesisHash: "sha256:hypothesis",
    approvedClaimSnapshotId: "acs_1",
    approvedClaimSnapshotHash: "sha256:snapshot",
    appealAxis: "速度",
    targetMoment: "急ぐ瞬間",
    whyItStops: "具体的な変化が一読で伝わるため",
    mainHook: "広告制作を早める",
    subHook: "次の検証へ",
    slotTexts: [{ slotId: "hook", text: "広告制作を早める" }],
    semanticGroupReadout: []
  };
  return { ...value, copyBriefHash: hashCopyBrief(value) };
}

function hashContext(bannerOverrides = {}) {
  const brief = copyBrief();
  return {
    banner: {
      id: "ban_1",
      productId: "prod_1",
      strategyId: "str_1",
      templateAdId: "tpl_1",
      imageSize: "1080x1080",
      copyBrief: brief,
      promptJson: { zones: [{ name: "hero" }] },
      promptText: "prompt",
      writtenImagePrompt: OLD_PROSE,
      styleNotes: OLD_NOTES,
      ...bannerOverrides
    },
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", benefit: "制作を早める" },
    template: { id: "tpl_1" }
  };
}

test("散文の変更でprompt出力ハッシュとimage入力ハッシュが変わる", () => {
  const before = hashContext();
  const after = hashContext({ writtenImagePrompt: NEW_PROSE, styleNotes: NEW_NOTES });
  const beforeOutputs = buildPipelineOutputHashes(before);
  const afterOutputs = buildPipelineOutputHashes(after);
  const beforeInputs = buildPipelineInputHashes(before);
  const afterInputs = buildPipelineInputHashes(after);

  assert.notEqual(beforeOutputs.prompt, afterOutputs.prompt);
  assert.notEqual(beforeInputs.image, afterInputs.image);
  assert.equal(beforeInputs.prompt, afterInputs.prompt);
});

test("styleNotesだけの変更でも両ハッシュが変わる", () => {
  const before = hashContext();
  const after = hashContext({ styleNotes: NEW_NOTES });
  assert.notEqual(buildPipelineOutputHashes(before).prompt, buildPipelineOutputHashes(after).prompt);
  assert.notEqual(buildPipelineInputHashes(before).image, buildPipelineInputHashes(after).image);
});

test("prompt再生成の無効化で古い散文とstyleNotesが消える", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-writer-invalidate-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const created = await addBannerCreative(projectRoot, {
    productId: "prod_1",
    strategyId: "strategy_1",
    title: "散文無効化"
  });
  await updateBannerCreative(projectRoot, created.id, {
    promptJson: { zones: [] },
    promptText: "prompt",
    writtenImagePrompt: OLD_PROSE,
    styleNotes: OLD_NOTES
  });
  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === created.id);
  assert.equal(stored.writtenImagePrompt, OLD_PROSE);
  assert.equal(stored.styleNotes, OLD_NOTES);

  const updated = await updateBannerCreative(projectRoot, created.id, {
    additionalInstruction: "背景だけ青にする"
  });
  assert.equal(updated.writtenImagePrompt, "");
  assert.equal(updated.styleNotes, "");
  assert.equal(updated.promptJson, null);
});

test("job復旧はpromptを再生成可能な失敗状態へ戻し、旧散文をimage入力に使わない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-writer-recovery-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const created = await addBannerCreative(projectRoot, {
    productId: "p1",
    strategyId: "s1",
    title: "散文復旧"
  });
  const brief = copyBrief();
  await updateBannerCreative(projectRoot, created.id, {
    copyBrief: brief,
    promptJson: { zones: [{ name: "hero" }] },
    promptText: "途中まで完成したprompt",
    writtenImagePrompt: OLD_PROSE,
    styleNotes: OLD_NOTES,
    productionStatus: "prompt_generating",
    promptGenerationLease: {
      ownerId: "7796-old-worker",
      attemptId: "old-prompt-attempt",
      operationKind: "prompt",
      state: "generating",
      queuedAt: "2026-07-20T12:00:00.000Z",
      startedAt: "2026-07-20T12:01:00.000Z",
      heartbeatAt: "2026-07-20T12:20:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    },
    pipelineNodes: {
      copyplan: { status: "completed", inputHash: "copy-in", outputHash: "copy-out" },
      prompt: { status: "running", inputHash: "prompt-in", outputHash: "prompt-out", attemptId: "old-prompt-attempt" },
      image: { status: "pending", inputHash: "", outputHash: "" }
    }
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: Date.parse("2026-07-20T12:30:00.000Z"),
    signalProcess: () => {
      const error = new Error("missing");
      error.code = "ESRCH";
      throw error;
    }
  });
  const [stored] = await listBannerCreatives(projectRoot);
  assert.deepEqual(recovered.resetPromptIds, [created.id]);
  assert.equal(stored.productionStatus, "failed");
  assert.equal(stored.pipelineNodes.prompt.status, "failed");
  assert.equal(stored.pipelineNodes.image.status, "pending");
  assert.equal(stored.promptText, "途中まで完成したprompt");

  const cleared = await updateBannerCreative(projectRoot, created.id, {
    additionalInstruction: "背景だけ白にする"
  });
  assert.equal(cleared.writtenImagePrompt, "");
  assert.equal(cleared.styleNotes, "");
});
