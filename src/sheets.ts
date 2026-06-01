import type { sheets_v4 } from "googleapis";
import type { ParsedQuestion } from "./types.js";

/**
 * En fråga som uteslutits ur utdatan, med tillräcklig information för att
 * lokalisera den i arket – men utan själva frågetexten eller alternativen
 * (testen är hemliga och ska inte hamna i loggen).
 */
export interface SkippedQuestion {
  /** Radnummer i arket (1-baserat). */
  row: number;
  /** Frågans nummer från kolumn A, eller null om det saknades. */
  number: string | null;
  /** Kort orsak till att frågan uteslöts (innehåller ingen frågetext). */
  reason: string;
}

/**
 * Resultatet av att parsa ett ark: de giltiga frågorna samt de rader som
 * uteslutits, med orsak.
 */
export interface ParseResult {
  questions: ParsedQuestion[];
  skipped: SkippedQuestion[];
}

/**
 * Läser alla cellvärden från första fliken i ett spreadsheet.
 * Använder UNFORMATTED_VALUE så att rätt-svar-kolumnen kommer som tal.
 */
export async function readSheetRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<string[][]> {
  // Hämta metadata för att få namnet på första fliken.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title,index)",
  });
  const first = (meta.data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is sheets_v4.Schema$SheetProperties => Boolean(p))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];

  if (!first?.title) {
    return [];
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: first.title,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = res.data.values ?? [];
  return rows.map((row) => row.map((cell) => (cell == null ? "" : String(cell).trim())));
}

/**
 * Avgör om en rad är en rubrikrad. Vi betraktar raden som rubrik om
 * kolumn A inte ser ut som ett frågenummer (tomt, eller saknar siffror).
 */
function looksLikeHeader(row: string[]): boolean {
  const a = (row[0] ?? "").trim();
  if (a === "") return true;
  return !/\d/.test(a);
}

/**
 * Parsar arkets rader till frågor enligt kolumnlayouten:
 *   A = nummer, B = fråga, C..(C+answerCount-1) = svar 1..N,
 *   nästa kolumn = siffra för rätt svar (1-baserat).
 *
 * Tomma svarsceller hoppas över (stöd för färre alternativ än answerCount).
 * Rader med bara ett förhandsallokerat nummer (ingen fråga, inget annat
 * innehåll) hoppas över tyst. Rader med fråga men utan giltiga svar/rätt-svar
 * utesluts och rapporteras.
 */
export function parseQuestions(
  rows: string[][],
  answerCount: number,
): ParseResult {
  const questions: ParsedQuestion[] = [];
  const skipped: SkippedQuestion[] = [];

  // Kolumnindex: A=0, B=1, C=2. Svar börjar på index 2.
  const firstAnswerCol = 2;
  const correctCol = firstAnswerCol + answerCount; // direkt efter sista svaret

  const seenNumbers = new Set<string>();

  rows.forEach((row, i) => {
    // Hoppa över en inledande rubrikrad.
    if (i === 0 && looksLikeHeader(row)) return;

    const rowNo = i + 1;
    const number = (row[0] ?? "").trim();
    const questionText = (row[1] ?? "").trim();

    // Helt tom rad – tyst hoppning (rapporteras inte).
    if (number === "" && questionText === "" && row.every((c) => c.trim() === "")) {
      return;
    }

    if (number === "") {
      skipped.push({ row: rowNo, number: null, reason: "saknar nummer i kolumn A" });
      return;
    }
    if (questionText === "") {
      // Rad med bara ett förhandsallokerat nummer (frågeskaparna reserverar
      // unika id:n i förväg) – tyst hoppning, ingen varning. Men om raden har
      // svar eller rätt-markering utan fråga är det troligen ett misstag och
      // rapporteras.
      const hasOtherContent = row
        .slice(firstAnswerCol, correctCol + 1)
        .some((c) => (c ?? "").trim() !== "");
      if (hasOtherContent) {
        skipped.push({ row: rowNo, number, reason: "saknar frågetext" });
      }
      return;
    }
    if (seenNumbers.has(number)) {
      skipped.push({ row: rowNo, number, reason: "dubblerat frågenummer" });
      return;
    }

    const answers: string[] = [];
    for (let c = 0; c < answerCount; c++) {
      const value = (row[firstAnswerCol + c] ?? "").trim();
      if (value !== "") answers.push(value);
    }

    if (answers.length === 0) {
      skipped.push({ row: rowNo, number, reason: "inga svarsalternativ" });
      return;
    }

    const correctRaw = (row[correctCol] ?? "").trim();
    const correctIndex = Number.parseInt(correctRaw, 10);
    if (!Number.isInteger(correctIndex) || correctIndex < 1 || correctIndex > answers.length) {
      const detail =
        correctRaw === ""
          ? "rätt svar saknas"
          : `ogiltig markering av rätt svar (förväntade 1–${answers.length})`;
      skipped.push({ row: rowNo, number, reason: detail });
      return;
    }

    seenNumbers.add(number);
    questions.push({ number, questionText, answers, correctIndex });
  });

  return { questions, skipped };
}
