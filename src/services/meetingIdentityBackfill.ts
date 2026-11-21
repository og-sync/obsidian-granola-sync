import type { FrontmatterField } from "./documentProcessor";

/** The frontmatter block at the very start of a note, up to its closing `---` line. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/;

/**
 * Adds the given fields to a note's frontmatter when the note doesn't have
 * them yet, inserting them just above the closing `---`.
 *
 * Used to backfill notes synced before these fields existed without a Full
 * sync, so local edits are kept: the body and every existing frontmatter
 * line stay byte-for-byte as they were, and fields the note already has
 * (even with a different value) are left alone.
 *
 * @returns The new content, or null when the note has no frontmatter block
 *   or already has every field.
 */
export function addMissingFrontmatterFields(
  content: string,
  fields: FrontmatterField[]
): string | null {
  const frontmatter = FRONTMATTER.exec(content)?.[0];
  if (!frontmatter) return null;

  const missing = fields.filter(
    (field) => !new RegExp(`^${field.key}:`, "m").test(frontmatter)
  );
  if (missing.length === 0) return null;

  const closingAt = frontmatter.lastIndexOf("---");
  const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const inserted = missing
    .map((field) => field.yaml.replace(/\n/g, newline) + newline)
    .join("");
  return content.slice(0, closingAt) + inserted + content.slice(closingAt);
}
