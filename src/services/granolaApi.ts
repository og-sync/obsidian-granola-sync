import { requestUrl } from "obsidian";
import * as v from "valibot";
import {
  ListNotesResponseSchema,
  ListFoldersResponseSchema,
  NoteDetailSchema,
} from "./validationSchemas";
import { log } from "../utils/logger";

export type {
  GranolaDoc,
  TranscriptEntry,
  GranolaFolder,
  NoteSummaryV1,
  NoteDetailV1,
} from "./granolaTypes";
import type {
  GranolaDoc,
  GranolaFolder,
  NoteSummaryV1,
  NoteDetailV1,
} from "./granolaTypes";

const API_BASE = "https://public-api.granola.ai/v1";
const PAGE_SIZE = 30;
const MAX_RETRIES = 3;

/** Sustained public-API budget is 5 req/s; stay under it between calls. */
let requestDelayMs = 220;
/** Test hook: disable throttling in unit tests. */
export function __setRequestDelayMs(ms: number): void {
  requestDelayMs = ms;
}

export class GranolaAuthError extends Error {
  constructor() {
    super("Granola API rejected the API key (401)");
    this.name = "GranolaAuthError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function apiGet(apiKey: string, pathAndQuery: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (requestDelayMs > 0) await sleep(requestDelayMs);
    const response = await requestUrl({
      url: `${API_BASE}${pathAndQuery}`,
      method: "GET",
      throw: false,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": `GranolaApiSyncObsidian/${PLUGIN_VERSION}`,
        "X-Client-Version": `GranolaApiSyncObsidian/${PLUGIN_VERSION}`,
      },
    });

    // 429 is rate limiting; 5xx is a server-side failure that is often
    // transient — both deserve a backoff and retry before giving up.
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < MAX_RETRIES
    ) {
      const backoff = Math.pow(2, attempt) * 1000;
      log.debug(
        `${response.status} from Granola API, retrying in ${backoff}ms (${pathAndQuery})`
      );
      await sleep(backoff);
      continue;
    }
    if (response.status === 401) throw new GranolaAuthError();
    if (response.status >= 400) {
      const error = new Error(
        `Granola API error ${response.status} for ${pathAndQuery}`
      );
      (error as Error & { status: number }).status = response.status;
      throw error;
    }
    return response.json as unknown;
  }
}

function parseOrThrow<TSchema extends v.GenericSchema>(
  schema: TSchema,
  data: unknown,
  label: string
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, data);
  if (!result.success) {
    log.error(`Validation failed for ${label}:`);
    log.error(JSON.stringify(result.issues, null, 2));
    throw new Error(`Invalid response from Granola API (${label})`);
  }
  return result.output;
}

/** Maps a v1 note detail into the internal GranolaDoc domain shape. */
export function noteDetailToGranolaDoc(detail: NoteDetailV1): GranolaDoc {
  return {
    id: detail.id,
    title: detail.title ?? null,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    web_url: detail.web_url ?? undefined,
    people: {
      attendees: (detail.attendees ?? []).map((attendee) => ({
        name: attendee.name ?? undefined,
        email: attendee.email ?? undefined,
      })),
    },
    summary_markdown: detail.summary_markdown,
    summary_text: detail.summary_text ?? undefined,
    private_notes_markdown: detail.private_notes_markdown ?? null,
    private_notes_text: detail.private_notes_text ?? null,
    folder_ids: (detail.folder_membership ?? []).map((folder) => folder.id),
    attachments: detail.attachments,
    transcript: detail.transcript ?? null,
  };
}

/**
 * Lists all accessible note summaries, following cursors.
 * daysBack > 0 adds created_after to limit server-side. The cutoff is the
 * start of that local day, so a day is always listed in full: daily notes
 * rebuild a day's section from the notes listed for it, and a partial day
 * would drop the notes created before the cutoff.
 */
export async function listAllNoteSummaries(
  apiKey: string,
  daysBack: number
): Promise<NoteSummaryV1[]> {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (daysBack > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    cutoff.setHours(0, 0, 0, 0);
    params.set("created_after", cutoff.toISOString());
  }

  const notes: NoteSummaryV1[] = [];
  let cursor: string | null | undefined = undefined;
  do {
    if (cursor) params.set("cursor", cursor);
    const json = await apiGet(apiKey, `/notes?${params.toString()}`);
    const page = parseOrThrow(
      ListNotesResponseSchema,
      json,
      "ListNotesResponseSchema"
    );
    notes.push(...page.notes);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  log.debug(`Listed ${notes.length} note summary/ies`);
  return notes;
}

/** Fetches one note's full detail, optionally including the transcript. */
export async function fetchNoteDetail(
  apiKey: string,
  noteId: string,
  includeTranscript: boolean
): Promise<GranolaDoc> {
  const query = includeTranscript ? "?include=transcript" : "";
  const json = await apiGet(apiKey, `/notes/${noteId}${query}`);
  const detail = parseOrThrow(NoteDetailSchema, json, "NoteDetailSchema");
  return noteDetailToGranolaDoc(detail);
}

/** Lists all folders, following cursors. */
export async function listAllFolders(apiKey: string): Promise<GranolaFolder[]> {
  const folders: GranolaFolder[] = [];
  let cursor: string | null | undefined = undefined;
  do {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const json = await apiGet(apiKey, `/folders?${params.toString()}`);
    const page = parseOrThrow(
      ListFoldersResponseSchema,
      json,
      "ListFoldersResponseSchema"
    );
    folders.push(...page.folders);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return folders;
}

/** Cheap connectivity/auth check used by the settings "Test connection" button. */
export async function verifyApiKey(
  apiKey: string
): Promise<{ ok: true } | { ok: false; status?: number; message: string }> {
  try {
    const json = await apiGet(apiKey, "/notes?page_size=1");
    parseOrThrow(ListNotesResponseSchema, json, "ListNotesResponseSchema");
    return { ok: true };
  } catch (error) {
    if (error instanceof GranolaAuthError) {
      return { ok: false, status: 401, message: "Invalid API key." };
    }
    const status = (error as { status?: number }).status;
    return {
      ok: false,
      status,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
