import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type { TextComponent } from "obsidian";
import { notifySync } from "./utils/notify";
import { validatePattern } from "./utils/filenameUtils";
import { verifyApiKey } from "./services/granolaApi";
import type GranolaSync from "./main";
import type { FolderMapData } from "./services/folderMapBuilder";
import githubLogoSvg from "../assets/github-logo.svg";

function appendSvg(target: HTMLElement, svgMarkup: string): void {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase() === "svg") {
    target.appendChild(svg);
  }
}

export interface FilterSettings {
  syncDaysBack: number;
  titleFilterMode: "disabled" | "include" | "exclude";
  titleFilterKeyword: string;
}

export interface NoteSettings {
  syncNotes: boolean;
  /**
   * Also sync the notes you typed yourself, above the AI summary. The API
   * only returns them for meetings you own, using a personal API key.
   */
  syncPrivateNotes: boolean;
  saveAsIndividualFiles: boolean; // true = files, false = sections

  // Only if saveAsIndividualFiles = true:
  baseFolderType: "custom" | "daily-notes"; // custom folder vs Daily Notes location
  customAttachmentBaseFolder?: string;
  customBaseFolder?: string; // only if baseFolderType = 'custom'
  subfolderPattern:
    | "none"
    | "day"
    | "month"
    | "year-month"
    | "year-quarter"
    | "custom";
  customSubfolderPattern?: string; // only if subfolderPattern = 'custom'
  filenamePattern: string; // default "{title}", supports variables

  // Only if saveAsIndividualFiles = true:
  // Option to add links to daily notes pointing to individual note files
  linkFromDailyNotes: boolean;
  dailyNoteLinkHeading?: string; // heading for links section, default "# Meetings"

  // Only if saveAsIndividualFiles = false:
  dailyNoteSectionHeading?: string;
}

export interface TranscriptSettings {
  syncTranscripts: boolean;
  transcriptHandling: "combined" | "same-location" | "custom-location";

  // Only if transcriptHandling = 'custom-location':
  customTranscriptBaseFolder?: string;
  transcriptSubfolderPattern?:
    | "none"
    | "day"
    | "month"
    | "year-month"
    | "year-quarter"
    | "custom";
  customTranscriptSubfolderPattern?: string;
  transcriptFilenamePattern?: string;
}

export interface AutomaticSyncSettings {
  isSyncEnabled: boolean;
  syncInterval: number;
  latestSyncTime: number;
}

type LegacySyncDestination =
  | "granola_folder"
  | "daily_notes"
  | "daily_note_folder_structure";

type LegacyTranscriptDestination =
  | "granola_transcripts_folder"
  | "daily_note_folder_structure"
  | "combined_with_note";

export interface LegacySettings {
  syncDestination?: LegacySyncDestination;
  transcriptDestination?: LegacyTranscriptDestination;
  granolaFolder?: string;
  granolaTranscriptsFolder?: string;
  dailyNoteSectionHeading?: string;
}

export type GranolaSyncSettings = NoteSettings &
  TranscriptSettings &
  AutomaticSyncSettings &
  FilterSettings & {
    /** Granola public API key (grn_…), created in Granola → Settings → Connectors → API keys. */
    apiKey: string;
    enableDebugLogging: boolean;
    showSyncNotifications: boolean;
    /** Last plugin version that ran; used to show upgrade notices once. */
    lastSeenVersion?: string;
    // Persisted folder map for detecting renames across syncs
    _folderMapCache?: FolderMapData;
    // Legacy settings preserved for potential rollback
    _legacySettings?: LegacySettings;
  };

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
  // Authentication
  apiKey: "",
  // AutomaticSyncSettings
  latestSyncTime: 0,
  isSyncEnabled: false,
  syncInterval: 30 * 60, // every 30 minutes
  // FilterSettings
  syncDaysBack: 7, // sync notes from last 7 days
  titleFilterMode: "disabled",
  titleFilterKeyword: "",
  // NoteSettings
  syncNotes: true,
  syncPrivateNotes: false, // Opt-in: private notes are the most personal content in Granola
  saveAsIndividualFiles: false, // Default to daily notes (sections)
  baseFolderType: "custom",
  customBaseFolder: "Granola",
  customAttachmentBaseFolder: "Granola Attachments",
  subfolderPattern: "none",
  filenamePattern: "{title}",
  linkFromDailyNotes: false,
  dailyNoteLinkHeading: "# Meetings",
  dailyNoteSectionHeading: "# Granola notes",
  // TranscriptSettings
  syncTranscripts: false,
  transcriptHandling: "custom-location",
  customTranscriptBaseFolder: "Granola/Transcripts",
  transcriptSubfolderPattern: "none",
  transcriptFilenamePattern: "{title}-transcript",
  // Debug / diagnostics
  enableDebugLogging: false,
  // Notifications
  showSyncNotifications: true,
};

/**
 * Settings removed in the public-API rewrite; deleted from loaded data on
 * startup. The public API has no owned/shared or private-notes distinction —
 * the API key's scope governs what is accessible.
 */
export function scrubRemovedSettings(loaded: Record<string, unknown>): void {
  delete loaded.includePrivateNotes;
  delete loaded.includeSharedNotes;
}

/**
 * Migrates old settings format to new format.
 * Detects old format by checking for presence of syncDestination enum.
 *
 * @param oldSettings - The settings object to migrate
 * @returns Migrated settings in new format
 */
export function migrateSettingsToNewFormat(
  oldSettings: Partial<GranolaSyncSettings> & LegacySettings
): GranolaSyncSettings {
  // Check if migration is needed (old format has syncDestination)
  if (!oldSettings.syncDestination) {
    // Already in new format or fresh install
    return Object.assign({}, DEFAULT_SETTINGS, oldSettings);
  }

  // Preserve old settings for potential rollback
  const legacySettings: { _legacySettings: LegacySettings } = {
    _legacySettings: {
      syncDestination: oldSettings.syncDestination,
      transcriptDestination: oldSettings.transcriptDestination,
      granolaFolder: oldSettings.granolaFolder,
      granolaTranscriptsFolder: oldSettings.granolaTranscriptsFolder,
      dailyNoteSectionHeading: oldSettings.dailyNoteSectionHeading,
    },
  };

  // Build new settings structure
  const newSettings: Partial<GranolaSyncSettings> & LegacySettings = {
    ...oldSettings, // Preserve automatic sync settings and other unchanged fields
    ...legacySettings,
  };

  // Migrate note settings
  if (oldSettings.syncDestination === "daily_notes") {
    newSettings.saveAsIndividualFiles = false;
    newSettings.dailyNoteSectionHeading =
      oldSettings.dailyNoteSectionHeading ||
      DEFAULT_SETTINGS.dailyNoteSectionHeading;
  } else {
    newSettings.saveAsIndividualFiles = true;
    newSettings.filenamePattern = "{title}"; // Default pattern

    if (oldSettings.syncDestination === "granola_folder") {
      newSettings.baseFolderType = "custom";
      newSettings.customBaseFolder =
        oldSettings.granolaFolder || DEFAULT_SETTINGS.customBaseFolder;
      newSettings.subfolderPattern = "none";
    } else if (oldSettings.syncDestination === "daily_note_folder_structure") {
      // User wanted date-based organization, but unclear if they wanted custom folder or Daily Notes folder
      // Default to custom folder with day-based subfolders (preserves existing behavior)
      newSettings.baseFolderType = "custom";
      newSettings.customBaseFolder =
        oldSettings.granolaFolder || DEFAULT_SETTINGS.customBaseFolder;
      newSettings.subfolderPattern = "day";
    }
  }

  // Migrate transcript settings
  if (oldSettings.transcriptDestination === "combined_with_note") {
    newSettings.transcriptHandling = "combined";
  } else if (
    oldSettings.transcriptDestination === "daily_note_folder_structure"
  ) {
    newSettings.transcriptHandling = "same-location";
    // Will use same organization as notes
  } else {
    newSettings.transcriptHandling = "custom-location";
    newSettings.customTranscriptBaseFolder =
      oldSettings.granolaTranscriptsFolder ||
      DEFAULT_SETTINGS.customTranscriptBaseFolder;
    newSettings.transcriptSubfolderPattern = "none";
    newSettings.transcriptFilenamePattern = "{title}-transcript";
  }

  // Remove old enum fields
  delete newSettings.syncDestination;
  delete newSettings.transcriptDestination;
  delete newSettings.granolaFolder;
  delete newSettings.granolaTranscriptsFolder;

  return Object.assign({}, DEFAULT_SETTINGS, newSettings);
}

/** Variables resolveSubfolderPattern actually substitutes. */
const SUBFOLDER_VARIABLES = ["year", "month", "day", "quarter"];

export class GranolaSyncSettingTab extends PluginSettingTab {
  plugin: GranolaSync;
  private showAdvanced = false;

  constructor(app: App, plugin: GranolaSync) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Wires inline validation into a pattern text field. Invalid patterns
   * (unknown variables, mistyped braces like "{year)") show an error under
   * the setting and are not saved; the last valid value stays in effect.
   * An empty value is allowed — callers fall back to their default.
   */
  private bindValidatedPattern(
    setting: Setting,
    text: TextComponent,
    allowedVariables: string[] | undefined,
    save: (value: string) => Promise<void>
  ): void {
    const errorEl = setting.infoEl.createDiv({
      cls: "granola-sync-pattern-error",
    });

    const check = (value: string): boolean => {
      if (!value) {
        errorEl.setText("");
        return true;
      }
      const validation = validatePattern(value, allowedVariables);
      errorEl.setText(validation.isValid ? "" : validation.error ?? "");
      text.inputEl.toggleClass(
        "granola-sync-pattern-input-invalid",
        !validation.isValid
      );
      return validation.isValid;
    };

    // Surface problems with the stored value as soon as settings open
    check(text.getValue());

    text.onChange(async (value) => {
      if (check(value)) {
        await save(value);
      }
    });
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    // General settings (no heading per Obsidian conventions)
    new Setting(containerEl)
      .setName("Granola API key")
      .setDesc(
        "Create a key in the Granola desktop app under settings → connectors → API keys (scope: Personal notes), then paste it here."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste your grn_… key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          const key = this.plugin.settings.apiKey;
          if (!key) {
            new Notice("Enter an API key first.");
            return;
          }
          button.setDisabled(true);
          const result = await verifyApiKey(key);
          button.setDisabled(false);
          if (result.ok) {
            new Notice("Granola API connection succeeded.");
          } else {
            new Notice(
              `Granola API connection failed: ${result.message}`,
              8000
            );
          }
        })
      );

    new Setting(containerEl)
      .setName("Periodic sync enabled")
      .setDesc(
        "Automatically sync your Granola notes at regular intervals. When disabled, you'll need to manually run the sync command."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.isSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.isSyncEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.isSyncEnabled) {
      new Setting(containerEl)
        .setName("Sync interval")
        .setDesc(
          "How often to automatically sync notes when periodic sync is enabled. Enter value in seconds (default: 1800 = 30 minutes)."
        )
        .addText((text) =>
          text
            .setPlaceholder("Enter the interval in seconds")
            .setValue(this.plugin.settings.syncInterval.toString())
            .onChange(async (value) => {
              const numValue = parseInt(value);
              if (!isNaN(numValue) && numValue >= 0) {
                this.plugin.settings.syncInterval = numValue;
                await this.plugin.saveSettings();
              } else {
                new Notice("Please enter a valid number for sync interval.");
              }
            })
        );
    }

    new Setting(containerEl)
      .setName("Sync notes")
      .setDesc(
        "Enable syncing of meeting notes from Granola. Turn this off if you only want to sync transcripts."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncNotes)
          .onChange(async (value) => {
            this.plugin.settings.syncNotes = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Attachment base folder")
      .setDesc("The folder where photos and screenshots are saved, grouped by meeting date and name. Changing this does not move existing files; run a full sync to update embeds.")
      .addText((text) =>
        text
          .setPlaceholder("Granola attachments")
          .setValue(this.plugin.settings.customAttachmentBaseFolder || "Granola Attachments")
          .onChange(async (value) => {
            this.plugin.settings.customAttachmentBaseFolder = value;
            await this.plugin.saveSettings();
          })
      );

    if (this.plugin.settings.syncNotes) {
      new Setting(containerEl)
        .setName("Sync private notes")
        .setDesc(
          "Also include the notes you typed yourself, above the generated summary. Granola only returns them for meetings you own, using a personal API key. Run a full sync to add them to notes that are already synced."
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.syncPrivateNotes)
            .onChange(async (value) => {
              this.plugin.settings.syncPrivateNotes = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Sync transcripts")
      .setDesc(
        "Enable syncing of meeting transcripts from Granola. Transcripts are saved with speaker-by-speaker formatting."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncTranscripts)
          .onChange(async (value) => {
            this.plugin.settings.syncTranscripts = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Show sync notifications")
      .setDesc(
        "Show a notice when a sync starts or finishes. Errors are always shown."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSyncNotifications)
          .onChange(async (value) => {
            this.plugin.settings.showSyncNotifications = value;
            await this.plugin.saveSettings();
          })
      );

    // Notes Section
    if (this.plugin.settings.syncNotes) {
      new Setting(containerEl).setName("Notes").setHeading();

      new Setting(containerEl)
        .setName("Save notes as")
        .setDesc("Choose how to package your Granola notes")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("sections", "Sections in daily notes")
            .addOption("files", "Individual files")
            .setValue(
              this.plugin.settings.saveAsIndividualFiles ? "files" : "sections"
            )
            .onChange(async (value) => {
              this.plugin.settings.saveAsIndividualFiles = value === "files";
              await this.plugin.saveSettings();
              this.display();
            })
        );

      if (this.plugin.settings.saveAsIndividualFiles) {
        new Setting(containerEl)
          .setName("Base folder")
          .setDesc("Choose where to save your note files")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("custom", "Custom folder")
              .addOption("daily-notes", "Daily notes folder")
              .setValue(this.plugin.settings.baseFolderType)
              .onChange(async (value) => {
                this.plugin.settings.baseFolderType = value as
                  | "custom"
                  | "daily-notes";
                await this.plugin.saveSettings();
                this.display();
              })
          );

        if (this.plugin.settings.baseFolderType === "custom") {
          new Setting(containerEl)
            .setName("Custom base folder")
            .setDesc("The folder where your Granola notes will be saved")
            .addText((text) =>
              text
                .setPlaceholder("Granola")
                .setValue(this.plugin.settings.customBaseFolder || "Granola")
                .onChange(async (value) => {
                  this.plugin.settings.customBaseFolder = value;
                  await this.plugin.saveSettings();
                })
            );
        }

        new Setting(containerEl)
          .setName("Subfolder organization")
          .setDesc("Choose how to organize notes in subfolders")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("none", "No subfolders (flat)")
              .addOption("day", "By day (YYYY-MM-DD)")
              .addOption("month", "By month (YYYY-MM)")
              .addOption("year-month", "By year/month (YYYY/MM)")
              .addOption("year-quarter", "By year/quarter (YYYY/Q1)")
              .addOption("custom", "Custom pattern")
              .setValue(this.plugin.settings.subfolderPattern)
              .onChange(async (value) => {
                this.plugin.settings.subfolderPattern = value as
                  | "none"
                  | "day"
                  | "month"
                  | "year-month"
                  | "year-quarter"
                  | "custom";
                await this.plugin.saveSettings();
                this.display();
              })
          );

        if (this.plugin.settings.subfolderPattern === "custom") {
          const subfolderSetting = new Setting(containerEl)
            .setName("Custom subfolder pattern")
            .setDesc(
              "Use variables: {year}, {month}, {day}, {quarter}. Example: {year}/{month}"
            );
          subfolderSetting.addText((text) => {
            text
              .setPlaceholder("{year}/{month}")
              .setValue(this.plugin.settings.customSubfolderPattern || "");
            this.bindValidatedPattern(
              subfolderSetting,
              text,
              SUBFOLDER_VARIABLES,
              async (value) => {
                this.plugin.settings.customSubfolderPattern = value;
                await this.plugin.saveSettings();
              }
            );
          });
        }

        const filenameSetting = new Setting(containerEl)
          .setName("Filename pattern")
          .setDesc(
            "Customize note filenames. Variables: {title}, {date}, {time}, {year}, {month}, {day}"
          );
        filenameSetting.addText((text) => {
          text
            .setPlaceholder("{title}")
            .setValue(this.plugin.settings.filenamePattern);
          this.bindValidatedPattern(
            filenameSetting,
            text,
            undefined,
            async (value) => {
              this.plugin.settings.filenamePattern = value || "{title}";
              await this.plugin.saveSettings();
            }
          );
        });

        new Setting(containerEl)
          .setName("Link from daily notes")
          .setDesc(
            "Add links to your individual note files from the corresponding daily notes. This creates a section in each daily note with links to meetings from that day."
          )
          .addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings.linkFromDailyNotes)
              .onChange(async (value) => {
                this.plugin.settings.linkFromDailyNotes = value;
                await this.plugin.saveSettings();
                this.display();
              })
          );

        if (this.plugin.settings.linkFromDailyNotes) {
          new Setting(containerEl)
            .setName("Daily note link heading")
            .setDesc(
              'The markdown heading for the meeting links section in daily notes. Include heading markers (e.g., "# Meetings").\n\n' +
              '**Important:** The plugin replaces the entire section from this heading until the next heading at the same or higher level. Any content you manually add under this heading will be overwritten during sync. To preserve your content, place it under a new heading.'
            )
            .addText((text) =>
              text
                .setPlaceholder("# Meetings")
                .setValue(
                  this.plugin.settings.dailyNoteLinkHeading || "# Meetings"
                )
                .onChange(async (value) => {
                  this.plugin.settings.dailyNoteLinkHeading = value;
                  await this.plugin.saveSettings();
                })
            );
        }
      } else {
        new Setting(containerEl)
          .setName("Daily note section heading")
          .setDesc(
            'The markdown heading for the Granola notes section. Include heading markers (e.g., "# meeting notes").'
          )
          .addText((text) =>
            text
              .setPlaceholder("# Granola notes")
              .setValue(
                this.plugin.settings.dailyNoteSectionHeading ||
                  "# Granola notes"
              )
              .onChange(async (value) => {
                this.plugin.settings.dailyNoteSectionHeading = value;
                await this.plugin.saveSettings();
              })
          );
      }
    }

    // Transcripts Section
    if (this.plugin.settings.syncTranscripts) {
      new Setting(containerEl).setName("Transcripts").setHeading();

      new Setting(containerEl)
        .setName("Transcript handling")
        .setDesc("Choose how to save transcripts")
        .addDropdown((dropdown) => {
          dropdown
            .addOption("custom-location", "Custom location")
            .addOption("same-location", "Same location as notes");
          if (
            this.plugin.settings.syncNotes &&
            this.plugin.settings.saveAsIndividualFiles
          ) {
            dropdown.addOption("combined", "Combined with notes");
          }
          dropdown
            .setValue(this.plugin.settings.transcriptHandling)
            .onChange(async (value) => {
              this.plugin.settings.transcriptHandling = value as
                | "combined"
                | "same-location"
                | "custom-location";
              await this.plugin.saveSettings();
              this.display();
            });
        });

      if (this.plugin.settings.transcriptHandling === "custom-location") {
        new Setting(containerEl)
          .setName("Transcript base folder")
          .setDesc("The folder where transcripts will be saved")
          .addText((text) =>
            text
              .setPlaceholder("Granola/transcripts")
              .setValue(
                this.plugin.settings.customTranscriptBaseFolder ||
                  "Granola/Transcripts"
              )
              .onChange(async (value) => {
                this.plugin.settings.customTranscriptBaseFolder = value;
                await this.plugin.saveSettings();
              })
          );

        new Setting(containerEl)
          .setName("Transcript subfolder organization")
          .setDesc("Choose how to organize transcripts in subfolders")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("none", "No subfolders (flat)")
              .addOption("day", "By day (YYYY-MM-DD)")
              .addOption("month", "By month (YYYY-MM)")
              .addOption("year-month", "By year/month (YYYY/MM)")
              .addOption("year-quarter", "By year/quarter (YYYY/Q1)")
              .addOption("custom", "Custom pattern")
              .setValue(
                this.plugin.settings.transcriptSubfolderPattern || "none"
              )
              .onChange(async (value) => {
                this.plugin.settings.transcriptSubfolderPattern = value as
                  | "none"
                  | "day"
                  | "month"
                  | "year-month"
                  | "year-quarter"
                  | "custom";
                await this.plugin.saveSettings();
                this.display();
              })
          );

        if (this.plugin.settings.transcriptSubfolderPattern === "custom") {
          const transcriptSubfolderSetting = new Setting(containerEl)
            .setName("Custom transcript subfolder pattern")
            .setDesc(
              "Use variables: {year}, {month}, {day}, {quarter}. Example: {year}/{month}"
            );
          transcriptSubfolderSetting.addText((text) => {
            text
              .setPlaceholder("{year}/{month}")
              .setValue(
                this.plugin.settings.customTranscriptSubfolderPattern || ""
              );
            this.bindValidatedPattern(
              transcriptSubfolderSetting,
              text,
              SUBFOLDER_VARIABLES,
              async (value) => {
                this.plugin.settings.customTranscriptSubfolderPattern = value;
                await this.plugin.saveSettings();
              }
            );
          });
        }

        const transcriptFilenameSetting = new Setting(containerEl)
          .setName("Transcript filename pattern")
          .setDesc(
            "Customize transcript filenames. Variables: {title}, {date}, {time}, {year}, {month}, {day}"
          );
        transcriptFilenameSetting.addText((text) => {
          text
            .setPlaceholder("{title}-transcript")
            .setValue(
              this.plugin.settings.transcriptFilenamePattern ||
                "{title}-transcript"
            );
          this.bindValidatedPattern(
            transcriptFilenameSetting,
            text,
            undefined,
            async (value) => {
              this.plugin.settings.transcriptFilenamePattern =
                value || "{title}-transcript";
              await this.plugin.saveSettings();
            }
          );
        });
      }
    }

    // Advanced Section (toggle to show/hide contents)
    new Setting(containerEl).setName("Advanced").setHeading().addToggle(
      (toggle) =>
        toggle.setValue(this.showAdvanced).onChange((value) => {
          this.showAdvanced = value;
          this.display();
        })
    );

    new Setting(containerEl).setDesc(
      "Full sync, filtering, and debugging options."
    );

    if (this.showAdvanced) {
      // Full sync
      new Setting(containerEl)
        .setName("Full sync")
        .setDesc(
          "Re-syncs all files from Granola 🚨 overwriting any local modifications 🚨. Use this to force refresh your notes and transcripts."
        )
        .addButton((button) =>
          button
            .setButtonText("Full sync")
            .setCta()
            .onClick(async () => {
              const showNotices = this.plugin.settings.showSyncNotifications;
              notifySync(showNotices, "Granola sync: Starting full sync.");
              await this.plugin.sync({ mode: "full" });
              notifySync(showNotices, "Granola sync: Full sync complete.");
            })
        );

      // Filtering
      new Setting(containerEl).setName("Filtering").setHeading();

      new Setting(containerEl)
        .setName("Sync history (days)")
        .setDesc(
          "How far back to sync notes and transcripts from Granola, in days. For example, setting this to 7 will only sync notes from the last 7 days. Set to 0 to sync all notes (max 100 notes)."
        )
        .addText((text) =>
          text
            .setPlaceholder("Enter number of days")
            .setValue(this.plugin.settings.syncDaysBack.toString())
            .onChange(async (value) => {
              const numValue = parseInt(value);
              if (!isNaN(numValue) && numValue >= 0) {
                this.plugin.settings.syncDaysBack = numValue;
                await this.plugin.saveSettings();
              } else {
                new Notice("Please enter a valid number for sync days.");
              }
            })
        );

      new Setting(containerEl)
        .setName("Title filter")
        .setDesc(
          "Filter which notes are synced based on their title."
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption("disabled", "Disabled")
            .addOption("include", "Only sync notes where the title includes...")
            .addOption("exclude", "Never sync notes where the title includes...")
            .setValue(this.plugin.settings.titleFilterMode)
            .onChange(async (value) => {
              this.plugin.settings.titleFilterMode = value as
                | "disabled"
                | "include"
                | "exclude";
              await this.plugin.saveSettings();
              this.display();
            })
        );

      if (this.plugin.settings.titleFilterMode !== "disabled") {
        new Setting(containerEl)
          .setName("Title filter keyword")
          .setDesc(
            "Documents will be filtered based on whether their title contains this text (case-insensitive)."
          )
          .addText((text) =>
            text
              .setPlaceholder("Enter keyword...")
              .setValue(this.plugin.settings.titleFilterKeyword)
              .onChange(async (value) => {
                this.plugin.settings.titleFilterKeyword = value;
                await this.plugin.saveSettings();
              })
          );
      }

      // Debugging
      new Setting(containerEl).setName("Debugging").setHeading();

      new Setting(containerEl)
        .setName("Export settings as JSON")
        .setDesc(
          "Copy the current plugin settings as formatted JSON to the clipboard."
        )
        .addButton((button) =>
          button.setButtonText("Export").onClick(async () => {
            try {
              const json = JSON.stringify(this.plugin.settings, null, 2);
              await navigator.clipboard.writeText(json);
              new Notice("Settings copied to clipboard");
            } catch (err) {
              new Notice(
                "Failed to copy settings: " +
                  (err instanceof Error ? err.message : String(err))
              );
            }
          })
        );

      new Setting(containerEl)
        .setName("Enable debug logging")
        .setDesc(
          "When enabled, writes detailed plugin logs to a granola-sync-debug.log file in the plugin folder. Disable when not needed."
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enableDebugLogging)
            .onChange(async (value) => {
              this.plugin.settings.enableDebugLogging = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Copy logs to clipboard")
        .setDesc(
          "Copy the current contents of the debug log file to your clipboard for debugging or bug reports."
        )
        .addButton((button) =>
          button
            .setButtonText("Copy logs to clipboard")
            .onClick(async () => {
              await this.plugin.copyDebugLogsToClipboard();
            })
        );
    }

    // Support Section
    new Setting(containerEl).setName("Support").setHeading();

    new Setting(containerEl)
      .setName("Need support?")
      .setDesc("File an issue on GitHub. Pull requests are even better.")
      .addButton((button) => {
        button.buttonEl.empty();
        button.buttonEl.addClass("granola-sync-support-icon");
        appendSvg(button.buttonEl, githubLogoSvg);
        button.onClick(() => {
          window.open("https://github.com/tomelliot/obsidian-granola-sync/");
        });
      });
  }
}
