const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function getUserTeams(userId) {
  // Step 1: determine if user owns any teams
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    select: {
      role: true,
      teamId: true,
    },
  });

  const isOwner = memberships.some((m) => m.role === 'owner');

  // Step 2: branch based on role
  if (isOwner) {
    return getOwnerTeams(userId);
  }

  return getMemberTeams(userId);
}

async function getOwnerTeams(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      teamMembers: {
        where: { role: 'owner' },
        select: {
          team: {
            select: {
              id: true,
              name: true,
              plan: true,
              subscription: {
                select: {
                  plan: true,
                  interval: true,
                  status: true,
                  trialEndsAt: true,
                  currentPeriodEnd: true,
                  stripePriceId: true,
                  stripeSubscriptionId: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

async function getMemberTeams(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      teamMembers: {
        where: { role: 'member' },
        select: {
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });
}

module.exports = {
  getUserTeams,
};
