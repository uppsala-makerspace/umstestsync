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
      const { questions: parsed, skipped } = parseQuestions(rows, config.answerCount);

      for (const s of skipped) {
        log.skip({
          test: testSlug,
          category: catSlug,
          questionId: s.number,
          row: s.row,
          reason: s.reason,
        });
      }

      const category = toCategory(parsed, cat.name, testSlug, catSlug, config.language);
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
