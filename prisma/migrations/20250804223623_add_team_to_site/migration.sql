/*
  Warnings:

  - You are about to drop the column `team` on the `Site` table. All the data in the column will be lost.
  - Added the required column `teamName` to the `Site` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Site" ("createdAt", "domain", "id", "name") SELECT "createdAt", "domain", "id", "name" FROM "Site";
DROP TABLE "Site";
ALTER TABLE "new_Site" RENAME TO "Site";
CREATE UNIQUE INDEX "Site_domain_key" ON "Site"("domain");
CREATE UNIQUE INDEX "Site_teamName_key" ON "Site"("teamName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
