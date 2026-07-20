import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  generateWhoWhatProposals,
  normalizeWhoWhatColorInference
} from "../src/core/who-what-ai.js";
import { addStrategy, listStrategies } from "../src/core/strategy-store.js";

test("根拠付き4色だけをinferredとして受理する", () => {
  const proposal = { decisionCriteria: "信頼できる", offer: "無料相談から始める" };
  assert.deepEqual(normalizeWhoWhatColorInference({
    status: "inferred",
    palette: { main: "#16324f", sub: "#fff", accent: "#f28c28", background: "#f7fafc" },
    reason: "信頼感と低リスク行動",
    evidence: ["判断基準: 信頼できる", "オファー: 無料相談から始める"]
  }, proposal), {
    status: "inferred",
    palette: { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" },
    reason: "信頼感と低リスク行動",
    evidence: ["判断基準: 信頼できる", "オファー: 無料相談から始める"]
  });
});

test("色不足または根拠なしをinsufficientへ落とす", () => {
  const actual = normalizeWhoWhatColorInference({
    status: "inferred",
    palette: { accent: "#F28C28" },
    reason: "なんとなく",
    evidence: []
  }, { benefit: "制作を短縮する" });
  assert.equal(actual.status, "insufficient");
  assert.deepEqual(actual.palette, {});
});

test("strategy storeがcolorInferenceを保存・再読込する", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-strategy-color-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  const colorInference = {
    status: "inferred",
    palette: { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" },
    reason: "信頼感を基調にする",
    evidence: ["判断基準: 信頼できる"]
  };
  const saved = await addStrategy(root, {
    productId: "product-1",
    conceptName: "信頼起点",
    decisionCriteria: "信頼できる",
    colorInference
  });
  const loaded = (await listStrategies(root)).find((item) => item.id === saved.id);
  assert.deepEqual(loaded.colorInference, colorInference);
});

test("旧戦略はファイルを書き換えず読込時だけinsufficientへ補完する", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-strategy-legacy-color-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  const legacy = [{ id: "str_legacy", productId: "product-1", conceptName: "旧戦略" }];
  await fs.writeFile(path.join(root, "data", "strategies.json"), JSON.stringify(legacy));

  const loaded = await listStrategies(root);
  assert.deepEqual(loaded[0].colorInference, {
    status: "insufficient",
    palette: {},
    reason: "legacy_or_manual_strategy",
    evidence: []
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "data", "strategies.json"), "utf8")), legacy);
});

test("2案の配色推論を既存1リクエストで生成・正規化する", async () => {
  let calls = 0;
  const result = await generateWhoWhatProposals({
    project: { product: {} },
    researchWorkspace: {
      products: [{ id: "product-1", name: "広告改善AI" }],
      facts: [],
      expressionRules: [],
      strategies: []
    }
  }, {
    productId: "product-1",
    jsonGenerator: async () => {
      calls += 1;
      return {
        proposals: [
          {
            conceptName: "信頼起点",
            targetAttributes: "広告担当者",
            decisionCriteria: "根拠が明確",
            benefit: "迷わず判断できる",
            markdown: "信頼起点の戦略",
            colorInference: {
              status: "inferred",
              palette: { main: "#16324f", sub: "#fff", accent: "#f28c28", background: "#f7fafc" },
              reason: "信頼と行動喚起",
              evidence: ["判断基準: 根拠が明確"]
            }
          },
          {
            conceptName: "根拠不足",
            targetAttributes: "制作担当者",
            benefit: "制作を短縮する",
            markdown: "速度起点の戦略",
            colorInference: {
              status: "inferred",
              palette: { accent: "#F28C28" },
              reason: "速度感",
              evidence: []
            }
          }
        ]
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.proposals[0].colorInference.status, "inferred");
  assert.equal(result.proposals[0].colorInference.palette.main, "#16324F");
  assert.equal(result.proposals[1].colorInference.status, "insufficient");
});
