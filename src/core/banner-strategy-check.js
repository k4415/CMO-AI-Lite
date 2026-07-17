const HIGH_RISK_PATTERN = /(?:20\d{2}年(?:\d{1,2}月(?:\d{1,2}日)?)?|\d[\d,.]*\s*(?:円|%|％|名|人|個|回|日|週間|週|ヶ?月|か月|年|倍|分|歳|本|件|社))/g;

export function checkBannerStrategyAlignment({ banner = {}, strategy = {}, additionalInstruction = "", authorizedClaimSet = null } = {}) {
  const strategyText = normalizeText(strategy.markdown || JSON.stringify(strategy || {}));
  const instructionText = normalizeText([
    additionalInstruction,
    banner?.additionalInstruction,
    banner?.revisionInstruction,
    banner?.bannerGenerationContract?.instructionPolicy?.rawInstruction
  ].filter(Boolean).join("\n"));
  const resolvedClaimSet = authorizedClaimSet
    || banner?.authorizedClaimSet
    || banner?.copyBrief?.authorizedClaimSet
    || {};
  const authorizedText = normalizeText([
    ...(Array.isArray(resolvedClaimSet?.claims) ? resolvedClaimSet.claims.flatMap((claim) => [claim?.text, ...(claim?.numericTokens || [])]) : []),
    ...(Array.isArray(resolvedClaimSet?.identityAnchors) ? resolvedClaimSet.identityAnchors : []),
    ...(Array.isArray(resolvedClaimSet?.mandatorySharedAnchors) ? resolvedClaimSet.mandatorySharedAnchors : [])
  ].filter(Boolean).join("\n"));
  const claims = extractHighRiskClaims(collectBannerCopy(banner));
  const findings = claims.map((claim) => {
    const tokens = extractHighRiskTokens(claim);
    const supportedBy = [
      ["strategy", strategyText],
      ["additional_instruction", instructionText],
      ["authorized_claim_set", authorizedText]
    ].find(([, sourceText]) => tokens.length > 0 && tokens.every((token) => sourceText.includes(normalizeText(token))))?.[0] || "";
    return {
      claim,
      tokens,
      supported: Boolean(supportedBy),
      supportedBy
    };
  });
  const warnings = findings
    .filter((item) => !item.supported)
    .map((item) => `選択WHO-WHAT範囲外の可能性: ${item.claim}`);
  return {
    status: warnings.length ? "warning" : "passed",
    findings,
    warnings,
    checkedAt: new Date().toISOString(),
    note: "バナーコピーを選択WHO-WHAT、追加指示、AuthorizedClaimSetの許可範囲で検査しています。事実DBは参照していません。"
  };
}

export function extractHighRiskClaims(value) {
  const claims = [];
  for (const line of String(value || "").replace(/\\n/g, "\n").replace(/\r/g, "").split(/\n+/)) {
    const text = line.trim();
    if (!text) continue;
    if (HIGH_RISK_PATTERN.test(text)) claims.push(text.slice(0, 180));
    HIGH_RISK_PATTERN.lastIndex = 0;
  }
  return [...new Set(claims)];
}

function collectBannerCopy(banner) {
  const brief = banner?.copyBrief && typeof banner.copyBrief === "object" ? banner.copyBrief : {};
  return [
    ...(Array.isArray(brief.slotTexts) ? brief.slotTexts.map((slot) => slot?.text) : []),
    brief.mainHook,
    brief.subHook,
    brief.proof,
    brief.offerBadge,
    brief.cta,
    brief.disclaimer,
    banner?.imageText
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
}

function extractHighRiskTokens(value) {
  return [...new Set((String(value || "").match(HIGH_RISK_PATTERN) || []).map((item) => item.trim()).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s,，、。・「」『』（）()]/g, "")
    .replace(/ヶ|か/g, "ケ")
    .toLowerCase();
}
