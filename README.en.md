# 招才官 · Zhaocai Guan

**A desktop recruiting assistant for HR.**

Organize job requirements, résumés, candidates, and interview progress on your own computer. Import files and screenshots you are authorized to use, review the source material, and decide what happens next. The current interface and full user guide are in Chinese.

[中文](README.md) · [Getting started (Chinese)](docs/GETTING_STARTED.md) · [Fictional examples](docs/examples/README.md) · [Roadmap](ROADMAP.md)

**Status: 1.0.1 public-release candidate, not yet published.** There is no public installer download URL. A complete packaged HR workflow, clean-Mac installation, and real AI-provider validation remain outstanding; existing checks do not establish production readiness.

## What it does

- Maintain local jobs, versioned job descriptions, and HR-confirmed hiring profiles.
- Import local résumé files and review screenshot OCR drafts before creating candidate records.
- Keep source evidence, assessment materials, interview notes, and a talent pool together.
- Track candidates through decisions made by HR. Optional AI assists with drafts and analysis.

The app is independent of BOSS Zhipin and other recruiting platforms. It does not log in to platform accounts, synchronize or scrape them, contact candidates automatically, or make hiring decisions.

## Platform status

| Platform | Current scope |
|---|---|
| macOS Apple Silicon / arm64 | Initial-release target; candidate not published or notarized |
| macOS Intel | Source only, not validated |
| Windows x64 | Experimental source; no first-release installer; local recording and transcription disabled |
| Linux | Unsupported |

For a verified Mac candidate, follow the [installation guide](docs/GETTING_STARTED.md#install) and its included checksum instructions. The application is named `招才官.app`. The candidate uses local ad-hoc signing and is not Apple-notarized. Follow the documented macOS security flow without disabling system-wide protection.

## Start without an AI account

The [example set](docs/examples/README.md) contains a fictional job description, a hiring profile reference, and two UTF-8 TXT résumés. TXT import does not require an AI key, recruiting-platform account, PDF/OCR tools, or a microphone.

Mac screenshot OCR requires an operational Xcode command-line toolchain for its Swift/Vision helper. PDF features use Poppler; Mac recording and transcription require SoX, whisper-cli, and a local model. These optional tools are not bundled. See [requirements](docs/GETTING_STARTED.md#optional-tools).

AI is disabled by default. Users may configure their own HTTPS OpenAI-compatible Chat Completions service, verify a model, and enable it. Sending candidate material requires separate confirmation. No real-provider compatibility list has been validated for this candidate; providers may charge for requests and process the material under their own terms.

## Data and development

Recruiting data is primarily stored locally; the project does not provide a shared recruiting backend. Approved AI requests and optional authorized Feishu/Lark imports use external services. Back up the complete data directory and any externally configured database or material directories before upgrading. Never include candidate data or credentials in public reports.

For developers, install Node.js 22 or later and npm; macOS also needs Xcode command-line tools:

```bash
npm ci
npx --no-install electron-rebuild -f -w better-sqlite3
npm run ui
```

See [development](DEVELOPMENT.md), [contributing](CONTRIBUTING.md), and [security reporting](SECURITY.md). The project is licensed under [AGPL-3.0-only](LICENSE); dependencies retain their [respective licenses](THIRD_PARTY_NOTICES.md).
