#!/usr/bin/env node
import { loadConfig } from "./config.js";
import {
  createClients,
  listTestFolders,
  listCategorySheets,
  canAccess,
} from "./drive.js";
import { readSheetRows, parseQuestions } from "./sheets.js";
import { slugify, toCategory } from "./transform.js";
import { writeCategory } from "./writer.js";
import { Logger } from "./logger.js";
import type { LocalizedText } from "./types.js";

interface CliArgs {
  configPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let configPath = "config.json";
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
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    }
  }
  return { configPath };
}

function printHelp(): void {
  console.log(`umstestsync – synkar frågeark från Google Drive till JSON.

Användning:
  umstestsync [--config <fil>]

Flaggor:
  -c, --config <fil>   Sökväg till konfigurationsfil (standard: config.json)
  -h, --help           Visa denna hjälp

Konfigurationen styr service account-nyckel, rotmapp på Drive,
utdatakatalog och språk. Se config.example.json.`);
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

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));
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
      const rows = await readSheetRows(sheets, cat.id);
      const {
        questions: parsed,
        titleOverrides,
        skipped,
        missingTranslations,
        droppedTranslations,
        warnings,
      } = parseQuestions(rows, config.answerCount, config.language);

      for (const w of warnings) {
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
      const category = toCategory(parsed, title, testSlug, catSlug);

      // Ett ark som plötsligt inte ger någon fråga alls (t.ex. en flerspråkig
      // layout vars rubrikrad försvunnit) ska inte skriva över en fungerande
      // kategorifil – utdatan är inte versionshanterad.
      const filledRows = rows.filter((r) => r.some((c) => c.trim() !== "")).length;
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
