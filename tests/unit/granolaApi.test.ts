import { requestUrl } from "obsidian";
import {
  listAllNoteSummaries,
  fetchNoteDetail,
  listAllFolders,
  verifyApiKey,
  noteDetailToGranolaDoc,
  GranolaAuthError,
  __setRequestDelayMs,
} from "../../src/services/granolaApi";

jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}));
jest.mock("../../src/utils/logger", () => ({
  log: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

(global as unknown as { PLUGIN_VERSION: string }).PLUGIN_VERSION = "0.1.0-test";

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const summary = (id: string) => ({
  id,
  title: "T",
  created_at: "2026-01-27T15:30:00Z",
  updated_at: "2026-01-27T16:45:00Z",
});

beforeEach(() => {
  mockRequestUrl.mockReset();
  __setRequestDelayMs(0); // no throttling in tests
});

describe("listAllNoteSummaries", () => {
  test("follows cursors until hasMore is false", async () => {
    mockRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: { notes: [summary("not_a")], hasMore: true, cursor: "c1" },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { notes: [summary("not_b")], hasMore: false, cursor: null },
      });

    const notes = await listAllNoteSummaries("grn_key", 0);
    expect(notes.map((n) => n.id)).toEqual(["not_a", "not_b"]);
    expect(mockRequestUrl.mock.calls[1][0].url).toContain("cursor=c1");
  });

  test("passes created_after when daysBack > 0", async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { notes: [], hasMore: false, cursor: null },
    });
    await listAllNoteSummaries("grn_key", 7);
    expect(mockRequestUrl.mock.calls[0][0].url).toContain("created_after=");
  });

  test("cuts off at the start of the local day so days are listed in full", async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { notes: [], hasMore: false, cursor: null },
    });
    await listAllNoteSummaries("grn_key", 7);
    const url = new URL(mockRequestUrl.mock.calls[0][0].url);
    const cutoff = new Date(url.searchParams.get("created_after")!);
    expect([
      cutoff.getHours(),
      cutoff.getMinutes(),
      cutoff.getSeconds(),
      cutoff.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
    const expectedDay = new Date();
    expectedDay.setDate(expectedDay.getDate() - 7);
    expect(cutoff.toDateString()).toBe(expectedDay.toDateString());
  });

  test("sends bearer header and page_size 30", async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { notes: [], hasMore: false, cursor: null },
    });
    await listAllNoteSummaries("grn_key", 0);
    const req = mockRequestUrl.mock.calls[0][0];
    expect(req.headers.Authorization).toBe("Bearer grn_key");
    expect(req.url).toContain("page_size=30");
  });

  test("retries once on 429 then succeeds", async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 429, json: {} })
      .mockResolvedValueOnce({
        status: 200,
        json: { notes: [summary("not_a")], hasMore: false, cursor: null },
      });
    const notes = await listAllNoteSummaries("grn_key", 0);
    expect(notes).toHaveLength(1);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  }, 10000);

  test("throws GranolaAuthError on 401", async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 401, json: {} });
    await expect(listAllNoteSummaries("grn_key", 0)).rejects.toBeInstanceOf(
      GranolaAuthError
    );
  });

  test("retries once on a transient 502 then succeeds", async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 502, json: {} })
      .mockResolvedValueOnce({
        status: 200,
        json: { notes: [summary("not_a")], hasMore: false, cursor: null },
      });
    const notes = await listAllNoteSummaries("grn_key", 0);
    expect(notes).toHaveLength(1);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  }, 10000);

  test("gives up on a persistent 502 after retries, carrying the status", async () => {
    mockRequestUrl.mockResolvedValue({ status: 502, json: {} });
    await expect(listAllNoteSummaries("grn_key", 0)).rejects.toMatchObject({
      status: 502,
    });
    expect(mockRequestUrl).toHaveBeenCalledTimes(4); // initial + MAX_RETRIES
  }, 20000);

  test("does not retry a 404", async () => {
    mockRequestUrl.mockResolvedValue({ status: 404, json: {} });
    await expect(listAllNoteSummaries("grn_key", 0)).rejects.toMatchObject({
      status: 404,
    });
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchNoteDetail", () => {
  const detail = {
    ...summary("not_a"),
    web_url: "https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c",
    calendar_event: null,
    attendees: [{ name: "Oat", email: "oat@granola.ai" }],
    folder_membership: [
      { id: "fol_1", object: "folder", name: "F", parent_folder_id: null },
    ],
    summary_text: "plain",
    summary_markdown: "## md",
    transcript: null,
  };

  test("maps detail into GranolaDoc", async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: detail });
    const doc = await fetchNoteDetail("grn_key", "not_a", false);
    expect(doc.id).toBe("not_a");
    expect(doc.summary_markdown).toBe("## md");
    expect(doc.people?.attendees).toEqual([
      { name: "Oat", email: "oat@granola.ai" },
    ]);
    expect(doc.folder_ids).toEqual(["fol_1"]);
    expect(mockRequestUrl.mock.calls[0][0].url).not.toContain("include=");
  });

  test("requests transcript when asked", async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: detail });
    await fetchNoteDetail("grn_key", "not_a", true);
    expect(mockRequestUrl.mock.calls[0][0].url).toContain("include=transcript");
  });
});

describe("listAllFolders", () => {
  test("paginates folders", async () => {
    mockRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          folders: [
            { id: "fol_1", object: "folder", name: "A", parent_folder_id: null },
          ],
          hasMore: true,
          cursor: "c",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          folders: [
            { id: "fol_2", object: "folder", name: "B", parent_folder_id: "fol_1" },
          ],
          hasMore: false,
          cursor: null,
        },
      });
    const folders = await listAllFolders("grn_key");
    expect(folders.map((f) => f.id)).toEqual(["fol_1", "fol_2"]);
  });
});

describe("verifyApiKey", () => {
  test("ok on 200", async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { notes: [], hasMore: false, cursor: null },
    });
    expect(await verifyApiKey("grn_key")).toEqual({ ok: true });
  });

  test("reports invalid key on 401", async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 401, json: {} });
    const res = await verifyApiKey("grn_bad");
    expect(res.ok).toBe(false);
  });
});

describe("noteDetailToGranolaDoc", () => {
  test("extracts fields", () => {
    const doc = noteDetailToGranolaDoc({
      id: "not_a",
      title: null,
      created_at: "2026-01-27T15:30:00Z",
      updated_at: "2026-01-27T16:45:00Z",
      web_url: "https://notes.granola.ai/d/abc",
      attendees: [],
      folder_membership: [],
      summary_text: "s",
      summary_markdown: null,
      transcript: null,
    });
    expect(doc.title).toBeNull();
    expect(doc.summary_text).toBe("s");
  });

  test("carries private notes through when the API returns them", () => {
    const doc = noteDetailToGranolaDoc({
      id: "not_a",
      title: "T",
      created_at: "2026-01-27T15:30:00Z",
      updated_at: "2026-01-27T16:45:00Z",
      web_url: "https://notes.granola.ai/d/abc",
      attendees: [],
      folder_membership: [],
      summary_text: "s",
      summary_markdown: "## md",
      private_notes_text: "raw",
      private_notes_markdown: "- raw",
      transcript: null,
    });
    expect(doc.private_notes_markdown).toBe("- raw");
    expect(doc.private_notes_text).toBe("raw");
  });

  test("leaves private notes null when the API omits them", () => {
    const doc = noteDetailToGranolaDoc({
      id: "not_a",
      title: "T",
      created_at: "2026-01-27T15:30:00Z",
      updated_at: "2026-01-27T16:45:00Z",
      web_url: "https://notes.granola.ai/d/abc",
      attendees: [],
      folder_membership: [],
      summary_text: "s",
      summary_markdown: "## md",
      transcript: null,
    });
    expect(doc.private_notes_markdown).toBeNull();
    expect(doc.private_notes_text).toBeNull();
  });
});
