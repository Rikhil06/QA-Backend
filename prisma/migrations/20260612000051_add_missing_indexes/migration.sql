-- CreateIndex
CREATE INDEX "QAReport_userId_archived_status_idx" ON "QAReport"("userId", "archived", "status");

-- CreateIndex
CREATE INDEX "QAReport_site_idx" ON "QAReport"("site");

-- CreateIndex
CREATE INDEX "QAReport_site_status_idx" ON "QAReport"("site", "status");
