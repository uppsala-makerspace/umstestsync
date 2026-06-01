import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";

/** Konfiguration för en synkning. Läses från en JSON-fil. */
export interface Config {
  /** Sökväg till service account-nyckelns JSON-fil. */
  serviceAccountKeyFile: string;
  /** Id för rotmappen på Google Drive som innehåller test-undermapparna. */
  rootFolderId: string;
  /** Katalog dit JSON-strukturen skrivs. */
  outputDir: string;
  /** Språkkod som arkens text taggas med. Standard: "sv". */
  language: string;
  /**
   * Antal förväntade svarskolumner (svar 1, 2, 3 ...) som börjar i kolumn C.
   * Standard: 3 (kolumn C, D, E), med rätt-svar-kolumnen direkt efter.
   */
  answerCount: number;
  /**
   * Sökväg till en loggfil. Anges den skrivs en läsbar logg över körningen,
   * inklusive vilka frågor som uteslutits och varför. Utelämnas den loggas
   * endast till konsolen.
   */
  logFile?: string;
}

const REQUIRED_KEYS = ["serviceAccountKeyFile", "rootFolderId"] as const;

/**
 * Läser och validerar en konfigurationsfil. Relativa sökvägar i configen
 * tolkas relativt configfilens katalog.
 */
export async function loadConfig(configPath: string): Promise<Config> {
  const absConfigPath = resolve(process.cwd(), configPath);
  let raw: string;
  try {
    raw = await readFile(absConfigPath, "utf8");
  } catch (err) {
    throw new Error(
      `Kunde inte läsa konfigurationsfilen "${absConfigPath}": ${(err as Error).message}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Konfigurationsfilen "${absConfigPath}" är inte giltig JSON: ${(err as Error).message}`,
    );
  }

  for (const key of REQUIRED_KEYS) {
    if (typeof parsed[key] !== "string" || (parsed[key] as string).length === 0) {
      throw new Error(`Konfigurationen saknar obligatoriskt fält "${key}".`);
    }
  }

  const configDir = dirname(absConfigPath);
  const resolveRelative = (p: string): string =>
    isAbsolute(p) ? p : resolve(configDir, p);

  return {
    serviceAccountKeyFile: resolveRelative(parsed.serviceAccountKeyFile as string),
    rootFolderId: parsed.rootFolderId as string,
    outputDir: resolveRelative(
      typeof parsed.outputDir === "string" ? parsed.outputDir : "./tests-data",
    ),
    language: typeof parsed.language === "string" ? parsed.language : "sv",
    answerCount:
      typeof parsed.answerCount === "number" && parsed.answerCount > 0
        ? parsed.answerCount
        : 3,
    logFile:
      typeof parsed.logFile === "string" && parsed.logFile.length > 0
        ? resolveRelative(parsed.logFile)
        : undefined,
  };
}
