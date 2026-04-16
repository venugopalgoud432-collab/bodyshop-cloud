require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const adminHash = await bcrypt.hash("ChangeMe123!", 10);
  const techHash = await bcrypt.hash("Tech12345!", 10);

  await prisma.user.upsert({
    where: { email: "admin@bodyshop.local" },
    update: {
      role: "admin",
      isActive: true
    },
    create: {
      name: "Admin User",
      email: "admin@bodyshop.local",
      passwordHash: adminHash,
      role: "admin",
      isActive: true
    }
  });

  await prisma.user.upsert({
    where: { email: "tech@bodyshop.local" },
    update: {
      role: "tech",
      isActive: true
    },
    create: {
      name: "Mike Tech",
      email: "tech@bodyshop.local",
      passwordHash: techHash,
      role: "tech",
      isActive: true
    }
  });

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
