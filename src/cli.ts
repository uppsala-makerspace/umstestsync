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

  console.log(`Autentiserar mot Google Drive …`);
  const { drive, sheets } = await createClients(config);

  console.log(`Läser test-mappar i rotmappen ${config.rootFolderId} …`);
  const testFolders = await listTestFolders(drive, config.rootFolderId);
  if (testFolders.length === 0) {
    console.warn(
      "Inga undermappar hittades i rotmappen. Är mappen delad med service account-mailen?",
    );
  }

  let totalCategories = 0;
  let totalQuestions = 0;

  for (const test of testFolders) {
    const testSlug = slugify(test.name);
    const categories = await listCategorySheets(drive, test.id);
    console.log(`\n[test] ${test.name} → ${testSlug}/  (${categories.length} kategorier)`);

    // Tom mapp kan bero på saknad åtkomst (t.ex. en genväg vars målmapp
    // inte är delad med service accountet). Skilj på de fallen.
    if (categories.length === 0 && !(await canAccess(drive, test.id))) {
      console.warn(
        `  ⚠ Kan inte läsa mappen "${test.name}". Om det är en genväg: ` +
          `dela målmappen med service account-mailen, eller flytta in den ` +
          `riktiga mappen i den delade enheten.`,
      );
    }

    for (const cat of categories) {
      const catSlug = slugify(cat.name);
      const rows = await readSheetRows(sheets, cat.id);
      const { questions: parsed, warnings } = parseQuestions(rows, config.answerCount);

      for (const w of warnings) {
        console.warn(`  ⚠ [${cat.name}] ${w}`);
      }

      const category = toCategory(parsed, testSlug, catSlug, config.language);
      const filePath = await writeCategory(
        config.outputDir,
        testSlug,
        catSlug,
        category,
      );

      totalCategories++;
      totalQuestions += category.questions.length;
      console.log(`  ✓ ${cat.name} → ${catSlug}.json  (${category.questions.length} frågor)`);
      void filePath;
    }
  }

  console.log(
    `\nKlart. ${totalQuestions} frågor i ${totalCategories} kategorier skrivna till ${config.outputDir}`,
  );
}

main().catch((err: unknown) => {
  console.error(`\nFel: ${(err as Error).message}`);
  process.exitCode = 1;
});
