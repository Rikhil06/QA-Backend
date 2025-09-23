/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `QAReport` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "QAReport" ADD COLUMN "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "QAReport_slug_key" ON "QAReport"("slug");
