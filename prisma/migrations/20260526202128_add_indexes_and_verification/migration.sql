-- CreateIndex
CREATE INDEX "Activity_userId_createdAt_idx" ON "Activity"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_reportId_idx" ON "Activity"("reportId");

-- CreateIndex
CREATE INDEX "QAReport_userId_idx" ON "QAReport"("userId");

-- CreateIndex
CREATE INDEX "QAReport_userId_status_idx" ON "QAReport"("userId", "status");

-- CreateIndex
CREATE INDEX "QAReport_userId_archived_idx" ON "QAReport"("userId", "archived");

-- CreateIndex
CREATE INDEX "QAReport_siteId_idx" ON "QAReport"("siteId");

-- CreateIndex
CREATE INDEX "QAReport_slug_idx" ON "QAReport"("slug");

-- CreateIndex
CREATE INDEX "Site_slug_idx" ON "Site"("slug");

-- CreateIndex
CREATE INDEX "Site_teamId_idx" ON "Site"("teamId");

-- CreateIndex
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");
