import { requestUrl } from "obsidian";
import { AttachmentSyncService } from "../../src/services/attachmentSyncService";
import type { GranolaDoc } from "../../src/services/granolaTypes";

// The network and vault write are external side effects; keep attachment
// naming, validation, and reuse in the real service.
jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
  normalizePath: (path: string) => path,
}));
jest.mock("../../src/utils/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const image = { id: "att_photo", object: "attachment" as const, type: "photo", url: "https://cdn.example/photo", width: 100, height: 50 };
const screenshot = { id: "att_screen", object: "attachment" as const, type: "screenshot", url: "https://cdn.example/screen", width: 1200, height: 800 };
const doc: GranolaDoc = { id: "not_a", title: "Test", summary_markdown: "Summary", attachments: [image, screenshot] };
const bytes = Uint8Array.from([137, 80, 78, 71]).buffer;

describe("AttachmentSyncService", () => {
  const request = requestUrl as jest.Mock;
  let files: Map<string, object>;
  let app: any;

  beforeEach(() => {
    request.mockReset();
    files = new Map();
    app = { vault: {
      getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
      createFolder: jest.fn().mockResolvedValue(undefined),
      createBinary: jest.fn(async (path: string) => { files.set(path, { path }); return { path }; }),
    } };
    request.mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, arrayBuffer: bytes });
  });

  test("downloads both image types in order and returns local paths", async () => {
    const result = await new AttachmentSyncService(app).sync(doc);
    expect(result.attachments?.map((item) => item.local_path)).toEqual([
      "Granola Attachments/not_a/att_photo.png",
      "Granola Attachments/not_a/att_screen.png",
    ]);
    expect(app.vault.createBinary).toHaveBeenCalledTimes(2);
    expect(app.vault.createBinary).toHaveBeenCalledWith("Granola Attachments/not_a/att_photo.png", bytes);
  });

  test("reuses existing files without downloading again", async () => {
    files.set("Granola Attachments/not_a/att_photo.png", { path: "Granola Attachments/not_a/att_photo.png" });
    const result = await new AttachmentSyncService(app).sync({ ...doc, attachments: [image] });
    expect(result.attachments?.[0].local_path).toBe("Granola Attachments/not_a/att_photo.png");
    expect(request).not.toHaveBeenCalled();
    expect(app.vault.createBinary).not.toHaveBeenCalled();
  });

  test("skips unknown types and failed downloads without creating broken embeds", async () => {
    request.mockRejectedValueOnce(new Error("offline"));
    const result = await new AttachmentSyncService(app).sync({ ...doc, attachments: [image, { ...screenshot, type: "video" }] });
    expect(result.attachments?.map((item) => item.local_path)).toEqual([undefined, undefined]);
    expect(app.vault.createBinary).not.toHaveBeenCalled();
  });

  test("rejects non-image responses and unsafe IDs", async () => {
    request.mockResolvedValueOnce({ status: 200, headers: { "content-type": "text/html" }, arrayBuffer: bytes });
    const result = await new AttachmentSyncService(app).sync({ ...doc, attachments: [image, { ...screenshot, id: "../escape" }] });
    expect(result.attachments?.map((item) => item.local_path)).toEqual([undefined, undefined]);
    expect(app.vault.createBinary).not.toHaveBeenCalled();
  });
});
