/*
  Warnings:

  - A unique constraint covering the columns `[siteId,slug]` on the table `QAReport` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[domain]` on the table `Site` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "QAReport_siteId_slug_key" ON "QAReport"("siteId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Site_domain_key" ON "Site"("domain");
