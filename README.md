# Obsidian Granola Sync

[![Release](https://github.com/tomelliot/obsidian-granola-sync/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/tomelliot/obsidian-granola-sync/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/tomelliot/obsidian-granola-sync/graph/badge.svg?token=UALN2224PQ)](https://codecov.io/gh/tomelliot/obsidian-granola-sync)

<a href="https://buymeacoffee.com/kayaic"><img src="assets/bmc-button.svg" alt="Buy Me A Coffee" height="60"></a>

> [!IMPORTANT]
> **Upgrading from 2.0.x? The plugin now connects differently.** Granola broke the old credential-based login in app version 7.427.0, so as of 2.1.0 this plugin uses Granola's **official API** instead. You'll need to create an API key in the Granola desktop app (**Settings → Connectors → API keys** — note that API keys require a **paid Granola plan**) and paste it into the plugin settings. Everything else — your synced notes and settings — carries over untouched.

This plugin pulls your [Granola](https://granola.ai) meeting notes and transcripts into your Obsidian vault as plain Markdown - so they're searchable, linkable, and yours to keep, instead of locked away in Granola, separate from everything else you know.

The most actively maintained Granola sync plugin, and the one that gets the details right: it syncs reliably, never leaves you with duplicate notes, and keeps everything neatly organised the way you set it up. It's built on a clean, well-tested codebase, so syncs just work and stay working.

This repo is maintained by [@kayacancode](https://github.com/kayacancode). [Tom Elliot](https://github.com/tomelliot), the plugin's original creator, is now working on [All Ears](https://github.com/tomelliot/all-ears): command-line tools for meeting capture, transcription, cleanup, and summarisation that read and write plain files.

## Now built on the official Granola API

As of version 2.1.0 the plugin authenticates with a personal API key against Granola's **official public API** (`public-api.granola.ai`), replacing the old approach of decrypting the desktop app's local credential store (which Granola 7.427.0 broke). That means:

- **No desktop app required** on the machine running Obsidian — the plugin talks straight to the API.
- **No keychain/DPAPI prompts** and no credential decryption — just paste a key.
- **AI summaries as the source of truth** — note bodies come from Granola's `summary_markdown` rather than a conversion of the raw note content, and only meetings with a finished AI summary and transcript come through.
- **Private notes are opt-in** — the notes you typed yourself can be synced above the summary by turning on **Sync private notes** (off by default). Granola only returns them for meetings you own, using a personal API key.
- The old "Include private notes" and "Include shared notes" settings were removed — access is governed by your API key's scope instead.

## Features

- Sync notes to daily-note sections or individual files, with configurable folders, subfolder patterns, and filename patterns
- Optional private-notes syncing: your own typed notes, placed above the AI summary in the same file
- Transcript syncing: separate files, same location as notes, or combined into the note
- Automatic bidirectional linking between notes and transcripts
- Periodic automatic syncing with a customizable interval
- Title-based include/exclude filtering and a sync-history window
- Rate-limit aware: batches requests within the public API's limits and retries on `429`
- **Platform support:** This plugin only works on desktop. It is not supported on mobile.

## Installation

1. Go to [https://community.obsidian.md/plugins/granola-sync](https://community.obsidian.md/plugins/granola-sync)
2. Click Install

## Setup

1. In the Granola desktop app, go to **Settings → Connectors → API keys** and create a new key with the **Personal notes** scope. (Enterprise workspaces need an admin to enable API keys first.)
2. In Obsidian, open the plugin settings and paste the key (`grn_…`) into **Granola API key**.
3. Click **Test connection** to confirm it works.
4. Run the command **Sync from Granola**, or enable periodic sync.

## Upgrading from 2.0.x

- Your settings are kept — you only need to add an API key (see Setup above).
- Your existing synced files are **updated in place, not duplicated**. The public API uses new note IDs, but each note's `web_url` carries the old internal ID, so the first sync re-keys existing files (matched by their `granola_id` frontmatter, with a target-path fallback) to the new IDs.
- Settings that no longer apply (credential paths, private/shared-notes toggles) are cleaned up automatically on load.

## What syncs

- Meetings that have a **generated AI summary and transcript** — that's what the public API returns. Notes still processing (or without a summary) are skipped until Granola finishes them.
- The note body is the **AI-enhanced summary** (`summary_markdown`).
- **Private notes** (optional): the notes you typed yourself during the meeting. Turn on **Sync private notes** and they are written above the summary in the same file, under a `Private notes` heading, with the summary under a `Summary` heading. Granola returns them only when your API key is a personal key and you own the meeting — shared or teammate-owned meetings sync exactly as before. Existing notes pick them up on the next **Full sync**.
- **Photos and screenshots**: images returned in Get Note's `attachments` array are downloaded to `Granola Attachments/<note ID>/` and embedded in the note in Granola's stored order. Existing images are reused on later syncs. Run a **Full sync** to add images to notes that were already synced before this release.
- **Transcripts** (optional), with speaker names when Granola can identify them.
- **Folders**: notes carry their Granola folder membership in frontmatter, including nested paths.
- Attendees, timestamps, and a `web_url` link back to the note in the Granola web app.

## Frontmatter structure

All synced files include structured frontmatter for tracking and deduplication:

**Notes:**
```yaml
---
granola_id: not_1d3tmYTlCICgjy
title: "Meeting Title"
type: note
created: 2024-01-15T10:00:00Z
updated: 2024-01-15T12:00:00Z
attendees:
  - John Doe
  - Jane Smith
web_url: https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c
transcript: "[[Transcripts/Meeting Title-transcript.md]]"
---
```

**Transcripts:**
```yaml
---
granola_id: not_1d3tmYTlCICgjy
title: "Meeting Title - Transcript"
type: transcript
created: 2024-01-15T10:00:00Z
updated: 2024-01-15T12:00:00Z
attendees:
  - John Doe
  - Jane Smith
note: "[[Granola/Meeting Title.md]]"
---
```

The `granola_id` is consistent across both note and transcript files for the same meeting, while the `type` field distinguishes them.

## Development

### Prerequisites

- Node.js 18 or later
- pnpm

### Setup and building

```bash
pnpm install
pnpm build
```

### Testing

```bash
pnpm test            # run all tests
pnpm test:watch      # watch mode
pnpm test:coverage   # with coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

### Releasing

```bash
node scripts/release.js        # auto-bump patch version
node scripts/release.js 2.1.1  # specific version
```

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for info on contributing to this project.

## License

MIT

## Disclaimer

This plugin is an independent project and is not affiliated with, endorsed by, or sponsored by Granola. It uses Granola's official public API with an API key you create in your own account. Do not use this plugin in any way that breaks [Granola's Terms of Service](https://www.granola.ai/terms) — you are responsible for ensuring your use complies with them.
