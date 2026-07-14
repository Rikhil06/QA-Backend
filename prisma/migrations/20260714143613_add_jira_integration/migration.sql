-- AlterTable
ALTER TABLE "QAReport" ADD COLUMN     "jiraIssueKey" TEXT,
ADD COLUMN     "jiraIssueUrl" TEXT;

-- CreateTable
CREATE TABLE "JiraIntegration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JiraIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteJiraConfig" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "cloudId" TEXT NOT NULL,
    "cloudUrl" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "issueType" TEXT NOT NULL DEFAULT 'Bug',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "integrationId" TEXT NOT NULL,

    CONSTRAINT "SiteJiraConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JiraIntegration_userId_key" ON "JiraIntegration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteJiraConfig_siteId_key" ON "SiteJiraConfig"("siteId");

-- AddForeignKey
ALTER TABLE "JiraIntegration" ADD CONSTRAINT "JiraIntegration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteJiraConfig" ADD CONSTRAINT "SiteJiraConfig_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "JiraIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteJiraConfig" ADD CONSTRAINT "SiteJiraConfig_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
