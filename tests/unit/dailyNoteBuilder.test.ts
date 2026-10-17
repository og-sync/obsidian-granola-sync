import {
  DailyNoteBuilder,
  NoteData,
  NoteLinkData,
} from "../../src/services/dailyNoteBuilder";
import { GranolaDoc } from "../../src/services/granolaApi";
import { DocumentProcessor } from "../../src/services/documentProcessor";
import { PathResolver } from "../../src/services/pathResolver";
import { App, TFile } from "obsidian";

// Mock dependencies
jest.mock("../../src/utils/dateUtils");
// Mock updateSection: it writes to the vault. demoteHeadings stays real — it is
// a pure function that shapes the section content under test.
jest.mock("../../src/utils/textUtils", () => {
  const actual = jest.requireActual("../../src/utils/textUtils");
  return { ...actual, updateSection: jest.fn() };
});
jest.mock("obsidian-daily-notes-interface");

import { getNoteDate } from "../../src/utils/dateUtils";
import { updateSection } from "../../src/utils/textUtils";
import { getEditorForFile } from "../../src/utils/fileUtils";
import {
  getDailyNote,
  getAllDailyNotes,
  createDailyNote,
} from "obsidian-daily-notes-interface";

jest.mock("../../src/utils/fileUtils", () => ({
  getEditorForFile: jest.fn(),
}));

describe("DailyNoteBuilder", () => {
  let dailyNoteBuilder: DailyNoteBuilder;
  let mockApp: App;
  let mockDocumentProcessor: DocumentProcessor;

  beforeEach(() => {
    // Setup mocks
    mockApp = {} as App;
    mockDocumentProcessor = {
      extractNoteForDailyNote: jest.fn(),
    } as unknown as DocumentProcessor;

    (getNoteDate as jest.Mock).mockReturnValue(
      new Date("2024-01-15T10:00:00Z")
    );

    dailyNoteBuilder = new DailyNoteBuilder(mockApp, mockDocumentProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("extractExistingNotes", () => {
    it("should not end the section at a heading inside a code block", () => {
      const fileContent = [
        "# Granola notes",
        "## First",
        "**Granola ID:** doc-1",
        "```sh",
        "# a comment",
        "```",
        "## Second",
        "**Granola ID:** doc-2",
        "# Journal",
        "**Granola ID:** not-in-section",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "# Granola notes"
      );

      expect(Array.from(result.keys())).toEqual(["doc-1", "doc-2"]);
    });

    it("should extract Granola IDs and updated_at timestamps from a daily note section", () => {
      const fileContent = [
        "# Daily Note",
        "",
        "## Granola Notes",
        "### Morning Standup",
        "**Granola ID:** doc-123",
        "**Created:** 2024-01-15T09:00:00Z",
        "**Updated:** 2024-01-15T09:30:00Z",
        "",
        "Content here",
        "",
        "### Planning Meeting",
        "**Granola ID:** doc-456",
        "**Created:** 2024-01-15T14:00:00Z",
        "**Updated:** 2024-01-15T14:45:00Z",
        "",
        "More content",
        "",
        "## Other Section",
        "Different content",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "## Granola Notes"
      );

      expect(result.size).toBe(2);
      expect(result.get("doc-123")).toBe("2024-01-15T09:30:00Z");
      expect(result.get("doc-456")).toBe("2024-01-15T14:45:00Z");
    });

    it("should handle notes without Updated timestamps", () => {
      const fileContent = [
        "## Granola Notes",
        "### Test Note",
        "**Granola ID:** doc-789",
        "**Created:** 2024-01-15T10:00:00Z",
        "",
        "Content",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "## Granola Notes"
      );

      expect(result.size).toBe(1);
      expect(result.get("doc-789")).toBeUndefined();
    });

    it("should return empty map when section doesn't exist", () => {
      const fileContent = [
        "# Daily Note",
        "",
        "Some content without the section",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "## Granola Notes"
      );

      expect(result.size).toBe(0);
    });

    it("should stop at next same-level section", () => {
      const fileContent = [
        "## Granola Notes",
        "### First Note",
        "**Granola ID:** doc-123",
        "**Updated:** 2024-01-15T09:00:00Z",
        "",
        "## Tasks",
        "### Should Not Be Included",
        "**Granola ID:** doc-999",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "## Granola Notes"
      );

      expect(result.size).toBe(1);
      expect(result.get("doc-123")).toBe("2024-01-15T09:00:00Z");
      expect(result.get("doc-999")).toBeUndefined();
    });

    it("should handle section with no notes", () => {
      const fileContent = [
        "## Granola Notes",
        "",
        "## Other Section",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "## Granola Notes"
      );

      expect(result.size).toBe(0);
    });

    it("should work with different heading levels", () => {
      const fileContent = [
        "# Granola Notes",
        "## Meeting 1",
        "**Granola ID:** doc-111",
        "**Updated:** 2024-01-15T10:00:00Z",
        "",
        "# Other Section",
      ].join("\n");

      const result = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "# Granola Notes"
      );

      expect(result.size).toBe(1);
      expect(result.get("doc-111")).toBe("2024-01-15T10:00:00Z");
    });
  });

  describe("buildDailyNotesMap", () => {
    it("should group documents by date", () => {
      const doc1: GranolaDoc = {
        id: "doc-1",
        title: "Note 1",
        created_at: "2024-01-15T10:00:00Z",
      };
      const doc2: GranolaDoc = {
        id: "doc-2",
        title: "Note 2",
        created_at: "2024-01-15T11:00:00Z",
      };
      const doc3: GranolaDoc = {
        id: "doc-3",
        title: "Note 3",
        created_at: "2024-01-16T10:00:00Z",
      };

      const noteData1: NoteData = {
        title: "Note 1",
        docId: "doc-1",
        type: "note",
        createdAt: "2024-01-15T10:00:00Z",
        attendees: [],
        markdown: "Content 1",
      };
      const noteData2: NoteData = {
        title: "Note 2",
        docId: "doc-2",
        type: "note",
        createdAt: "2024-01-15T11:00:00Z",
        attendees: [],
        markdown: "Content 2",
      };
      const noteData3: NoteData = {
        title: "Note 3",
        docId: "doc-3",
        type: "note",
        createdAt: "2024-01-16T10:00:00Z",
        attendees: [],
        markdown: "Content 3",
      };

      (mockDocumentProcessor.extractNoteForDailyNote as jest.Mock)
        .mockReturnValueOnce(noteData1)
        .mockReturnValueOnce(noteData2)
        .mockReturnValueOnce(noteData3);

      (getNoteDate as jest.Mock)
        .mockReturnValueOnce(new Date("2024-01-15"))
        .mockReturnValueOnce(new Date("2024-01-15"))
        .mockReturnValueOnce(new Date("2024-01-16"));

      const result = dailyNoteBuilder.buildDailyNotesMap([doc1, doc2, doc3]);

      expect(result.size).toBe(2);
      expect(result.get("2024-01-15")).toEqual([
        { noteData: noteData1, doc: doc1 },
        { noteData: noteData2, doc: doc2 },
      ]);
      expect(result.get("2024-01-16")).toEqual([{ noteData: noteData3, doc: doc3 }]);
    });

    it("should skip documents with no valid content", () => {
      const doc1: GranolaDoc = {
        id: "doc-1",
        title: "Note 1",
      };
      const doc2: GranolaDoc = {
        id: "doc-2",
        title: "Note 2",
        created_at: "2024-01-15T10:00:00Z",
      };

      (mockDocumentProcessor.extractNoteForDailyNote as jest.Mock)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          title: "Note 2",
          docId: "doc-2",
          type: "note",
          createdAt: "2024-01-15T10:00:00Z",
          attendees: [],
          markdown: "Content 2",
        });

      (getNoteDate as jest.Mock).mockReturnValue(new Date("2024-01-15"));

      const result = dailyNoteBuilder.buildDailyNotesMap([doc1, doc2]);

      expect(result.size).toBe(1);
      expect(result.get("2024-01-15")).toHaveLength(1);
      expect(result.get("2024-01-15")![0].noteData.docId).toBe("doc-2");
    });

    it("should return empty map when no valid documents", () => {
      (
        mockDocumentProcessor.extractNoteForDailyNote as jest.Mock
      ).mockReturnValue(null);

      const result = dailyNoteBuilder.buildDailyNotesMap([
        { id: "doc-1" } as GranolaDoc,
      ]);

      expect(result.size).toBe(0);
    });
  });

  describe("getOrCreateDailyNote", () => {
    it("should return existing daily note if found", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(mockFile);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});

      const result = await dailyNoteBuilder.getOrCreateDailyNote("2024-01-15");

      expect(result).toBe(mockFile);
      expect(createDailyNote).not.toHaveBeenCalled();
    });

    it("should create daily note if not found", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(null);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});
      (createDailyNote as jest.Mock).mockResolvedValue(mockFile);

      const result = await dailyNoteBuilder.getOrCreateDailyNote("2024-01-15");

      expect(result).toBe(mockFile);
      expect(createDailyNote).toHaveBeenCalled();
    });
  });

  describe("buildDailyNoteSectionContent", () => {
    const noteData: NoteData = {
      title: "Test Note",
      docId: "doc-123",
      type: "note",
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
      attendees: [],
      markdown: "# Content\n\nTest content",
    };

    it("should return just heading when no notes", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [],
        "## Granola Notes"
      );

      expect(result).toBe("## Granola Notes");
    });

    it("should build section content with note metadata", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData],
        "## Granola Notes"
      );

      expect(result).toContain("## Granola Notes");
      expect(result).toContain("### Test Note");
      expect(result).toContain("**Granola ID:** doc-123");
      expect(result).toContain("**Created:** 2024-01-15T10:00:00Z");
      expect(result).toContain("**Updated:** 2024-01-15T12:00:00Z");
      expect(result).toContain("# Content\n\nTest content");
    });

    it("should handle notes without timestamps", () => {
      const noteWithoutTimestamps: NoteData = {
        title: "Test Note",
        docId: "doc-123",
        type: "note",
        attendees: [],
        markdown: "Content",
      };

      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteWithoutTimestamps],
        "## Granola Notes"
      );

      expect(result).not.toContain("**Created:**");
      expect(result).not.toContain("**Updated:**");
      expect(result).toContain("### Test Note");
      expect(result).toContain("**Granola ID:** doc-123");
    });

    it("should not add transcript link to daily note sections", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData],
        "## Granola Notes"
      );

      expect(result).not.toContain("**Transcript:**");
      expect(result).not.toContain("[[<");
    });

    it("should handle multiple notes", () => {
      const noteData2: NoteData = {
        title: "Second Note",
        docId: "doc-456",
        type: "note",
        attendees: [],
        markdown: "Second content",
      };

      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData, noteData2],
        "## Granola Notes"
      );

      expect(result).toContain("### Test Note");
      expect(result).toContain("### Second Note");
      expect(result).toContain("**Granola ID:** doc-123");
      expect(result).toContain("**Granola ID:** doc-456");
    });

    it("should trim and add newline at end", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData],
        "## Granola Notes"
      );

      expect(result.endsWith("\n")).toBe(true);
      expect(result.endsWith("\n\n")).toBe(false);
    });

    it("should demote note body headings below the note heading", () => {
      const granolaNote: NoteData = {
        ...noteData,
        markdown: "# Topic\n\n- point\n\n## Detail\n\n# Next Steps",
      };

      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [granolaNote],
        "# Granola notes"
      );

      expect(result).toContain("## Test Note");
      expect(result).toContain(
        "### Topic\n\n- point\n\n#### Detail\n\n### Next Steps"
      );
      // The section heading is the only level-1 heading left
      expect(result.match(/^# /gm)).toHaveLength(1);
    });

    it("should leave body headings that are already deep enough", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [{ ...noteData, markdown: "### Topic\n\nText" }],
        "# Granola notes"
      );

      expect(result).toContain("\n### Topic\n\nText");
    });

    it("should build a section whose notes are all found on the next sync", () => {
      // Regression: level-1 headings in a note body ended the section early,
      // so later notes were never seen as synced and the section was
      // re-inserted on every sync.
      const notes: NoteData[] = [
        { ...noteData, docId: "doc-1", markdown: "# Topic\n\nText" },
        { ...noteData, docId: "doc-2", markdown: "# Other\n\nText" },
      ];
      const section = dailyNoteBuilder.buildDailyNoteSectionContent(
        notes,
        "# Granola notes"
      );
      const fileContent = `# Tasks\n\n${section}`;

      const existing = dailyNoteBuilder.extractExistingNotes(
        fileContent,
        "# Granola notes"
      );

      expect(Array.from(existing.keys())).toEqual(["doc-1", "doc-2"]);
    });

    it("should use heading level one deeper than section heading", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData],
        "## Granola Notes"
      );

      // Section is ##, note should be ###
      expect(result).toContain("### Test Note");
    });

    it("should handle different section heading levels", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData],
        "# Granola Notes"
      );

      // Section is #, note should be ##
      expect(result).toContain("## Test Note");
    });

    it("should not exceed heading level 6", () => {
      const result = dailyNoteBuilder.buildDailyNoteSectionContent(
        [noteData],
        "###### Granola Notes"
      );

      // Section is ######, note should still be ###### (max level)
      expect(result).toContain("###### Test Note");
    });
  });

  describe("updateDailyNoteSection", () => {
    it("should update section successfully", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (updateSection as jest.Mock).mockResolvedValue(undefined);

      await dailyNoteBuilder.updateDailyNoteSection(
        mockFile,
        "## Granola Notes",
        "Content"
      );

      expect(updateSection).toHaveBeenCalledWith(
        mockApp,
        mockFile,
        "## Granola Notes",
        "Content",
        false
      );
    });

    it("should handle errors gracefully", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      const error = new Error("Update failed");
      (updateSection as jest.Mock).mockRejectedValue(error);

      // Mock console.error to avoid test output noise
      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await dailyNoteBuilder.updateDailyNoteSection(
        mockFile,
        "## Granola Notes",
        "Content"
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[Granola Sync]",
        "Error updating daily note section:",
        error
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe("repeated syncs", () => {
    const sectionHeading = "# Granola notes";
    const dailyNoteFile = { path: "2024-01-15.md" } as TFile;
    const userContentAbove = "# Tasks\n\n- [ ] Write report";
    const userContentBelow = "# Journal\n\nA quiet afternoon.";

    const meetingA: NoteData = {
      title: "Morning standup",
      docId: "doc-a",
      type: "note",
      createdAt: "2024-01-15T09:00:00Z",
      updatedAt: "2024-01-15T09:30:00Z",
      attendees: [],
      markdown:
        "# Updates\n\n- Shipped the fix\n\n```sh\n# not a heading\nnpm test\n```\n\n# Next Steps\n\n- Review PR",
    };
    const meetingB: NoteData = {
      title: "Afternoon planning",
      docId: "doc-b",
      type: "note",
      createdAt: "2024-01-15T15:00:00Z",
      updatedAt: "2024-01-15T15:45:00Z",
      attendees: [],
      markdown: "# Goals\n\n- Plan the release\n\n# Next Steps\n\n- Draft notes",
    };

    let fileContent: string;
    let builder: DailyNoteBuilder;

    beforeEach(() => {
      fileContent = `${userContentAbove}\n\n${sectionHeading}\n\n${userContentBelow}`;
      // Use the real updateSection so the section boundary detection is
      // exercised end to end. Only the vault is stubbed: it is file I/O, so
      // here it reads and writes an in-memory string instead.
      const actual = jest.requireActual("../../src/utils/textUtils");
      (updateSection as jest.Mock).mockImplementation(actual.updateSection);
      const app = {
        vault: {
          read: jest.fn(async () => fileContent),
          process: jest.fn(
            async (_file: TFile, fn: (data: string) => string) => {
              fileContent = fn(fileContent);
            }
          ),
        },
      } as unknown as App;
      builder = new DailyNoteBuilder(app, mockDocumentProcessor);
    });

    afterEach(() => {
      (updateSection as jest.Mock).mockReset();
    });

    // Mirrors the daily note branch of GranolaSync.syncNotesToDailyNotes:
    // skip the day when every note is present and up to date, otherwise
    // rebuild the section from the notes listed for the day.
    async function sync(notesForDay: NoteData[]): Promise<void> {
      const existing = builder.extractExistingNotes(fileContent, sectionHeading);
      const allUpToDate = notesForDay.every(
        (note) => existing.get(note.docId) === note.updatedAt
      );
      if (allUpToDate && existing.size === notesForDay.length) {
        return;
      }
      await builder.updateDailyNoteSection(
        dailyNoteFile,
        sectionHeading,
        builder.buildDailyNoteSectionContent(notesForDay, sectionHeading)
      );
    }

    function expectSingleSection(expectedIds: string[]): void {
      expect(fileContent.split(sectionHeading)).toHaveLength(2);
      const ids = Array.from(
        fileContent.matchAll(/^\*\*Granola ID:\*\* (.+)$/gm),
        (match) => match[1]
      );
      expect(ids).toEqual(expectedIds);
      expect(
        Array.from(builder.extractExistingNotes(fileContent, sectionHeading).keys())
      ).toEqual(expectedIds);
      expect(fileContent.startsWith(`${userContentAbove}\n\n`)).toBe(true);
      expect(fileContent.endsWith(userContentBelow)).toBe(true);
    }

    it("should keep one section as meetings are added later in the day", async () => {
      await sync([meetingA]);
      expectSingleSection(["doc-a"]);
      const afterFirstSync = fileContent;

      await sync([meetingA]);
      expect(fileContent).toBe(afterFirstSync);
      expect(updateSection).toHaveBeenCalledTimes(1);

      await sync([meetingA, meetingB]);
      expectSingleSection(["doc-a", "doc-b"]);
      const afterSecondMeeting = fileContent;

      await sync([meetingA, meetingB]);
      expect(fileContent).toBe(afterSecondMeeting);
      expect(updateSection).toHaveBeenCalledTimes(2);

      // Both meetings sit inside the one section, above the user's content
      const sectionStart = fileContent.indexOf(sectionHeading);
      const sectionEnd = fileContent.indexOf(userContentBelow);
      const section = fileContent.slice(sectionStart, sectionEnd);
      expect(section).toContain("## Morning standup");
      expect(section).toContain("## Afternoon planning");
      expect(section).toContain("```sh\n# not a heading\nnpm test\n```");
    });

    it("should keep one section when a note has a code block that is never closed", async () => {
      // A stray fence must not stretch the section to the end of the file,
      // or updating it would overwrite the user's content below
      const unclosed: NoteData = {
        ...meetingA,
        markdown: "# Updates\n\n```\nnpm test\n\n# Next Steps\n\n- Review PR",
      };

      for (let i = 0; i < 3; i++) {
        await sync([unclosed, meetingB]);
        expectSingleSection(["doc-a", "doc-b"]);
      }
      expect(updateSection).toHaveBeenCalledTimes(1);
    });
  });

  describe("buildDailyNoteLinksMap", () => {
    it("should group notes by date and extract link data", () => {
      const doc1: GranolaDoc = {
        id: "doc-1",
        title: "Morning Standup",
        created_at: "2024-01-15T09:00:00Z",
      };
      const doc2: GranolaDoc = {
        id: "doc-2",
        title: "Planning Meeting",
        created_at: "2024-01-15T14:00:00Z",
      };
      const doc3: GranolaDoc = {
        id: "doc-3",
        title: "Retrospective",
        created_at: "2024-01-16T10:00:00Z",
      };

      (getNoteDate as jest.Mock)
        .mockReturnValueOnce(new Date("2024-01-15T09:00:00Z"))
        .mockReturnValueOnce(new Date("2024-01-15T14:00:00Z"))
        .mockReturnValueOnce(new Date("2024-01-16T10:00:00Z"));

      const notesWithPaths = [
        {
          doc: doc1,
          notePath: "Granola/Morning Standup.md",
        },
        {
          doc: doc2,
          notePath: "Granola/Planning Meeting.md",
        },
        {
          doc: doc3,
          notePath: "Granola/Retrospective.md",
        },
      ];

      const result = dailyNoteBuilder.buildDailyNoteLinksMap(notesWithPaths);

      expect(result.size).toBe(2);
      expect(result.get("2024-01-15")).toHaveLength(2);
      expect(result.get("2024-01-16")).toHaveLength(1);
    });

    it("should sort links by time within each day", () => {
      const doc1: GranolaDoc = {
        id: "doc-1",
        title: "Afternoon Meeting",
        created_at: "2024-01-15T14:00:00Z",
      };
      const doc2: GranolaDoc = {
        id: "doc-2",
        title: "Morning Standup",
        created_at: "2024-01-15T09:00:00Z",
      };

      (getNoteDate as jest.Mock)
        .mockReturnValueOnce(new Date("2024-01-15T14:00:00Z"))
        .mockReturnValueOnce(new Date("2024-01-15T09:00:00Z"));

      const notesWithPaths = [
        {
          doc: doc1,
          notePath: "Granola/Afternoon Meeting.md",
        },
        {
          doc: doc2,
          notePath: "Granola/Morning Standup.md",
        },
      ];

      const result = dailyNoteBuilder.buildDailyNoteLinksMap(notesWithPaths);
      const linksForDay = result.get("2024-01-15")!;

      // Should be sorted by time, so Morning Standup comes first
      expect(linksForDay[0].title).toBe("Morning Standup");
      expect(linksForDay[1].title).toBe("Afternoon Meeting");
    });

    it("should handle documents without titles", () => {
      //@ts-expect-error - title is missing
      const doc: GranolaDoc = {
        id: "doc-1",
        created_at: "2024-01-15T10:00:00Z",
      };

      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T10:00:00Z")
      );

      const notesWithPaths = [
        {
          doc,
          notePath: "Granola/Untitled.md",
        },
      ];

      const result = dailyNoteBuilder.buildDailyNoteLinksMap(notesWithPaths);
      const linksForDay = result.get("2024-01-15")!;

      expect(linksForDay[0].title).toBe("Untitled");
    });

    it("should return empty map when no notes provided", () => {
      const result = dailyNoteBuilder.buildDailyNoteLinksMap([]);
      expect(result.size).toBe(0);
    });
  });

  describe("buildDailyNoteLinksSectionContent", () => {
    it("should return just heading when no links", () => {
      const result = dailyNoteBuilder.buildDailyNoteLinksSectionContent(
        [],
        "## Meetings"
      );

      expect(result).toBe("## Meetings");
    });

    it("should build section content with links and times", () => {
      const links: NoteLinkData[] = [
        {
          title: "Morning Standup",
          filePath: "Granola/Morning Standup.md",
          time: "09:00",
        },
        {
          title: "Planning Meeting",
          filePath: "Granola/Planning Meeting.md",
          time: "14:00",
        },
      ];

      const result = dailyNoteBuilder.buildDailyNoteLinksSectionContent(
        links,
        "## Meetings"
      );

      expect(result).toContain("## Meetings");
      expect(result).toContain(
        "- 09:00 - [[Granola/Morning Standup|Morning Standup]]"
      );
      expect(result).toContain(
        "- 14:00 - [[Granola/Planning Meeting|Planning Meeting]]"
      );
      expect(result.endsWith("\n")).toBe(true);
    });

    it("should handle links without times", () => {
      const links: NoteLinkData[] = [
        {
          title: "Some Meeting",
          filePath: "Granola/Some Meeting.md",
        },
      ];

      const result = dailyNoteBuilder.buildDailyNoteLinksSectionContent(
        links,
        "## Meetings"
      );

      expect(result).toContain("- [[Granola/Some Meeting|Some Meeting]]");
      expect(result).not.toContain("- undefined");
    });

    it("should strip .md extension from wiki links", () => {
      const links: NoteLinkData[] = [
        {
          title: "Test Meeting",
          filePath: "Granola/Test Meeting.md",
          time: "10:00",
        },
      ];

      const result = dailyNoteBuilder.buildDailyNoteLinksSectionContent(
        links,
        "## Meetings"
      );

      expect(result).toContain("[[Granola/Test Meeting|Test Meeting]]");
      expect(result).not.toContain(".md|");
    });
  });

  describe("parseExistingLinks", () => {
    it("should parse links with times from a section", () => {
      const fileContent = [
        "# Daily Note",
        "",
        "## Meetings",
        "- 09:00 - [[Granola/Morning Standup|Morning Standup]]",
        "- 14:00 - [[Granola/Planning Meeting|Planning Meeting]]",
        "",
        "## Other Section",
      ].join("\n");

      const result = dailyNoteBuilder.parseExistingLinks(
        fileContent,
        "## Meetings"
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        time: "09:00",
        filePath: "Granola/Morning Standup.md",
        title: "Morning Standup",
      });
      expect(result[1]).toEqual({
        time: "14:00",
        filePath: "Granola/Planning Meeting.md",
        title: "Planning Meeting",
      });
    });

    it("should parse links without times", () => {
      const fileContent = [
        "## Meetings",
        "- [[Granola/Some Meeting|Some Meeting]]",
      ].join("\n");

      const result = dailyNoteBuilder.parseExistingLinks(
        fileContent,
        "## Meetings"
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: "Granola/Some Meeting.md",
        title: "Some Meeting",
      });
    });

    it("should return empty array when section does not exist", () => {
      const fileContent = "# Daily Note\n\nSome content";

      const result = dailyNoteBuilder.parseExistingLinks(
        fileContent,
        "## Meetings"
      );

      expect(result).toHaveLength(0);
    });

    it("should stop at next same-level heading", () => {
      const fileContent = [
        "## Meetings",
        "- 09:00 - [[Granola/Meeting 1|Meeting 1]]",
        "",
        "## Reflections",
        "- 10:00 - [[Granola/Not A Meeting|Not A Meeting]]",
      ].join("\n");

      const result = dailyNoteBuilder.parseExistingLinks(
        fileContent,
        "## Meetings"
      );

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Meeting 1");
    });

    it("should handle empty section", () => {
      const fileContent = [
        "## Meetings",
        "",
        "## Other Section",
      ].join("\n");

      const result = dailyNoteBuilder.parseExistingLinks(
        fileContent,
        "## Meetings"
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("mergeLinks", () => {
    it("should merge existing and new links without duplicates", () => {
      const existing: NoteLinkData[] = [
        {
          time: "09:00",
          filePath: "Granola/Morning.md",
          title: "Morning",
          granolaId: "doc-1",
        },
        {
          time: "11:00",
          filePath: "Granola/Midday.md",
          title: "Midday",
          granolaId: "doc-2",
        },
      ];

      const newLinks: NoteLinkData[] = [
        {
          time: "14:00",
          filePath: "Granola/Afternoon.md",
          title: "Afternoon",
          granolaId: "doc-3",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks(existing, newLinks);

      expect(result).toHaveLength(3);
      expect(result[0].title).toBe("Morning");
      expect(result[1].title).toBe("Midday");
      expect(result[2].title).toBe("Afternoon");
    });

    it("should deduplicate by granolaId with new links taking precedence", () => {
      const existing: NoteLinkData[] = [
        {
          time: "09:00",
          filePath: "Granola/Meeting.md",
          title: "Old Title",
          granolaId: "doc-1",
        },
      ];

      const newLinks: NoteLinkData[] = [
        {
          time: "09:00",
          filePath: "Granola/Meeting.md",
          title: "Updated Title",
          granolaId: "doc-1",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks(existing, newLinks);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Updated Title");
    });

    it("should deduplicate by granolaId when set (same note, different path)", () => {
      const existing: NoteLinkData[] = [
        {
          time: "09:00",
          filePath: "Granola/Old Path/Meeting.md",
          title: "Standup",
          granolaId: "doc-1",
        },
      ];

      const newLinks: NoteLinkData[] = [
        {
          time: "09:00",
          filePath: "Granola/New Path/Meeting.md",
          title: "Standup",
          granolaId: "doc-1",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks(existing, newLinks);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Standup");
      expect(result[0].filePath).toBe("Granola/New Path/Meeting.md");
    });

    it("should sort merged links by time", () => {
      const existing: NoteLinkData[] = [
        {
          time: "14:00",
          filePath: "Granola/Afternoon.md",
          title: "Afternoon",
          granolaId: "doc-2",
        },
      ];

      const newLinks: NoteLinkData[] = [
        {
          time: "09:00",
          filePath: "Granola/Morning.md",
          title: "Morning",
          granolaId: "doc-1",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks(existing, newLinks);

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Morning");
      expect(result[1].title).toBe("Afternoon");
    });

    it("should drop links without granolaId", () => {
      const existing: NoteLinkData[] = [
        { time: "09:00", filePath: "Granola/A.md", title: "A" },
      ];
      const newLinks: NoteLinkData[] = [
        {
          time: "10:00",
          filePath: "Granola/B.md",
          title: "B",
          granolaId: "doc-2",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks(existing, newLinks);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("B");
    });

    it("should handle empty existing links", () => {
      const newLinks: NoteLinkData[] = [
        {
          time: "10:00",
          filePath: "Granola/Meeting.md",
          title: "Meeting",
          granolaId: "doc-1",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks([], newLinks);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Meeting");
    });

    it("should handle empty new links", () => {
      const existing: NoteLinkData[] = [
        {
          time: "10:00",
          filePath: "Granola/Meeting.md",
          title: "Meeting",
          granolaId: "doc-1",
        },
      ];

      const result = dailyNoteBuilder.mergeLinks(existing, []);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Meeting");
    });
  });

  describe("addLinksToDailyNotes", () => {
    let mockVault: { read: jest.Mock };

    beforeEach(() => {
      // addLinksToDailyNotes now reads the daily note to merge existing links
      mockVault = {
        read: jest.fn().mockResolvedValue(""),
      };
      (mockApp as any).vault = mockVault;
    });

    it("should add links to daily notes for each date", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(mockFile);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});
      (updateSection as jest.Mock).mockResolvedValue(undefined);
      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T10:00:00Z")
      );
      mockVault.read.mockResolvedValue("# Daily Note\n\n## Meetings\n\n## Other");

      const doc: GranolaDoc = {
        id: "doc-1",
        title: "Test Meeting",
        created_at: "2024-01-15T10:00:00Z",
      };

      const notesWithPaths = [
        {
          doc,
          notePath: "Granola/Test Meeting.md",
        },
      ];

      await dailyNoteBuilder.addLinksToDailyNotes(
        notesWithPaths,
        "## Meetings",
        false,
        () => null
      );

      expect(updateSection).toHaveBeenCalledWith(
        mockApp,
        mockFile,
        "## Meetings",
        expect.stringContaining("[[Granola/Test Meeting|Test Meeting]]"),
        false
      );
    });

    it("should handle errors gracefully", async () => {
      const error = new Error("Failed to get daily note");
      (getDailyNote as jest.Mock).mockReturnValue(null);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});
      (createDailyNote as jest.Mock).mockRejectedValue(error);
      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T10:00:00Z")
      );

      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const doc: GranolaDoc = {
        id: "doc-1",
        title: "Test Meeting",
        created_at: "2024-01-15T10:00:00Z",
      };

      const notesWithPaths = [
        {
          doc,
          notePath: "Granola/Test Meeting.md",
        },
      ];

      await dailyNoteBuilder.addLinksToDailyNotes(
        notesWithPaths,
        "## Meetings",
        false,
        () => null
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("should pass forceOverwrite to updateSection", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(mockFile);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});
      (updateSection as jest.Mock).mockResolvedValue(undefined);
      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T10:00:00Z")
      );
      mockVault.read.mockResolvedValue("");

      const doc: GranolaDoc = {
        id: "doc-1",
        title: "Test Meeting",
        created_at: "2024-01-15T10:00:00Z",
      };

      const notesWithPaths = [
        {
          doc,
          notePath: "Granola/Test Meeting.md",
        },
      ];

      await dailyNoteBuilder.addLinksToDailyNotes(
        notesWithPaths,
        "## Meetings",
        true, // forceOverwrite
        () => null
      );

      expect(updateSection).toHaveBeenCalledWith(
        mockApp,
        mockFile,
        "## Meetings",
        expect.any(String),
        true
      );
    });

    it("should preserve existing links when syncing only new meetings", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(mockFile);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});
      (updateSection as jest.Mock).mockResolvedValue(undefined);

      // Simulate daily note that already has a morning meeting link
      const existingDailyNoteContent = [
        "# Daily Note",
        "",
        "## Meetings",
        "- 09:00 - [[Granola/Morning Standup|Morning Standup]]",
        "",
        "## Reflections",
      ].join("\n");
      mockVault.read.mockResolvedValue(existingDailyNoteContent);

      const afternoonDoc: GranolaDoc = {
        id: "doc-2",
        title: "Afternoon Planning",
        created_at: "2024-01-15T14:00:00Z",
      };

      // Second sync: only the afternoon meeting is new
      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T14:00:00Z")
      );

      await dailyNoteBuilder.addLinksToDailyNotes(
        [
          {
            doc: afternoonDoc,
            notePath: "Granola/Afternoon Planning.md",
          },
        ],
        "## Meetings",
        false,
        (path) =>
          path === "Granola/Morning Standup.md"
            ? "doc-1"
            : path === "Granola/Afternoon Planning.md"
              ? "doc-2"
              : null
      );

      expect(updateSection).toHaveBeenCalledTimes(1);
      const callContent = (updateSection as jest.Mock).mock.calls[0][3];

      // Both the existing morning meeting and new afternoon meeting should be present
      expect(callContent).toContain("## Meetings");
      expect(callContent).toContain(
        "- 09:00 - [[Granola/Morning Standup|Morning Standup]]"
      );
      expect(callContent).toContain(
        "- 14:00 - [[Granola/Afternoon Planning|Afternoon Planning]]"
      );

      // Verify sorted order
      const morningIndex = callContent.indexOf("Morning Standup");
      const afternoonIndex = callContent.indexOf("Afternoon Planning");
      expect(morningIndex).toBeLessThan(afternoonIndex);
    });

    it("should not duplicate links when re-syncing existing meetings", async () => {
      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(mockFile);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});
      (updateSection as jest.Mock).mockResolvedValue(undefined);

      // Daily note already has both meetings
      const existingContent = [
        "## Meetings",
        "- 09:00 - [[Granola/Morning Standup|Morning Standup]]",
        "- 14:00 - [[Granola/Afternoon Planning|Afternoon Planning]]",
      ].join("\n");
      mockVault.read.mockResolvedValue(existingContent);

      // Re-sync the morning meeting (e.g., it was updated)
      const morningDoc: GranolaDoc = {
        id: "doc-1",
        title: "Morning Standup",
        created_at: "2024-01-15T09:00:00Z",
      };

      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T09:00:00Z")
      );

      // Resolver simulates FileSyncService.granolaIdCache: same note = same granolaId
      const getGranolaIdForPath = (path: string) =>
        path === "Granola/Morning Standup.md"
          ? "doc-1"
          : path === "Granola/Afternoon Planning.md"
            ? "doc-2"
            : null;

      await dailyNoteBuilder.addLinksToDailyNotes(
        [
          {
            doc: morningDoc,
            notePath: "Granola/Morning Standup.md",
          },
        ],
        "## Meetings",
        false,
        getGranolaIdForPath
      );

      const callContent = (updateSection as jest.Mock).mock.calls[0][3];

      // Should have exactly 2 links, not 3
      const linkCount = (callContent.match(/^- /gm) || []).length;
      expect(linkCount).toBe(2);
      expect(callContent).toContain("Morning Standup");
      expect(callContent).toContain("Afternoon Planning");
    });

    it("should preserve other content in daily note when updating section", async () => {
      // Use the real updateSection function for this test
      const textUtilsModule = jest.requireActual("../../src/utils/textUtils");
      const realUpdateSection = textUtilsModule.updateSection;

      // Temporarily replace the mock with the real function
      (updateSection as jest.Mock).mockImplementation(realUpdateSection);

      // Mock getEditorForFile to return null so we use vault.process path
      (getEditorForFile as jest.Mock).mockReturnValue(null);

      const mockFile = { path: "2024-01-15.md" } as TFile;
      (getDailyNote as jest.Mock).mockReturnValue(mockFile);
      (getAllDailyNotes as jest.Mock).mockReturnValue({});

      // Daily note with content before and after the section
      const existingFileContent = [
        "# Daily Note",
        "",
        "Some content before the section",
        "",
        "## Meetings",
        "- Old meeting link",
        "",
        "## Other Section",
        "Content after the section",
      ].join("\n");

      // Mock vault to capture the modified content
      let modifiedContent = "";
      const mockVault = {
        read: jest.fn().mockResolvedValue(existingFileContent),
        process: jest.fn(async (file: TFile, callback: (data: string) => string) => {
          modifiedContent = callback(existingFileContent);
          return modifiedContent;
        }),
      };
      const mockAppWithVault = {
        vault: mockVault,
      } as unknown as App;

      (getNoteDate as jest.Mock).mockReturnValue(
        new Date("2024-01-15T10:00:00Z")
      );

      const doc: GranolaDoc = {
        id: "doc-1",
        title: "New Meeting",
        created_at: "2024-01-15T10:00:00Z",
      };

      // Use real DocumentProcessor and PathResolver: addLinksToDailyNotes doesn't use
      // DocumentProcessor, but using real dependencies provides integration-style
      // confidence and avoids over-mocking internal business logic
      const pathResolver = new PathResolver({
        syncNotes: true,
        saveAsIndividualFiles: true,
        baseFolderType: "custom",
        customBaseFolder: "Granola",
        subfolderPattern: "none",
        filenamePattern: "{title}",
        linkFromDailyNotes: false,
        syncTranscripts: false,
        transcriptHandling: "combined",
      });
      const documentProcessor = new DocumentProcessor(
        { syncTranscripts: false, syncPrivateNotes: false },
        pathResolver
      );

      const dailyNoteBuilderWithVault = new DailyNoteBuilder(
        mockAppWithVault,
        documentProcessor
      );

      await dailyNoteBuilderWithVault.addLinksToDailyNotes(
        [
          {
            doc,
            notePath: "Granola/New Meeting.md",
          },
        ],
        "## Meetings",
        false,
        () => null
      );

      expect(mockVault.process).toHaveBeenCalled();

      // Verify content before the section is preserved
      expect(modifiedContent).toContain("# Daily Note");
      expect(modifiedContent).toContain("Some content before the section");

      // Verify content after the section is preserved
      expect(modifiedContent).toContain("## Other Section");
      expect(modifiedContent).toContain("Content after the section");

      // Verify the section itself is updated
      expect(modifiedContent).toContain("## Meetings");
      expect(modifiedContent).toContain(
        "- 10:00 - [[Granola/New Meeting|New Meeting]]"
      );

      // Verify section structure: heading comes first in the section
      const meetingsSectionMatch = modifiedContent.match(
        /## Meetings\n([\s\S]*?)(?=\n## |$)/
      );
      expect(meetingsSectionMatch).not.toBeNull();
      const meetingsContent = meetingsSectionMatch![1];
      expect(meetingsContent).toMatch(
        /^- 10:00 - \[\[Granola\/New Meeting\|New Meeting\]\]/
      );
    });
  });
});
