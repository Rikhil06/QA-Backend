-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_QAReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "site" TEXT,
    "siteName" TEXT,
    "comment" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "imagePath" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'new',
    "priority" TEXT NOT NULL DEFAULT 'not_assigned',
    "resolvedAt" DATETIME,
    "duration" INTEGER,
    "userName" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    CONSTRAINT "QAReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_QAReport" ("comment", "duration", "id", "imagePath", "priority", "resolvedAt", "site", "siteName", "slug", "status", "timestamp", "url", "userId", "userName", "x", "y") SELECT "comment", "duration", "id", "imagePath", "priority", "resolvedAt", "site", "siteName", "slug", "status", "timestamp", "url", "userId", "userName", "x", "y" FROM "QAReport";
DROP TABLE "QAReport";
ALTER TABLE "new_QAReport" RENAME TO "QAReport";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
