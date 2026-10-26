import type { App, TFile } from "obsidian";
import { demoteHeadings, protectFencedCode, updateSection } from "../../src/utils/textUtils";
import { getEditorForFile } from "../../src/utils/fileUtils";

// Editor lookup reaches Obsidian's workspace; keep text transformations real.
jest.mock("../../src/utils/fileUtils", () => ({ getEditorForFile: jest.fn() }));

const heading = "# Granola notes";
const journal = '# Journal\nPrivate entry\n\n```js\nconsole.log("keep");\n```';

describe("daily note boundary regressions", () => {
  it.each(["```", "~~~"])("keeps a %s block bounded by its list item", (fence) => {
    const body = `- Example\n\n  ${fence}sh\n  npm test\n- Done\n\n# Next Steps\nDetails`;
    expect(protectFencedCode(body)).toBe(body);
    expect(demoteHeadings(protectFencedCode(body), 3)).toBe(
      `- Example\n\n  ${fence}sh\n  npm test\n- Done\n\n### Next Steps\nDetails`
    );
  });

  it.each(["- - -", "* * *"])("does not treat thematic break %s as a list", (rule) => {
    const body = `${rule}\n\n  \`\`\`sh\n# comment\n  \`\`\`\n\n# Next Steps\nDetails`;
    expect(demoteHeadings(protectFencedCode(body), 3)).toBe(
      `${rule}\n\n  \`\`\`sh\n # comment\n  \`\`\`\n\n### Next Steps\nDetails`
    );
  });

  describe.each(["disk", "editor"])("through %s updates", (mode) => {
    it.each([1, 2, 3])("replaces a template heading indented %i spaces without matching code", async (indent) => {
      let content = `${" ".repeat(indent)}${heading}\n## Old meeting\nStale content\n\n${journal}`;
      const app = { vault: {
        read: async () => content,
        process: async (_file: TFile, fn: (value: string) => string) => { content = fn(content); },
      } } as unknown as App;
      const editor = { replaceRange(text: string, from: {line: number; ch: number}, to: {line: number; ch: number}) {
        const offset = (pos: {line: number; ch: number}) => {
          const lines = content.split("\n");
          return pos.line >= lines.length ? content.length : lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
        };
        content = content.slice(0, offset(from)) + text + content.slice(offset(to));
      } };
      (getEditorForFile as jest.Mock).mockReturnValue(mode === "editor" ? editor : null);
      for (let version = 1; version <= 3; version++) {
        const section = `${heading}\n## Meeting\nVersion ${version}\n` +
          demoteHeadings(protectFencedCode(`\`\`\`sh\n${heading}\n\`\`\``), 3) + "\n";
        await updateSection(app, {} as TFile, heading, section, true);
        expect(content).not.toContain("Stale content");
        expect(content.match(/^# Granola notes$/gm)).toHaveLength(1);
        expect(content.match(/^## Meeting$/gm)).toHaveLength(1);
        expect(content).toContain(`Version ${version}`);
        expect(content.endsWith(journal)).toBe(true);
      }
    });
  });
});
