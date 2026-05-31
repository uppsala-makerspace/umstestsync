# umstestsync

Synkroniserar frågeark från **Google Drive** (Google Sheets) till en JSON-struktur
av **test** och **kategorier**.

Frågorna ligger i ett skyddat Google Drive och struktureras i två nivåer:

- **Test** – en undermapp i en rotmapp på Drive.
- **Kategori** – ett Google Sheets-ark i en test-undermapp. Frågorna inom en
  kategori är utbytbara (slumpas fram av det system som senare sätter ihop ett test).

Utdatan blir en katalog med en JSON-fil per kategori:

```
tests-data/
  <test-slug>/
    <kategori-slug>.json
```

Se `tests-data-example/` för formatet.

## Arkets layout

Varje kategori-ark läses från sin första flik med följande kolumner:

| Kolumn | Innehåll                              |
| ------ | ------------------------------------- |
| A      | Frågans nummer (unikt inom arket)     |
| B      | Själva frågan                         |
| C      | Svar 1                                |
| D      | Svar 2                                |
| E      | Svar 3                                |
| F      | Siffra (1–3) som anger rätt svar      |

- Antalet svarskolumner styrs av `answerCount` i konfigurationen (standard 3).
  Rätt-svar-kolumnen ligger alltid direkt efter sista svarskolumnen.
- Tomma svarsceller hoppas över, så en fråga kan ha färre alternativ än `answerCount`.
- En inledande rubrikrad upptäcks och hoppas över automatiskt (kolumn A utan siffror).
- Arken är enspråkiga. Texten taggas med `language` (standard `sv`) i utdatan,
  t.ex. `{ "sv": "..." }`, så att fler språk kan tillkomma utan formatändring.

Frågans id i utdatan blir `"<test-slug>-<kategori-slug>-<nummer>"` så att det är
globalt unikt över hela frågepoolen.

## Autentisering (service account)

Drive-mappen är skyddad. Åtkomst sker med ett **service account**:

1. Skapa ett Google Cloud-projekt och aktivera **Google Drive API** och **Google Sheets API**.
2. Skapa ett service account och ladda ner dess **JSON-nyckel**.
3. **Dela** rotmappen på Drive med service accountets e-postadress
   (`...@...iam.gserviceaccount.com`) med minst läsbehörighet.
4. Peka `serviceAccountKeyFile` i konfigurationen mot nyckelfilen.

Nyckelfilen och `config.json` är `.gitignore`:ade – checka aldrig in dem.

## Lägga till test

Testen samlas i den delade enheten **UMS-tester**:
<https://drive.google.com/drive/folders/0AJtcBqBPCOeNUk9PVA>

För varje test:

1. Lägg testmappen i den delade enheten **UMS-tester** (en genväg till mappen fungerar också).
2. **Dela målmappen** – dvs. den mapp som faktiskt innehåller kategori-arken – med
   service account-användaren:

   ```
   umstestsync-reader@umstestsync.iam.gserviceaccount.com
   ```

   med minst läsbehörighet (*Visare*).

> Viktigt: en genväg i den delade enheten ger **inte** i sig service accountet åtkomst
> till mappen den pekar på. Du måste dela själva målmappen med användaren ovan, annars
> hittas inga kategorier i testet. (Lägger du in den riktiga mappen direkt i den delade
> enheten i stället för en genväg behövs ingen separat delning – medlemskap i enheten räcker.)

## Konfiguration

Kopiera `config.example.json` till `config.json` och fyll i:

```json
{
  "serviceAccountKeyFile": "./service-account.json",
  "rootFolderId": "0AJtcBqBPCOeNUk9PVA",
  "outputDir": "./tests-data",
  "language": "sv",
  "answerCount": 3
}
```

`rootFolderId` är id:t i Drive-mappens URL: `https://drive.google.com/drive/folders/<ID>`.
Relativa sökvägar tolkas relativt konfigurationsfilens katalog.

## Användning

```bash
npm install

# Bygger och kör mot config.json i arbetskatalogen:
npm run sync
```

`config.json` används som standard. Vill du peka mot en annan fil:

```bash
npm run sync -- --config annan-config.json
```

## Utveckling

- `npm run build` – kompilerar TypeScript till `dist/`.
- Källkoden ligger i `src/` (ESM, TypeScript).
