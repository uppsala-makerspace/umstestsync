import { colLetter, numberKey, type Layout, type RowRecord } from "./sheets.js";
import type { ParsedQuestion } from "./types.js";

/**
 * En rad som ska infogas i arket. Cellerna skrivs i den nya raden; ingen
 * befintlig cell rörs någonsin.
 */
export interface SheetEdit {
  /** 1-baserat radnummer i det ursprungliga rutnätet – raden infogas direkt under. */
  anchorRow: number;
  /** Om den nya raden ska ärva formatering från raden ovanför. */
  inheritFromBefore: boolean;
  /** Värden per nollbaserat kolumnindex. Strängar som börjar med "=" är formler. */
  cells: { col: number; value: string }[];
  /** Kort beskrivning för loggen – aldrig frågetext. */
  label: string;
}

/** En befintlig, tom cell som ska fyllas i. Ingen rad infogas. */
export interface CellFill {
  /** 1-baserat radnummer i det ursprungliga rutnätet. */
  row: number;
  col: number;
  value: string;
}

/** Allt som behöver ändras i ett ark. */
export interface SheetPlan {
  /** Rader att infoga. */
  inserts: SheetEdit[];
  /** Tomma språkceller att fylla i med baspråket. */
  fills: CellFill[];
}

export interface PlanOptions {
  /** Spreadsheetets namn, används som titel på baspråket. */
  sheetName: string;
  baseLanguage: string;
  targetLanguages: string[];
  /** Argumentavskiljare i formler: ";" i sv_SE, "," i en_US. */
  separator: string;
}

/** =GOOGLETRANSLATE(C4;"sv";"en") */
function translateFormula(
  col: number,
  row: number,
  from: string,
  to: string,
  sep: string,
): string {
  return `=GOOGLETRANSLATE(${colLetter(col)}${row}${sep}"${from}"${sep}"${to}")`;
}

/**
 * Räknar ut vilka rader som saknas i ett flerspråkigt ark: titelrader och en
 * översättningsrad per fråga och målspråk.
 *
 * Ren funktion utan nätverksanrop. Urvalet av frågor tas från `accepted`, dvs.
 * bara frågor som parsern faktiskt godkände – annars skulle förhandsallokerade
 * nummer och trasiga rader få en permanent felrad var. Beslutet om ett språk
 * redan *finns* tas däremot på alla rader i gruppen, även ogiltiga: en
 * översättningsrad vars formel failat finns i arket och ska inte dubbleras.
 */
export function planSheetEdits(
  records: RowRecord[],
  accepted: ParsedQuestion[],
  layout: Layout,
  opts: PlanOptions,
): SheetPlan {
  if (layout.languageCol === null || opts.targetLanguages.length === 0) {
    return { inserts: [], fills: [] };
  }
  const langCol = layout.languageCol;
  const { baseLanguage, targetLanguages, separator: sep } = opts;

  const edits: SheetEdit[] = [];

  // --- Tomma språkceller ----------------------------------------------------
  // En rad utan språktagg läses som baspråket; skriv ut det i arket så att
  // taggen syns och raden blir entydig. Bara rader som faktiskt bär text –
  // ett reserverat nummer utan fråga lämnas orört.
  const fills: CellFill[] = records
    .filter((r) => !r.hasLanguageTag && r.questionText !== "")
    .map((r) => ({ row: r.row, col: langCol, value: baseLanguage }));

  // --- Titelrader -----------------------------------------------------------
  // Rubrikraden är 1-baserat radnummer layout.dataStart (dataStart är det
  // nollbaserade indexet för första dataraden).
  const headerRow = layout.dataStart;
  const titleRows = records.filter((r) => r.kind === "title");
  const titleLanguages = new Set(titleRows.map((r) => r.language));
  const existingBaseTitle = titleRows.find((r) => r.language === baseLanguage);

  const titleAnchor = existingBaseTitle?.row ?? headerRow;
  let baseTitleRow = existingBaseTitle?.row;
  if (baseTitleRow === undefined && headerRow > 0) {
    // Den nya raden hamnar direkt under rubrikraden.
    baseTitleRow = headerRow + 1;
    edits.push({
      anchorRow: titleAnchor,
      // Ärv inte rubrikradens formatering (fetstil, bakgrund).
      inheritFromBefore: false,
      cells: [
        { col: layout.numberCol, value: "titel" },
        { col: langCol, value: baseLanguage },
        { col: layout.questionCol, value: opts.sheetName.trim() },
      ],
      label: `titel (${baseLanguage})`,
    });
  }

  if (baseTitleRow !== undefined) {
    for (const lang of targetLanguages) {
      if (titleLanguages.has(lang)) continue;
      edits.push({
        anchorRow: titleAnchor,
        inheritFromBefore: false,
        cells: [
          { col: layout.numberCol, value: "titel" },
          { col: langCol, value: lang },
          {
            col: layout.questionCol,
            value: translateFormula(layout.questionCol, baseTitleRow, baseLanguage, lang, sep),
          },
        ],
        label: `titel (${lang})`,
      });
    }
  }

  // --- Översättningsrader ---------------------------------------------------
  const groups = new Map<string, RowRecord[]>();
  for (const r of records) {
    if (r.kind !== "question" || r.key === "") continue;
    const group = groups.get(r.key);
    if (group) group.push(r);
    else groups.set(r.key, [r]);
  }

  for (const question of accepted) {
    const group = groups.get(numberKey(question.number));
    if (!group || group.length === 0) continue;

    const present = new Set(group.map((r) => r.language));
    const missing = targetLanguages.filter((lang) => !present.has(lang));
    if (missing.length === 0) continue;

    // Källa: baspråkets rad om den finns, annars gruppens första giltiga rad.
    const valid = group.filter((r) => r.valid);
    const source = valid.find((r) => r.language === baseLanguage) ?? valid[0];
    if (!source) continue;

    // Ankare: gruppens sista rad, så att numret alltid står ovanför och ärvs.
    const anchorRow = Math.max(...group.map((r) => r.row));

    for (const lang of missing) {
      edits.push({
        anchorRow,
        inheritFromBefore: true,
        cells: [
          { col: langCol, value: lang },
          {
            col: layout.questionCol,
            // Källspråket är källradens eget, inte baspråket – saknas sv och
            // en en-rad blir källa måste formeln säga "en".
            value: translateFormula(
              layout.questionCol,
              source.row,
              source.language,
              lang,
              sep,
            ),
          },
          // Exakt de svarskolumner som är ifyllda på källraden, så att
          // maskjämförelsen i mergeLanguageRows går igenom.
          ...source.answerCols.map((col) => ({
            col,
            value: translateFormula(col, source.row, source.language, lang, sep),
          })),
        ],
        label: `fråga ${question.number} (${lang})`,
      });
    }
  }

  // Loggas i arkets ordning; skrivaren sorterar om nedifrån och upp.
  return { inserts: edits.sort((a, b) => a.anchorRow - b.anchorRow), fills };
}
