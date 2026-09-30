function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function extractInterviewReportPayload(value) {
  const parsed = parseMaybeJson(value);
  if (!parsed) return null;
  if (parsed.report_json) return parseMaybeJson(parsed.report_json) || parsed;
  if (parsed.report && parsed.report.report_json) return parseMaybeJson(parsed.report.report_json) || parsed.report;
  if (parsed.report) return parseMaybeJson(parsed.report) || parsed.report;
  return parsed;
}

export function extractInterviewReportMeta(value) {
  const row = value && value.report && typeof value.report === 'object' ? value.report : value;
  if (!row || typeof row !== 'object') return null;
  const version = Number(row.version);
  if (!Number.isInteger(version) || version < 1) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    version,
    status: row.status || 'draft',
    read_only: row.read_only === true,
    legacy: row.legacy === true,
    stale: row.stale === true,
    stale_reason: row.stale_reason || null,
    source_snapshot: row.source_snapshot || null,
  };
}

export function sessionInterviewReportStateFromGetResponse(response) {
  const meta = extractInterviewReportMeta(response);
  return {
    report: extractInterviewReportPayload(response && response.report),
    meta,
    facts: Array.isArray(response && response.facts) ? response.facts : [],
    expectedVersion: meta ? meta.version : 0,
  };
}
