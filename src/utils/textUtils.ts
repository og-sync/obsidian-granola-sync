import type { App, TFile } from "obsidian";
import { getEditorForFile } from "./fileUtils";

export function getHeadingLevel(line = ""): number | null {
  const heading = line.match(/^(#{1,6})\s+\S/);
  return heading ? heading[1].length : null;
}

export function toHeading(title: string, level: number): string {
  const hash = "".padStart(level, "#");
  return `${hash} ${title}`;
}

interface FencedCodeBlock {
  /** Line index of the opening fence */
  start: number;
  /**
   * Line index of the closing fence, or of the first line after the block if
   * it is never closed
   */
  end: number;
  closed: boolean;
  /** The opening fence's indent and fence characters, e.g. " ```" */
  fence: string;
  /** Whether the opening fence follows a list marker, e.g. "- ```" */
  inListItem: boolean;
}

function countLeadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Finds the fenced code blocks in a list of markdown lines. As in CommonMark,
 * a block is closed only by a fence of the same character, at least as long,
 * with nothing but whitespace after it, and a block that is never closed runs
 * to the end. A backtick fence can't have a backtick after it, so "```a```"
 * is inline code, not a fence.
 *
 * A fence that follows a list marker opens a block inside that list item. Its
 * lines are indented to the item's content, and it ends when the item does.
 */
function findFencedCodeBlocks(lines: string[]): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  // Keep list context across paragraphs: a fence need not share the marker line.
  const listIndents: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const leading = countLeadingSpaces(line);
    if (line.trim() !== "") {
      while (listIndents.length && leading < listIndents[listIndents.length - 1]) {
        listIndents.pop();
      }
    }
    let itemIndent = listIndents[listIndents.length - 1] ?? 0;
    let fragment = line.slice(itemIndent);
    // Thematic breaks take precedence over list markers in Markdown.
    const thematicBreak = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/.test(fragment);
    const marker = !thematicBreak && fragment.match(/^( {0,3})(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/);
    if (marker) {
      itemIndent += marker[0].length;
      listIndents.push(itemIndent);
      fragment = line.slice(itemIndent);
    }
    const opening = fragment.match(/^( {0,3})(`{3,}(?!.*`)|~{3,})/);
    if (!opening) {
      continue;
    }
    const [, indent, openingFence] = opening;
    const inListItem = listIndents.length > 0;

    let end = i + 1;
    let closed = false;
    while (end < lines.length) {
      const line = lines[end];
      const leadingSpaces = countLeadingSpaces(line);
      if (inListItem && line.trim() !== "" && leadingSpaces < itemIndent) {
        break;
      }
      // `\s*$` also accepts the trailing "\r" of a CRLF line
      const closingFence = line.match(/^ *(`{3,}|~{3,})\s*$/)?.[1];
      if (
        closingFence !== undefined &&
        leadingSpaces - itemIndent <= 3 &&
        closingFence[0] === openingFence[0] &&
        closingFence.length >= openingFence.length
      ) {
        closed = true;
        break;
      }
      end++;
    }
    blocks.push({
      start: i,
      end,
      closed,
      fence: indent + openingFence,
      inListItem,
    });
    // An unclosed block's end line is outside it, so read it next
    i = closed ? end : end - 1;
  }

  return blocks;
}

/**
 * Finds the heading lines in a list of markdown lines, keyed by line index,
 * skipping lines inside fenced code blocks.
 */
export function findHeadingLines(lines: string[]): Map<number, number> {
  const headings = new Map<number, number>();
  const blocks = findFencedCodeBlocks(lines);

  for (let i = 0, block = 0; i < lines.length; i++) {
    if (block < blocks.length && i === blocks[block].start) {
      i = blocks[block].closed ? blocks[block].end : blocks[block].end - 1;
      block++;
      continue;
    }
    const level = getHeadingLevel(lines[i]);
    if (level) {
      headings.set(i, level);
    }
  }

  return headings;
}

/**
 * Rewrites the fenced code blocks in a markdown fragment so that none of their
 * lines can be read as a heading by line-based section detection (see
 * updateSection), without changing how the fragment renders:
 *
 * - A block that is never closed is closed at the end of the fragment, so it
 *   can't swallow the content that follows the fragment.
 * - In a block with a line that looks like a heading, e.g. a "# comment" line
 *   in a shell snippet, each such line gets a leading space. CommonMark strips
 *   up to the opening fence's indent from each line of the block, so if the
 *   fence is not indented, it and every line of the block are indented by one
 *   space first. The code is unchanged when rendered, but no line starts
 *   with "#".
 *
 * Blocks in a list item are left alone: their lines are indented, and they end
 * with the item.
 *
 * Section boundaries are found without regard to code blocks, as which fences
 * pair up can't be known when the fragment and the user's own content around
 * it are read together, and a wrong guess would overwrite the user's content.
 */
export function protectFencedCode(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks = findFencedCodeBlocks(lines).filter((b) => !b.inListItem);

  for (const { start, end, closed, fence } of blocks.reverse()) {
    let closing = end;
    if (!closed) {
      // Close before a trailing newline, so no blank line is added to the code
      closing = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      lines.splice(closing, 0, fence);
    }

    const hasHeadingLine = lines
      .slice(start + 1, closing)
      .some((line) => getHeadingLevel(line) !== null);
    if (!hasHeadingLine) {
      continue;
    }

    if (fence.startsWith(" ")) {
      for (let i = start + 1; i < closing; i++) {
        if (getHeadingLevel(lines[i]) !== null) {
          lines[i] = " " + lines[i];
        }
      }
      continue;
    }

    lines[start] = " " + lines[start];
    for (let i = start + 1; i < closing; i++) {
      // Whitespace-only lines are code too; only empty ones are left as is
      if (lines[i].replace(/\r$/, "") !== "") {
        lines[i] = " " + lines[i];
      }
    }
    // A fence can be indented at most 3 spaces
    if (countLeadingSpaces(lines[closing]) < 3) {
      lines[closing] = " " + lines[closing];
    }
  }

  return lines.join("\n");
}

/**
 * Shifts every heading in a markdown fragment deeper by the same amount, so
 * that the shallowest one ends up at `minLevel` (capped at level 6). Relative
 * structure is preserved; markdown that is already deep enough is returned
 * unchanged. Lines inside fenced code blocks are left alone.
 *
 * Needed when embedding a fragment under a heading: section boundaries are
 * found by heading level (see updateSection), so an embedded heading at the
 * same or a higher level than its container would end the section early.
 */
export function demoteHeadings(markdown: string, minLevel: number): string {
  const lines = markdown.split("\n");
  const headingLevels = findHeadingLines(lines);

  if (headingLevels.size === 0) {
    return markdown;
  }
  const shift = minLevel - Math.min(...headingLevels.values());
  if (shift <= 0) {
    return markdown;
  }

  for (const [index, level] of headingLevels) {
    const newLevel = Math.min(level + shift, 6);
    lines[index] = "#".repeat(newLevel) + lines[index].slice(level);
  }
  return lines.join("\n");
}

export function getTab(useTab: boolean, tabSize: number): string {
  if (useTab) {
    return "\t";
  }
  return "".padStart(tabSize, " ");
}

export function groupBy<T>(
  arr: T[],
  predicate: (item: T) => string | number
): Record<string | number, T[]> {
  return arr.reduce((acc, elem) => {
    const val = predicate(elem);
    acc[val] = acc[val] || [];
    acc[val].push(elem);
    return acc;
  }, {} as Record<string | number, T[]>);
}

export async function updateSection(
  app: App,
  file: TFile,
  heading: string,
  sectionContents: string,
  forceOverwrite: boolean = false
): Promise<void> {
  const headingLevel = getHeadingLevel(heading);

  const { vault } = app;
  const fileContents = await vault.read(file);
  const fileLines = fileContents.split("\n");

  const blocks = findFencedCodeBlocks(fileLines);
  const logbookSectionLineNum = fileLines.findIndex((line, index) =>
    // Markdown permits up to three leading spaces on a heading. Ignore
    // lookalikes inside code, including the indented lines we write ourselves.
    /^ {0,3}#/.test(line) && line.trim() === heading &&
    !blocks.some((block) => index >= block.start &&
      (block.closed ? index <= block.end : index < block.end))
  );
  let nextSectionLineNum = -1;
  if (logbookSectionLineNum !== -1) {
    for (let i = logbookSectionLineNum + 1; i < fileLines.length; i++) {
      // Never skip fences while finding the END: an unclosed meeting fence
      // could pair with the journal and hide the user's section boundary.
      const currLevel = getHeadingLevel(fileLines[i]);
      if (headingLevel !== null && currLevel && currLevel <= headingLevel) {
        nextSectionLineNum = i;
        break;
      }
    }
  }

  // Check if content is unchanged (unless force overwrite is enabled)
  if (!forceOverwrite && logbookSectionLineNum !== -1) {
    const existingSectionLines =
      nextSectionLineNum !== -1
        ? fileLines.slice(logbookSectionLineNum, nextSectionLineNum)
        : fileLines.slice(logbookSectionLineNum);
    const existingSection = existingSectionLines.join("\n").trim();
    const newSection = sectionContents.trim();
    if (existingSection === newSection) {
      return; // No changes needed
    }
  }

  const editor = getEditorForFile(app, file);
  if (editor) {
    // if the "## Pinboard" header exists, we just replace the
    // section. If it doesn't, we need to append it to the end
    // if the file and add `\n` for separation.
    if (logbookSectionLineNum !== -1) {
      const from = { line: logbookSectionLineNum, ch: 0 };
      const to =
        nextSectionLineNum !== -1
          ? { line: nextSectionLineNum - 1, ch: 0 }
          : { line: fileLines.length, ch: 0 };

      editor.replaceRange(`${sectionContents}\n`, from, to);
      return;
    } else {
      const pos = { line: fileLines.length - 1, ch: 0 };
      editor.replaceRange(`\n\n${sectionContents}`, pos, pos);
      return;
    }
  }

  // Editor is not open, modify the file on disk...
  if (logbookSectionLineNum !== -1) {
    // Section already exists, just replace
    const prefix = fileLines.slice(0, logbookSectionLineNum);
    const suffix =
      nextSectionLineNum !== -1 ? fileLines.slice(nextSectionLineNum) : [];

    await vault.process(file, () => {
      return [...prefix, sectionContents, ...suffix].join("\n");
    });
  } else {
    // Section does not exist, append to end of file.
    await vault.process(file, () => {
      return [...fileLines, "", sectionContents].join("\n");
    });
  }
}

/**
 * Replaces the properties block at the start of a file with this new one, or adds a new properties block if that does not exist
 * @param app
 * @param file the file to add to
 * @param properties a string representing the properties to add
 * @example
 * const properties = dedent`---
 *   tags: work
 *   time: 2023-12-01
 *   ---`;
 * updateProperties(app, file, properties);
 */
export async function updateProperties(
  app: App,
  file: TFile,
  properties: string
): Promise<void> {
  const { vault } = app;
  const fileContents = await vault.read(file);
  let fileLines = fileContents.split("\n");
  const propertiesLines: number[] = [];

  // Collect all of the properties marker lines
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i] === "---") {
      propertiesLines.push(i);
    }
  }

  // If we found correct matching markers, remove the existing properties so we can update them
  if (propertiesLines[0] === 0 && propertiesLines[1] > 0) {
    const propertiesEndLine = propertiesLines[1];
    fileLines = fileLines.slice(propertiesEndLine + 1);
  }

  // Don't worry about the case where the editor is open here.
  // It's more unlikely that the user is editing the existing note
  await vault.process(file, () => {
    return [properties, ...fileLines].join("\n");
  });
}
