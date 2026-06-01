import type { Category, Option, ParsedQuestion, Question } from "./types.js";

/** Bokstavs-id för svarsalternativ: a, b, c, ... z, aa, ab, ... */
function letterId(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Gör om ett namn (mapp eller ark) till en filsystemsvänlig slug.
 * Svenska diakriter translittereras (å/ä→a, ö→o) för att matcha stilen
 * i exempeldatan (t.ex. "safety-basics").
 */
export function slugify(name: string): string {
  const map: Record<string, string> = {
    å: "a", ä: "a", ö: "o", é: "e", è: "e", ü: "u", ø: "o", æ: "ae",
  };
  return name
    .trim()
    .toLowerCase()
    .replace(/[åäöéèüøæ]/g, (ch) => map[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // ta bort kvarvarande diakriter
    .replace(/[^a-z0-9]+/g, "-") // allt annat → bindestreck
    .replace(/^-+|-+$/g, "") // trimma ledande/avslutande bindestreck
    .replace(/-{2,}/g, "-"); // kollapsa dubbla bindestreck
}

/**
 * Omvandlar parsade frågor till utdataformatet.
 *
 * @param parsed    Frågorna från ett ark.
 * @param title     Kategorins titel (arkets råa namn, med å/ä/ö bevarade).
 * @param testSlug  Sluggat testnamn (undermappens namn).
 * @param catSlug   Sluggat kategorinamn (arkets namn).
 * @param language  Språkkod som texterna taggas med, t.ex. "sv".
 */
export function toCategory(
  parsed: ParsedQuestion[],
  title: string,
  testSlug: string,
  catSlug: string,
  language: string,
): Category {
  const questions: Question[] = parsed.map((q) => {
    const options: Option[] = q.answers.map((text, idx) => ({
      id: letterId(idx),
      text: { [language]: text },
      // correctIndex är 1-baserat.
      correct: idx + 1 === q.correctIndex,
    }));

    return {
      id: `${testSlug}-${catSlug}-${q.number}`,
      question: { [language]: q.questionText },
      options,
    };
  });

  return { title: { [language]: title.trim() }, questions };
}
