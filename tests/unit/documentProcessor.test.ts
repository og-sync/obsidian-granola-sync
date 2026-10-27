import { DocumentProcessor } from "../../src/services/documentProcessor";
import { GranolaDoc } from "../../src/services/granolaApi";
import { PathResolver } from "../../src/services/pathResolver";
import { parseFrontmatter, TRICKY_TITLES } from "../helpers/frontmatter";

// Mock getNoteDate: This function has time-dependent behavior (returns new Date()
// as fallback), so we mock it to ensure consistent, deterministic test results
// and avoid brittleness from time-dependent test failures.
jest.mock("../../src/utils/dateUtils", () => {
  const actual = jest.requireActual("../../src/utils/dateUtils");
  return {
    ...actual,
    getNoteDate: jest.fn(),
  };
});

import { getNoteDate } from "../../src/utils/dateUtils";

const MOCK_MARKDOWN = "# Mock Content\n\nThis is mock markdown content.";

describe("DocumentProcessor", () => {
  let documentProcessor: DocumentProcessor;
  let mockPathResolver: PathResolver;

  beforeEach(() => {
    (getNoteDate as jest.Mock).mockReturnValue(
      new Date("2024-01-15T00:00:00.000Z")
    );

    // Use real PathResolver instance but spy on methods to control their return values
    mockPathResolver = new PathResolver({
      syncNotes: true,
      saveAsIndividualFiles: true,
      baseFolderType: "custom",
      customBaseFolder: "Granola",
      subfolderPattern: "none",
      filenamePattern: "{title}",
      syncTranscripts: true,
      transcriptHandling: "custom-location",
      customTranscriptBaseFolder: "Transcripts",
      transcriptSubfolderPattern: "none",
      transcriptFilenamePattern: "{title}-transcript",
    });

    jest
      .spyOn(mockPathResolver, "computeTranscriptFilenamePattern")
      .mockReturnValue("{title}-transcript");
    jest
      .spyOn(mockPathResolver, "getNoteFilenamePattern")
      .mockReturnValue("{title}");

    documentProcessor = new DocumentProcessor(
      {
        syncTranscripts: false,
        syncPrivateNotes: false,
      },
      mockPathResolver
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("prepareNote", () => {
    it("embeds downloaded photos and screenshots in stored order", () => {
      const doc: GranolaDoc = {
        id: "not_a", title: "Images", summary_markdown: "Summary",
        attachments: [
          { id: "att_photo", object: "attachment", type: "photo", url: "https://cdn.example/photo", width: 100, height: 50, local_path: "Granola Attachments/not_a/att_photo.png" },
          { id: "att_screen", object: "attachment", type: "screenshot", url: "https://cdn.example/screen", width: 1200, height: 800, local_path: "Granola Attachments/not_a/att_screen.jpg" },
        ],
      };
      const content = documentProcessor.prepareNote(doc)!.content;
      expect(content).toContain("Summary\n\n## Attachments\n\n![[Granola Attachments/not_a/att_photo.png]]\n\n![[Granola Attachments/not_a/att_screen.jpg]]");
    });

    it("omits embeds for attachments that failed to download", () => {
      const doc: GranolaDoc = {
        id: "not_a", title: "Images", summary_markdown: "Summary",
        attachments: [{ id: "att_photo", object: "attachment", type: "photo", url: "https://cdn.example/photo", width: 100, height: 50 }],
      };
      expect(documentProcessor.prepareNote(doc)!.content).not.toContain("## Attachments");
    });
    it("should prepare a note with basic frontmatter", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        updated_at: "2024-01-15T12:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.filename).toBe("Test Note.md");
      expect(result.content).toContain("---");
      expect(result.content).toContain("granola_id: doc-123");
      expect(result.content).toContain("title: Test Note");
      expect(result.content).toContain("type: note");
      expect(result.content).toContain("created: 2024-01-15T10:00:00Z");
      expect(result.content).toContain("updated: 2024-01-15T12:00:00Z");
      expect(result.content).toContain("# Mock Content");
    });

    it("should include web_url in frontmatter when present", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        web_url: "https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).toContain(
        "web_url: https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c"
      );
    });

    it("should not include web_url in frontmatter when absent", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).not.toContain("web_url:");
    });

    it("should fall back to summary_text when summary_markdown is missing", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        summary_markdown: null,
        summary_text: "Plain text summary.",
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).toContain("Plain text summary.");
    });

    it("should handle documents without created_at or updated_at", () => {
      const doc: GranolaDoc = {
        id: "doc-456",
        title: "Minimal Note",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.filename).toBe("Minimal Note.md");
      expect(result.content).toContain("granola_id: doc-456");
      expect(result.content).toContain("type: note");
      expect(result.content).not.toContain("created:");
      expect(result.content).not.toContain("updated:");
    });

    it("should escape quotes in titles for YAML frontmatter", () => {
      const doc: GranolaDoc = {
        id: "doc-789",
        title: 'Note with "quotes"',
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      // Frontmatter must be valid YAML and round-trip the title exactly.
      const fm = parseFrontmatter(result.content);
      expect(fm.title).toBe('Note with "quotes"');
    });

    it.each(TRICKY_TITLES)(
      "should write valid YAML frontmatter for a title with %s (issue #139)",
      (_label, title) => {
        const doc: GranolaDoc = {
          id: "doc-tricky",
          title,
          summary_markdown: MOCK_MARKDOWN,
        };

        const result = documentProcessor.prepareNote(doc);

        // parseFrontmatter throws on invalid YAML — the #139 failure mode.
        const fm = parseFrontmatter(result.content);
        // granola_id must remain readable so deduplication keeps working.
        expect(fm.granola_id).toBe("doc-tricky");
        // The (multi-line) title is preserved exactly through the round-trip.
        expect(fm.title).toBe(title);
      }
    );

    it("should not add transcript field when path not provided", () => {
      documentProcessor = new DocumentProcessor(
        {
          syncTranscripts: true,
          syncPrivateNotes: false,
        },
        mockPathResolver
      );

      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).not.toContain("transcript:");
      expect(result.content).not.toContain("[Transcript]");
    });

    it("should not add transcript link when disabled", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).not.toContain("[Transcript]");
      expect(result.content).not.toContain("[[");
    });

    it("should use default title when title is missing", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: null,
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).toContain(
        "title: Untitled Granola Note at 2024-01-15 00-00-00"
      );
    });

    it("should return null when document has no summary content", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Invalid Note",
      };

      expect(documentProcessor.prepareNote(doc)).toBeNull();
    });

    it("should return null when summary fields are empty/whitespace", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Invalid Note",
        summary_markdown: "   ",
        summary_text: "",
      };

      expect(documentProcessor.prepareNote(doc)).toBeNull();
    });

    it("should use PathResolver's getNoteFilenamePattern for filename generation", () => {
      jest
        .spyOn(mockPathResolver, "getNoteFilenamePattern")
        .mockReturnValue("{date}-{title}");

      documentProcessor = new DocumentProcessor(
        {
          syncTranscripts: false,
          syncPrivateNotes: false,
        },
        mockPathResolver
      );

      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      // resolveFilenamePattern resolves {date} with "2024-01-15" and {title} with "Test Note"
      expect(result.filename).toBe("2024-01-15-Test Note.md");
      expect(mockPathResolver.getNoteFilenamePattern).toHaveBeenCalled();
    });
  });

  it("puts attachment embeds before the transcript in a combined note", () => {
    const doc: GranolaDoc = {
      id: "not_a", title: "Images", summary_markdown: "Summary",
      attachments: [{ id: "att_photo", object: "attachment", type: "photo", url: "https://cdn.example/photo", width: 100, height: 50, local_path: "Granola Attachments/not_a/att_photo.png" }],
    };
    const content = documentProcessor.prepareCombinedNote(doc, "Transcript body")!.content;
    expect(content).toContain("![[Granola Attachments/not_a/att_photo.png]]");
    expect(content.indexOf("![[Granola Attachments/not_a/att_photo.png]]")).toBeLessThan(content.indexOf("## Transcript"));
  });

  it("includes local embeds in a daily note section body", () => {
    const doc: GranolaDoc = {
      id: "not_a", title: "Images", summary_markdown: "Summary",
      attachments: [{ id: "att_photo", object: "attachment", type: "photo", url: "https://cdn.example/photo", width: 100, height: 50, local_path: "Granola Attachments/not_a/att_photo.png" }],
    };
    expect(documentProcessor.extractNoteForDailyNote(doc)!.markdown).toContain("### Attachments\n\n![[Granola Attachments/not_a/att_photo.png]]");
  });

  describe("prepareTranscript", () => {
    it("should prepare transcript with correct filename", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
      };
      const transcriptContent = "Speaker 1: Hello\nSpeaker 2: World";

      const result = documentProcessor.prepareTranscript(
        doc,
        transcriptContent
      );

      expect(result.filename).toBe("Test Note-transcript.md");
      expect(result.content).toBe(transcriptContent);
    });

    it("should handle missing title", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: null,
      };
      const transcriptContent = "Speaker 1: Hello";

      const result = documentProcessor.prepareTranscript(
        doc,
        transcriptContent
      );

      expect(result.filename).toBe(
        "Untitled Granola Note at 2024-01-15 00-00-00-transcript.md"
      );
    });

    it("should use PathResolver's computeTranscriptFilenamePattern for filename generation", () => {
      jest
        .spyOn(mockPathResolver, "computeTranscriptFilenamePattern")
        .mockReturnValue("{date}-{title}-transcript");

      documentProcessor = new DocumentProcessor(
        {
          syncTranscripts: true,
          syncPrivateNotes: false,
        },
        mockPathResolver
      );

      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
      };
      const transcriptContent = "Speaker 1: Hello";

      const result = documentProcessor.prepareTranscript(
        doc,
        transcriptContent
      );

      expect(result.filename).toBe("2024-01-15-Test Note-transcript.md");
      expect(
        mockPathResolver.computeTranscriptFilenamePattern
      ).toHaveBeenCalled();
    });
  });

  describe("extractNoteForDailyNote", () => {
    it("should extract note data for daily notes", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        updated_at: "2024-01-15T12:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.extractNoteForDailyNote(doc);

      expect(result).toEqual({
        title: "Test Note",
        docId: "doc-123",
        type: "note",
        createdAt: "2024-01-15T10:00:00Z",
        updatedAt: "2024-01-15T12:00:00Z",
        attendees: [],
        transcript: undefined,
        markdown: MOCK_MARKDOWN,
      });
    });

    it("should return null when document has no summary content", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Invalid Note",
      };

      const result = documentProcessor.extractNoteForDailyNote(doc);

      expect(result).toBeNull();
    });

    it("should handle documents without timestamps", () => {
      const doc: GranolaDoc = {
        id: "doc-456",
        title: "Minimal Note",
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.extractNoteForDailyNote(doc);

      expect(result).toEqual({
        title: "Minimal Note",
        docId: "doc-456",
        type: "note",
        createdAt: undefined,
        updatedAt: undefined,
        attendees: [],
        transcript: undefined,
        markdown: MOCK_MARKDOWN,
      });
    });
  });

  describe("prepareCombinedNote", () => {
    it("should prepare a combined note with both note and transcript content", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        updated_at: "2024-01-15T12:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent =
        "## You (00:00:01)\n\nHello world.\n\n## Guest (00:00:05)\n\nHi there.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      expect(result.filename).toBe("Test Note.md");
      expect(result.content).toContain("---");
      expect(result.content).toContain("granola_id: doc-123");
      expect(result.content).toContain("title: Test Note");
      expect(result.content).toContain("type: combined");
      expect(result.content).toContain("created: 2024-01-15T10:00:00Z");
      expect(result.content).toContain("updated: 2024-01-15T12:00:00Z");
      expect(result.content).toContain("## Note\n\n");
      expect(result.content).toContain("# Mock Content");
      expect(result.content).toContain("## Transcript\n\n");
      expect(result.content).toContain("## You (00:00:01)");
      expect(result.content).toContain("Hello world.");
      expect(result.content).toContain("## Guest (00:00:05)");
      expect(result.content).toContain("Hi there.");
    });

    it("should not include transcript or note link fields in frontmatter", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      expect(result.content).not.toContain("transcript:");
      expect(result.content).not.toContain("note:");
      expect(result.content).not.toContain("[[");
    });

    it("should include attendees in frontmatter", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        people: {
          attendees: [
            { name: "Alice", email: "alice@example.com" },
            { name: "Bob", email: "bob@example.com" },
          ],
        },
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      expect(result.content).toContain("attendees:");
      expect(result.content).toContain("  - Alice");
      expect(result.content).toContain("  - Bob");
    });

    it("should handle empty attendees array", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        people: {
          attendees: [],
        },
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      expect(result.content).toContain("attendees: []");
    });

    it("should handle documents without timestamps", () => {
      const doc: GranolaDoc = {
        id: "doc-456",
        title: "Minimal Note",
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      expect(result.filename).toBe("Minimal Note.md");
      expect(result.content).toContain("granola_id: doc-456");
      expect(result.content).toContain("type: combined");
      expect(result.content).not.toContain("created:");
      expect(result.content).not.toContain("updated:");
    });

    it("should escape quotes in titles for YAML frontmatter", () => {
      const doc: GranolaDoc = {
        id: "doc-789",
        title: 'Note with "quotes"',
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      const fm = parseFrontmatter(result.content);
      expect(fm.title).toBe('Note with "quotes"');
    });

    it.each(TRICKY_TITLES)(
      "should write valid YAML frontmatter for a title with %s (issue #139)",
      (_label, title) => {
        const doc: GranolaDoc = {
          id: "doc-tricky",
          title,
          summary_markdown: MOCK_MARKDOWN,
        };

        const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

        const result = documentProcessor.prepareCombinedNote(
          doc,
          transcriptContent
        );

        const fm = parseFrontmatter(result.content);
        expect(fm.granola_id).toBe("doc-tricky");
        expect(fm.title).toBe(title);
      }
    );

    it("should place transcript content after note content", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTranscript text.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      const noteIndex = result.content.indexOf("## Note");
      const transcriptIndex = result.content.indexOf("## Transcript");
      const noteContentIndex = result.content.indexOf("# Mock Content");
      const transcriptContentIndex = result.content.indexOf("Transcript text");

      expect(noteIndex).toBeLessThan(transcriptIndex);
      expect(noteContentIndex).toBeLessThan(transcriptIndex);
      expect(transcriptIndex).toBeLessThan(transcriptContentIndex);
    });

    it("should return null when document has no summary content", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Invalid Note",
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      expect(
        documentProcessor.prepareCombinedNote(doc, transcriptContent)
      ).toBeNull();
    });

    it("should use default title when title is missing", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: null,
        summary_markdown: MOCK_MARKDOWN,
      };

      const transcriptContent = "## You (00:00:01)\n\nTest.\n\n";

      const result = documentProcessor.prepareCombinedNote(
        doc,
        transcriptContent
      );

      expect(result.content).toContain(
        "title: Untitled Granola Note at 2024-01-15 00-00-00"
      );
    });
  });

  describe("attendees edge cases", () => {
    it("should handle attendees with only email (no name)", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        people: {
          attendees: [
            { email: "alice@example.com" }, // No name
            { name: "Bob", email: "bob@example.com" },
          ],
        },
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).toContain("attendees:");
      // Should use email when name is missing
      expect(result.content).toContain("alice@example.com");
      expect(result.content).toContain("Bob");
    });

    it("should filter out attendees with neither name nor email", () => {
      const doc: GranolaDoc = {
        id: "doc-123",
        title: "Test Note",
        created_at: "2024-01-15T10:00:00Z",
        people: {
          attendees: [
            { name: "Alice" },
            {}, // No name or email - should be filtered
            { email: "bob@example.com" },
          ],
        },
        summary_markdown: MOCK_MARKDOWN,
      };

      const result = documentProcessor.prepareNote(doc);

      expect(result.content).toContain("attendees:");
      expect(result.content).toContain("Alice");
      expect(result.content).toContain("bob@example.com");
      // Should not contain "Unknown" which would be filtered out
      expect(result.content).not.toContain("Unknown");
    });
  });
  describe("private notes", () => {
    const SUMMARY = "## Key points\n\n- AI summary line";
    const PRIVATE = "- my own typed note";

    const docWithPrivate: GranolaDoc = {
      id: "doc-priv",
      title: "Owned Meeting",
      created_at: "2024-01-15T10:00:00Z",
      updated_at: "2024-01-15T12:00:00Z",
      summary_markdown: SUMMARY,
      private_notes_markdown: PRIVATE,
      private_notes_text: "my own typed note",
    };

    function withPrivateNotesEnabled(): DocumentProcessor {
      return new DocumentProcessor(
        { syncTranscripts: false, syncPrivateNotes: true },
        mockPathResolver
      );
    }

    it("writes private notes above the summary, each under its own heading", () => {
      const result = withPrivateNotesEnabled().prepareNote(docWithPrivate);

      const body = result!.content.split("---\n")[2];
      expect(body).toBe(
        `## Private notes\n\n${PRIVATE}\n\n## Summary\n\n${SUMMARY}`
      );
    });

    it("leaves the body as the bare summary when the setting is off", () => {
      const result = documentProcessor.prepareNote(docWithPrivate);

      expect(result!.content).not.toContain("my own typed note");
      expect(result!.content).not.toContain("## Private notes");
      expect(result!.content).not.toContain("## Summary");
      expect(result!.content).toContain(SUMMARY);
    });

    it("leaves the body as the bare summary when the API returned no private notes", () => {
      const doc: GranolaDoc = {
        ...docWithPrivate,
        private_notes_markdown: null,
        private_notes_text: null,
      };

      const result = withPrivateNotesEnabled().prepareNote(doc);

      expect(result!.content).not.toContain("## Private notes");
      expect(result!.content).not.toContain("## Summary");
      expect(result!.content).toContain(SUMMARY);
    });

    it("treats whitespace-only private notes as absent", () => {
      const doc: GranolaDoc = {
        ...docWithPrivate,
        private_notes_markdown: "  \n",
        private_notes_text: "   ",
      };

      const result = withPrivateNotesEnabled().prepareNote(doc);

      expect(result!.content).not.toContain("## Private notes");
    });

    it("falls back to private_notes_text when private_notes_markdown is missing", () => {
      const doc: GranolaDoc = {
        ...docWithPrivate,
        private_notes_markdown: null,
      };

      const result = withPrivateNotesEnabled().prepareNote(doc);

      expect(result!.content).toContain(
        "## Private notes\n\nmy own typed note\n\n## Summary"
      );
    });

    it("still writes a note that has private notes but no summary", () => {
      const doc: GranolaDoc = {
        ...docWithPrivate,
        summary_markdown: null,
        summary_text: undefined,
      };

      const result = withPrivateNotesEnabled().prepareNote(doc);

      expect(result).not.toBeNull();
      expect(result!.content).toContain(`## Private notes\n\n${PRIVATE}`);
      expect(result!.content).not.toContain("## Summary");
    });

    it("puts private notes before the note and transcript in combined files", () => {
      const result = withPrivateNotesEnabled().prepareCombinedNote(
        docWithPrivate,
        "**Speaker:** hello"
      );

      const body = result!.content.split("---\n")[2];
      expect(body).toBe(
        `## Private notes\n\n${PRIVATE}\n\n## Note\n\n${SUMMARY}\n\n## Transcript\n\n**Speaker:** hello`
      );
    });

    it("keeps the combined layout unchanged when the setting is off", () => {
      const result = documentProcessor.prepareCombinedNote(
        docWithPrivate,
        "**Speaker:** hello"
      );

      const body = result!.content.split("---\n")[2];
      expect(body).toBe(
        `## Note\n\n${SUMMARY}\n\n## Transcript\n\n**Speaker:** hello`
      );
    });

    it("uses level-3 headings for daily note sections", () => {
      const result = withPrivateNotesEnabled().extractNoteForDailyNote(
        docWithPrivate
      );

      expect(result!.markdown).toBe(
        `### Private notes\n\n${PRIVATE}\n\n### Summary\n\n${SUMMARY}`
      );
    });
  });
});
