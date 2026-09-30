const crypto = require('crypto');

function clean(value) {
  return value === undefined || value === null ? '' : String(value).normalize('NFKC').trim();
}

function canonicalText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[\s·•●，,。；;：:（）()【】\[\]“”"'`~!！?？/_\\|-]+/g, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function decimalText(value) {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function normalizeMonthlySalary(value) {
  const raw = clean(value);
  if (!raw) return { raw: null, status: 'unknown', unit: null, min_k: null, max_k: null, normalized_text: null };
  if (/面议/.test(raw)) return { raw, status: 'unknown', unit: null, min_k: null, max_k: null, normalized_text: null };
  if (/年薪|\/年|每年|13薪|14薪|15薪|16薪/.test(raw)) {
    return { raw, status: 'unsupported', unit: null, min_k: null, max_k: null, normalized_text: null };
  }

  const compact = raw.replace(/\s+/g, '').replace(/[–—~至]/g, '-').toLowerCase();
  let match;
  let multiplier = 1;
  if ((match = compact.match(/^(\d+(?:\.\d+)?)k(?:-(\d+(?:\.\d+)?)k?)?$/))) multiplier = 1;
  else if ((match = compact.match(/^(\d+(?:\.\d+)?)(?:万|万元)(?:-(\d+(?:\.\d+)?)(?:万|万元)?)?$/))) multiplier = 10;
  else if ((match = compact.match(/^(\d+(?:\.\d+)?)(?:元)(?:-(\d+(?:\.\d+)?)(?:元)?)?$/))) multiplier = 0.001;
  else if ((match = compact.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(k|万|万元|元)$/))) {
    multiplier = match[3] === 'k' ? 1 : (match[3] === '元' ? 0.001 : 10);
  } else {
    return { raw, status: 'invalid', unit: null, min_k: null, max_k: null, normalized_text: null };
  }

  const minK = Number(match[1]) * multiplier;
  const maxK = Number(match[2] || match[1]) * multiplier;
  if (!Number.isFinite(minK) || !Number.isFinite(maxK) || minK <= 0 || maxK <= 0 || minK > maxK) {
    return { raw, status: 'invalid', unit: null, min_k: null, max_k: null, normalized_text: null };
  }
  return {
    raw,
    status: 'normalized',
    unit: 'K/month',
    min_k: minK,
    max_k: maxK,
    normalized_text: minK === maxK ? `${decimalText(minK)}K` : `${decimalText(minK)}-${decimalText(maxK)}K`,
  };
}

function canonicalIdentityFacts(facts = {}) {
  const salary = normalizeMonthlySalary(facts.salary);
  return {
    age: canonicalText(facts.age),
    degree: canonicalText(facts.degree),
    work_years: canonicalText(facts.work_years),
    salary: salary.status === 'normalized' ? salary.normalized_text.toLowerCase() : canonicalText(facts.salary),
    availability: canonicalText(facts.availability),
    recent_focus: canonicalText(facts.recent_focus),
    work_experience_text: canonicalText(facts.work_experience_text),
    education_text: canonicalText(facts.education_text),
  };
}

function buildScreenshotIdentity({ name, facts = {}, sourceHashes = [] } = {}) {
  const canonicalFacts = canonicalIdentityFacts(facts);
  const contentFingerprint = sha256(JSON.stringify(canonicalFacts));
  const normalizedName = canonicalText(name);
  const hashes = [...new Set((sourceHashes || []).map(clean).filter((value) => /^[a-f0-9]{64}$/i.test(value)).map((value) => value.toLowerCase()))].sort();
  const sourceFingerprint = hashes.length ? sha256(JSON.stringify(hashes)) : null;
  const anchors = [
    canonicalFacts.age,
    canonicalFacts.degree,
    canonicalFacts.work_years,
    canonicalFacts.recent_focus,
    canonicalFacts.work_experience_text,
    canonicalFacts.education_text,
  ].filter(Boolean);
  const hasRichAnchor = [canonicalFacts.recent_focus, canonicalFacts.work_experience_text, canonicalFacts.education_text]
    .some((value) => value.length >= 8);
  const contentStrong = !!normalizedName && anchors.length >= 2 && hasRichAnchor;
  const contentIdentityKey = contentStrong
    ? sha256(JSON.stringify({ name: normalizedName, content_fingerprint: contentFingerprint }))
    : null;
  return {
    identity_key: contentIdentityKey || sourceFingerprint,
    method: contentIdentityKey ? 'strong_content' : (sourceFingerprint ? 'exact_source_hash' : 'insufficient'),
    status: contentIdentityKey || sourceFingerprint ? 'stable' : 'insufficient',
    normalized_name: normalizedName || null,
    content_fingerprint: contentFingerprint,
    content_identity_key: contentIdentityKey,
    source_fingerprint: sourceFingerprint,
    source_hashes: hashes,
    anchor_count: anchors.length,
  };
}

module.exports = {
  buildScreenshotIdentity,
  canonicalIdentityFacts,
  normalizeMonthlySalary,
};
