/*
  Warnings:

  - Added the required column `userName` to the `QAReport` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Comment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "QAReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Comment" ("content", "createdAt", "id", "reportId", "userId") SELECT "content", "createdAt", "id", "reportId", "userId" FROM "Comment";
DROP TABLE "Comment";
ALTER TABLE "new_Comment" RENAME TO "Comment";
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
    "userId" TEXT,
    CONSTRAINT "QAReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_QAReport" ("comment", "duration", "id", "imagePath", "resolvedAt", "site", "siteName", "slug", "status", "timestamp", "url", "userId", "x", "y") SELECT "comment", "duration", "id", "imagePath", "resolvedAt", "site", "siteName", "slug", "status", "timestamp", "url", "userId", "x", "y" FROM "QAReport";
DROP TABLE "QAReport";
ALTER TABLE "new_QAReport" RENAME TO "QAReport";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
