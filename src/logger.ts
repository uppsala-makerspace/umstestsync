import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Data som behövs för att logga en utesluten fråga – utan frågetext. */
export interface SkipEntry {
  test: string;
  category: string;
  /** Frågans ursprungliga nummer från arket, eller null om det saknades. */
  questionId: string | null;
  /** Radnummer i arket (för att kunna hitta raden även utan nummer). */
  row: number;
  reason: string;
}

/**
 * Enkel logger som skriver läsbara rader till konsolen och, om en sökväg
 * angetts, samlar dem och skriver dem till en loggfil vid `flush()`.
 *
 * Uteslutna frågor loggas med test, kategori och frågans ursprungliga nummer
 * – aldrig själva frågetexten eller svarsalternativen.
 */
export class Logger {
  private readonly lines: string[] = [];
  private skipCount = 0;

  constructor(private readonly filePath?: string) {}

  /** Antal uteslutna frågor som loggats hittills. */
  get skips(): number {
    return this.skipCount;
  }

  /** Informationsrad – skrivs till konsol och fil som den är. */
  info(message: string): void {
    console.log(message);
    this.lines.push(message);
  }

  /** Allmän varning – markeras med ⚠ i konsolen och WARN i filen. */
  warn(message: string): void {
    console.warn(`  ⚠ ${message}`);
    this.lines.push(`WARN  ${message}`);
  }

  /** Loggar att en fråga uteslutits, utan att avslöja frågans innehåll. */
  skip(entry: SkipEntry): void {
    this.skipCount++;
    const id = entry.questionId ? `fråga ${entry.questionId}` : "fråga (utan nummer)";
    const console_ = `  ⚠ [${entry.category}] ${id} (rad ${entry.row}): ${entry.reason} → utesluten`;
    const file_ =
      `WARN  utesluten fråga  test="${entry.test}"  kategori="${entry.category}"  ` +
      `${id}  rad=${entry.row}  orsak=${entry.reason}`;
    console.warn(console_);
    this.lines.push(file_);
  }

  /**
   * Skriver loggfilen om en sökväg angavs. Lägger till en rubrik med
   * tidsstämpel överst. Returnerar sökvägen, eller null om ingen fil skrevs.
   */
  async flush(): Promise<string | null> {
    if (!this.filePath) return null;
    const header = `umstestsync-logg – ${new Date().toISOString()}`;
    const content = `${header}\n${"=".repeat(header.length)}\n${this.lines.join("\n")}\n`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, content, "utf8");
    return this.filePath;
  }
}
