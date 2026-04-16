require("dotenv").config();

const express = require("express");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();

const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bodyshop Cloud V4 is running");
});

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: "not connected",
      error: String(error.message || error)
    });
  }
});

app.get("/login", (req, res) => {
  res.send("Login page coming soon");
});

app.get("/dashboard", async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      orderBy: { updatedAt: "desc" },
      take: 20
    });

    res.json({
      ok: true,
      count: jobs.length,
      jobs
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Bodyshop Cloud V4 running on port ${PORT}`);
});
