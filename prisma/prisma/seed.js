require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@bodyshop.local" },
    update: {},
    create: {
      name: "Admin User",
      email: "admin@bodyshop.local",
      passwordHash,
      role: "admin",
      isActive: true
    }
  });

  const tech = await prisma.user.upsert({
    where: { email: "tech@bodyshop.local" },
    update: {},
    create: {
      name: "Mike Tech",
      email: "tech@bodyshop.local",
      passwordHash,
      role: "tech",
      isActive: true
    }
  });

  const job = await prisma.job.upsert({
    where: { roNumber: "AB-4001" },
    update: {},
    create: {
      roNumber: "AB-4001",
      customerName: "Demo Customer",
      customerPhone: "+15555550123",
      customerEmail: "demo@example.com",
      year: "2024",
      make: "Honda",
      model: "CR-V",
      color: "Grey",
      insuranceProvider: "MPI",
      claimNumber: "MPI-4001",
      advisor: "Front Desk",
      technician: "Mike Tech",
      status: "WAITING_PARTS",
      stage: "Parts delay",
      estimatedHours: 18,
      hoursWorked: 6,
      partsOrdered: "Headlamp, bracket, clips",
      customerPortalToken: "demo-v4-customer-token-4001"
    }
  });

  await prisma.jobUpdate.create({
    data: {
      jobId: job.id,
      authorId: admin.id,
      message: "We are waiting for one backordered part. We will update you once it arrives.",
      customerVisible: true
    }
  });

  await prisma.part.createMany({
    data: [
      { jobId: job.id, name: "Headlamp", vendor: "Dealer", quantity: 1, status: "BACKORDERED" },
      { jobId: job.id, name: "Bracket", vendor: "Dealer", quantity: 1, status: "ORDERED" }
    ]
  });

  await prisma.supplement.create({
    data: {
      jobId: job.id,
      title: "Hidden reinforcement damage",
      amount: 620.0,
      description: "Additional parts and labor after teardown",
      status: "SUBMITTED",
      submittedAt: new Date()
    }
  });

  await prisma.notification.create({
    data: {
      jobId: job.id,
      userId: admin.id,
      type: "SMS",
      recipient: "+15555550123",
      message: "Your repair is delayed waiting for a part. We will update you as soon as it arrives.",
      status: "QUEUED"
    }
  });

  await prisma.timeEntry.create({
    data: {
      jobId: job.id,
      userId: tech.id,
      technicianName: "Mike Tech",
      startedAt: new Date(Date.now() - 4 * 3600000),
      endedAt: new Date(Date.now() - 2 * 3600000),
      status: "CLOCKED_OUT",
      notes: "Front teardown"
    }
  });

  console.log("Seed complete.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
