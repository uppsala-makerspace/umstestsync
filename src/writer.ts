import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Category } from "./types.js";

/**
 * Skriver en kategori till outputDir/<testSlug>/<catSlug>.json med samma
 * indentering (2 mellanslag) och avslutande radbrytning som exempeldatan.
 */
export async function writeCategory(
  outputDir: string,
  testSlug: string,
  catSlug: string,
  category: Category,
): Promise<string> {
  const dir = join(outputDir, testSlug);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${catSlug}.json`);
  const json = JSON.stringify(category, null, 2) + "\n";
  await writeFile(filePath, json, "utf8");
  return filePath;
}
