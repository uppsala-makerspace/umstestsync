/**
 * Typer för utdataformatet. Speglar strukturen i tests-data-example/.
 *
 * Text representeras som ett språkobjekt, t.ex. { "sv": "..." }, även om
 * arken just nu är enspråkiga. Det gör formatet framtidssäkert om fler
 * språk tillkommer.
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
  /** Kategorins titel, från spreadsheetets namn (med å/ä/ö bevarade). */
  title: LocalizedText;
  questions: Question[];
}

/**
 * Ett rått, parsat frågeobjekt innan det fått sitt globala id och
 * lokaliserats. Numret kommer från arkets första kolumn.
 */
export interface ParsedQuestion {
  /** Frågans nummer från kolumn A (unikt inom arket). */
  number: string;
  questionText: string;
  /** Svarstexter i ordning (svar 1, 2, 3 ...). */
  answers: string[];
  /** 1-baserat index för rätt svar (från kolumn F). */
  correctIndex: number;
}
