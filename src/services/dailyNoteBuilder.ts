import { App, TFile, Notice } from "obsidian";
import {
  createDailyNote,
  getDailyNote,
  getAllDailyNotes,
} from "obsidian-daily-notes-interface";
import { moment } from "../utils/moment";
import { GranolaDoc } from "./granolaApi";
import { getNoteDate } from "../utils/dateUtils";
import { DocumentProcessor } from "./documentProcessor";
import { demoteHeadings, updateSection } from "../utils/textUtils";
import { log } from "../utils/logger";

export interface NoteData {
  title: string;
  docId: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
  attendees: string[];
  transcript?: string;
  folders?: string[];
  markdown: string;
}

export interface NoteLinkData {
  title: string;
  filePath: string;
  time?: string; // HH:MM format
  /** Granola document ID; used for deduplication (source of truth: FileSyncService.granolaIdCache) */
  granolaId?: string;
}

/**
 * Service for building and managing daily notes with Granola content.
 * Handles grouping notes by date, building section content, and updating daily notes.
 */
export class DailyNoteBuilder {
  constructor(private app: App, private documentProcessor: DocumentProcessor) {}

  /**
   * Extracts existing Granola IDs and their updated_at timestamps from a daily note section.
   * Note: This method focuses on extracting the minimal info needed for change detection.
   * It parses Type, Attendees, and Transcript fields if present for completeness,
   * but only Granola ID and Updated timestamp are used for comparison.
   *
   * @param fileContent - The content of the daily note file
   * @param sectionHeading - The section heading to look for
   * @returns Map of Granola IDs to their updated_at timestamps
   */
  extractExistingNotes(
    fileContent: string,
    sectionHeading: string
  ): Map<string, string | undefined> {
    const existingNotes = new Map<string, string | undefined>();
    const lines = fileContent.split("\n");
    const headingLevel = lines
      .find((line) => line.trim() === sectionHeading)
      ?.match(/^(#{1,6})\s/)?.[1].length;

    if (!headingLevel) {
      return existingNotes; // Section doesn't exist
    }

    let inSection = false;
    let currentGranolaId: string | null = null;
    let currentUpdatedAt: string | undefined = undefined;

    for (const line of lines) {
      if (line.trim() === sectionHeading) {
        inSection = true;
        continue;
      }

      if (inSection) {
        // Check if we've reached the next section at the same or higher level
        const currentLevel = line.match(/^(#{1,6})\s/)?.[1].length;
        if (currentLevel && currentLevel <= headingLevel) {
          // Save the last note if we have one
          if (currentGranolaId) {
            existingNotes.set(currentGranolaId, currentUpdatedAt);
          }
          break; // End of section
        }

        // Look for Granola ID pattern
        const idMatch = line.match(/^\*\*Granola ID:\*\*\s+(.+)$/);
        if (idMatch) {
          // Save previous note if exists
          if (currentGranolaId) {
            existingNotes.set(currentGranolaId, currentUpdatedAt);
          }
          currentGranolaId = idMatch[1].trim();
          currentUpdatedAt = undefined;
        }

        // Look for Updated timestamp pattern
        const updatedMatch = line.match(/^\*\*Updated:\*\*\s+(.+)$/);
        if (updatedMatch && currentGranolaId) {
          currentUpdatedAt = updatedMatch[1].trim();
        }

        // We could parse Type, Attendees, and Transcript here if needed for future features
        // For now, we only need Updated timestamp for change detection
      }
    }

    // Don't forget the last note
    if (currentGranolaId) {
      existingNotes.set(currentGranolaId, currentUpdatedAt);
    }

    return existingNotes;
  }

  /**
   * Groups documents by their date and extracts note data for each.
   *
   * @param documents - Array of Granola documents to process
   * @returns Map of date keys (YYYY-MM-DD) to arrays of note data with their source documents
   */
  buildDailyNotesMap(
    documents: GranolaDoc[],
    docFolders: Record<string, string[]> = {}
  ): Map<string, Array<{ noteData: NoteData; doc: GranolaDoc }>> {
    const dailyNotesMap = new Map<
      string,
      Array<{ noteData: NoteData; doc: GranolaDoc }>
    >();

    for (const doc of documents) {
      const folders = docFolders[doc.id];
      const noteData = this.documentProcessor.extractNoteForDailyNote(
        doc,
        undefined,
        folders
      );
      if (!noteData) {
        log.debug(`Skipping doc ${doc.id} in daily notes — no parseable content`);
        continue;
      }

      const noteDate = getNoteDate(doc);
      const mapKey = moment(noteDate).format("YYYY-MM-DD");

      if (!dailyNotesMap.has(mapKey)) {
        dailyNotesMap.set(mapKey, []);
      }

      dailyNotesMap.get(mapKey)!.push({ noteData, doc });
    }

    return dailyNotesMap;
  }

  /**
   * Gets or creates a daily note for the given date.
   *
   * @param dateKey - Date key in YYYY-MM-DD format
   * @returns The daily note file
   */
  async getOrCreateDailyNote(dateKey: string): Promise<TFile> {
    const noteMoment = moment(dateKey, "YYYY-MM-DD");
    let dailyNoteFile = getDailyNote(noteMoment, getAllDailyNotes());

    if (!dailyNoteFile) {
      dailyNoteFile = await createDailyNote(noteMoment);
    }

    return dailyNoteFile;
  }

  /**
   * Builds the section content for a daily note with the given notes.
   *
   * @param notesForDay - Array of note data for the day
   * @param sectionHeading - The heading to use for the section
   * @returns The formatted section content
   */
  buildDailyNoteSectionContent(
    notesForDay: NoteData[],
    sectionHeading: string
  ): string {
    if (notesForDay.length === 0) {
      return sectionHeading;
    }

    // Determine the section heading level
    const sectionLevel =
      sectionHeading.match(/^(#{1,6})\s/)?.[1].length || 2;
    const noteHeadingLevel = Math.min(sectionLevel + 1, 6); // One level deeper, max 6
    const noteHeadingPrefix = "#".repeat(noteHeadingLevel);

    let content = sectionHeading;

    for (const note of notesForDay) {
      content += `\n${noteHeadingPrefix} ${note.title}\n`;
      content += `**Granola ID:** ${note.docId}\n`;

      if (note.type) {
        content += `**Type:** ${note.type}\n`;
      }

      if (note.createdAt) {
        content += `**Created:** ${note.createdAt}\n`;
      }
      if (note.updatedAt) {
        content += `**Updated:** ${note.updatedAt}\n`;
      }

      if (note.attendees && note.attendees.length > 0) {
        content += `**Attendees:** ${note.attendees.join(", ")}\n`;
      }

      if (note.transcript) {
        content += `**Transcript:** ${note.transcript}\n`;
      }

      if (note.folders && note.folders.length > 0) {
        content += `**Folders:** ${note.folders.join(", ")}\n`;
      }

      // Keep the note's own headings below its title heading. Granola
      // summaries often use level-1 headings, which would otherwise be read
      // as the end of this section on the next sync, leaving the old content
      // behind and inserting the section again.
      const body = demoteHeadings(note.markdown, noteHeadingLevel + 1);
      content += `\n${body}\n`;
    }

    return content.trim() + "\n";
  }

  /**
   * Updates a daily note section with the given content.
   *
   * @param dailyNoteFile - The daily note file to update
   * @param sectionHeading - The section heading to update
   * @param sectionContent - The new content for the section
   * @param forceOverwrite - If true, always updates the section even if content is unchanged
   */
  async updateDailyNoteSection(
    dailyNoteFile: TFile,
    sectionHeading: string,
    sectionContent: string,
    forceOverwrite: boolean = false
  ): Promise<void> {
    try {
      await updateSection(
        this.app,
        dailyNoteFile,
        sectionHeading,
        sectionContent,
        forceOverwrite
      );
    } catch (error) {
      new Notice(
        `Error updating section in ${dailyNoteFile.path}. Check console.`,
        7000
      );
      log.error("Error updating daily note section:", error);
    }
  }

  /**
   * Groups note link data by date and returns a map of date keys to arrays of link data.
   *
   * @param notesWithPaths - Array of objects containing doc and note path
   * @returns Map of date keys (YYYY-MM-DD) to arrays of note link data
   */
  buildDailyNoteLinksMap(
    notesWithPaths: Array<{
      doc: GranolaDoc;
      notePath: string;
    }>
  ): Map<string, NoteLinkData[]> {
    const linksMap = new Map<string, NoteLinkData[]>();

    for (const { doc, notePath } of notesWithPaths) {
      const noteDate = getNoteDate(doc);
      const mapKey = moment(noteDate).format("YYYY-MM-DD");
      const title = doc.title || "Untitled";

      // Extract time from the note date
      const hours = noteDate.getHours().toString().padStart(2, "0");
      const minutes = noteDate.getMinutes().toString().padStart(2, "0");
      const time = `${hours}:${minutes}`;

      const linkData: NoteLinkData = {
        title,
        filePath: notePath,
        time,
        granolaId: doc.id,
      };

      if (!linksMap.has(mapKey)) {
        linksMap.set(mapKey, []);
      }

      linksMap.get(mapKey)!.push(linkData);
    }

    // Sort links within each day by time
    for (const [, links] of linksMap) {
      links.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    }

    return linksMap;
  }

  /**
   * Parses existing meeting links from a daily note section.
   *
   * @param fileContent - The content of the daily note file
   * @param sectionHeading - The section heading to look for
   * @returns Array of NoteLinkData parsed from existing links
   */
  parseExistingLinks(
    fileContent: string,
    sectionHeading: string
  ): NoteLinkData[] {
    const links: NoteLinkData[] = [];
    const lines = fileContent.split("\n");
    const headingLevel = sectionHeading.match(/^(#{1,6})\s/)?.[1].length;

    let inSection = false;

    for (const line of lines) {
      if (line.trim() === sectionHeading) {
        inSection = true;
        continue;
      }

      if (inSection) {
        // Check if we've reached the next section at the same or higher level
        const currentLevel = line.match(/^(#{1,6})\s/)?.[1].length;
        if (headingLevel && currentLevel && currentLevel <= headingLevel) {
          break;
        }

        // Parse link lines: "- HH:MM - [[path|title]]" or "- [[path|title]]"
        const linkWithTimeMatch = line.match(
          /^-\s+(\d{2}:\d{2})\s+-\s+\[\[([^|]+)\|([^\]]+)\]\]/
        );
        if (linkWithTimeMatch) {
          links.push({
            time: linkWithTimeMatch[1],
            filePath: linkWithTimeMatch[2] + ".md",
            title: linkWithTimeMatch[3],
          });
          continue;
        }

        const linkWithoutTimeMatch = line.match(
          /^-\s+\[\[([^|]+)\|([^\]]+)\]\]/
        );
        if (linkWithoutTimeMatch) {
          links.push({
            filePath: linkWithoutTimeMatch[1] + ".md",
            title: linkWithoutTimeMatch[2],
          });
        }
      }
    }

    return links;
  }

  /**
   * Merges existing links with new links, deduplicating by granolaId.
   * Only links with a granolaId are included (unresolved/deleted notes are dropped).
   * New links take precedence when granolaIds match.
   *
   * @param existingLinks - Links already in the daily note section (with granolaId set by caller)
   * @param newLinks - Newly synced links to add (always have granolaId from doc.id)
   * @returns Merged and sorted array of links
   */
  mergeLinks(
    existingLinks: NoteLinkData[],
    newLinks: NoteLinkData[]
  ): NoteLinkData[] {
    const withGranolaId = (
      l: NoteLinkData
    ): l is NoteLinkData & { granolaId: string } => l.granolaId != null;
    const existing = existingLinks.filter(withGranolaId);
    const new_ = newLinks.filter(withGranolaId);

    const byGranolaId = new Map<string, (NoteLinkData & { granolaId: string })>();
    for (const link of existing) {
      byGranolaId.set(link.granolaId, link);
    }
    for (const link of new_) {
      byGranolaId.set(link.granolaId, link);
    }

    const merged = Array.from(byGranolaId.values());
    merged.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    return merged;
  }

  /**
   * Builds the section content for daily note links.
   *
   * @param linksForDay - Array of note link data for the day
   * @param sectionHeading - The heading to use for the section
   * @returns The formatted section content with links
   */
  buildDailyNoteLinksSectionContent(
    linksForDay: NoteLinkData[],
    sectionHeading: string
  ): string {
    if (linksForDay.length === 0) {
      return sectionHeading;
    }

    let content = sectionHeading;

    for (const link of linksForDay) {
      // Extract just the filename without extension for the wiki link
      const filename = link.filePath.replace(/\.md$/, "");
      const timePrefix = link.time ? `${link.time} - ` : "";
      content += `\n- ${timePrefix}[[${filename}|${link.title}]]`;
    }

    return content.trim() + "\n";
  }

  /**
   * Adds links to daily notes for a set of synced individual note files.
   *
   * Sync order guarantees: buildCache() runs before sync; each save updates the cache.
   * So existing links in the section were written by a prior sync and resolve via the cache
   * unless the note was deleted—in which case the link is dropped.
   *
   * @param notesWithPaths - Array of objects containing doc and note path
   * @param sectionHeading - The heading for the links section
   * @param forceOverwrite - If true, always updates the section even if content is unchanged
   * @param getGranolaIdForPath - Resolver from file path to Granola ID (FileSyncService.getGranolaIdByPath). Required; unresolved existing links are dropped (e.g. deleted note).
   */
  async addLinksToDailyNotes(
    notesWithPaths: Array<{
      doc: GranolaDoc;
      notePath: string;
    }>,
    sectionHeading: string,
    forceOverwrite: boolean = false,
    getGranolaIdForPath: (path: string) => string | null
  ): Promise<void> {
    const linksMap = this.buildDailyNoteLinksMap(notesWithPaths);

    for (const [dateKey, newLinksForDay] of linksMap) {
      try {
        const dailyNoteFile = await this.getOrCreateDailyNote(dateKey);

        const fileContent = await this.app.vault.read(dailyNoteFile);
        const existingLinks = this.parseExistingLinks(
          fileContent,
          sectionHeading
        );

        // Resolve granolaId from cache; drop links that don't resolve (e.g. deleted note)
        for (const link of existingLinks) {
          link.granolaId = getGranolaIdForPath(link.filePath) ?? undefined;
        }

        const mergedLinks = this.mergeLinks(existingLinks, newLinksForDay);

        const sectionContent = this.buildDailyNoteLinksSectionContent(
          mergedLinks,
          sectionHeading
        );

        await this.updateDailyNoteSection(
          dailyNoteFile,
          sectionHeading,
          sectionContent,
          forceOverwrite
        );

        log.debug(
          `Added ${newLinksForDay.length} new link(s) to daily note for ${dateKey} (${mergedLinks.length} total)`
        );
      } catch (error) {
        log.error(`Error adding links to daily note for ${dateKey}:`, error);
        new Notice(
          `Error adding meeting links to daily note for ${dateKey}. Check console.`,
          7000
        );
      }
    }
  }
}
