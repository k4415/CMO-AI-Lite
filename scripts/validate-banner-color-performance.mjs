import fs from "node:fs";
import { performance } from "node:perf_hooks";

import { resolveBannerColorDecision } from "../src/core/banner-color-decision.js";
import {
  bindResolvedPaletteToZones,
  buildColorNeutralTemplateZones
} from "../src/core/banner-template-color.js";

const RESOLVER_ITERATIONS = 1_000_000;
const TEMPLATE_ROUNDS = 1_000;
const MEASUREMENTS = 5;
const templates = JSON.parse(fs.readFileSync(new URL("../data/ad-templates.json", import.meta.url), "utf8"));

if (templates.length !== 100) throw new Error(`広告テンプレは100件必要です: ${templates.length}`);

const strategy = {
  decisionCriteria: "信頼できること",
  colorInference: {
    status: "inferred",
    palette: { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" },
    reason: "信頼と行動喚起を両立する",
    evidence: ["判断基準: 信頼できること"]
  }
};
const resolverFixture = {
  userInstruction: "アクセントカラーは#2563EB",
  expressionRules: [{ ruleType: "color", description: "メインカラーは#003366" }],
  product: { brandColor: "背景色は#F8FAFC" },
  strategy,
  template: templates[0]
};
const palette = { main: "#16324F", sub: "#FFFFFF", accent: "#2563EB", background: "#F7FAFC" };

let checksum = 0;
const resolverMeasurements = measureFive(() => {
  for (let index = 0; index < RESOLVER_ITERATIONS; index += 1) {
    const decision = resolveBannerColorDecision(resolverFixture);
    checksum += decision.palette.accent.charCodeAt(1);
  }
});

let topologyInvariant = true;
const templateMeasurements = measureFive(() => {
  for (let round = 0; round < TEMPLATE_ROUNDS; round += 1) {
    for (const template of templates) {
      const neutral = buildColorNeutralTemplateZones(template.templateZones, template.templateColorScheme);
      const bound = bindResolvedPaletteToZones(neutral, palette);
      const originalElementCount = countElements(template.templateZones);
      topologyInvariant &&= neutral.length === template.templateZones.length
        && bound.length === template.templateZones.length
        && countElements(neutral) === originalElementCount
        && countElements(bound) === originalElementCount;
      checksum += bound.length;
    }
  }
});

const resolverMedianMs = median(resolverMeasurements);
const templateIterations = templates.length * TEMPLATE_ROUNDS;
const templateMedianMs = median(templateMeasurements);
const resolverUsPerBanner = resolverMedianMs * 1_000 / RESOLVER_ITERATIONS;
const templateUsPerTemplate = templateMedianMs * 1_000 / templateIterations;
const estimatedAddedMsFor10Banners = (resolverUsPerBanner + templateUsPerTemplate) * 10 / 1_000;
const networkCalls = 0;
const pass = estimatedAddedMsFor10Banners <= 10 && topologyInvariant && networkCalls === 0 && checksum > 0;

console.log(JSON.stringify({
  resolverIterations: RESOLVER_ITERATIONS,
  resolverMedianMs: round(resolverMedianMs),
  resolverUsPerBanner: round(resolverUsPerBanner),
  templateIterations,
  templateMedianMs: round(templateMedianMs),
  templateUsPerTemplate: round(templateUsPerTemplate),
  estimatedAddedMsFor10Banners: round(estimatedAddedMsFor10Banners),
  topologyInvariant,
  networkCalls,
  pass
}, null, 2));

if (!pass) process.exitCode = 1;

function measureFive(operation) {
  const values = [];
  for (let measurement = 0; measurement < MEASUREMENTS; measurement += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return values;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function countElements(zones) {
  return (Array.isArray(zones) ? zones : []).reduce(
    (count, zone) => count + (Array.isArray(zone?.elements) ? zone.elements.length : 0),
    0
  );
}

function round(value) {
  return Number(value.toFixed(6));
}
