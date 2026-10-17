import {
  getHeadingLevel,
  toHeading,
  demoteHeadings,
  findHeadingLines,
  groupBy,
  updateProperties,
  updateSection,
} from "../../src/utils/textUtils";
import { getEditorForFile } from "../../src/utils/fileUtils";

jest.mock("../../src/utils/fileUtils", () => ({
  getEditorForFile: jest.fn(),
}));

describe("textUtils helpers", () => {
  describe("getHeadingLevel", () => {
    it("should detect heading level based on number of # characters", () => {
      expect(getHeadingLevel("# Heading")).toBe(1);
      expect(getHeadingLevel("## Heading")).toBe(2);
      expect(getHeadingLevel("###### Heading")).toBe(6);
    });

    it("should return null when the line is not a markdown heading", () => {
      expect(getHeadingLevel("No heading here")).toBeNull();
      expect(getHeadingLevel("   ###MissingSpace")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(getHeadingLevel("")).toBeNull();
    });

    it("should return null when heading has no space after #", () => {
      expect(getHeadingLevel("###")).toBeNull();
      expect(getHeadingLevel("##")).toBeNull();
    });

    it("should return null when heading has no text after space", () => {
      expect(getHeadingLevel("## ")).toBeNull();
      expect(getHeadingLevel("# ")).toBeNull();
    });

    it("should handle edge case with single character after space", () => {
      expect(getHeadingLevel("# A")).toBe(1);
      expect(getHeadingLevel("## B")).toBe(2);
    });
  });

  describe("toHeading", () => {
    it("should prefix the title with the correct number of # symbols", () => {
      expect(toHeading("My Title", 1)).toBe("# My Title");
      expect(toHeading("My Title", 3)).toBe("### My Title");
    });
  });

  describe("findHeadingLines", () => {
    it("should map heading lines to their levels", () => {
      const lines = ["# A", "text", "### B", "#hashtag", "#"];
      expect(findHeadingLines(lines)).toEqual(
        new Map([
          [0, 1],
          [2, 3],
        ])
      );
    });

    it("should skip headings inside fenced code blocks", () => {
      const lines = ["# A", "```sh", "# comment", "```", "~~~", "# more", "~~~", "## B"];
      expect(findHeadingLines(lines)).toEqual(
        new Map([
          [0, 1],
          [7, 2],
        ])
      );
    });

    it("should not hide headings after a fence that is never closed", () => {
      const lines = ["# A", "```", "code", "# B"];
      expect(findHeadingLines(lines)).toEqual(
        new Map([
          [0, 1],
          [3, 1],
        ])
      );
    });
  });

  describe("demoteHeadings", () => {
    it("should shift headings so the shallowest is at the minimum level", () => {
      const markdown = "# Topic\n\nText\n\n## Detail\n\n# Next";
      expect(demoteHeadings(markdown, 3)).toBe(
        "### Topic\n\nText\n\n#### Detail\n\n### Next"
      );
    });

    it("should return markdown unchanged when headings are deep enough", () => {
      const markdown = "### Topic\n\n#### Detail";
      expect(demoteHeadings(markdown, 3)).toBe(markdown);
      expect(demoteHeadings(markdown, 2)).toBe(markdown);
    });

    it("should return markdown without headings unchanged", () => {
      expect(demoteHeadings("Just text\n- #hashtag", 3)).toBe(
        "Just text\n- #hashtag"
      );
    });

    it("should cap headings at level 6", () => {
      expect(demoteHeadings("# A\n##### B", 4)).toBe("#### A\n###### B");
    });

    it("should not touch lines inside fenced code blocks", () => {
      const markdown = "# Topic\n```sh\n# a comment\n```\n~~~\n# more\n~~~";
      expect(demoteHeadings(markdown, 2)).toBe(
        "## Topic\n```sh\n# a comment\n```\n~~~\n# more\n~~~"
      );
    });

    it("should not close a code block on a fence with an info string", () => {
      // Regression: "```sh" inside an open block was taken as its closing
      // fence, so the "#" lines after it were changed into headings.
      const markdown = "# Topic\n```\n```sh\n# a comment\n```\n# After";
      expect(demoteHeadings(markdown, 2)).toBe(
        "## Topic\n```\n```sh\n# a comment\n```\n## After"
      );
    });

    it("should not close a code block on a shorter fence", () => {
      const markdown = "# Topic\n````\n```\n# a comment\n````\n# After";
      expect(demoteHeadings(markdown, 2)).toBe(
        "## Topic\n````\n```\n# a comment\n````\n## After"
      );
    });

    it("should demote headings after a fence that is never closed", () => {
      const markdown = "# Topic\n```\ncode\n# Next Steps";
      expect(demoteHeadings(markdown, 2)).toBe(
        "## Topic\n```\ncode\n## Next Steps"
      );
    });

    it("should handle CRLF line endings", () => {
      const markdown =
        "# Topic\r\n```sh\r\n# a comment\r\n```\r\n# After\r\nText";
      expect(demoteHeadings(markdown, 2)).toBe(
        "## Topic\r\n```sh\r\n# a comment\r\n```\r\n## After\r\nText"
      );
    });
  });

  describe("groupBy", () => {
    const data = [
      { id: 1, category: "a" },
      { id: 2, category: "b" },
      { id: 3, category: "a" },
    ];

    it("should group array items by predicate key", () => {
      const grouped = groupBy(data, (item) => item.category);
      expect(grouped).toEqual({
        a: [data[0], data[2]],
        b: [data[1]],
      });
    });
  });
});

describe("updateProperties & updateSection", () => {
  let mockApp: jest.Mocked<any>;
  let mockVault: any;
  let mockFile: any;

  beforeEach(() => {
    mockVault = {
      read: jest.fn(),
      modify: jest.fn(),
      process: jest.fn(),
    };

    mockApp = {
      vault: mockVault,
    } as unknown as jest.Mocked<any>;

    mockFile = { path: "test.md" };

    // By default there is no open editor for the file
    (getEditorForFile as jest.Mock).mockReturnValue(null);
  });

  describe("updateProperties", () => {
    const newProperties = ["---", "tags: test", "---"].join("\n");

    it("should prepend a new properties block when none exists", async () => {
      mockVault.read.mockResolvedValueOnce("Content line");

      await updateProperties(mockApp, mockFile, newProperties);

      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      const modifiedText = processCallback("Content line");
      expect(modifiedText.startsWith(newProperties)).toBe(true);
    });

    it("should replace an existing properties block at the top of the file", async () => {
      const existing = ["---", "old: property", "---", "Old content"].join(
        "\n"
      );
      mockVault.read.mockResolvedValueOnce(existing);

      await updateProperties(mockApp, mockFile, newProperties);

      // The modified text should start with the new properties and not contain the old one
      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      const modifiedText = processCallback(existing);
      expect(modifiedText.startsWith(newProperties)).toBe(true);
      expect(modifiedText).not.toContain("old: property");
    });
  });

  describe("updateSection", () => {
    const heading = "## Granola Notes";
    const sectionContent = `${heading}\nNew synced content`;

    it("should append a new section when the heading does not exist", async () => {
      mockVault.read.mockResolvedValueOnce("File without heading");

      await updateSection(mockApp, mockFile, heading, sectionContent);

      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      const modified = processCallback("File without heading");
      expect(modified.trimEnd()).toContain(sectionContent);
    });

    it("should replace the existing section when the heading is present", async () => {
      const existingFile = [
        "# Title",
        "",
        heading,
        "Old content",
        "# Another heading",
        "More",
      ].join("\n");

      mockVault.read.mockResolvedValueOnce(existingFile);

      await updateSection(mockApp, mockFile, heading, sectionContent);

      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      const modified = processCallback(existingFile);
      // The new content should be in place of old content
      expect(modified).toContain(sectionContent);
      expect(modified).not.toContain("Old content");
    });


    it("should update section even when content is unchanged if forceOverwrite is true", async () => {
      const existingFile = [heading, sectionContent].join("\n");
      mockVault.read.mockResolvedValueOnce(existingFile);

      await updateSection(mockApp, mockFile, heading, sectionContent, true);

      // Should still process when forceOverwrite is true
      expect(mockVault.process).toHaveBeenCalled();
    });

    it("should use editor when file is open", async () => {
      const existingFile = [heading, "Old content"].join("\n");
      mockVault.read.mockResolvedValueOnce(existingFile);
      const mockEditor = {
        replaceRange: jest.fn(),
      };
      (getEditorForFile as jest.Mock).mockReturnValue(mockEditor);

      await updateSection(mockApp, mockFile, heading, sectionContent);

      expect(getEditorForFile).toHaveBeenCalledWith(mockApp, mockFile);
      expect(mockEditor.replaceRange).toHaveBeenCalled();
      // Should not use vault.process when editor is available
      expect(mockVault.process).not.toHaveBeenCalled();
    });

    it("should append section when heading doesn't exist and editor is available", async () => {
      const existingFile = "Existing content";
      mockVault.read.mockResolvedValueOnce(existingFile);
      const mockEditor = {
        replaceRange: jest.fn(),
      };
      (getEditorForFile as jest.Mock).mockReturnValue(mockEditor);

      await updateSection(mockApp, mockFile, heading, sectionContent);

      expect(mockEditor.replaceRange).toHaveBeenCalledWith(
        expect.stringContaining(sectionContent),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("should handle section at end of file with no next section", async () => {
      const existingFile = ["# Title", "", heading, "Old content"].join("\n");
      mockVault.read.mockResolvedValueOnce(existingFile);

      await updateSection(mockApp, mockFile, heading, sectionContent);

      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      const modified = processCallback(existingFile);
      expect(modified).toContain(sectionContent);
      expect(modified).not.toContain("Old content");
    });

    it("should not end the section at a heading inside a code block", async () => {
      const existingFile = [
        "# Granola notes",
        "## Note",
        "```sh",
        "# a comment",
        "```",
        "Old content",
        "",
        "# Journal",
        "Other content",
      ].join("\n");
      const newSection = "# Granola notes\n## Note\nNew content\n";
      mockVault.read.mockResolvedValueOnce(existingFile);

      await updateSection(mockApp, mockFile, "# Granola notes", newSection);

      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      expect(processCallback(existingFile)).toBe(
        "# Granola notes\n## Note\nNew content\n\n# Journal\nOther content"
      );
    });

    it("should correctly detect section boundaries when content contains same-level headings", async () => {
      // This test verifies the fix for heading level conflict
      // When section content contains headings at the same level as the section heading,
      // the boundary detection should still work correctly
      const existingFile = [
        "# Daily Note",
        "",
        "## Granola Notes",
        "### First Note",
        "**Granola ID:** doc-1",
        "Content 1",
        "",
        "### Second Note",
        "**Granola ID:** doc-2",
        "Content 2",
        "",
        "## Other Section",
        "Other content",
      ].join("\n");

      const newSectionContent = [
        "## Granola Notes",
        "### Updated Note",
        "**Granola ID:** doc-3",
        "Updated content",
      ].join("\n");

      mockVault.read.mockResolvedValueOnce(existingFile);

      await updateSection(mockApp, mockFile, "## Granola Notes", newSectionContent);

      const processCallback = (mockVault.process as jest.Mock).mock.calls[0][1];
      const modified = processCallback(existingFile);

      // Verify the section was replaced correctly
      expect(modified).toContain("## Granola Notes");
      expect(modified).toContain("### Updated Note");
      expect(modified).toContain("**Granola ID:** doc-3");
      expect(modified).toContain("Updated content");
      
      // Verify old content was removed
      expect(modified).not.toContain("First Note");
      expect(modified).not.toContain("Second Note");
      expect(modified).not.toContain("doc-1");
      expect(modified).not.toContain("doc-2");
      
      // Verify content outside the section is preserved
      expect(modified).toContain("# Daily Note");
      expect(modified).toContain("## Other Section");
      expect(modified).toContain("Other content");
    });
  });
});
