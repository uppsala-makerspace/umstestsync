import type { sheets_v4 } from "googleapis";
import { formulaSeparator, overrideSeparator, type SheetData } from "./sheets.js";
import type { SheetEdit, SheetPlan } from "./translate.js";

/** Resultatet av att applicera ändringar på ett ark. */
export interface WriteResult {
  /** Antal infogade rader. */
  inserted: number;
  /** Antal ifyllda språkceller. */
  filled: number;
  /** Etiketter för det som lades till, för loggen (aldrig frågetext). */
  labels: string[];
  warnings: string[];
}

/** Var en infogad rad hamnar när alla insättningar är gjorda. */
interface Placed {
  edit: SheetEdit;
  /** 1-baserat radnummer i det färdiga rutnätet. */
  finalRow: number;
}

/**
 * Enkel exponentiell backoff. Sheets tillåter 60 läsningar och 60 skrivningar
 * per minut och användare, och verktyget kör oövervakat.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { code?: number }).code;
      if (status !== 429 && status !== 500 && status !== 503) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastError;
}

/** Cellvärden till ett updateCells-anrop för en enda (nyss infogad) rad. */
function rowRequest(
  sheetId: number,
  rowIndex: number,
  cells: { col: number; value: string }[],
): sheets_v4.Schema$Request {
  const first = Math.min(...cells.map((c) => c.col));
  const last = Math.max(...cells.map((c) => c.col));
  const values: sheets_v4.Schema$CellData[] = [];
  for (let col = first; col <= last; col++) {
    const cell = cells.find((c) => c.col === col);
    // Mellanliggande kolumner lämnas tomma – raden är nyss skapad och tom.
    values.push(
      cell === undefined
        ? {}
        : {
            userEnteredValue: cell.value.startsWith("=")
              ? { formulaValue: cell.value }
              : { stringValue: cell.value },
          },
    );
  }
  return {
    updateCells: {
      start: { sheetId, rowIndex, columnIndex: first },
      rows: [{ values }],
      fields: "userEnteredValue",
    },
  };
}

/**
 * Infogar de planerade raderna i arket.
 *
 * Allt sker i **en** batchUpdate. Requests tillämpas sekventiellt och varje
 * request ser föregående requests effekt, så begärandena sorteras nedifrån och
 * upp: när ett ankare behandlas har bara rader strikt under det påverkats, och
 * ankarets ursprungliga index gäller fortfarande. Att göra det i två anrop
 * (infoga först, skriva värden sedan) vore inte atomärt – faller det andra
 * anropet bort står en tom rad kvar och nästa körning infogar en till.
 */
export async function applySheetEdits(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheet: SheetData,
  plan: SheetPlan,
): Promise<WriteResult> {
  const edits = plan.inserts;
  if (edits.length === 0 && plan.fills.length === 0) {
    return { inserted: 0, filled: 0, labels: [], warnings: [] };
  }

  // Gruppera per ankare: flera målspråk på samma fråga infogas som ett block.
  const byAnchor = new Map<number, SheetEdit[]>();
  for (const edit of edits) {
    const group = byAnchor.get(edit.anchorRow);
    if (group) group.push(edit);
    else byAnchor.set(edit.anchorRow, [edit]);
  }
  const anchors = [...byAnchor.keys()].sort((a, b) => a - b);

  // Slutliga radnummer, för att kunna skriva om cellerna om separatorn var fel.
  const placed: Placed[] = [];
  let shift = 0;
  for (const anchor of anchors) {
    const group = byAnchor.get(anchor) ?? [];
    group.forEach((edit, k) => placed.push({ edit, finalRow: anchor + shift + 1 + k }));
    shift += group.length;
  }

  const requests: sheets_v4.Schema$Request[] = [];

  // Ifyllningarna först: de ändrar inte radantalet, och så länge ingen
  // insättning hunnit tillämpas gäller radernas ursprungliga index.
  for (const fill of plan.fills) {
    requests.push(rowRequest(sheet.sheetId, fill.row - 1, [{ col: fill.col, value: fill.value }]));
  }

  for (const anchor of [...anchors].reverse()) {
    const group = byAnchor.get(anchor) ?? [];
    if (anchor >= sheet.rowCount) {
      requests.push({
        appendDimension: { sheetId: sheet.sheetId, dimension: "ROWS", length: group.length },
      });
    } else {
      requests.push({
        insertDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: "ROWS",
            startIndex: anchor,
            endIndex: anchor + group.length,
          },
          inheritFromBefore: anchor > 0 && group.every((e) => e.inheritFromBefore),
        },
      });
    }
    group.forEach((edit, k) => {
      requests.push(rowRequest(sheet.sheetId, anchor + k, edit.cells));
    });
  }

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
  );

  const warnings = await verify(sheets, spreadsheetId, sheet, placed);
  return {
    inserted: edits.length,
    filled: plan.fills.length,
    labels: edits.map((e) => e.label),
    warnings,
  };
}

/**
 * Läser tillbaka de infogade raderna och kontrollerar att formlerna räknades
 * ut. Är felet "Formula parse error." valdes fel argumentavskiljare – då
 * skrivs cellerna om en gång med den andra, och valet cachas för locale:n.
 */
async function verify(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheet: SheetData,
  placed: Placed[],
  retried = false,
): Promise<string[]> {
  const rows = placed.map((p) => p.finalRow).sort((a, b) => a - b);
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  if (firstRow === undefined || lastRow === undefined) return [];

  const res = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`'${sheet.title.replace(/'/g, "''")}'!${firstRow}:${lastRow}`],
      includeGridData: true,
      fields: "sheets.data.rowData.values.effectiveValue.errorValue(type,message)",
    }),
  );
  const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData ?? [];

  const errors: { row: number; message: string }[] = [];
  for (const p of placed) {
    const values = rowData[p.finalRow - firstRow]?.values ?? [];
    for (const cell of values) {
      const message = cell.effectiveValue?.errorValue?.message;
      if (message) errors.push({ row: p.finalRow, message });
    }
  }
  if (errors.length === 0) return [];

  const parseErrors = errors.filter((e) => e.message === "Formula parse error.");
  if (parseErrors.length > 0 && !retried) {
    // Fel avskiljare. Skriv om samma celler med den andra och försök igen.
    const wrong = formulaSeparator(sheet.locale);
    const right = wrong === ";" ? "," : ";";
    overrideSeparator(sheet.locale, right);
    const requests = placed.map((p) =>
      rowRequest(
        sheet.sheetId,
        p.finalRow - 1,
        // Bara formler – en statisk titel kan innehålla tecknet som text.
        p.edit.cells.map((c) => ({
          col: c.col,
          value: c.value.startsWith("=") ? c.value.split(wrong).join(right) : c.value,
        })),
      ),
    );
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
    );
    const remaining = await verify(sheets, spreadsheetId, sheet, placed, true);
    return [
      `formlerna skrevs om med "${right}" som argumentavskiljare (arkets locale är ${sheet.locale})`,
      ...remaining,
    ];
  }

  const rowsWithErrors = [...new Set(errors.map((e) => e.row))].join(", ");
  return [`formelfel i de tillagda raderna ${rowsWithErrors} – kontrollera dem i arket`];
}
