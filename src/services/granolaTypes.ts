import * as v from "valibot";
import {
  TranscriptEntrySchema,
  FolderSchema,
  NoteSummarySchema,
  NoteDetailSchema,
  NoteAttachmentSchema,
} from "./validationSchemas";

export type TranscriptEntry = v.InferOutput<typeof TranscriptEntrySchema>;
export type GranolaFolder = v.InferOutput<typeof FolderSchema>;
export type NoteSummaryV1 = v.InferOutput<typeof NoteSummarySchema>;
export type NoteDetailV1 = v.InferOutput<typeof NoteDetailSchema>;
export type GranolaAttachment = v.InferOutput<typeof NoteAttachmentSchema> & {
  /** Vault-relative path after a successful download. */
  local_path?: string;
};

/**
 * Internal domain shape consumed by the sync pipeline (processor, file sync,
 * daily notes, path resolution). Built from a v1 NoteDetail by
 * noteDetailToGranolaDoc() in granolaApi.ts.
 */
export interface GranolaDoc {
  id: string;
  title: string | null;
  created_at?: string;
  updated_at?: string;
  /** Granola web app URL; its trailing UUID is the legacy internal doc id. */
  web_url?: string;
  people?: {
    attendees?: Array<{ name?: string; email?: string }>;
  };
  summary_markdown?: string | null;
  summary_text?: string;
  /**
   * The owner's own typed notes. Only returned when the API key belongs to
   * the user who created the note; null for everyone else.
   */
  private_notes_markdown?: string | null;
  private_notes_text?: string | null;
  /** IDs of folders this note belongs to (fol_…). */
  folder_ids?: string[];
  attachments?: GranolaAttachment[];
  /** Present when fetched with include=transcript. */
  transcript?: TranscriptEntry[] | null;
}
