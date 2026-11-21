import { addMissingFrontmatterFields } from "../../src/services/meetingIdentityBackfill";
import { parseFrontmatter } from "../helpers/frontmatter";

// Notes users have edited locally: the backfill must only add fields, never
// touch the body or rewrite any existing frontmatter line.
const NOTE = [
  "---",
  "granola_id: not_abc",
  'title: "Hybraen <> Betaworks"',
  "type: note",
  "attendees:",
  "  - Kaya Jones",
  "status: my own field",
  "---",
  "## Summary",
  "",
  "My local edit --- with dashes",
  "---",
  "a horizontal rule above",
  "",
].join("\n");

const FIELDS = [
  { key: "attendee_emails", yaml: "attendee_emails: \n  - kaya@example.com" },
  { key: "calendar_event_id", yaml: "calendar_event_id: kgr0b54ks278e31vck05shvjm4" },
  { key: "calendar_event_title", yaml: "calendar_event_title: Hybraen <> Betaworks" },
  { key: "calendar_start", yaml: "calendar_start: 2026-11-19T13:30:00-05:00" },
];

describe("addMissingFrontmatterFields", () => {
  it("adds the fields at the end of the frontmatter and leaves everything else byte-identical", () => {
    const result = addMissingFrontmatterFields(NOTE, FIELDS)!;

    const closing = NOTE.indexOf("\n---\n", 4);
    expect(result.startsWith(NOTE.slice(0, closing))).toBe(true);
    expect(result.endsWith(NOTE.slice(closing))).toBe(true);
    expect(parseFrontmatter(result)).toMatchObject({
      status: "my own field",
      attendee_emails: ["kaya@example.com"],
      calendar_start: "2026-11-19T13:30:00-05:00",
      calendar_event_title: "Hybraen <> Betaworks",
    });
  });

  it("only adds fields the note doesn't have yet", () => {
    const withStart = NOTE.replace("type: note\n", "type: note\ncalendar_start: kept-as-is\n");
    const result = addMissingFrontmatterFields(withStart, FIELDS)!;

    expect(parseFrontmatter(result).calendar_start).toBe("kept-as-is");
    expect(result.match(/^calendar_start:/gm)).toHaveLength(1);
    expect(parseFrontmatter(result).calendar_event_id).toBe("kgr0b54ks278e31vck05shvjm4");
  });

  it("returns null when every field is already present or there is nothing to add", () => {
    const complete = addMissingFrontmatterFields(NOTE, FIELDS)!;
    expect(addMissingFrontmatterFields(complete, FIELDS)).toBeNull();
    expect(addMissingFrontmatterFields(NOTE, [])).toBeNull();
  });

  it("returns null for a file without a frontmatter block", () => {
    expect(addMissingFrontmatterFields("## Just a body\n", FIELDS)).toBeNull();
  });
});
