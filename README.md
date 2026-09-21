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

Varje kategori-ark läses från sin första flik. Ett ark kan vara **enspråkigt** eller
**flerspråkigt**; layouten avgörs av om det finns en språkkolumn.

### Enspråkigt ark

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
- Texten taggas med baspråket `language` (standard `sv`) i utdatan, t.ex.
  `{ "sv": "..." }`.

### Flerspråkigt ark

Har arket en kolumn med rubriken **Språk** som *första eller andra* kolumn finns i
stället **en rad per språk och fråga**. Övriga kolumner skjuts ett steg åt höger:

| Kolumn | Innehåll                                      |
| ------ | --------------------------------------------- |
| A      | Frågans nummer                                |
| B      | Språk (`sv`, `en`, ...)                       |
| C      | Själva frågan                                 |
| D–F    | Svar 1–3                                      |
| G      | Siffra (1–3) som anger rätt svar              |

Språkkolumnen får lika gärna ligga först (då är A = språk och B = nummer).

```
Nummer | Språk | Fråga                | Svar 1 | Svar 2 | Svar 3 | Rätt
titel  | sv    | Pelarborr            |        |        |        |
titel  | en    | Pillar drill         |        |        |        |
1      | sv    | Vad används den till?| ...    | ...    | ...    | 1
1      | en    | What is it used for? | ...    | ...    | ...    |
```

- **Rubrikraden är obligatorisk** i flerspråkiga ark – det är den som talar om att
  språkkolumnen finns. Saknas den tolkas arket som enspråkigt och blir obrukbart
  (det loggas som en varning).
- Godkända rubriker: `Språk`, `Language` eller `Lang` – skiftlägesokänsligt, men utan
  tillägg i cellen.
- Språkkoden används som nyckel i JSON:en, i gemener (`sv`, `en`).
- Raderna hör ihop via **numret**. Nummer- och rätt-svar-cellerna får vara
  sammanslagna (merge:ade) över språkraderna – står värdet bara på den första raden
  ärver följdraderna det.
- **Baspråkets rad (`language` i konfigurationen) är facit.** Svarsalternativen måste
  vara ifyllda i samma kolumner som på baspråkets rad; det är det som gör att
  alternativ `b` betyder samma sak på alla språk. Gör en översättning inte det, eller
  markerar den ett annat rätt svar, faller **bara den översättningen** bort – frågan
  blir kvar på övriga språk och det loggas som en varning.
- En fråga som bara finns på ett språk tas med – språknyckeln utelämnas helt för
  översättningen som saknas, och det loggas som en varning (inte en uteslutning).
- Hela frågan utesluts bara om baspråkets egen rad är ogiltig, eller om ingen rad alls
  markerar ett rätt svar (saknar baspråket markering måste översättningarna vara
  överens).

### Kategorititel

Kategorins titel är normalt spreadsheetets namn. Vill man ha den på flera språk – eller
skriva den annorlunda än filnamnet – lägger man in en **titelrad**: `titel` (eller
`title`) i nummerkolumnen och själva titeln i frågekolumnen, en rad per språk. Ingen
extra kolumn behövs. Titelrader överlagrar arknamnet.

Frågans id i utdatan blir `"<test-slug>-<kategori-slug>-<nummer>"` så att det är
globalt unikt över hela frågepoolen. Numret delas av frågans språkrader, så id:t
ändras inte när en översättning tillkommer.

## Automatisk påfyllning av översättningar

Att översätta ett helt ark för hand är besvärligt. Anges `translateTo` i
konfigurationen fyller synken själv på det som saknas i **flerspråkiga** ark:

- en titelrad per språk, om de saknas (baspråkets med spreadsheetets namn),
- en översättningsrad per fråga och målspråk, direkt under frågans sista rad.

Den nya raden får språktaggen, tom nummercell och tom rätt-svar-cell (båda ärvs
uppifrån) samt `=GOOGLETRANSLATE(...)` i frågekolumnen och i exakt de svarskolumner
som är ifyllda på källraden. Källspråket i formeln tas från källradens egen
språktagg.

**Formlerna ligger kvar som formler.** Det är avsiktligt: rättar du den svenska
frågan följer översättningen med automatiskt. Vill du rätta en översättning skriver
du helt enkelt över cellen – då blir den statisk text och verktyget rör den aldrig
mer. Frys alltså inte formlerna till värden "för städningens skull".

Verktyget **ändrar aldrig en befintlig cell**, bara infogar nya rader. Följderna av
det:

- Har en översättningsrad bara halva innehållet ifyllt lagas den inte – den faller
  bort ur utdatan och loggas som varning tills du fyllt i den.
- Raderar du en översättningsrad återskapas den vid nästa körning. Vill du undertrycka
  en översättning behåller du raden och tömmer texten; språktaggen räcker för att
  verktyget ska lämna frågan i fred.
- När titelraderna väl finns styr **de** kategorititeln – döper du om spreadsheetet
  ändras inte längre titeln i utdatan.
- Verktyget infogar rader. Egna formler i andra flikar och namngivna intervall
  justeras av Sheets när insättningen ligger inuti intervallet, men inte när den
  ligger exakt på slutgränsen.

Inget skrivs om `translateTo` saknas (då begärs inte ens skrivbehörighet), om arket
saknar språkkolumn, om arket inte gav en enda läsbar fråga, om service accountet
saknar redigeringsrätt, eller om arket skulle behöva fler än 500 nya rader.

Kör med `--dry-run` för att se vad som skulle läggas till utan att skriva något:

```bash
npm run sync -- --dry-run
```

Det är också det sätt man bör felsöka manuellt på, eftersom en manuell körning
samtidigt som serverns timkörning annars kan ge en dubblettrad.

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

   med minst läsbehörighet (*Visare*) – eller **Redigerare**, om verktyget ska fylla
   på översättningsrader i arken (se `translateTo`).

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
  "translateTo": ["en"],
  "answerCount": 3,
  "logFile": "./umstestsync.log"
}
```

| Fält                    | Beskrivning                                                            |
| ----------------------- | --------------------------------------------------------------------- |
| `serviceAccountKeyFile` | Sökväg till service account-nyckelns JSON-fil.                        |
| `rootFolderId`          | Id för rotmappen/den delade enheten (se URL:en, se nedan).            |
| `outputDir`             | Katalog dit JSON-strukturen skrivs. Standard `./tests-data`.          |
| `language`              | Baspråk: källspråk, standardtagg för otaggade rader, titelfallback. Standard `sv`. |
| `translateTo`           | Språk som arken ska fyllas på med. Utelämnas → verktyget skriver ingenting.  |
| `answerCount`           | Antal svarskolumner (börjar i kolumn C). Standard `3`.                |
| `logFile`               | Valfri sökväg till loggfil. Utelämnas → loggas endast till konsolen.  |

`rootFolderId` är id:t i Drive-mappens URL: `https://drive.google.com/drive/folders/<ID>`.
Relativa sökvägar tolkas relativt konfigurationsfilens katalog.

## Loggning

Anges `logFile` skrivs en läsbar logg över körningen (annars loggas allt bara till
konsolen). Loggen listar vilka frågor som **uteslutits** och varför – t.ex. saknad
frågetext, inga svarsalternativ eller avsaknad av markerat rätt svar:

```
WARN  utesluten fråga  test="introtra"  kategori="bandslip"  fråga 10  rad=11  orsak=saknar frågetext
```

Flerspråkiga ark ger dessutom **varningar** som inte utesluter någon fråga, t.ex. att
en fråga saknar en översättning (samlat till en rad per kategori och språk):

```
WARN  [pelartest] 3 frågor saknar en-översättning: 4, 7, 9
WARN  [pelartest] en-översättningen utesluten för 1 fråga (svarsalternativen är olika ifyllda): 5
```

Och en rad när verktyget fyllt på arket:

```
  ✎ Bandsliptest: 11 en-översättningar, titel (sv), titel (en)
```

En cell vars `GOOGLETRANSLATE`-formel failat (`#ERROR!`, `#N/A` …) tas aldrig med i
utdatan – raden utesluts med orsaken `formelfel i cellen` och varnas vid varje
körning tills den rättats.

Av sekretesskäl innehåller loggen bara **test, kategori och frågans ursprungliga
nummer** (samt radnummer och orsak) – aldrig själva frågetexten eller svarsalternativen.
Av samma skäl säger en orsak aldrig *vilket* alternativ som är rätt, bara att
markeringen saknas eller skiljer sig mellan språken.
Loggfilen skrivs om vid varje körning och är `.gitignore`:ad (`*.log`).

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

## Drift

Systemet är driftsatt på servern och kör en synkning **varje timme**, så att
ändringar i frågearken slår igenom automatiskt.

Loggen från den senaste körningen finns publikt på:
<https://www.uppsalamakerspace.se/umstestsync.log>

Där ser du vilka frågor som uteslutits och varför (t.ex. saknat rätt svar) –
utan att själva frågorna avslöjas.

Makerspace-medlemsappen hämtar i sin tur in testfrågorna en gång i timmen, så en
ändring i arken bör synas i appen inom några minuter efter att synkningen körts.

Som skydd mot att ett trasigt ark tömmer en kategori skrivs kategorifilen **inte** om
när arket har innehåll men inte gav en enda giltig fråga (t.ex. en flerspråkig layout
vars rubrikrad försvunnit). Den föregående filen ligger kvar och orsaken loggas. Ett
ark som kastar fel stoppar heller inte körningen – felet loggas och nästa kategori tas.

Är `translateTo` ifyllt skriver den timvisa körningen även i arken (se *Automatisk
påfyllning av översättningar*). Det är idempotent: när alla rader finns gör
efterföljande körningar ingenting.

## Utveckling

- `npm run build` – kompilerar TypeScript till `dist/`.
- Källkoden ligger i `src/` (ESM, TypeScript).
