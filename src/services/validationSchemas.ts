import * as v from "valibot";

// --- Granola public API v1 schemas (https://public-api.granola.ai/v1) ---
//
// Schemas are deliberately loose (no object-type literals, unknown keys are
// ignored) so additive API changes don't break syncs. `owner` is
// intentionally unmodeled — nothing consumes it.

export const UserSchema = v.object({
  name: v.nullish(v.string()),
  email: v.nullish(v.string()),
});

/**
 * The calendar event a note was recorded against. Only the fields people
 * tools need to join a note to its calendar meeting are modeled; `invitees`
 * is left out because the API returns it empty.
 */
export const CalendarEventSchema = v.object({
  calendar_event_id: v.nullish(v.string()),
  event_title: v.nullish(v.string()),
  scheduled_start_time: v.nullish(v.string()),
});

export const FolderSchema = v.object({
  id: v.string(),
  name: v.string(),
  parent_folder_id: v.nullish(v.string()),
});

export const SpeakerSchema = v.object({
  source: v.string(),
  diarization_label: v.optional(v.string()),
  name: v.optional(v.string()),
});

export const TranscriptEntrySchema = v.object({
  speaker: SpeakerSchema,
  text: v.string(),
  start_time: v.string(),
  end_time: v.string(),
});

export const NoteAttachmentSchema = v.object({
  id: v.string(),
  object: v.literal("attachment"),
  // Granola documents photo today; screenshot has also started appearing.
  // Keep this open so future types can be ignored without failing the note.
  type: v.string(),
  url: v.string(),
  width: v.number(),
  height: v.number(),
});

export const NoteSummarySchema = v.object({
  id: v.string(),
  title: v.nullish(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
});

export const NoteDetailSchema = v.object({
  id: v.string(),
  title: v.nullish(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
  web_url: v.nullish(v.string()),
  attendees: v.optional(v.array(UserSchema), []),
  calendar_event: v.nullish(CalendarEventSchema),
  folder_membership: v.optional(v.array(FolderSchema), []),
  attachments: v.optional(v.array(NoteAttachmentSchema), []),
  summary_text: v.nullish(v.string()),
  summary_markdown: v.nullish(v.string()),
  /** The owner's own typed notes; only present when the API key belongs to the note's creator. */
  private_notes_text: v.nullish(v.string()),
  private_notes_markdown: v.nullish(v.string()),
  transcript: v.nullish(v.array(TranscriptEntrySchema)),
});

export const ListNotesResponseSchema = v.object({
  notes: v.array(NoteSummarySchema),
  hasMore: v.boolean(),
  cursor: v.nullish(v.string()),
});

export const ListFoldersResponseSchema = v.object({
  folders: v.array(FolderSchema),
  hasMore: v.boolean(),
  cursor: v.nullish(v.string()),
});

/** Full transcript pages use the same entries as an inline transcript. */
export const GetTranscriptResponseSchema = v.object({
  transcript: v.array(TranscriptEntrySchema),
  hasMore: v.boolean(),
  cursor: v.nullish(v.string()),
});
