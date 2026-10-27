import { Notice, Plugin } from "obsidian";
import { moment } from "./utils/moment";
import { getDailyNote, getAllDailyNotes } from "obsidian-daily-notes-interface";
import { getTitleOrDefault } from "./utils/filenameUtils";
import { notifySync } from "./utils/notify";
import { getNoteDate, getEffectiveUpdatedAt } from "./utils/dateUtils";
import {
  GranolaSyncSettings,
  LegacySettings,
  DEFAULT_SETTINGS,
  GranolaSyncSettingTab,
  migrateSettingsToNewFormat,
  scrubRemovedSettings,
} from "./settings";
import {
  listAllNoteSummaries,
  fetchNoteDetail,
  GranolaAuthError,
  GranolaDoc,
  TranscriptEntry,
} from "./services/granolaApi";
import {
  buildFolderMap,
  diffFolderMaps,
} from "./services/folderMapBuilder";
import {
  formatTranscriptBySpeaker,
  formatTranscriptBody,
} from "./services/transcriptFormatter";
import {
  importLegacySettings,
  hasNoExistingSettings,
} from "./services/legacySettingsImport";
import { PathResolver } from "./services/pathResolver";
import { FileSyncService } from "./services/fileSyncService";
import { DocumentProcessor } from "./services/documentProcessor";
import { DailyNoteBuilder } from "./services/dailyNoteBuilder";
import { AttachmentSyncService } from "./services/attachmentSyncService";
import { filterDocumentsByTitle } from "./utils/documentFilter";
import { configureLogger, log } from "./utils/logger";
import { formatStringListAsYaml } from "./utils/yamlUtils";
import {
  showStatusBar,
  hideStatusBar,
  showStatusBarTemporary,
} from "./utils/statusBar";

/** Plugin major version that introduced the "Sync private notes" setting. */
const PRIVATE_NOTES_MAJOR_VERSION = 3;

/** Leading integer of a semver string; 0 when missing or unparsable. */
function majorVersion(version: string | undefined): number {
  const major = parseInt(version ?? "", 10);
  return Number.isNaN(major) ? 0 : major;
}

export default class GranolaSync extends Plugin {
  settings: GranolaSyncSettings;
  syncIntervalId: number | null = null;
  private pathResolver!: PathResolver;
  private fileSyncService!: FileSyncService;
  private documentProcessor!: DocumentProcessor;
  private dailyNoteBuilder!: DailyNoteBuilder;
  statusBarItemEl: HTMLElement | null = null;
  statusBarTimeoutId: number | null = null;

  async onload() {
    await this.loadSettings();

    await this.maybeShowUpgradeNotice();

    this.initializeLogger();

    // Initialize services
    this.initializeServices();

    // This adds a simple command that can be triggered anywhere
    this.addCommand({
      id: "sync-granola",
      name: "Sync from Granola",
      callback: async () => {
        notifySync(
          this.settings.showSyncNotifications,
          "Granola sync: Starting manual sync."
        );
        await this.sync();
        notifySync(
          this.settings.showSyncNotifications,
          "Granola sync: Manual sync complete."
        );

        if (!this.settings.syncNotes && !this.settings.syncTranscripts) {
          new Notice(
            "Granola sync: No sync options enabled. Please enable either notes or transcripts in settings."
          );
        }
      },
    });

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new GranolaSyncSettingTab(this.app, this));

    // Setup periodic sync based on settings
    this.setupPeriodicSync();

    // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
    // Example: this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
    // We handle our interval manually with setupPeriodicSync and clearPeriodicSync
  }

  onunload() {
    // Clean up status bar (includes clearing timeout)
    hideStatusBar(this);
  }

  async loadSettings() {
    let loadedData = (await this.loadData()) as
      | (Partial<GranolaSyncSettings> & LegacySettings)
      | null;

    // On a fresh install, adopt settings left behind in a plugin folder we
    // previously shipped under, so an id change doesn't reset the user.
    let importedFrom: string | null = null;
    if (hasNoExistingSettings(loadedData)) {
      const imported = await this.importSettingsFromPreviousPluginId();
      if (imported) {
        loadedData = imported.settings;
        importedFrom = imported.pluginId;
      }
    }

    const mergedSettings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    scrubRemovedSettings(mergedSettings as unknown as Record<string, unknown>);

    // Check if migration is needed
    if (mergedSettings.syncDestination) {
      // Migrate old settings to new format
      this.settings = migrateSettingsToNewFormat(mergedSettings);
      // Save migrated settings immediately
      await this.saveData(this.settings);
      log.info("Migrated settings from old format to new format");
    } else {
      // Already in new format
      this.settings = mergedSettings;
    }

    if (importedFrom) {
      // Persist immediately so the import runs exactly once.
      await this.saveData(this.settings);
      log.info(`Imported settings from previous plugin id "${importedFrom}"`);
      new Notice(
        `Granola sync: imported your settings from the previous "${importedFrom}" plugin folder.`
      );
    }
  }

  /**
   * Reads settings from a plugin folder this plugin used to live under.
   * Best-effort: any failure leaves the user on defaults rather than blocking
   * plugin load.
   */
  private async importSettingsFromPreviousPluginId(): Promise<{
    pluginId: string;
    settings: Record<string, unknown>;
  } | null> {
    try {
      const vault = this.app?.vault;
      const adapter = vault?.adapter;
      if (!adapter?.exists || !adapter?.read || !vault?.configDir) return null;
      return await importLegacySettings(adapter, vault.configDir);
    } catch (error) {
      log.warn("Could not import settings from a previous plugin id", error);
      return null;
    }
  }

  /**
   * On the first load of a new plugin version, show a one-time notice:
   * - without an API key, that syncing now requires one (so upgraders from
   *   2.0.x learn what changed);
   * - with a key, and coming from a 2.x version (or none recorded), that
   *   private notes can now be synced — the headline change in 3.0.0.
   * Later 3.x upgrades are recorded silently.
   */
  private async maybeShowUpgradeNotice(): Promise<void> {
    const currentVersion = this.manifest.version;
    const previousVersion = this.settings.lastSeenVersion;
    if (previousVersion === currentVersion) return;

    this.settings.lastSeenVersion = currentVersion;
    await this.saveData(this.settings);

    if (!this.settings.apiKey) {
      new Notice(
        "Granola sync now uses Granola's official API and needs an API key to sync. " +
          "Create one in the Granola app under settings → connectors → API keys " +
          "(requires a paid Granola plan), then paste it in the plugin settings.",
        0
      );
      return;
    }

    if (majorVersion(previousVersion) < PRIVATE_NOTES_MAJOR_VERSION) {
      new Notice(
        "Granola sync can now include the private notes you typed yourself, above the summary. " +
          "Turn on sync private notes in the plugin settings, then run a full sync to add them to existing notes. " +
          "Granola only returns them for meetings you own, using a personal API key.",
        0
      );
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.updateServices();
    this.setupPeriodicSync();
  }

  /**
   * Initializes all services with current settings.
   * Called during plugin load and when settings change.
   */
  private initializeServices(): void {
    // Initialize PathResolver with current settings
    this.pathResolver = new PathResolver(this.settings);

    // Initialize FileSyncService with PathResolver
    // FileSyncService uses getter function for settings, so it will automatically
    // pick up the latest settings values
    this.fileSyncService = new FileSyncService(
      this.app,
      this.pathResolver,
      () => this.settings
    );

    // Initialize DocumentProcessor with current settings
    this.documentProcessor = new DocumentProcessor(
      {
        syncTranscripts: this.settings.syncTranscripts,
        syncPrivateNotes: this.settings.syncPrivateNotes,
      },
      this.pathResolver
    );

    // Initialize DailyNoteBuilder with DocumentProcessor
    this.dailyNoteBuilder = new DailyNoteBuilder(
      this.app,
      this.documentProcessor
    );
  }

  /**
   * Updates services when settings change during plugin runtime.
   * Recreates services that depend on settings to ensure they use the latest values.
   */
  private updateServices(): void {
    this.initializeServices();
  }

  setupPeriodicSync() {
    this.clearPeriodicSync(); // Clear any existing interval first
    if (this.settings.isSyncEnabled && this.settings.syncInterval > 0) {
      this.syncIntervalId = window.setInterval(() => {
        void this.sync();
      }, this.settings.syncInterval * 1000);
      this.registerInterval(this.syncIntervalId); // Register with Obsidian to auto-clear on disable
    }
  }

  clearPeriodicSync() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  private debugLogFilePath: string | null = null;

  private initializeLogger(): void {
    // manifest.dir is the vault-relative plugin folder, so logs stay inside
    // the vault and go through the adapter API on every platform.
    const pluginDir = this.manifest.dir;

    if (!pluginDir) {
      configureLogger(null);
      return;
    }

    // Generate a timestamped log filename once per session
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d{3}Z$/, "");
    const logsDir = `${pluginDir}/logs`;
    this.debugLogFilePath = `${logsDir}/${timestamp}.log`;

    configureLogger({
      isDebugEnabled: () => this.settings.enableDebugLogging,
      appendLine: async (line: string) => {
        if (!this.debugLogFilePath) return;
        try {
          const adapter = this.app.vault.adapter;
          if (!(await adapter.exists(logsDir))) {
            await adapter.mkdir(logsDir);
          }
          await adapter.append(this.debugLogFilePath, line);
        } catch {
          // Swallow all errors to avoid affecting plugin behavior
        }
      },
    });
  }

  async copyDebugLogsToClipboard(): Promise<void> {
    const debugLogPath = this.debugLogFilePath;

    if (!debugLogPath) {
      new Notice(
        "Copying debug logs is not available in this environment."
      );
      return;
    }

    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(debugLogPath))) {
        new Notice(
          "Debug log file not found. Enable debug logging and try again."
        );
        return;
      }

      const contents = await adapter.read(debugLogPath);

      if (!contents) {
        new Notice("Debug log file is empty.");
        return;
      }

      await navigator.clipboard.writeText(contents);
      new Notice("Debug logs copied to clipboard.");
    } catch (error) {
      new Notice(
        "Failed to copy debug logs: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  private updateSyncStatus(
    kind: "Note" | "Transcript",
    current: number,
    total: number
  ): void {
    if (total <= 0) {
      return;
    }

    const clampedCurrent = Math.min(Math.max(current, 1), total);
    const label = kind === "Note" ? "note" : "Transcript";
    showStatusBar(this, `Granola sync: ${label} ${clampedCurrent}/${total}`);
  }

  /**
   * Updates frontmatter on all vault notes affected by folder renames.
   * Scans all markdown files for folders entries matching old paths
   * and replaces them with new paths.
   */
  private async updateRenamedFolders(
    renamedPaths: Map<string, string>
  ): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let updatedCount = 0;

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const folders = cache?.frontmatter?.folders as
        | string[]
        | undefined;
      if (!folders || !Array.isArray(folders)) continue;

      let changed = false;
      const updatedFolders = folders.map((folder) => {
        const newPath = renamedPaths.get(folder);
        if (newPath) {
          changed = true;
          return newPath;
        }
        return folder;
      });

      if (changed) {
        const content = await this.app.vault.read(file);
        const updatedContent = this.replaceFrontmatterFolders(
          content,
          updatedFolders
        );
        if (updatedContent !== content) {
          await this.app.vault.modify(file, updatedContent);
          updatedCount++;
        }
      }
    }

    if (updatedCount > 0) {
      log.debug(
        `Updated folders in ${updatedCount} file(s) due to folder renames`
      );
    }
  }

  /**
   * Replaces the folders list in YAML frontmatter with updated values.
   */
  private replaceFrontmatterFolders(
    content: string,
    newFolders: string[]
  ): string {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return content;

    const frontmatter = frontmatterMatch[1];

    const folderBlockRegex =
      /folders:\s*\n((?:\s+-\s+.*\n?)*)/;
    const match = frontmatter.match(folderBlockRegex);
    if (!match) return content;

    const newBlock =
      "folders:\n" +
      newFolders.map((f) => `  - "${f}"`).join("\n") +
      "\n";
    const updatedFrontmatter = frontmatter.replace(folderBlockRegex, newBlock);

    return content.replace(
      /^---\n[\s\S]*?\n---/,
      `---\n${updatedFrontmatter}\n---`
    );
  }

  /**
   * Backfills the `folders` frontmatter field on existing vault notes that have
   * a `granola_id` but are missing folder metadata. This ensures previously
   * synced documents get folder paths added when the feature is first enabled.
   */
  private async backfillFolderMetadata(
    docFolders: Record<string, string[]>
  ): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let updatedCount = 0;
    let scannedCount = 0;
    let alreadyHasFoldersCount = 0;
    let noFolderDataCount = 0;
    let noFrontmatterCount = 0;

    log.debug(`backfillFolderMetadata — scanning ${files.length} markdown file(s), docFolders has ${Object.keys(docFolders).length} mapping(s)`);

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatter?.granola_id) continue;

      scannedCount++;

      // Skip files that already have a folders field
      if (cache.frontmatter.folders !== undefined) {
        alreadyHasFoldersCount++;
        continue;
      }

      const granolaId = cache.frontmatter.granola_id as string;
      const folders = docFolders[granolaId];
      if (!folders || folders.length === 0) {
        noFolderDataCount++;
        log.debug(`backfill skip — no folder data for granolaId=${granolaId} (${file.path})`);
        continue;
      }

      const content = await this.app.vault.read(file);
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) {
        noFrontmatterCount++;
        log.debug(`backfill skip — no parseable frontmatter in ${file.path}`);
        continue;
      }

      const frontmatter = frontmatterMatch[1];
      const foldersYaml = `folders: ${formatStringListAsYaml(folders)}`;
      const updatedFrontmatter = frontmatter + "\n" + foldersYaml;
      const updatedContent = content.replace(
        /^---\n[\s\S]*?\n---/,
        `---\n${updatedFrontmatter}\n---`
      );

      if (updatedContent !== content) {
        await this.app.vault.modify(file, updatedContent);
        updatedCount++;
        log.debug(`backfill updated — ${file.path} (granolaId=${granolaId}, folders=${JSON.stringify(folders)})`);
      }
    }

    log.debug(`backfillFolderMetadata — scanned=${scannedCount} granola files, updated=${updatedCount}, alreadyHasFolders=${alreadyHasFoldersCount}, noFolderData=${noFolderDataCount}, noFrontmatter=${noFrontmatterCount}`);
  }

  // Top-level sync function that handles common setup once
  async sync(options: { mode?: "standard" | "full" } = {}) {
    const mode = options.mode ?? "standard";
    log.debug(`Sync started — mode=${mode}, daysBack=${this.settings.syncDaysBack}`);

    const apiKey = this.settings.apiKey;
    if (!apiKey) {
      new Notice(
        "Granola sync: No API key configured. Create one in Granola → settings → connectors → API keys, then paste it in the plugin settings.",
        10000
      );
      return;
    }

    showStatusBar(this, "Granola sync: Syncing...");

    // Build the Granola ID cache before syncing
    await this.fileSyncService.buildCache();

    const needTranscripts = this.settings.syncTranscripts;
    const isCombinedMode =
      needTranscripts && this.settings.transcriptHandling === "combined";
    const noteType = isCombinedMode ? "combined" : "note";

    const documents: GranolaDoc[] = [];
    try {
      // Phase 1: cheap summary listing (id/title/timestamps only)
      let summaries = await listAllNoteSummaries(
        apiKey,
        mode === "full" ? 0 : this.settings.syncDaysBack
      );
      summaries = filterDocumentsByTitle(
        summaries,
        this.settings.titleFilterMode,
        this.settings.titleFilterKeyword
      );

      // Phase 2: hydrate only notes that need work (rate-limit friendly)
      const toHydrate = summaries.filter((summary) => {
        if (mode === "full") return true;
        const existing = this.fileSyncService.findByGranolaId(
          summary.id,
          noteType
        );
        // New note — or a legacy-id file, which is resolved at save time.
        if (!existing) return true;
        return this.fileSyncService.isRemoteNewer(
          summary.id,
          summary.updated_at,
          noteType
        );
      });
      log.debug(
        `Hydrating ${toHydrate.length} of ${summaries.length} note(s)`
      );

      let hydratedCount = 0;
      let failedFetches = 0;
      for (const summary of toHydrate) {
        hydratedCount++;
        showStatusBar(
          this,
          `Granola sync: Fetching ${hydratedCount}/${toHydrate.length}`
        );
        try {
          documents.push(
            await fetchNoteDetail(apiKey, summary.id, needTranscripts)
          );
        } catch (error: unknown) {
          // A rejected key won't recover on the next note — abort the sync.
          if (error instanceof GranolaAuthError) throw error;
          // Anything else (e.g. a note Granola's server persistently 502s
          // on) should cost us that note, not the whole sync.
          failedFetches++;
          log.error(
            `Skipping note ${summary.id} ("${summary.title}") — fetch failed:`,
            error
          );
        }
      }
      if (failedFetches > 0) {
        new Notice(
          `Granola sync: ${failedFetches} note${
            failedFetches === 1 ? "" : "s"
          } could not be fetched and ${
            failedFetches === 1 ? "was" : "were"
          } skipped. See the debug log for details.`,
          10000
        );
      }
    } catch (error: unknown) {
      if (error instanceof GranolaAuthError) {
        new Notice(
          "Granola sync error: The Granola API rejected your API key. Check it in the plugin settings.",
          10000
        );
      } else {
        const errorStatus = (error as { status?: number })?.status;
        if (errorStatus && errorStatus >= 500) {
          new Notice(
            "Granola sync error: Granola API server error. Please try again later.",
            10000
          );
        } else {
          new Notice(
            "Granola sync error: Failed to fetch notes from the Granola API. Please check your internet connection.",
            10000
          );
        }
      }
      log.error("Error fetching Granola notes:", error);
      hideStatusBar(this);
      return;
    }

    if (documents.length === 0) {
      notifySync(
        this.settings.showSyncNotifications,
        "Granola sync: Everything up to date.",
        5000
      );
      hideStatusBar(this);
      return;
    }

    showStatusBar(this, `Granola sync: Syncing ${documents.length} notes`);
    log.debug(`Granola API: hydrated ${documents.length} note(s) (mode=${mode})`);

    if (this.settings.syncNotes) {
      const attachmentSync = new AttachmentSyncService(this.app);
      for (let i = 0; i < documents.length; i++) {
        if (documents[i].attachments?.length) {
          documents[i] = await attachmentSync.sync(documents[i]);
        }
      }
    }

    // Build folder map (document → folder paths)
    let docFolders: Record<string, string[]> = {};
    try {
      showStatusBar(this, "Granola sync: Fetching folders...");
      const freshFolderMap = await buildFolderMap(apiKey, documents);
      const previousFolderMap = this.settings._folderMapCache ?? null;

      // Detect folder renames and update affected notes
      const diff = diffFolderMaps(previousFolderMap, freshFolderMap);
      if (diff.renamedPaths.size > 0) {
        log.debug(`Detected ${diff.renamedPaths.size} folder rename(s)`);
        await this.updateRenamedFolders(diff.renamedPaths);
      }

      // Persist the fresh folder map
      this.settings._folderMapCache = freshFolderMap;
      await this.saveData(this.settings);

      docFolders = freshFolderMap.docFolders;
      log.debug(`Folder map built — ${Object.keys(freshFolderMap.folders).length} folder(s), ${Object.keys(docFolders).length} document(s) with folder data`);

      // Backfill folders on existing notes that don't have the field yet
      await this.backfillFolderMetadata(docFolders);
    } catch (error) {
      log.error("Failed to build folder map, continuing sync without folder data:", error);
      // Use previously cached data if available
      if (this.settings._folderMapCache) {
        docFolders = this.settings._folderMapCache.docFolders;
        log.debug("Using cached folder map from previous sync");
      }
    }

    const forceOverwrite = mode === "full";

    // Transcripts arrive with the note detail — no separate fetch phase.
    let transcriptDataMap: Map<string, TranscriptEntry[]> | null = null;
    if (this.settings.syncTranscripts) {
      transcriptDataMap = new Map();
      for (const doc of documents) {
        if (doc.transcript && doc.transcript.length > 0) {
          transcriptDataMap.set(doc.id, doc.transcript);
        }
      }
      if (!isCombinedMode) {
        await this.saveTranscriptFiles(
          documents,
          transcriptDataMap,
          forceOverwrite
        );
      }
    }
    if (this.settings.syncNotes) {
      await this.syncNotes(documents, forceOverwrite, transcriptDataMap, docFolders);
    }

    // Update frontmatter cross-links between notes and transcripts using
    // actual on-disk paths (after collision resolution).
    await this.updateCrossLinks(documents);

    // Show success message
    showStatusBarTemporary(this, "Granola sync: Complete");
  }

  private async syncNotes(
    documents: GranolaDoc[],
    forceOverwrite: boolean = false,
    transcriptDataMap: Map<string, TranscriptEntry[]> | null = null,
    docFolders: Record<string, string[]> = {}
  ): Promise<void> {
    let syncedCount: number;
    log.debug(`syncNotes — mode=${this.settings.saveAsIndividualFiles ? "individual" : "daily-notes"}, docs=${documents.length}`);

    if (!this.settings.saveAsIndividualFiles) {
      syncedCount = await this.syncNotesToDailyNotes(
        documents,
        forceOverwrite,
        transcriptDataMap,
        docFolders
      );
    } else {
      const result = await this.syncNotesToIndividualFiles(
        documents,
        forceOverwrite,
        transcriptDataMap,
        docFolders
      );
      syncedCount = result.syncedCount;

      // Add links to daily notes if enabled.
      // Sync order: buildCache() runs before sync; each save updates the cache. So when we merge
      // existing links here, every link we wrote in a prior sync either resolves (note still in
      // vault) or is dropped (note deleted).
      if (this.settings.linkFromDailyNotes && result.syncedNotes.length > 0) {
        const linkHeading =
          this.settings.dailyNoteLinkHeading ||
          DEFAULT_SETTINGS.dailyNoteLinkHeading!;
        await this.dailyNoteBuilder.addLinksToDailyNotes(
          result.syncedNotes,
          linkHeading,
          forceOverwrite,
          (path) => this.fileSyncService.getGranolaIdByPath(path)
        );
      }
    }

    this.settings.latestSyncTime = Date.now();
    // Persist directly: saveSettings() rebuilds services and would clear the
    // FileSyncService cache mid-sync, breaking updateCrossLinks().
    await this.saveData(this.settings);

    log.debug(`Saved ${syncedCount} note(s)`);
  }

  private async syncNotesToDailyNotes(
    documents: GranolaDoc[],
    forceOverwrite: boolean = false,
    transcriptDataMap: Map<string, TranscriptEntry[]> | null = null,
    docFolders: Record<string, string[]> = {}
  ): Promise<number> {
    const dailyNotesMap = this.dailyNoteBuilder.buildDailyNotesMap(documents, docFolders);
    const sectionHeadingSetting = (
      this.settings.dailyNoteSectionHeading ||
      DEFAULT_SETTINGS.dailyNoteSectionHeading!
    ).trim();
    const isCombinedMode =
      this.settings.syncTranscripts &&
      this.settings.transcriptHandling === "combined";
    let processedCount = 0;
    let syncedCount = 0;

    for (const [dateKey, notesWithDocs] of dailyNotesMap) {
      const dailyNoteFile = await this.dailyNoteBuilder.getOrCreateDailyNote(
        dateKey
      );

      // Extract just the note data for comparison
      const notesForDay = notesWithDocs.map((item) => item.noteData);

      // Check if all notes for this date are already up-to-date (unless forceOverwrite is true)
      if (!forceOverwrite) {
        const fileContent = await this.app.vault.read(dailyNoteFile);
        const existingNotes = this.dailyNoteBuilder.extractExistingNotes(
          fileContent,
          sectionHeadingSetting
        );

        // Check if all notes are present and up-to-date
        const allNotesUpToDate = notesForDay.every((note) => {
          const existingUpdatedAt = existingNotes.get(note.docId);
          // Note is up-to-date if it exists and has the same or newer updated_at timestamp
          return existingUpdatedAt !== undefined && existingUpdatedAt === note.updatedAt;
        });

        if (allNotesUpToDate && existingNotes.size === notesForDay.length) {
          log.debug(`Daily notes for ${dateKey} — all ${notesForDay.length} note(s) up-to-date, skipping`);
          processedCount += notesForDay.length;
          this.updateSyncStatus("Note", processedCount, documents.length);
          continue;
        }
      }

      // Append transcript content for combined mode
      const notesWithTranscripts = notesWithDocs.map(({ noteData, doc }) => {
        if (isCombinedMode && transcriptDataMap) {
          const transcriptData = transcriptDataMap.get(doc.id || "");
          if (transcriptData && transcriptData.length > 0) {
            const transcriptBody = formatTranscriptBody(transcriptData);
            // Set transcript link to heading within the same section
            return {
              ...noteData,
              markdown:
                noteData.markdown + "\n\n### Transcript\n\n" + transcriptBody,
              transcript: "[[#Transcript]]",
            };
          }
        }
        return noteData;
      });

      const sectionContent = this.dailyNoteBuilder.buildDailyNoteSectionContent(
        notesWithTranscripts,
        sectionHeadingSetting
      );

      await this.dailyNoteBuilder.updateDailyNoteSection(
        dailyNoteFile,
        sectionHeadingSetting,
        sectionContent,
        forceOverwrite
      );
      processedCount += notesForDay.length;
      this.updateSyncStatus("Note", processedCount, documents.length);

      syncedCount += notesForDay.length;
    }

    return syncedCount;
  }

  private async syncNotesToIndividualFiles(
    documents: GranolaDoc[],
    forceOverwrite: boolean = false,
    transcriptDataMap: Map<string, TranscriptEntry[]> | null = null,
    docFolders: Record<string, string[]> = {}
  ): Promise<{
    syncedCount: number;
    syncedNotes: Array<{ doc: GranolaDoc; notePath: string }>;
  }> {
    let processedCount = 0;
    let syncedCount = 0;
    const syncedNotes: Array<{
      doc: GranolaDoc;
      notePath: string;
    }> = [];
    const isCombinedMode =
      this.settings.syncTranscripts &&
      this.settings.transcriptHandling === "combined";

    for (const doc of documents) {
      const notePath = this.pathResolver.computeNotePath(doc);

      // Skip processing if note already exists locally and is up-to-date (unless forceOverwrite is true)
      if (!forceOverwrite) {
        const existingNote = this.fileSyncService.findByGranolaId(
          doc.id,
          isCombinedMode ? "combined" : "note"
        );
        if (existingNote) {
          // Check if remote is newer than local
          if (
            !this.fileSyncService.isRemoteNewer(
              doc.id,
              getEffectiveUpdatedAt(doc),
              isCombinedMode ? "combined" : "note"
            )
          ) {
            log.debug(`Skipping doc ${doc.id} — local copy is up-to-date`);
            continue;
          }
        }
      }

      processedCount++;
      this.updateSyncStatus("Note", processedCount, documents.length);

      const folders = docFolders[doc.id];
      log.debug(`Syncing doc ${doc.id} — folders=${folders ? JSON.stringify(folders) : "none"}`);

      // Handle combined mode: save note and transcript together
      if (isCombinedMode && transcriptDataMap) {
        const transcriptData = transcriptDataMap.get(doc.id || "");
        if (transcriptData && transcriptData.length > 0) {
          const transcriptBody = formatTranscriptBody(transcriptData);
          const result = await this.fileSyncService.saveCombinedNoteToDisk(
            doc,
            this.documentProcessor,
            transcriptBody,
            forceOverwrite,
            folders
          );
          if (result.saved) {
            syncedCount++;
            // Use the actual on-disk path to handle collision-resolved filenames
            // (recurring meetings share a title, so later saves get a date suffix).
            syncedNotes.push({ doc, notePath: result.path ?? notePath });
          }
        } else {
          // No transcript available, save as regular note
          const result = await this.fileSyncService.saveNoteToDisk(
            doc,
            this.documentProcessor,
            forceOverwrite,
            folders
          );
          if (result.saved) {
            syncedCount++;
            syncedNotes.push({ doc, notePath: result.path ?? notePath });
          }
        }
      } else {
        // Save note without cross-links; frontmatter linking is done
        // in updateCrossLinks() after both notes and transcripts are saved.
        const result = await this.fileSyncService.saveNoteToDisk(
          doc,
          this.documentProcessor,
          forceOverwrite,
          folders
        );
        if (result.saved) {
          syncedCount++;
          syncedNotes.push({ doc, notePath: result.path ?? notePath });
        }
      }
    }

    log.debug(
      `syncNotesToIndividualFiles - Completed: ${syncedCount} saved out of ${processedCount} processed`
    );
    return { syncedCount, syncedNotes };
  }

  /**
   * After both notes and transcripts are saved, update frontmatter cross-links
   * using the actual on-disk paths (which may differ from computed paths due to
   * collision resolution with date suffixes).
   */
  private async updateCrossLinks(documents: GranolaDoc[]): Promise<void> {
    // Cross-links only apply when both notes and transcripts are synced, and
    // transcripts are saved as separate files (not combined mode).
    if (
      !this.settings.syncNotes ||
      !this.settings.syncTranscripts ||
      this.settings.transcriptHandling === "combined"
    ) {
      return;
    }

    let updatedCount = 0;
    for (const doc of documents) {
      try {
        const transcriptFile = this.fileSyncService.findByGranolaId(doc.id, "transcript");
        if (!transcriptFile) continue;

        // Resolve the note path for transcript→note linking
        let noteLinkPath: string | null = null;
        if (this.settings.saveAsIndividualFiles) {
          // Individual files: use actual on-disk path from cache
          const noteFile = this.fileSyncService.findByGranolaId(doc.id, "note");
          if (noteFile) {
            noteLinkPath = noteFile.path;
            await this.app.fileManager.processFrontMatter(
              noteFile,
              (fm: Record<string, unknown>) => {
                fm.transcript = `[[${transcriptFile.path}]]`;
              }
            );
          }
        } else {
          // Daily notes mode: link to the daily note heading
          const noteDate = getNoteDate(doc);
          const noteMoment = moment(noteDate);
          const dailyNoteFile = getDailyNote(noteMoment, getAllDailyNotes());
          if (dailyNoteFile) {
            const title = getTitleOrDefault(doc);
            noteLinkPath = `${dailyNoteFile.basename}#${title}`;
          }
        }

        if (noteLinkPath) {
          await this.app.fileManager.processFrontMatter(
            transcriptFile,
            (fm: Record<string, unknown>) => {
              fm.note = `[[${noteLinkPath}]]`;
            }
          );
        }

        updatedCount++;
      } catch (e) {
        log.error(`updateCrossLinks: failed for doc ${doc.id}:`, e);
      }
    }

    if (updatedCount > 0) {
      log.debug(`Updated cross-links in ${updatedCount} note/transcript pair(s)`);
    }
  }

  /**
   * Saves separate transcript files for documents whose transcript arrived
   * with the note detail. Not used in combined mode (the transcript is
   * embedded into the note file there).
   */
  private async saveTranscriptFiles(
    documents: GranolaDoc[],
    transcriptDataMap: Map<string, TranscriptEntry[]>,
    forceOverwrite: boolean = false
  ): Promise<void> {
    let processedCount = 0;
    let syncedCount = 0;

    for (const doc of documents) {
      const docId = doc.id;
      const title = getTitleOrDefault(doc);
      const transcriptData = transcriptDataMap.get(docId);
      if (!transcriptData || transcriptData.length === 0) {
        log.debug(`Skipping transcript for doc ${docId} — no transcript data`);
        continue;
      }

      try {
        // Skip if transcript already exists locally and is up-to-date (unless forceOverwrite is true)
        if (!forceOverwrite) {
          const existingTranscript = this.fileSyncService.findByGranolaId(
            docId,
            "transcript"
          );
          if (
            existingTranscript &&
            !this.fileSyncService.isRemoteNewer(
              docId,
              getEffectiveUpdatedAt(doc),
              "transcript"
            )
          ) {
            log.debug(`Skipping transcript for doc ${docId} — local copy is up-to-date`);
            continue;
          }
        }

        // Save transcript without cross-links; frontmatter linking is done
        // in updateCrossLinks() after both notes and transcripts are saved,
        // so the paths reflect any collision-resolved filenames.
        const transcriptMd = formatTranscriptBySpeaker(
          transcriptData,
          title,
          docId,
          doc.created_at,
          getEffectiveUpdatedAt(doc),
          doc.people?.attendees
            ?.map((attendee) => attendee.name || attendee.email || "Unknown")
            .filter((name) => name !== "Unknown"),
          undefined
        );
        processedCount++;
        this.updateSyncStatus("Transcript", processedCount, documents.length);
        const transcriptResult = await this.fileSyncService.saveTranscriptToDisk(
          doc,
          transcriptMd,
          this.documentProcessor,
          forceOverwrite
        );
        if (transcriptResult.saved) {
          syncedCount++;
        }
      } catch (e) {
        new Notice(
          `Error saving transcript for document: ${title}. Check console.`,
          7000
        );
        log.error(`Transcript save error for doc ${docId}:`, e);
      }
    }
    log.debug(
      `saveTranscriptFiles - Completed: ${syncedCount} saved out of ${processedCount} processed`
    );
  }
}
