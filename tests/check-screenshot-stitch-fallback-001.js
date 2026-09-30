
const { PROJECT_ROOT } = require("../src/paths");
// Guards the stitching step's cross-platform behaviour.
//
// Stitching composes the per-candidate review image and needs Python plus
// Pillow. `python3` was hardcoded, which is a fair bet on macOS and wrong on
// Windows, where the import then failed as a whole at the stitch step. The step
// is optional by construction — ingest treats a missing stitched row as null —
// so the contract is: resolve an interpreter, and when there is none, drop the
// preview and say so, rather than failing the import or pretending it worked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolvePythonForStitching } = require("../src/start-screenshot-import");

// A real probe, not a stub: an interpreter that cannot import Pillow is as
// useless as no interpreter, because the script dies on import.
const missing = resolvePythonForStitching.call(null);
const bogus = (() => {
  const previous = process.env.HRBOSS_PYTHON;
  process.env.HRBOSS_PYTHON = '/nonexistent/python-for-this-check';
  try { return resolvePythonForStitching(); } finally {
    if (previous === undefined) delete process.env.HRBOSS_PYTHON; else process.env.HRBOSS_PYTHON = previous;
  }
})();
assert.equal(bogus.ok, false, '不存在的解析器必须判为不可用');
assert.ok(Array.isArray(bogus.rejected) && bogus.rejected.length,
  '不可用时必须说明每个候选为什么被拒，否则 Windows 上无从排查');
assert.ok(bogus.rejected.every((line) => /:/.test(line)), '拒绝理由必须带候选名');

// The override exists so a machine with Python under another name can still
// stitch without code changes.
const overridden = (() => {
  const previous = process.env.HRBOSS_PYTHON;
  process.env.HRBOSS_PYTHON = process.execPath;
  try { return resolvePythonForStitching(); } finally {
    if (previous === undefined) delete process.env.HRBOSS_PYTHON; else process.env.HRBOSS_PYTHON = previous;
  }
})();
assert.equal(overridden.ok, false, 'HRBOSS_PYTHON 指向非 Python 时必须判为不可用，而不是盲信');

const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/start-screenshot-import.js"), 'utf8');
assert.doesNotMatch(source, /runStep\('拼合截图', 'python3'/,
  '拼合步骤不得再硬编码 python3');
assert.match(source, /runStep\('拼合截图', python\.command/,
  '拼合步骤必须使用解析出的解析器');
// Both are required artifacts of the evidence manifest and are normally written
// by the stitch script; skipping has to write them or the batch cannot commit.
assert.match(source, /batch\.stitchedIndexPath/, '跳过拼合时必须写出 stitched index');
assert.match(source, /batch\.indexMarkdownPath/, '跳过拼合时必须写出 index markdown');
assert.match(source, /stitch_skipped_reason: stitchSkippedReason/,
  '跳过拼合必须上报原因，不得静默降级');

console.log(JSON.stringify({
  ok: true,
  contract: 'SCREENSHOT-STITCH-FALLBACK-001',
  interpreter_is_resolved_not_assumed: true,
  pillow_is_probed_not_assumed: true,
  override_env: 'HRBOSS_PYTHON',
  unusable_interpreter_is_rejected: true,
  skip_is_reported_not_silent: true,
  skip_writes_required_evidence_artifacts: true,
  local_interpreter_available: missing.ok === true,
  network: 'not-used',
}));
