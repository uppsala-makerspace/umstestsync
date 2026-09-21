#!/usr/bin/env node
import { loadConfig } from "./config.js";
import {
  createClients,
  listTestFolders,
  listCategorySheets,
  canAccess,
} from "./drive.js";
import type { sheets_v4 } from "googleapis";
import { readSheetRows, parseQuestions, formulaSeparator, type SheetData } from "./sheets.js";
import { planSheetEdits } from "./translate.js";
import { applySheetEdits } from "./writeSheet.js";
import type { DriveItem } from "./drive.js";
import type { Config } from "./config.js";
import { slugify, toCategory } from "./transform.js";
import { writeCategory } from "./writer.js";
import { Logger } from "./logger.js";
import type { LocalizedText } from "./types.js";

interface CliArgs {
  configPath: string;
  dryRun: boolean;
}

/**
 * Tak för hur många rader som får infogas i ett enskilt ark per körning. En
 * felkonfiguration ska inte kunna skriva obegränsat i skarp data.
 */
const MAX_INSERTS_PER_SHEET = 500;

function parseArgs(argv: string[]): CliArgs {
  let configPath = "config.json";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Flaggan --config kräver en sökväg.");
      }
      configPath = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    }
  }
  return { configPath, dryRun };
}

function printHelp(): void {
  console.log(`umstestsync – synkar frågeark från Google Drive till JSON.

Användning:
  umstestsync [--config <fil>]

Flaggor:
  -c, --config <fil>   Sökväg till konfigurationsfil (standard: config.json)
      --dry-run        Logga vilka rader som skulle fyllas på i arken, utan
                       att skriva något
  -h, --help           Visa denna hjälp

Konfigurationen styr service account-nyckel, rotmapp på Drive,
utdatakatalog, språk och vilka språk arken ska fyllas på med
(translateTo). Se config.example.json.`);
}

/** "1 fråga" / "3 frågor". */
function plural(count: number): string {
  return `${count} ${count === 1 ? "fråga" : "frågor"}`;
}

/** Kortar en lång lista frågenummer så att loggraden förblir läsbar. */
function formatNumbers(numbers: string[]): string {
  const shown = numbers.slice(0, 20).join(", ");
  return numbers.length > 20 ? `${shown}, …` : shown;
}

/**
 * Fyller på arket med saknade titelrader och översättningsrader. Returnerar
 * true om något skrevs, dvs. om arket behöver läsas om.
 *
 * Grindarna här är avsiktligt stränga: verktyget kör oövervakat varje timme
 * och skriver i skarp data.
 */
async function fillTranslations(
  sheetsApi: sheets_v4.Sheets,
  cat: DriveItem,
  sheet: SheetData,
  parsed: ReturnType<typeof parseQuestions>,
  config: Config,
  log: Logger,
  dryRun: boolean,
): Promise<boolean> {
  // Bara flerspråkiga ark, och bara när arket gav något att utgå från.
  if (parsed.layout.languageCol === null) return false;
  if (parsed.questions.length === 0) return false;

  const edits = planSheetEdits(parsed.records, parsed.questions, parsed.layout, {
    sheetName: cat.name,
    baseLanguage: config.language,
    targetLanguages: config.translateTo,
    separator: formulaSeparator(sheet.locale),
  });
  if (edits.length === 0) return false;

  const summary = describeEdits(edits.map((e) => e.label));

  if (cat.canEdit === false) {
    log.warn(
      `"${cat.name}" saknar redigeringsbehörighet för service accountet – ` +
        `${summary} kunde inte läggas till. Dela arket som Redigerare.`,
    );
    return false;
  }
  if (edits.length > MAX_INSERTS_PER_SHEET) {
    log.warn(
      `"${cat.name}" skulle behöva ${edits.length} nya rader, vilket överstiger taket ` +
        `på ${MAX_INSERTS_PER_SHEET}. Inget skrevs – kontrollera arkets layout.`,
    );
    return false;
  }
  if (sheet.columnCount <= parsed.layout.correctCol) {
    log.warn(
      `"${cat.name}" har för få kolumner (${sheet.columnCount}) för layouten – inget skrevs.`,
    );
    return false;
  }
  if (dryRun) {
    log.info(`  ✎ [dry-run] ${cat.name}: ${summary}`);
    return false;
  }

  const res = await applySheetEdits(sheetsApi, cat.id, sheet, edits);
  for (const w of res.warnings) log.warn(`[${slugify(cat.name)}] ${w}`);
  log.info(`  ✎ ${cat.name}: ${summary}`);
  return res.inserted > 0;
}

/** "11 en-översättningar, titel (sv), titel (en)" – aldrig någon frågetext. */
function describeEdits(labels: string[]): string {
  const perLanguage = new Map<string, number>();
  const titles: string[] = [];
  for (const label of labels) {
    if (label.startsWith("titel")) {
      titles.push(label);
      continue;
    }
    const lang = /\(([^)]+)\)$/.exec(label)?.[1] ?? "?";
    perLanguage.set(lang, (perLanguage.get(lang) ?? 0) + 1);
  }
  const parts = [...perLanguage.entries()].map(([lang, n]) => `${n} ${lang}-översättningar`);
  return [...parts, ...titles].join(", ");
}

async function main(): Promise<void> {
  const { configPath, dryRun } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const log = new Logger(config.logFile);

  log.info(`Autentiserar mot Google Drive …`);
  const { drive, sheets } = await createClients(config);

  log.info(`Läser test-mappar i rotmappen ${config.rootFolderId} …`);
  const testFolders = await listTestFolders(drive, config.rootFolderId);
  if (testFolders.length === 0) {
    log.warn(
      "Inga undermappar hittades i rotmappen. Är mappen delad med service account-mailen?",
    );
  }

  let totalCategories = 0;
  let totalQuestions = 0;

  for (const test of testFolders) {
    const testSlug = slugify(test.name);
    const categories = await listCategorySheets(drive, test.id);
    log.info(`\n[test] ${test.name} → ${testSlug}/  (${categories.length} kategorier)`);

    // Tom mapp kan bero på saknad åtkomst (t.ex. en genväg vars målmapp
    // inte är delad med service accountet). Skilj på de fallen.
    if (categories.length === 0 && !(await canAccess(drive, test.id))) {
      log.warn(
        `Kan inte läsa mappen "${test.name}". Om det är en genväg: ` +
          `dela målmappen med service account-mailen, eller flytta in den ` +
          `riktiga mappen i den delade enheten.`,
      );
    }

    for (const cat of categories) {
      const catSlug = slugify(cat.name);
      // Ett trasigt ark (t.ex. saknad redigeringsrätt) får inte stoppa synken
      // för resten av kategorierna.
      try {
        let sheet = await readSheetRows(sheets, cat.id);
        let parsed = parseQuestions(sheet.rows, config.answerCount, config.language);

        // Fyll på saknade titel- och översättningsrader i arket, och läs om
        // så att samma körning får med dem i utdatan.
        if (config.translateTo.length > 0) {
          const wrote = await fillTranslations(sheets, cat, sheet, parsed, config, log, dryRun);
          if (wrote) {
            sheet = await readSheetRows(sheets, cat.id);
            parsed = parseQuestions(sheet.rows, config.answerCount, config.language);
          }
        }

        const { questions, titleOverrides, skipped, missingTranslations, droppedTranslations } =
          parsed;

        for (const w of parsed.warnings) {
          log.warn(`[${catSlug}] ${w}`);
        }

        for (const s of skipped) {
          log.skip({
            test: testSlug,
            category: catSlug,
            questionId: s.number,
            row: s.row,
            reason: s.reason,
          });
        }

        // En rad per språk – inte en per fråga: ett ark med fem av sextio frågor
        // översatta ska inte fylla loggen med varningar.
        for (const m of missingTranslations) {
          log.warn(
            `[${catSlug}] ${plural(m.numbers.length)} saknar ${m.language}-översättning: ` +
              formatNumbers(m.numbers),
          );
        }

        // Frågan är med – det är bara översättningen som fallit bort.
        for (const d of droppedTranslations) {
          log.warn(
            `[${catSlug}] ${d.language}-översättningen utesluten för ${plural(d.numbers.length)} ` +
              `(${d.reason}): ${formatNumbers(d.numbers)}`,
          );
        }

        // Arkets titel kommer från spreadsheetets namn, men en titelrad i arket
        // får överlagra den (och lägga till fler språk).
        const title: LocalizedText = { [config.language]: cat.name.trim(), ...titleOverrides };
        const category = toCategory(questions, title, testSlug, catSlug);

        // Ett ark som plötsligt inte ger någon fråga alls (t.ex. en flerspråkig
        // layout vars rubrikrad försvunnit) ska inte skriva över en fungerande
        // kategorifil – utdatan är inte versionshanterad.
        const filledRows = sheet.rows.filter((r) => r.some((c) => c.trim() !== "")).length;
        if (category.questions.length === 0 && filledRows > 1) {
          log.warn(
            `Inga frågor kunde läsas ur "${cat.name}" trots ${filledRows} ifyllda rader – ` +
              `${catSlug}.json lämnas orörd. Kontrollera arkets rubrikrad och kolumner.`,
          );
          continue;
        }

        await writeCategory(config.outputDir, testSlug, catSlug, category);

        totalCategories++;
        totalQuestions += category.questions.length;
        const skipNote = skipped.length > 0 ? `, ${skipped.length} uteslutna` : "";
        log.info(
          `  ✓ ${cat.name} → ${catSlug}.json  (${category.questions.length} frågor${skipNote})`,
        );
      } catch (err) {
        log.warn(`Kunde inte behandla "${cat.name}": ${(err as Error).message}`);
      }
    }
  }

  log.info(
    `\nKlart. ${totalQuestions} frågor i ${totalCategories} kategorier skrivna till ${config.outputDir}` +
      (log.skips > 0 ? ` (${log.skips} frågor uteslutna – se varningar)` : ""),
  );

  const logPath = await log.flush();
  if (logPath) {
    console.log(`Logg skriven till ${logPath}`);
  }
}

main().catch((err: unknown) => {
  console.error(`\nFel: ${(err as Error).message}`);
  process.exitCode = 1;
});
