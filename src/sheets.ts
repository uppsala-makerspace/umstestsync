import type { sheets_v4 } from "googleapis";
import type { ParsedQuestion } from "./types.js";

/**
 * Resultatet av att parsa ett ark: de giltiga frågorna samt eventuella
 * varningar om rader som hoppades över.
 */
export interface ParseResult {
  questions: ParsedQuestion[];
  warnings: string[];
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
 * Rader utan fråga eller utan giltigt rätt-svar hoppas över med en varning.
 */
export function parseQuestions(
  rows: string[][],
  answerCount: number,
): ParseResult {
  const questions: ParsedQuestion[] = [];
  const warnings: string[] = [];

  // Kolumnindex: A=0, B=1, C=2. Svar börjar på index 2.
  const firstAnswerCol = 2;
  const correctCol = firstAnswerCol + answerCount; // direkt efter sista svaret

  const seenNumbers = new Set<string>();

  rows.forEach((row, i) => {
    // Hoppa över en inledande rubrikrad.
    if (i === 0 && looksLikeHeader(row)) return;

    const number = (row[0] ?? "").trim();
    const questionText = (row[1] ?? "").trim();

    // Helt tom rad – tyst hoppning.
    if (number === "" && questionText === "" && row.every((c) => c.trim() === "")) {
      return;
    }

    if (number === "") {
      warnings.push(`Rad ${i + 1}: saknar nummer i kolumn A – hoppas över.`);
      return;
    }
    if (questionText === "") {
      warnings.push(`Rad ${i + 1} (nr ${number}): saknar frågetext – hoppas över.`);
      return;
    }
    if (seenNumbers.has(number)) {
      warnings.push(
        `Rad ${i + 1}: frågenummer "${number}" förekommer flera gånger – hoppas över.`,
      );
      return;
    }

    const answers: string[] = [];
    for (let c = 0; c < answerCount; c++) {
      const value = (row[firstAnswerCol + c] ?? "").trim();
      if (value !== "") answers.push(value);
    }

    if (answers.length === 0) {
      warnings.push(`Rad ${i + 1} (nr ${number}): inga svarsalternativ – hoppas över.`);
      return;
    }

    const correctRaw = (row[correctCol] ?? "").trim();
    const correctIndex = Number.parseInt(correctRaw, 10);
    if (!Number.isInteger(correctIndex) || correctIndex < 1 || correctIndex > answers.length) {
      warnings.push(
        `Rad ${i + 1} (nr ${number}): ogiltig rätt-svar-markering "${correctRaw}" ` +
          `(förväntade 1–${answers.length}) – hoppas över.`,
      );
      return;
    }

    seenNumbers.add(number);
    questions.push({ number, questionText, answers, correctIndex });
  });

  return { questions, warnings };
}
