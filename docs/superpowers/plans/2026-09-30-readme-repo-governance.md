# README and repository governance implementation plan

Goal: improve the product-first Chinese/English README and organize the repository without changing recruiting behavior, database formats, npm command names, dependencies, application identity, or user-data locations.

Approved specification: the user-approved implementation plan in this conversation (2026-09-30). Base: 11ba96fd0ab93650e0ef3643d7bdeacddee6de90. Existing release tags and binary assets are immutable for this work. Deliver a draft PR, not a merge or a new binary release.

## Global constraints
- Only synthetic fixtures; no paid provider calls or real recruiting data.
- Retain old audit evidence. Distinguish an implemented capability from real-provider acceptance.
- Establish registration and path rules before relocating files. Preserve check coverage and intentional platform skips.
- Keep existing modules and filenames; no unrelated business-logic decomposition.

## Review focus
- Electron development versus packaged resource roots, child processes, preload and native tools.
- Source-string regression checks must still inspect their intended production files.
- Check registration must detect new unregistered checks and preserve all existing suite membership.
- Source exports must match a frozen commit and exclude untracked files; packages must exclude test/development material.
- README must work from the real repository entry page, on narrow screens and without images.

### Task 1: Align documentation and source responsibilities
Fix current release/AI status, label historical release-preparation documents, document repository ownership and directory roles. Keep dated evidence unchanged.
Verify links and review changed status statements; commit documentation separately.

### Task 2: Rebuild the README product presentation
Use native GitHub layout, one heading, exact approved value statement, textual download/help links, release status, then actual workbench screenshot. Follow with real JD input/output/manual review and five capabilities with validation boundaries. Preserve Chinese UI disclosure in English.
Verify local targets/anchors and desktop/mobile light/dark rendering; commit homepage separately.

### Task 3: Register checks and unify execution groups
Add a typed manifest (kind, runtime, platforms, groups, manual reason), validate inventory completeness, reuse manifest groups in runners and CI, classify previously unregistered checks. First prove missing/duplicate/manual-without-reason registrations fail.
Run registration behavior tests, suite membership comparison and targeted runner checks; commit registration separately.

### Task 4: Relocate files and preserve runtime contracts
Move root check files to tests/, checks support to tests/support/, fixture generator to tests/fixtures/, ASR benchmark to scripts/, runtime JS to src/, native tools to native/, old candidate HTML to src/legacy/. Keep forge.config.js and package files at root. Rewrite module/resource/process/documentation paths. Keep user data roots stable.
Update package inclusion/exclusion and release validations together. Test resource roots and package-input filtering with temporary fixtures.
Run full verify and compare to baseline, source startup, synthetic workflow and isolated package checks; commit migration separately.

### Task 5: Freeze source exports and verify delivery
Export source only from an explicit resolved Git commit; record commit identity and validate extracted tracked inventory. Prove untracked sentinel exclusion in a temporary repository. Build an isolated candidate and verify package manifest and synthetic persistence. Record Windows limitations independently.
Collect before/after visuals, exact check coverage and verification outcomes. Independent whole-branch review, fix important issues, push branch and create draft PR. Do not merge or overwrite release assets.
