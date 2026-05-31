import { google, type drive_v3, type sheets_v4 } from "googleapis";
import type { Config } from "./config.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** Ett namngivet objekt på Drive (mapp eller ark). */
export interface DriveItem {
  /** Det faktiska id:t att traversera/läsa (genvägar resolvas till sitt mål). */
  id: string;
  /** Namnet att visa/slugga (genvägens eget namn om det är en genväg). */
  name: string;
}

/** Klienter för Drive- och Sheets-API:erna, autentiserade via service account. */
export interface GoogleClients {
  drive: drive_v3.Drive;
  sheets: sheets_v4.Sheets;
}

/**
 * Autentiserar mot Google med en service account-nyckel och returnerar
 * Drive- och Sheets-klienter. Endast läsbehörighet begärs.
 */
export async function createClients(config: Config): Promise<GoogleClients> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.serviceAccountKeyFile,
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
  const authClient = await auth.getClient();
  // @ts-expect-error – GoogleAuth-klienten är kompatibel som auth-option.
  const drive = google.drive({ version: "v3", auth: authClient });
  // @ts-expect-error – samma som ovan.
  const sheets = google.sheets({ version: "v4", auth: authClient });
  return { drive, sheets };
}

/**
 * Listar samtliga barn till en mapp som antingen har önskat mimeType, eller
 * är en genväg (shortcut) som pekar på ett objekt med önskat mimeType.
 *
 * Genvägar resolvas till sitt mål: id sätts till genvägens `targetId` så att
 * efterföljande anrop traverserar/läser det riktiga objektet, medan namnet
 * behålls från genvägen (det är det användaren ser i den delade enheten).
 */
async function listChildren(
  drive: drive_v3.Drive,
  parentId: string,
  targetMimeType: string,
): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let pageToken: string | undefined;
  // Hämta både direkta objekt av rätt typ och genvägar (resolvas nedan).
  const query =
    `'${parentId}' in parents and trashed = false and ` +
    `(mimeType = '${targetMimeType}' or mimeType = '${SHORTCUT_MIME}')`;

  do {
    const res = await drive.files.list({
      q: query,
      fields:
        "nextPageToken, files(id, name, mimeType, " +
        "shortcutDetails(targetId, targetMimeType))",
      orderBy: "name",
      pageSize: 1000,
      // Stöd för delade enheter (Shared Drives).
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });

    for (const file of res.data.files ?? []) {
      if (!file.name) continue;

      if (file.mimeType === SHORTCUT_MIME) {
        const target = file.shortcutDetails;
        // Behåll bara genvägar som pekar på rätt sorts mål.
        if (target?.targetId && target.targetMimeType === targetMimeType) {
          items.push({ id: target.targetId, name: file.name });
        }
        continue;
      }

      if (file.mimeType === targetMimeType && file.id) {
        items.push({ id: file.id, name: file.name });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return items;
}

/**
 * Listar test-undermapparna direkt under rotmappen. Hanterar både riktiga
 * mappar och genvägar till mappar (vanligt i en delad enhet).
 */
export function listTestFolders(
  drive: drive_v3.Drive,
  rootFolderId: string,
): Promise<DriveItem[]> {
  return listChildren(drive, rootFolderId, FOLDER_MIME);
}

/**
 * Listar kategori-spreadsheeten i en test-undermapp. Hanterar både riktiga
 * ark och genvägar till ark.
 */
export function listCategorySheets(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<DriveItem[]> {
  return listChildren(drive, folderId, SHEET_MIME);
}

/**
 * Kontrollerar om service accountet kan läsa metadata för ett objekt.
 * Drive returnerar 404 ("File not found") även vid saknad behörighet, så
 * ett false här betyder oftast "ingen åtkomst" snarare än "finns inte".
 */
export async function canAccess(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<boolean> {
  try {
    await drive.files.get({
      fileId,
      fields: "id",
      supportsAllDrives: true,
    });
    return true;
  } catch {
    return false;
  }
}
