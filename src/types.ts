/**
 * Typer för utdataformatet. Speglar strukturen i tests-data-example/.
 *
 * Text representeras som ett språkobjekt, t.ex. { "sv": "..." }. Ett ark kan
 * vara enspråkigt (texten taggas med baspråket ur konfigurationen) eller
 * flerspråkigt (en rad per språk, se sheets.ts).
 */

/** Texter nycklade på språkkod, t.ex. { sv: "Var hittar du ...?" }. */
export type LocalizedText = Record<string, string>;

/** Ett svarsalternativ till en fråga. */
export interface Option {
  /** Lokalt id inom frågan: "a", "b", "c", ... */
  id: string;
  text: LocalizedText;
  correct: boolean;
}

/** En fråga med sina svarsalternativ. */
export interface Question {
  /** Globalt unikt id: "<test>-<kategori>-<nummer>". */
  id: string;
  question: LocalizedText;
  options: Option[];
}

/** Innehållet i en kategorifil (motsvarar ett spreadsheet). */
export interface Category {
  /**
   * Kategorins titel per språk. Baspråkets titel kommer från spreadsheetets
   * namn (med å/ä/ö bevarade) om inte en titelrad i arket säger annat.
   */
  title: LocalizedText;
  questions: Question[];
}

/**
 * Ett rått, parsat frågeobjekt innan det fått sitt globala id. Numret kommer
 * från arkets nummerkolumn och delas av frågans alla språkrader.
 */
export interface ParsedQuestion {
  /** Frågans nummer från nummerkolumnen (unikt inom arket). */
  number: string;
  questionText: LocalizedText;
  /**
   * Svarstexter i ordning (svar 1, 2, 3 ...), var och en med sina språktexter.
   * Positionen är gemensam för alla språk – se parseQuestions.
   */
  answers: LocalizedText[];
  /** 1-baserat index för rätt svar, gemensamt för alla språk. */
  correctIndex: number;
}
