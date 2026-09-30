# Zhaocai Guan — a local recruiting workspace for HR

**Keep résumés, candidates, and interview progress in one workspace.**

### [Download for Mac Apple Silicon (DMG)](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal.dmg)

**1.0.1 prerelease · Apple Silicon only · Not Apple-notarized**

[Installer checksums](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal-SHA256SUMS.txt) · [Alternative ZIP](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal.zip) · [Release notes and known limitations](https://github.com/denggui-ai/zhaocai-guan/releases/tag/v1.0.1-rc.1)

[中文](README.md) · [Actual interface walkthrough](docs/DEMO.md) · [Download sample materials](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-demo-materials-1.0.1.zip) · [Installation help](docs/GETTING_STARTED.md#install)

![The actual recruiting workspace with fictional jobs and candidates](docs/screenshots/workbench.png)

*The interface, sample materials, and full user guide are in Chinese. Start with TXT résumés without an AI key, a recruiting-platform account, or additional OCR/PDF tools.*

## Three everyday recruiting tasks

| Task | How the app helps |
|---|---|
| Organize résumé files | Import authorized materials into the right job, review the original text, and confirm candidate records |
| Follow candidate progress | Keep source materials and manual follow-up records together; HR decides the next step |
| Prepare interviews | Record interview schedules and retain interview, assessment, and talent-pool materials locally |

Built for HR users managing recruiting on their own Mac. There is no shared recruiting backend. The app is independent of BOSS Zhipin and other recruiting platforms: it does not log in, synchronize, scrape, automatically contact candidates, or make hiring decisions. You handle communications and invitations yourself.

## Try two fictional résumés first

[Download sample ZIP](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-demo-materials-1.0.1.zip) · [Sample checksum](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-demo-materials-1.0.1-SHA256SUMS.txt) · [Material list](docs/examples/README.md)

1. Create a fictional job, save and activate its JD, then save and confirm its hiring profile.
2. Import both TXT résumés; check the job, names, and source text before confirming each record.
3. Open the two candidates and their original materials. Optionally record a fictional interview manually.

**Completion check:** the correct job contains two candidates, their source materials open, and the records remain after a normal quit and restart. Follow the [step-by-step guide](docs/GETTING_STARTED.md#first-use). Samples do not predetermine ratings or hiring decisions.

## Platform and installation

| Platform | Current scope |
|---|---|
| Mac Apple Silicon / arm64 | [DMG prerelease](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal.dmg); not Apple-notarized |
| Mac Intel | Source only, not validated; no verified installer |
| Windows x64 | Experimental source, no installer; local recording and transcription disabled |
| Linux | Unsupported |

Verify the downloaded file's SHA-256, then move `招才官.app` into Applications. The app uses ad-hoc signing; follow the [documented macOS opening steps](docs/GETTING_STARTED.md#install) without disabling system-wide protection. Clean-Mac installation and real AI-provider validation remain outstanding; see the [verified scope and limitations](https://github.com/denggui-ai/zhaocai-guan/releases/tag/v1.0.1-rc.1).

Mac screenshot OCR requires a working Xcode command-line toolchain or Xcode. PDF features use Poppler; local recording/transcription requires SoX, whisper-cli, and a model. These optional tools are not bundled. Start with TXT and add [tools as needed](docs/GETTING_STARTED.md#optional-tools).

## Optional AI and local data

AI is off by default. To enable it, configure your own HTTPS OpenAI-compatible Chat Completions service and verify a model. No real-provider compatibility list has been validated. Material transmission requires separate confirmation; providers may charge and process materials under their terms. See [AI setup](docs/GETTING_STARTED.md#optional-ai).

Recruiting data is primarily local. Approved AI requests and optional authorized Feishu/Lark imports use external services. Before upgrading, quit the app and back up the complete data and any externally configured material directories. See [backup and recovery](docs/GETTING_STARTED.md#business-restore).

## Help and feedback

[Installation and usage FAQ](docs/GETTING_STARTED.md#help) · [Report a problem](https://github.com/denggui-ai/zhaocai-guan/issues/new?template=bug_report.yml) · [Suggest an improvement](https://github.com/denggui-ai/zhaocai-guan/issues/new?template=feature_request.yml) · [Roadmap](ROADMAP.md)

Tell us the version, Mac chip, step reached, and expected versus actual result, including whether the sample records were created successfully. Use fictional materials only; do not upload candidate information or credentials. Report vulnerabilities through the [security policy](SECURITY.md). GitHub sign-in is needed to submit an issue, not to download the app.

## For developers

Use Node.js 22 or later and npm; macOS also needs Xcode command-line tools:

```bash
npm ci
npx --no-install electron-rebuild -f -w better-sqlite3
npm run ui
```

See [development](DEVELOPMENT.md), [contributing](CONTRIBUTING.md), and [source guide](SOURCE-DEVELOPMENT-TUTORIAL.md). Licensed under [AGPL-3.0-only](LICENSE); dependencies retain their [respective licenses](THIRD_PARTY_NOTICES.md).
