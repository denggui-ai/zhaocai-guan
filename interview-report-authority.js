'use strict';

const crypto = require('crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value), 'utf8')
    .digest('hex');
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function buildConfirmedInterviewProjection(input = {}) {
  const reportRow = input.reportRow || {};
  const sourceReport = parseJson(input.report) || parseJson(reportRow.report_json);
  if (!sourceReport || typeof sourceReport !== 'object' || Array.isArray(sourceReport)) {
    throw new Error('confirmed interview source report is invalid');
  }
  const reviews = Array.isArray(input.factReviews) ? input.factReviews : [];
  const reviewByKey = new Map(reviews.map((row) => [String(row.field_key), row]));
  const authoritativeFacts = (Array.isArray(sourceReport.key_facts) ? sourceReport.key_facts : [])
    .map((fact) => {
      const review = reviewByKey.get(String(fact.field_key));
      // Drop only facts HR never reviewed or explicitly rejected. A fact HR
      // confirmed as "unknown" must stay in the authoritative projection so the
      // archived report can tell "asked, still unknown" from "never covered".
      if (!review || !['confirmed', 'corrected'].includes(review.status)) return null;
      if (review.status === 'corrected') {
        return {
          ...fact,
          status: 'supported',
          value: String(review.corrected_value || '').trim(),
          evidence_refs: Array.isArray(fact.evidence_refs) ? fact.evidence_refs : [],
        };
      }
      return { ...fact };
    })
    .filter(Boolean);
  const authoritativeReport = {
    ...sourceReport,
    key_facts: authoritativeFacts,
  };
  const factReviews = reviews.map((row) => ({
    field_key: row.field_key,
    status: row.status,
    corrected_value: row.status === 'corrected' ? row.corrected_value : null,
    reviewed_by: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
  }));
  const projection = {
    schema_version: 'confirmed_interview_report_projection_v1',
    report_id: Number(reportRow.id),
    session_id: Number(reportRow.session_id),
    source_report_version: Number(input.sourceReportVersion || reportRow.version),
    source_report_hash: String(reportRow.content_hash || sha256(sourceReport)),
    confirmed_by: input.confirmedBy || reportRow.confirmed_by || null,
    confirmed_at: input.confirmedAt || reportRow.confirmed_at || null,
    report: authoritativeReport,
    fact_reviews: factReviews,
  };
  return {
    projection,
    projectionJson: stableJson(projection),
    contentHash: sha256(projection),
  };
}

module.exports = {
  buildConfirmedInterviewProjection,
  sha256,
  stableJson,
};
