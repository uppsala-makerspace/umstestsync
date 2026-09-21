import type { sheets_v4 } from "googleapis";
import type { LocalizedText, ParsedQuestion } from "./types.js";

/**
 * En fråga som uteslutits ur utdatan, med tillräcklig information för att
 * lokalisera den i arket – men utan själva frågetexten eller alternativen
 * (testen är hemliga och ska inte hamna i loggen). Av samma skäl får en orsak
 * aldrig röja vilket alternativ som är rätt.
 */
export interface SkippedQuestion {
  /** Radnummer i arket (1-baserat). */
  row: number;
  /** Frågans nummer från nummerkolumnen, eller null om det saknades. */
  number: string | null;
  /** Kort orsak till att frågan uteslöts (innehåller ingen frågetext). */
  reason: string;
}

/** Frågor som saknar ett av arkets språk – medtagna, men ofullständiga. */
export interface MissingTranslation {
  language: string;
  /** Frågenumren som saknar språket, i arkets ordning. */
  numbers: string[];
}

/**
 * Översättningar som uteslutits för att de inte stämmer med baspråkets rad.
 * Frågan är medtagen – det är bara det ena språket som fallit bort.
 */
export interface DroppedTranslation {
  language: string;
  /** Kort orsak, utan att röja frågans innehåll eller vilket svar som är rätt. */
  reason: string;
  numbers: string[];
}

/**
 * Resultatet av att parsa ett ark: de giltiga frågorna samt de rader som
 * uteslutits, med orsak.
 */
export interface ParseResult {
  questions: ParsedQuestion[];
  /** Titlar från titelrader i arket, nycklade på språkkod. Tomt om inga fanns. */
  titleOverrides: LocalizedText;
  /** Språkkoder som förekommer i arket, i den ordning de dök upp. */
  languages: string[];
  skipped: SkippedQuestion[];
  missingTranslations: MissingTranslation[];
  droppedTranslations: DroppedTranslation[];
  /** Varningar om arket som helhet (rubrikrad, titelrader, konstiga språkkoder). */
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
 * Normaliserar en cell för jämförelse med nyckelord: gemener utan svenska
 * diakriter. Medvetet inte `slugify` från transform.ts – den är en regel för
 * filnamn, inte för hur arkets rubriker tolkas.
 */
function normalizeCell(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o");
}

/** Rubriker som utpekar språkkolumnen. Matchas exakt efter normalisering. */
const LANGUAGE_HEADERS = new Set(["sprak", "language", "lang"]);

/** Nummerkolumnens värde på en titelrad. */
const TITLE_KEYWORDS = new Set(["titel", "title"]);

/** Form som en språkkod förväntas ha, t.ex. "sv", "en", "en-gb". */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]+)*$/;

/** Kolumnbokstav för ett nollbaserat kolumnindex (A, B, C ...). */
function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Var arkets olika fält ligger, och var datat börjar. */
interface Layout {
  numberCol: number;
  /** null = enspråkigt ark. */
  languageCol: number | null;
  questionCol: number;
  firstAnswerCol: number;
  correctCol: number;
  /** Första dataraden (0 eller 1). */
  dataStart: number;
}

/**
 * Avgör om en rad är en rubrikrad. Vi betraktar raden som rubrik om
 * nummerkolumnen inte ser ut som ett frågenummer (tomt, eller saknar siffror).
 */
function looksLikeHeader(row: string[], numberCol: number): boolean {
  const value = (row[numberCol] ?? "").trim();
  if (value === "") return true;
  return !/\d/.test(value);
}

/**
 * Sekundär detektion: ser arket flerspråkigt ut trots att rubrikraden saknas?
 * Utan rubrik tolkas ett flerspråkigt ark som enspråkigt, och då blir varje
 * fråga ogiltig – bättre att säga det rakt ut.
 */
function looksMultilingual(rows: string[][]): boolean {
  for (const col of [0, 1]) {
    let hits = 0;
    for (const row of rows) {
      if (/^[a-z]{2,3}$/i.test((row[col] ?? "").trim())) hits++;
    }
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * Bestämmer kolumnlayouten utifrån rubrikraden.
 *
 * Finns rubriken "Språk" (eller "Language"/"Lang") i första eller andra
 * kolumnen är arket flerspråkigt och övriga kolumner skjuts ett steg åt höger.
 * Annars gäller dagens enspråkiga layout: A = nummer, B = fråga.
 */
export function detectLayout(
  rows: string[][],
  answerCount: number,
): { layout: Layout; warnings: string[] } {
  const warnings: string[] = [];
  const header = rows[0] ?? [];

  const build = (
    numberCol: number,
    languageCol: number | null,
    questionCol: number,
    dataStart: number,
  ): Layout => ({
    numberCol,
    languageCol,
    questionCol,
    firstAnswerCol: questionCol + 1,
    correctCol: questionCol + 1 + answerCount,
    dataStart,
  });

  if (LANGUAGE_HEADERS.has(normalizeCell(header[0] ?? ""))) {
    return { layout: build(1, 0, 2, 1), warnings };
  }
  if (LANGUAGE_HEADERS.has(normalizeCell(header[1] ?? ""))) {
    return { layout: build(0, 1, 2, 1), warnings };
  }

  if (looksMultilingual(rows)) {
    warnings.push(
      'arket ser flerspråkigt ut men saknar rubrikrad med "Språk" som första ' +
        "eller andra kolumn – tolkas som enspråkigt",
    );
  }
  const dataStart = rows.length > 0 && looksLikeHeader(header, 0) ? 1 : 0;
  return { layout: build(0, null, 1, dataStart), warnings };
}

/**
 * Nyckel att gruppera språkrader på. UNFORMATTED_VALUE ger "1" för en talcell
 * men "01" för en textcell – utan normalisering skulle samma fråga kunna
 * splittras i två. Frågans id byggs av det först sedda råa numret.
 */
function numberKey(number: string): string {
  return /^\d+(\.0+)?$/.test(number) ? String(Number(number)) : number.toLowerCase();
}

/** En datarad efter radvalidering, innan språkraderna slagits ihop. */
interface RawRow {
  row: number;
  number: string;
  key: string;
  language: string;
  questionText: string;
  /** Icke-tomma svarstexter i ordning. */
  answers: string[];
  /** Vilka svarskolumner som var ifyllda, t.ex. "110". */
  mask: string;
  correctRaw: string;
}

/**
 * Parsar arkets rader till frågor.
 *
 * Enspråkigt ark: A = nummer, B = fråga, C..(C+answerCount-1) = svar 1..N,
 * nästa kolumn = siffra för rätt svar (1-baserat).
 *
 * Flerspråkigt ark (rubriken "Språk" först eller som andra kolumn): samma
 * layout men ett steg åt höger, och en rad per språk och fråga. Raderna hör
 * ihop via nummerkolumnen; nummer- och rätt-svar-cellerna får vara tomma på
 * följdraderna (de är i praktiken sammanslagna) och ärvs då.
 *
 * Tomma svarsceller hoppas över (stöd för färre alternativ än answerCount).
 * Rader med bara ett förhandsallokerat nummer (ingen fråga, inget annat
 * innehåll) hoppas över tyst. Rader med fråga men utan giltiga svar/rätt-svar
 * utesluts och rapporteras.
 */
export function parseQuestions(
  rows: string[][],
  answerCount: number,
  defaultLanguage: string,
): ParseResult {
  const { layout, warnings } = detectLayout(rows, answerCount);
  const multilingual = layout.languageCol !== null;

  const skipped: SkippedQuestion[] = [];
  const titleOverrides: LocalizedText = {};
  const languages: string[] = [];
  const rawRows: RawRow[] = [];
  const seen = new Map<string, Set<string>>();
  const oddCodes = new Set<string>();
  let lastNumber = "";

  for (let i = layout.dataStart; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const rowNo = i + 1;

    // Helt tom rad – tyst hoppning (rapporteras inte).
    if (cells.every((c) => c.trim() === "")) continue;

    const cellAt = (col: number | null): string =>
      col === null ? "" : (cells[col] ?? "").trim();

    const numberCell = cellAt(layout.numberCol);
    const languageCell = cellAt(layout.languageCol);
    const questionText = cellAt(layout.questionCol);
    const hasAnswerContent = cells
      .slice(layout.firstAnswerCol, layout.correctCol + 1)
      .some((c) => (c ?? "").trim() !== "");

    // Titelrad: nyckelordet står i nummerkolumnen och titeln i frågekolumnen –
    // ingen extra kolumn införs.
    if (TITLE_KEYWORDS.has(normalizeCell(numberCell))) {
      if (questionText === "") continue;
      const lang = multilingual ? languageCell.toLowerCase() : defaultLanguage;
      if (lang === "") {
        warnings.push(`titelrad utan språkkod (rad ${rowNo}) ignorerad`);
      } else if (titleOverrides[lang] !== undefined) {
        warnings.push(
          `flera titelrader för språket "${lang}" (rad ${rowNo}) – den första används`,
        );
      } else {
        titleOverrides[lang] = questionText;
      }
      continue;
    }

    if (numberCell !== "") lastNumber = numberCell;
    // Sammanslagen nummercell: följdraden för nästa språk är tom och ärver.
    const number =
      numberCell !== "" || !multilingual || languageCell === "" ? numberCell : lastNumber;

    if (number === "") {
      // Rad med bara en språkkod och inget annat – lika ofarlig som ett
      // förhandsallokerat nummer, rapporteras inte.
      if (multilingual && languageCell !== "" && questionText === "" && !hasAnswerContent) {
        continue;
      }
      skipped.push({
        row: rowNo,
        number: null,
        reason: `saknar nummer i kolumn ${colLetter(layout.numberCol)}`,
      });
      continue;
    }

    if (questionText === "") {
      // Rad med bara ett förhandsallokerat nummer (frågeskaparna reserverar
      // unika id:n i förväg) – tyst hoppning, ingen varning. Men om raden har
      // svar eller rätt-markering utan fråga är det troligen ett misstag och
      // rapporteras.
      if (hasAnswerContent) {
        skipped.push({ row: rowNo, number, reason: "saknar frågetext" });
      }
      continue;
    }

    let language = defaultLanguage;
    if (multilingual) {
      language = languageCell.toLowerCase();
      if (language === "") {
        skipped.push({ row: rowNo, number, reason: "saknar språkkod" });
        continue;
      }
      if (!LANGUAGE_CODE.test(language) && !oddCodes.has(language)) {
        oddCodes.add(language);
        warnings.push(
          `"${language}" ser inte ut som en språkkod (rad ${rowNo}) men används som nyckel`,
        );
      }
    }

    const key = multilingual ? numberKey(number) : number;
    if (seen.get(key)?.has(language)) {
      skipped.push({
        row: rowNo,
        number,
        reason: multilingual
          ? `dubblerad rad för språket "${language}"`
          : "dubblerat frågenummer",
      });
      continue;
    }

    const answers: string[] = [];
    let mask = "";
    for (let c = 0; c < answerCount; c++) {
      const value = (cells[layout.firstAnswerCol + c] ?? "").trim();
      if (value !== "") {
        answers.push(value);
        mask += "1";
      } else {
        mask += "0";
      }
    }

    if (answers.length === 0) {
      skipped.push({ row: rowNo, number, reason: "inga svarsalternativ" });
      continue;
    }

    const correctRaw = (cells[layout.correctCol] ?? "").trim();
    // I enspråkigt läge valideras rätt svar redan här, precis som förut. I
    // flerspråkigt läge får siffran stå på vilken som helst av språkraderna
    // och kontrolleras därför först när raderna slagits ihop.
    if (!multilingual) {
      const correctIndex = Number.parseInt(correctRaw, 10);
      if (!Number.isInteger(correctIndex) || correctIndex < 1 || correctIndex > answers.length) {
        skipped.push({
          row: rowNo,
          number,
          reason:
            correctRaw === ""
              ? "rätt svar saknas"
              : `ogiltig markering av rätt svar (förväntade 1–${answers.length})`,
        });
        continue;
      }
    }

    const languagesForKey = seen.get(key);
    if (languagesForKey) languagesForKey.add(language);
    else seen.set(key, new Set([language]));

    if (!languages.includes(language)) languages.push(language);
    rawRows.push({ row: rowNo, number, key, language, questionText, answers, mask, correctRaw });
  }

  const { questions, missingTranslations, droppedTranslations } = mergeLanguageRows(
    rawRows,
    languages,
    defaultLanguage,
    skipped,
  );

  // Uteslutningar rapporteras i radordning oavsett i vilket steg de upptäcktes.
  skipped.sort((a, b) => a.row - b.row);

  return {
    questions,
    titleOverrides,
    languages,
    skipped,
    missingTranslations,
    droppedTranslations,
    warnings,
  };
}

/**
 * Slår ihop språkraderna till en fråga per nummer, i den ordning numren dök
 * upp i arket.
 *
 * Baspråkets rad är facit. Svarsalternativens position måste vara identisk
 * mellan språken – det är det som gör att option-id:t "b" betyder samma
 * alternativ på alla språk (se letterId i transform.ts). En översättning som
 * inte stämmer med baspråket faller bort för sig; frågan blir kvar.
 */
function mergeLanguageRows(
  rawRows: RawRow[],
  languages: string[],
  defaultLanguage: string,
  skipped: SkippedQuestion[],
): {
  questions: ParsedQuestion[];
  missingTranslations: MissingTranslation[];
  droppedTranslations: DroppedTranslation[];
} {
  const groups = new Map<string, RawRow[]>();
  const order: string[] = [];
  for (const raw of rawRows) {
    const group = groups.get(raw.key);
    if (group) {
      group.push(raw);
    } else {
      groups.set(raw.key, [raw]);
      order.push(raw.key);
    }
  }

  const questions: ParsedQuestion[] = [];
  const missing = new Map<string, string[]>();
  const dropped = new Map<string, DroppedTranslation>();

  for (const key of order) {
    const group = groups.get(key) ?? [];
    const first = group[0];
    if (!first) continue;
    const number = first.number;

    // Baspråkets rad är facit för både alternativens positioner och rätt svar.
    // Saknas baspråket får den första raden i arket rollen.
    const reference = group.find((r) => r.language === defaultLanguage) ?? first;
    const droppedHere = new Set<string>();
    const dropTranslation = (raw: RawRow, reason: string): void => {
      droppedHere.add(raw.language);
      const groupKey = `${raw.language}\n${reason}`;
      const entry = dropped.get(groupKey);
      if (entry) entry.numbers.push(number);
      else dropped.set(groupKey, { language: raw.language, reason, numbers: [number] });
    };

    let kept = group.filter((raw) => {
      if (raw.mask === reference.mask) return true;
      dropTranslation(raw, "svarsalternativen är olika ifyllda");
      return false;
    });

    // Rätt-svar-cellen är i praktiken sammanslagen över språkraderna och
    // behöver bara vara ifylld en gång. Orsakstexterna röjer aldrig vilket
    // alternativ som är rätt.
    let correctRaw = reference.correctRaw;
    if (correctRaw !== "") {
      kept = kept.filter((raw) => {
        if (raw.correctRaw === "" || raw.correctRaw === correctRaw) return true;
        dropTranslation(raw, "rätt svar markerat annorlunda än på baspråket");
        return false;
      });
    } else {
      // Baspråket saknar markering – då måste de övriga vara överens, annars
      // går det inte att avgöra vilket svar som är rätt.
      const distinct = [...new Set(kept.map((r) => r.correctRaw).filter((c) => c !== ""))];
      const only = distinct[0];
      if (only === undefined) {
        skipped.push({ row: reference.row, number, reason: "rätt svar saknas" });
        continue;
      }
      if (distinct.length > 1) {
        for (const raw of kept.filter((r) => r.correctRaw !== "")) {
          skipped.push({
            row: raw.row,
            number,
            reason: "rätt svar markerat olika för olika språk",
          });
        }
        continue;
      }
      correctRaw = only;
    }

    const correctIndex = Number.parseInt(correctRaw, 10);
    if (
      !Number.isInteger(correctIndex) ||
      correctIndex < 1 ||
      correctIndex > reference.answers.length
    ) {
      skipped.push({
        row: reference.row,
        number,
        reason: `ogiltig markering av rätt svar (förväntade 1–${reference.answers.length})`,
      });
      continue;
    }

    const questionText: LocalizedText = {};
    const answers: LocalizedText[] = reference.answers.map(() => ({}));
    for (const raw of kept) {
      questionText[raw.language] = raw.questionText;
      raw.answers.forEach((text, idx) => {
        const target = answers[idx];
        if (target) target[raw.language] = text;
      });
    }

    // Saknad översättning utesluter inte frågan – språknyckeln utelämnas helt
    // (aldrig tom sträng) så att konsumenten kan falla tillbaka själv. Språk
    // som just rapporterats som uteslutna räknas inte en gång till.
    const present = new Set(kept.map((r) => r.language));
    for (const language of languages) {
      if (present.has(language) || droppedHere.has(language)) continue;
      const numbers = missing.get(language);
      if (numbers) numbers.push(number);
      else missing.set(language, [number]);
    }

    questions.push({ number, questionText, answers, correctIndex });
  }

  const missingTranslations = [...missing.entries()].map(([language, numbers]) => ({
    language,
    numbers,
  }));

  return { questions, missingTranslations, droppedTranslations: [...dropped.values()] };
}
