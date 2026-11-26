# Granola API review and product opportunities — 2026-11-26

## Evidence and comparison limits

This first automated audit compares the supplied November 12 baseline (changelog
v1.6.0, October 2026) with the current v1.7.0 specification. There is no saved
November 12 OpenAPI document, so exact schema additions and formatting-only
changes cannot be reconstructed. Future runs have a saved public-doc snapshot.

Sources: [introduction](https://docs.granola.ai/introduction),
[changelog](https://docs.granola.ai/api-reference/changelog),
[documentation index](https://docs.granola.ai/llms.txt),
[OpenAPI](https://docs.granola.ai/api-reference/openapi.json).

Documented substantive v1.7 changes: transcript keyword search with optional
`note_ids`, transcript `from_time`, improved phone/watch timestamps and speaker
line splitting, an iOS missing-lines fix, and screenshot attachments with
`captured_at` and `description`. Timing and missing-lines fixes are server-side;
the plugin already accepts string timestamps and diarization labels. Current
main already downloads photo/screenshot attachments. It does not yet use screenshot
capture metadata. No extra settings are necessary for the recording fixes.

The index also documents analytics, audit, legal holds, workspace keys, and
webhooks. Without an older snapshot these cannot all be dated as new changes.
Analytics/audit/legal holds serve workspace administration and compliance rather
than note sync; defer UI for them. Notes-by-ID-only keys cannot enumerate notes,
so a successful connection test does not imply useful bulk-sync scope.

## Implemented: complete large transcript recovery

**Need:** long meetings must sync with their full transcript, including in combined
notes and daily notes. Previously an inline fetch failure skipped the whole note.

**Documented contract:** v1.4 introduced HTTP 413 `TRANSCRIPT_TOO_LARGE` and the
[paginated transcript endpoint](https://docs.granola.ai/api-reference/get-transcript).
The public spec documents the status but no structured error-body schema.

**Chosen design:** keep the fast inline request; on 413 with transcripts enabled,
fetch note metadata without `include`, validate each transcript page, and return
the normal domain object only after all pages succeed. Existing sync code then
uses the same formatting, attachment handling, paths, and cross-links. Requests
retain throttling, retries and API-key authentication. Empty pages may continue;
missing or repeated continuation cursors fail explicitly. Authentication,
permission, validation and network failures propagate through existing sync error
handling, with no partial transcript returned for writing.

**Alternatives:** always use the paginated endpoint (extra requests for every
meeting); skip large transcripts (loses content). Automatic fallback is the
smallest useful slice. No settings or migration. Existing skipped notes are
retried on the next sync in the configured date window; Full sync includes older
notes. Tests use synthetic HTTP responses, never a personal key or live API.

## Opportunity: opt-in Agent Brief snapshot (proposal, not implemented)

**User need:** keep a readable, current personal context note for planning and
local agents, without manually copying priorities and relationship context.
Agent Briefs summarize the user's context across meetings; they are distinct
from the older pre-meeting briefs for an upcoming meeting.

**Documented behavior:** the [Agent brief help page](https://docs.granola.ai/help-center/customising-granola/agent-brief.md)
and [MCP documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp.md)
now explicitly document `get_agent_brief` over Granola MCP for Business and
Enterprise. Enterprise admins can disable access via “Read About Me profiles”.
Briefs include priorities, relationships, projects, glossary, habits, communication
style and identity; users can correct cards. Gmail may also contribute context.
Granola starts a brief after ten transcribed meetings and refreshes it overnight.
MCP uses OAuth 2.0 and Dynamic Client Registration (DCR), not REST API keys.
The REST OpenAPI paths and schemas contain no Agent Brief endpoint. The
[announcement watch item](https://x.com/meetgranola/status/2120551910789046391)
was inaccessible (403); it is not used as endpoint evidence.

**Proposed experience (idea):** a disabled-by-default “Sync Agent Brief” capability
with a preview and explicit destination such as `Granola Context/Agent Brief.md`.
Explain that saving locally copies sensitive cross-meeting and potentially Gmail
context into a vault, where other plugins, backups and vault sharing can read it.
Offer a manual refresh first; no automatic per-meeting fetches or write-back.

**Proposed data flow (assumption requiring a feasibility spike):** independent
Granola MCP OAuth connection → verify availability/permission → `get_agent_brief`
→ validate the documented/discovered tool result → preview → replace one managed
Markdown snapshot. Store account/workspace identity and fetched time as metadata;
only store a source refresh time if the tool actually supplies one. Keep access
tokens out of Markdown and logs. Do not reuse the REST key as an MCP credential.

**Settings/migration:** separate connection and opt-in flag, explicit destination,
clear disconnect behavior. Existing sync settings remain compatible. No migration
of meeting notes. Define a safe token store and desktop/mobile support before
shipping. This PR does not initiate OAuth or retrieve personal brief content.

**Edge cases:** insufficient meetings, unsupported plan, disabled admin permission,
revoked login, workspace/account switch, empty brief, correction/deletion, stale
response, edited destination and offline use. Keep the last snapshot on failures
and visibly mark its age; do not overwrite local edits without a conflict rule.
A remote revocation cannot retract copies already in backups.

**Alternatives/tradeoffs:** wait for a REST endpoint (fits current architecture but
no timeline); MCP OAuth (supported retrieval, larger auth and lifecycle scope);
manual user paste (works now, no refresh guarantee). Avoid private endpoints or
an invented REST route. Existing connected tools in an assistant environment do
not supply an OAuth implementation or portable credentials to an Obsidian plugin.

**Recommended first slice:** a separate MCP feasibility spike to verify the DCR/OAuth flow in Obsidian, tool result schema, permissions, workspace identity and safe token
storage, followed by a manual preview/export command if feasible. Keep it out of
this reliability PR: the REST-only plugin has no MCP client or OAuth lifecycle.

**Open questions:** can Obsidian desktop/mobile complete the documented DCR/OAuth
flow reliably, including redirects? Does the tool identify workspace and source refresh time? Can the
user choose cards? Should disconnect optionally delete the local snapshot? What
conflict policy best protects user edits? These are unresolved, not API promises.

## Opportunity: find and import a transcript passage (proposal)

**Need:** retrieve a decision from an older unsynced meeting without importing all
meeting history. [Search transcripts](https://docs.granola.ai/api-reference/search-transcripts)
returns matching notes with short excerpts; `from_time` on Get Transcript starts
at the relevant passage. This is an additive search workflow, not a replacement
for List Notes, which remains appropriate for complete sync.

**Proposed experience/data flow:** a manual “Find in Granola transcripts” command
accepts keywords and optional dates → cursor-paginated search → excerpt picker →
fetch the selected note and its complete transcript through normal sync. Show
excerpts as previews only, never as a complete transcript. A later read-only
passage viewer could use `from_time` without creating truncated synced files.

**Settings/migration:** reuse current API key, destinations, conflict handling and
sync format; no automatic query history storage. Keep result previews out of logs.
Search respects key scope; Notes-by-ID-only keys return no search results.
Handle cursor expiry, empty intermediate pages, incomplete search status,
indexing lag, duplicate results and access changes between search and import.

**Alternatives/tradeoffs:** local vault search is fast and offline but cannot find
unsynced meetings; narrowing date-range sync is simpler but imports unrelated
notes. Recommend a manual search-and-preview command first, with full-note import
only after explicit selection. Open questions: query UX, scope filters, and
whether preview alone solves enough of the need to postpone importing.

## Other follow-ups

- Space filters could reduce unwanted imports, but require a separate scope UX
  and a clear migration policy for notes that move between spaces.
- Webhooks could reduce polling delay but require a reachable HTTPS receiver and
  signing-secret management; a local Obsidian plugin should not register a public
  receiver automatically. Defer unless a companion service is explicitly wanted.
- Screenshot capture time/descriptions may help navigation later; current image
  downloads already preserve useful content, so no extra UI in this PR.
