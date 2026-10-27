import { GranolaDoc } from "./granolaApi";
import {
  getTitleOrDefault,
  resolveFilenamePattern,
} from "../utils/filenameUtils";
import { getEffectiveUpdatedAt } from "../utils/dateUtils";
import { PathResolver } from "./pathResolver";
import {
  buildTitleYaml,
  formatAttendeesAsYaml,
  formatStringListAsYaml,
} from "../utils/yamlUtils";

export interface DocumentProcessorSettings {
  syncTranscripts: boolean;
  /**
   * Include the owner's own typed notes (`private_notes_*`) above the AI
   * summary. The API only returns them for notes the key's user created.
   */
  syncPrivateNotes: boolean;
}

/** Section headings used when a note body has more than one part. */
const PRIVATE_NOTES_HEADING = "Private notes";
const SUMMARY_HEADING = "Summary";
const ATTACHMENTS_HEADING = "Attachments";

function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

/**
 * Metadata for a note document
 */
export interface NoteMetadata {
  granolaId: string;
  title: string;
  type: "note" | "combined" | "transcript";
  createdAt?: string;
  updatedAt?: string;
  attendees: string[];
  transcript?: string;
  folders?: string[];
  webUrl?: string;
}

/**
 * Options for building note metadata
 */
export interface MetadataOptions {
  type: "note" | "combined" | "transcript";
  transcriptPath?: string;
  folders?: string[];
}

/**
 * Options for building note body
 */
export interface BodyOptions {
  headingLevel: number;
}

/**
 * Service for processing Granola documents into Obsidian-ready markdown.
 * Handles frontmatter generation, transcript linking, and content formatting.
 */
export class DocumentProcessor {
  constructor(
    private settings: DocumentProcessorSettings,
    private pathResolver: PathResolver
  ) {}

  /**
   * Builds metadata for a note document.
   *
   * @param doc - The Granola document to process
   * @param options - Metadata options including type and transcript path
   * @returns Structured metadata object
   */
  buildNoteMetadata(doc: GranolaDoc, options: MetadataOptions): NoteMetadata {
    const title = getTitleOrDefault(doc);
    const granolaId = doc.id || "unknown_id";
    const attendees =
      doc.people?.attendees
        ?.map((attendee) => attendee.name || attendee.email || "Unknown")
        .filter((name) => name !== "Unknown") || [];

    const metadata: NoteMetadata = {
      granolaId,
      title,
      type: options.type,
      createdAt: doc.created_at,
      updatedAt: getEffectiveUpdatedAt(doc),
      attendees,
      webUrl: doc.web_url,
    };

    // Add transcript link if provided (only for individual note files)
    if (this.settings.syncTranscripts && options.transcriptPath) {
      metadata.transcript = options.transcriptPath;
    }

    // Add folder paths if provided and non-empty
    if (options.folders && options.folders.length > 0) {
      metadata.folders = options.folders;
    }

    return metadata;
  }

  /**
   * The AI summary as ready-made markdown (`summary_markdown`), falling back
   * to the plain `summary_text`. Null when the note has no summary content.
   */
  getSummaryMarkdown(doc: GranolaDoc): string | null {
    if (doc.summary_markdown?.trim()) {
      return doc.summary_markdown;
    }
    if (doc.summary_text?.trim()) {
      return doc.summary_text;
    }
    return null;
  }

  /**
   * The owner's own typed notes as markdown, falling back to plain text.
   * Null when the setting is off or the API returned none (the key's user is
   * not the note's owner, or nothing was typed).
   */
  getPrivateNotesMarkdown(doc: GranolaDoc): string | null {
    if (!this.settings.syncPrivateNotes) {
      return null;
    }
    if (doc.private_notes_markdown?.trim()) {
      return doc.private_notes_markdown;
    }
    if (doc.private_notes_text?.trim()) {
      return doc.private_notes_text;
    }
    return null;
  }

  private getAttachmentSection(doc: GranolaDoc, headingLevel: number): string | null {
    const embeds = doc.attachments
      ?.filter((attachment) => attachment.local_path)
      .map((attachment) => `![[${attachment.local_path}]]`) ?? [];
    if (embeds.length === 0) return null;
    return `${heading(headingLevel, ATTACHMENTS_HEADING)}\n\n${embeds.join("\n\n")}`;
  }

  /**
   * Builds the body content for a note.
   *
   * With no private notes the body is the summary verbatim, so files stay
   * byte-identical to earlier versions. When private notes are present they
   * go first, and both parts get a heading at `options.headingLevel` so a
   * reader can tell their own notes from the AI summary.
   *
   * @param doc - The Granola document to process
   * @param options - Heading level for the section headings
   * @returns The markdown body, or null when the note has no content at all
   */
  buildNoteBody(doc: GranolaDoc, options: BodyOptions): string | null {
    const summary = this.getSummaryMarkdown(doc);
    const privateNotes = this.getPrivateNotesMarkdown(doc);
    const attachments = this.getAttachmentSection(doc, options.headingLevel);
    if (privateNotes === null && attachments === null) {
      return summary;
    }

    const sections: string[] = [];
    if (privateNotes !== null) {
      sections.push(`${heading(options.headingLevel, PRIVATE_NOTES_HEADING)}\n\n${privateNotes}`);
    }
    if (summary !== null) {
      sections.push(privateNotes !== null
        ? `${heading(options.headingLevel, SUMMARY_HEADING)}\n\n${summary}`
        : summary);
    }
    if (attachments !== null) sections.push(attachments);
    return sections.join("\n\n");
  }

  /**
   * Prepares a note document for saving, including frontmatter.
   *
   * The transcript link is not set here: for separate-file transcripts it is
   * written post-hoc by updateCrossLinks() using the actual on-disk path (which
   * may differ from the computed path after collision resolution).
   *
   * @param doc - The Granola document to process
   * @returns Object containing the filename and full markdown content
   */
  prepareNote(
    doc: GranolaDoc,
    folders?: string[]
  ): { filename: string; content: string } | null {
    // Build body first — if there's no summary content, bail out early
    const body = this.buildNoteBody(doc, { headingLevel: 2 });
    if (body === null) {
      return null;
    }

    // Build metadata using shared builder
    const metadata = this.buildNoteMetadata(doc, {
      type: "note",
      folders,
    });

    // Prepare frontmatter
    const frontmatterLines = [
      "---",
      `granola_id: ${metadata.granolaId}`,
      buildTitleYaml(metadata.title),
      `type: ${metadata.type}`,
    ];
    if (metadata.createdAt) frontmatterLines.push(`created: ${metadata.createdAt}`);
    if (metadata.updatedAt) frontmatterLines.push(`updated: ${metadata.updatedAt}`);
    frontmatterLines.push(`attendees: ${formatAttendeesAsYaml(metadata.attendees)}`);
    if (metadata.webUrl) frontmatterLines.push(`web_url: ${metadata.webUrl}`);

    // Add transcript link to frontmatter if provided
    if (metadata.transcript) {
      frontmatterLines.push(`transcript: "[[${metadata.transcript}]]"`);
    }

    // Add folder paths if present
    if (metadata.folders && metadata.folders.length > 0) {
      frontmatterLines.push(
        `folders: ${formatStringListAsYaml(metadata.folders)}`
      );
    }

    frontmatterLines.push("---", "");

    const finalMarkdown = frontmatterLines.join("\n") + body;

    const filenamePattern = this.pathResolver.getNoteFilenamePattern();
    const filename = resolveFilenamePattern(doc, filenamePattern);

    return { filename, content: finalMarkdown };
  }

  /**
   * Prepares a transcript document for saving.
   *
   * @param doc - The Granola document
   * @param transcriptContent - The formatted transcript content
   * @returns Object containing the filename and content
   */
  prepareTranscript(
    doc: GranolaDoc,
    transcriptContent: string
  ): { filename: string; content: string } {
    const filenamePattern =
      this.pathResolver.computeTranscriptFilenamePattern();
    const filename = resolveFilenamePattern(doc, filenamePattern);

    return { filename, content: transcriptContent };
  }

  /**
   * Prepares a combined note and transcript document for saving.
   * Combines note content and transcript content in a single file with separate headings.
   *
   * @param doc - The Granola document to process
   * @param transcriptContent - The formatted transcript body content (without frontmatter)
   * @returns Object containing the filename and full markdown content
   */
  prepareCombinedNote(
    doc: GranolaDoc,
    transcriptContent: string,
    folders?: string[]
  ): { filename: string; content: string } | null {
    // Build body parts first — if there's no content at all, bail out early
    const summary = this.getSummaryMarkdown(doc);
    const privateNotes = this.getPrivateNotesMarkdown(doc);
    const attachments = this.getAttachmentSection(doc, 2);
    if (summary === null && privateNotes === null && attachments === null) {
      return null;
    }

    // Build metadata using shared builder
    const metadata = this.buildNoteMetadata(doc, { type: "combined", folders });

    // Prepare frontmatter with type: combined
    const frontmatterLines = [
      "---",
      `granola_id: ${metadata.granolaId}`,
      buildTitleYaml(metadata.title),
      `type: ${metadata.type}`,
    ];
    if (metadata.createdAt) frontmatterLines.push(`created: ${metadata.createdAt}`);
    if (metadata.updatedAt) frontmatterLines.push(`updated: ${metadata.updatedAt}`);
    frontmatterLines.push(`attendees: ${formatAttendeesAsYaml(metadata.attendees)}`);
    if (metadata.webUrl) frontmatterLines.push(`web_url: ${metadata.webUrl}`);

    // Note: Combined files do NOT include transcript or note link fields in frontmatter

    // Add folder paths if present
    if (metadata.folders && metadata.folders.length > 0) {
      frontmatterLines.push(
        `folders: ${formatStringListAsYaml(metadata.folders)}`
      );
    }

    frontmatterLines.push("---", "");

    let finalMarkdown = frontmatterLines.join("\n");

    // Private notes (when enabled and present) sit above the AI summary
    if (privateNotes !== null) {
      finalMarkdown += `${heading(2, PRIVATE_NOTES_HEADING)}\n\n`;
      finalMarkdown += privateNotes;
      finalMarkdown += "\n\n";
    }

    if (summary !== null) {
      finalMarkdown += "## Note\n\n";
      finalMarkdown += summary;
      finalMarkdown += "\n\n";
    }

    if (attachments !== null) {
      finalMarkdown += attachments + "\n\n";
    }

    // Add transcript content at the end with heading
    finalMarkdown += "## Transcript\n\n";
    finalMarkdown += transcriptContent;

    const filenamePattern = this.pathResolver.getNoteFilenamePattern();
    const filename = resolveFilenamePattern(doc, filenamePattern);

    return { filename, content: finalMarkdown };
  }

  /**
   * Extracts note information for daily note sections.
   *
   * @param doc - The Granola document
   * @param transcriptLink - Optional transcript link (e.g., "[[#Transcript]]" for daily note sections)
   * @returns Note data for daily note section building with full metadata
   */
  extractNoteForDailyNote(
    doc: GranolaDoc,
    transcriptLink?: string,
    folders?: string[]
  ): {
    title: string;
    docId: string;
    type: string;
    createdAt?: string;
    updatedAt?: string;
    attendees: string[];
    transcript?: string;
    folders?: string[];
    markdown: string;
  } | null {
    // Build body first — if there's no summary content, bail out early
    const body = this.buildNoteBody(doc, { headingLevel: 3 });
    if (body === null) {
      return null;
    }

    // Build metadata using shared builder
    const metadata = this.buildNoteMetadata(doc, {
      type: "note",
      transcriptPath: transcriptLink,
      folders,
    });

    return {
      title: metadata.title,
      docId: metadata.granolaId,
      type: metadata.type,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      attendees: metadata.attendees,
      transcript: metadata.transcript,
      folders: metadata.folders,
      markdown: body,
    };
  }
}
