import { App, requestUrl } from "obsidian";
import type { GranolaDoc, GranolaAttachment } from "./granolaTypes";
import { log } from "../utils/logger";

const ROOT = "Granola Attachments";
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
};
const EXTENSIONS = [...new Set(Object.values(IMAGE_EXTENSIONS))];
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Downloads Granola images once and records vault-relative paths for embeds. */
export class AttachmentSyncService {
  constructor(private app: App) {}

  async sync(doc: GranolaDoc): Promise<GranolaDoc> {
    if (!doc.attachments?.length) return doc;

    const attachments: GranolaAttachment[] = [];
    for (const attachment of doc.attachments) {
      const localPath = await this.saveAttachment(doc, attachment);
      attachments.push({ ...attachment, local_path: localPath ?? undefined });
    }
    return { ...doc, attachments };
  }

  private async saveAttachment(
    doc: GranolaDoc,
    attachment: GranolaAttachment
  ): Promise<string | null> {
    if (
      !["photo", "screenshot"].includes(attachment.type) ||
      !SAFE_ID.test(doc.id) ||
      !SAFE_ID.test(attachment.id)
    ) return null;

    const folder = `${ROOT}/${doc.id}`;
    const stem = `${folder}/${attachment.id}`;
    for (const ext of EXTENSIONS) {
      const path = `${stem}.${ext}`;
      if (this.app.vault.getAbstractFileByPath(path)) return path;
    }

    try {
      // Attachment URLs are capability URLs and can change. Request the
      // current URL without sending the Granola API key to its host.
      const url = new URL(attachment.url);
      if (url.protocol !== "https:") throw new Error("Attachment URL must use HTTPS");
      const response = await requestUrl({ url: url.href, method: "GET", throw: false });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const contentType = Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === "content-type"
      )?.[1].split(";", 1)[0].trim().toLowerCase();
      const ext = contentType && IMAGE_EXTENSIONS[contentType];
      if (!ext) throw new Error(`Unsupported image type: ${contentType ?? "missing"}`);

      if (!this.app.vault.getAbstractFileByPath(ROOT)) {
        await this.app.vault.createFolder(ROOT);
      }
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const path = `${stem}.${ext}`;
      await this.app.vault.createBinary(path, response.arrayBuffer);
      return path;
    } catch (error) {
      log.warn(`Could not save attachment ${attachment.id} for note ${doc.id}:`, error);
      return null;
    }
  }
}
