import test from "node:test";
import assert from "node:assert/strict";

import { clearCategoryRelationCache, resolveCategoryRelation } from "../src/core/banner-category-relation.js";

test.beforeEach(() => clearCategoryRelationCache());

test("missing source profile defaults to near", async () => {
  let called = false;
  const result = await resolveCategoryRelation({
    template: {},
    strategy: { markdown: "戦略" },
    jsonGenerator: async () => {
      called = true;
      return { value: "far" };
    }
  });

  assert.equal(called, false);
  assert.equal(result.value, "near");
  assert.equal(result.confidence, 0);
  assert.equal(result.reuseMethod, "mechanism_only");
});

test("far category selects pattern_fill and preserves decision evidence", async () => {
  let request = null;
  const result = await resolveCategoryRelation({
    template: {
      copyBlueprint: {
        sourceCategoryProfile: { category: "美容", solutionType: "美容液", problem: "肌悩み" }
      }
    },
    strategy: { id: "strategy_1", markdown: "法人向け広告制作システムを比較検討する担当者" },
    jsonGenerator: async (input) => {
      request = input;
      return {
        value: "far",
        confidence: 0.92,
        reason: "購買文脈と解決策が異なる",
        signals: ["B2C美容とB2B SaaS"]
      };
    }
  });

  assert.match(request.system, /near|far/);
  assert.doesNotMatch(request.user, /事実DB|facts/);
  assert.equal(result.value, "far");
  assert.equal(result.reuseMethod, "pattern_fill");
  assert.equal(result.confidence, 0.92);
  assert.deepEqual(result.signals, ["B2C美容とB2B SaaS"]);
});

test("invalid relation response falls back conservatively to near", async () => {
  const result = await resolveCategoryRelation({
    template: { copyBlueprint: { sourceCategoryProfile: { category: "教育" } } },
    strategy: { markdown: "戦略" },
    jsonGenerator: async () => ({ value: "unknown", confidence: 4 })
  });

  assert.equal(result.value, "near");
  assert.equal(result.reuseMethod, "mechanism_only");
  assert.equal(result.confidence, 1);
});

test("category relation is cached by strategy and template versions", async () => {
  let calls = 0;
  const input = {
    template: {
      id: "tpl_1",
      copyBlueprint: { version: 2, sourceCategoryProfile: { category: "美容" } }
    },
    strategy: { id: "str_1", updatedAt: "2026-07-16T00:00:00.000Z", markdown: "法人向け" },
    jsonGenerator: async () => {
      calls += 1;
      return { value: "far", confidence: 0.8 };
    }
  };

  const first = await resolveCategoryRelation(input);
  const second = await resolveCategoryRelation(input);
  const changed = await resolveCategoryRelation({
    ...input,
    strategy: { ...input.strategy, updatedAt: "2026-07-16T01:00:00.000Z" }
  });

  assert.equal(first.value, "far");
  assert.equal(second.value, "far");
  assert.equal(changed.value, "far");
  assert.equal(calls, 2);
});
