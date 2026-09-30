'use strict';

// Regenerate after a clean npm ci. Paths in the report are repository-relative.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const inventory = new Map();
const texts = new Map();
const missing = [];
// These published npm tarballs omit the upstream MIT license file.
const upstreamLicenses = {
  '@ant-design/icons-svg@4.5.0': ['ant-design-icons-svg.txt', 'https://github.com/ant-design/ant-design-icons/blob/master/LICENSE'],
  'toggle-selection@1.0.6': ['toggle-selection.txt', 'https://github.com/sudodoki/toggle-selection/blob/master/LICENSE'],
};
for (const project of ['', 'frontend', 'electron-spike']) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, project, 'package-lock.json'), 'utf8'));
  for (const [location, entry] of Object.entries(lock.packages || {})) {
    if (!location || !location.includes('node_modules/') || !entry.version) continue;
    const name = entry.name || location.split('node_modules/').at(-1);
    const key = `${name}@${entry.version}`;
    const packageRoot = path.join(root, project, location);
    let installed = {};
    try { installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); } catch {}
    const license = entry.license || installed.license || 'UNKNOWN';
    const licenseText = typeof license === 'string' ? license : JSON.stringify(license);
    const record = inventory.get(key) || { name, version: entry.version, license: licenseText, projects: [], runtime: false };
    record.projects.push(project || 'root');
    record.projects = [...new Set(record.projects)];
    const runtime = !entry.dev && project !== 'electron-spike';
    record.runtime ||= runtime;
    inventory.set(key, record);
    if (runtime && !texts.has(key)) {
      let files = [];
      try {
        files = fs.readdirSync(packageRoot).filter((file) => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(file));
      } catch {}
      const contents = files.flatMap((file) => {
        const target = path.join(packageRoot, file);
        return fs.statSync(target).isFile() ? [`--- ${file} ---\n${fs.readFileSync(target, 'utf8').trim()}`] : [];
      });
      if (!contents.length && upstreamLicenses[key]) {
        const [file, url] = upstreamLicenses[key];
        contents.push(`Source: ${url}\n${fs.readFileSync(path.join(__dirname, 'third-party-licenses', file), 'utf8').trim()}`);
      }
      if (contents.length) texts.set(key, contents.join('\n\n'));
      else missing.push(key);
    }
  }
}
const rows = [...inventory.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const unknown = rows.filter((row) => row.license === 'UNKNOWN').map((row) => `${row.name}@${row.version}`);
const missingTexts = [...new Set(missing)].filter((key) => !texts.has(key));
const docs = path.join(root, 'docs');
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'third-party-dependencies.json'), `${JSON.stringify({
  schema: 'talentbench_dependency_licenses_v1',
  scope: 'root, frontend and electron-spike package-lock.json',
  packages: rows,
  unknown_licenses: unknown,
  runtime_license_text_missing: missingTexts,
}, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), [
  '# Third-party notices', '',
  'Generated from the three npm lockfiles and installed package metadata. Regenerate with `node release/generate-third-party-notices.js` after `npm ci`.', '',
  'Runtime dependency license texts are retained in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). Electron distributions also include their own LICENSE and LICENSES.chromium.html. External tools such as Poppler, SoX and whisper.cpp are separately installed and retain their upstream licenses.', '',
  'The table includes development/build dependencies as well as runtime dependencies. A declared SPDX expression is an inventory entry, not an independent legal compatibility determination.', '',
  `Packages: ${rows.length}. Unknown license metadata: ${unknown.length}. Missing runtime license text: ${missingTexts.length}.`, '',
  '| Package | Version | Declared license | Scope |',
  '| --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.version} | ${row.license.replaceAll('|', '\\|')} | ${row.runtime ? 'runtime' : 'build/development'} |`), '',
].join('\n'));
fs.writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), [
  'Zhaocai Guan — third-party runtime licenses',
  'Electron and Chromium license files are additionally included in the Electron distribution.', '',
  ...[...texts].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, content]) => `===== ${key} =====\n\n${content}\n`),
].join('\n'));
console.log(JSON.stringify({ packages: rows.length, runtimeLicenseTexts: texts.size, unknown, missingTexts }));
if (unknown.length || missingTexts.length) process.exitCode = 1;
