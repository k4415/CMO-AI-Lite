import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";
import { regulationExcelFixtures } from "./regulation-excel-fixtures.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "regulations");
fs.mkdirSync(fixtureDir, { recursive: true });

for (const fixture of Object.values(regulationExcelFixtures)) {
  const workbook = xlsx.utils.book_new();
  for (const sheet of fixture.sheets) {
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  xlsx.writeFile(workbook, path.join(fixtureDir, fixture.fixtureFileName), {
    bookType: "xlsx",
    compression: true
  });
}
