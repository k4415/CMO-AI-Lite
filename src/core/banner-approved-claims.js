import crypto from "node:crypto";

const STRUCTURED_STRATEGY_FIELDS = [
  ["targetAttributes", "audience"],
  ["desire", "desire"],
  ["decisionCriteria", "decision_criteria"],
  ["alternatives", "alternative"],
  ["productConcept", "product_concept"],
  ["usp", "usp"],
  ["benefit", "benefit"],
  ["proof", "proof"],
  ["offer", "offer"]
];

const OBJECTIVE_WORDS = new Map([
  ["無料", "free"],
  ["割引", "discount"],
  ["最安", "lowest_price"],
  ["保証", "guarantee"],
  ["限定", "limited"],
  ["比較", "comparison"],
  ["実績", "result"],
  ["達成", "achievement"],
  ["no.1", "number_one"],
  ["ナンバーワン", "number_one"]
]);

export function buildApprovedClaimSnapshot({ strategy = {}, product = {}, instructionPolicy = {} } = {}) {
  const sources = [
    ...strategySegments(strategy),
    ...productSegments(product),
    ...instructionSegments(instructionPolicy)
  ];
  const claims = uniqueByKey(sources.map((source) => {
    const text = clean(source.text);
    const numericTokens = extractNumericTokens(text);
    const objectiveTokens = extractObjectiveTokens(text);
    return {
      claimId: stableId("clm", [
        source.sourceType,
        source.sourceId,
        source.sourcePath,
        normalizeText(text)
      ]),
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      text,
      claimKind: source.claimKind,
      allowedUses: allowedUsesForClaimKind(source.claimKind),
      numericTokens,
      objectiveTokens,
      risk: objectiveTokens.length ? "objective" : "general"
    };
  }).filter((claim) => claim.text), (claim) => claim.claimId);
  const payload = {
    version: 1,
    strategyId: clean(strategy.id),
    productId: clean(product.id),
    claims
  };
  const contentHash = hashObject(payload);
  return {
    ...payload,
    snapshotId: `acs_${contentHash.slice(7, 23)}`,
    contentHash
  };
}

export function normalizeApprovedClaimSnapshot(value) {
  const source = value && typeof value === "object" ? value : {};
  const claims = Array.isArray(source.claims) ? source.claims.map((claim) => {
    const text = clean(claim.text);
    return {
      claimId: clean(claim.claimId),
      sourceType: clean(claim.sourceType),
      sourceId: clean(claim.sourceId),
      sourcePath: clean(claim.sourcePath),
      text,
      claimKind: clean(claim.claimKind),
      allowedUses: uniqueStrings(claim.allowedUses),
      numericTokens: Array.isArray(claim.numericTokens)
        ? [...new Set(claim.numericTokens.map(clean).filter(Boolean))]
        : extractNumericTokens(text),
      objectiveTokens: Array.isArray(claim.objectiveTokens)
        ? uniqueStrings(claim.objectiveTokens)
        : extractObjectiveTokens(text),
      risk: claim.risk === "objective" || extractObjectiveTokens(text).length ? "objective" : "general"
    };
  }).filter((claim) => claim.claimId && claim.text) : [];
  const payload = {
    version: 1,
    strategyId: clean(source.strategyId),
    productId: clean(source.productId),
    claims
  };
  const contentHash = hashObject(payload);
  return {
    ...payload,
    snapshotId: clean(source.snapshotId) || `acs_${contentHash.slice(7, 23)}`,
    contentHash
  };
}

export function validateCopyAuthorization({
  copyBrief = {},
  creativeHypothesis = {},
  approvedClaimSnapshot = {}
} = {}) {
  const snapshot = normalizeApprovedClaimSnapshot(approvedClaimSnapshot);
  const claimsById = new Map(snapshot.claims.map((claim) => [claim.claimId, claim]));
  const expectedHypothesisId = clean(creativeHypothesis.hypothesisId);
  const violations = [];
  for (const slot of Array.isArray(copyBrief.slotTexts) ? copyBrief.slotTexts : []) {
    const text = clean(slot.text);
    if (!text) continue;
    if (!expectedHypothesisId || clean(slot.hypothesisId || copyBrief.hypothesisId) !== expectedHypothesisId) {
      violations.push({ slotId: clean(slot.slotId), code: "hypothesis_id_mismatch" });
    }
    const claimIds = [...new Set((slot.claimIds || []).map(clean).filter(Boolean))];
    const linkedClaims = claimIds.map((claimId) => claimsById.get(claimId)).filter(Boolean);
    for (const claimId of claimIds) {
      if (!claimsById.has(claimId)) {
        violations.push({ slotId: clean(slot.slotId), code: "unknown_claim_id", claimId });
      }
    }
    const slotUse = copyUseForSlot(slot);
    for (const claim of linkedClaims) {
      if (claim.allowedUses.length && !claim.allowedUses.includes(slotUse)) {
        violations.push({ slotId: clean(slot.slotId), code: "claim_use_not_authorized", claimId: claim.claimId, slotUse });
      }
    }
    if (slotRequiresClaim(slot) && !linkedClaims.length) {
      violations.push({ slotId: clean(slot.slotId), code: "claim_id_missing" });
    }
    const objectiveTokens = extractObjectiveTokens(text);
    if (objectiveTokens.length && !linkedClaims.length) {
      violations.push({ slotId: clean(slot.slotId), code: "objective_claim_id_missing" });
      continue;
    }
    const allowedTokens = new Set(linkedClaims.flatMap((claim) => claim.objectiveTokens));
    for (const token of objectiveTokens) {
      if (!allowedTokens.has(token)) {
        violations.push({ slotId: clean(slot.slotId), code: "objective_token_not_authorized", token });
      }
    }
  }
  return {
    status: violations.length ? "failed" : "passed",
    violations
  };
}

export function extractNumericTokens(value) {
  const normalized = normalizeText(value).replaceAll("か月", "ヶ月").replaceAll("％", "%");
  return [...new Set(normalized.match(/[0-9]+(?:[.,][0-9]+)?(?:%|円|日|週間|週|ヶ月|月|年|倍|分の[0-9]+)?/g) || [])];
}

export function extractObjectiveTokens(value) {
  const normalized = normalizeText(value);
  const tokens = extractNumericTokens(normalized).map((token) => `number:${token}`);
  for (const [word, token] of OBJECTIVE_WORDS) {
    if (normalized.includes(word)) tokens.push(`objective:${token}`);
  }
  return [...new Set(tokens)];
}

function strategySegments(strategy) {
  const structured = STRUCTURED_STRATEGY_FIELDS.flatMap(([field, claimKind]) => splitClaimUnits(strategy[field]).map((text, index) => ({
    sourceType: "strategy",
    sourceId: clean(strategy.id),
    sourcePath: `${field}.${index}`,
    claimKind,
    text
  })));
  if (structured.length) return structured;
  return legacyMarkdownSegments(clean(strategy.markdown), clean(strategy.id));
}

function productSegments(product) {
  return ["name", "brandName"].flatMap((field) => splitLines(product[field]).map((text) => ({
    sourceType: "product_identity",
    sourceId: clean(product.id),
    sourcePath: field,
    claimKind: "identity",
    text
  })));
}

function instructionSegments(instructionPolicy) {
  const claimTexts = uniqueStrings([
    ...(instructionPolicy.authorizedClaims || []),
    ...(instructionPolicy.fixedCopy || [])
  ]);
  return claimTexts.map((text, index) => ({
    sourceType: "additional_instruction",
    sourceId: hashObject({ text }),
    sourcePath: `authorizedClaims.${index}`,
    claimKind: "instruction_claim",
    text
  }));
}

function legacyMarkdownSegments(markdown, sourceId) {
  const sections = [];
  let heading = "root";
  let body = [];
  const flush = () => {
    const claimKind = claimKindForHeading(heading);
    for (const [index, text] of splitClaimUnits(body.join("\n")).entries()) {
      sections.push({ sourceType: "strategy", sourceId, sourcePath: `markdown.${heading}.${index}`, claimKind, text });
    }
    body = [];
  };
  for (const line of String(markdown).split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+)$/) || line.match(/^\*\*([^*]+?):\*\*$/);
    if (match?.[1]) {
      flush();
      heading = normalizeText(match[1]) || "section";
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function splitClaimUnits(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitClaimUnits(item));
  return String(value || "").split(/\r?\n/)
    .map((line) => clean(line).replace(/^[-・]\s*/, ""))
    .filter((line) => line && !/^(?:を満たすものがいい|とは異なり|があるから|実際に)$/.test(line));
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map(clean).filter(Boolean);
}

function claimKindForHeading(value) {
  const heading = normalizeText(value);
  if (/ターゲット|属性/.test(heading)) return "audience";
  if (/欲求/.test(heading)) return "desire";
  if (/判断基準/.test(heading)) return "decision_criteria";
  if (/競合|代替/.test(heading)) return "alternative";
  if (/商品コンセプト|戦略コンセプト/.test(heading)) return "product_concept";
  if (/usp/.test(heading)) return "usp";
  if (/ベネフィット|便益/.test(heading)) return "benefit";
  if (/実績|根拠|proof/.test(heading)) return "proof";
  if (/オファー/.test(heading)) return "offer";
  return "problem";
}

function allowedUsesForClaimKind(kind) {
  if (kind === "identity") return ["identity", "headline", "body"];
  if (kind === "instruction_claim") return ["identity", "headline", "audience", "benefit", "proof", "offer", "cta", "body"];
  if (kind === "offer") return ["headline", "offer", "cta", "body"];
  if (kind === "proof") return ["headline", "proof", "body"];
  if (kind === "audience") return ["headline", "audience", "body"];
  return ["headline", "benefit", "proof", "body"];
}

function copyUseForSlot(slot) {
  const role = normalizeText([slot.role, slot.messageRole, slot.canonicalField].filter(Boolean).join(" "));
  if (/offer|オファー|badge/.test(role)) return "offer";
  if (/cta|action|申込/.test(role)) return "cta";
  if (/proof|evidence|実績|根拠/.test(role)) return "proof";
  if (/headline|hook|main|見出し/.test(role)) return "headline";
  return "body";
}

function slotRequiresClaim(slot) {
  const role = normalizeText([slot.role, slot.messageRole, slot.canonicalField].filter(Boolean).join(" "));
  return !/(?:cta|action|注記|disclaimer|装飾|decorative)/.test(role);
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function stableId(prefix, parts) {
  return `${prefix}_${crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16)}`;
}

function hashObject(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueByKey(items, getKey) {
  return [...new Map(items.map((item) => [getKey(item), item])).values()];
}

function normalizeText(value) {
  return clean(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function clean(value) {
  return String(value ?? "").trim();
}
