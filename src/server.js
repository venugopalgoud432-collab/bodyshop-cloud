require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const flash = require("connect-flash");
const helmet = require("helmet");
const morgan = require("morgan");
const methodOverride = require("method-override");
const expressLayouts = require("express-ejs-layouts");
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const { requireAuth } = require("./middleware/auth");
const { statusLabel, formatDateInput, hoursLeft, statusOptions } = require("./utils/viewHelpers");

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("layout", "layouts/main");
app.use(expressLayouts);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change_me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false }
  })
);
app.use(flash());
app.use("/uploads", express.static(path.resolve(UPLOAD_DIR)));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flashSuccess = req.flash("success");
  res.locals.flashError = req.flash("error");
  res.locals.statusLabel = statusLabel;
  res.locals.statusOptions = statusOptions;
  res.locals.formatDateInput = formatDateInput;
  res.locals.hoursLeft = hoursLeft;
  next();
});

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  return res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.render("auth/login", { title: "Login" });
});

app.post("/login", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.isActive || !(await bcrypt.compare(req.body.password || "", user.passwordHash))) {
    req.flash("error", "Invalid login.");
    return res.redirect("/login");
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };

  req.flash("success", `Welcome back, ${user.name}.`);
  res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/dashboard", requireAuth, async (req, res) => {
  const jobs = await prisma.job.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50
  });

  res.render("dashboard/index", {
    title: "Dashboard",
    jobs
  });
});

app.get("/jobs/new", requireAuth, (req, res) => {
  res.render("jobs/form", {
    title: "New Job",
    job: null
  });
});

app.post("/jobs", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.create({
      data: {
        roNumber: req.body.roNumber,
        customerName: req.body.customerName,
        customerPhone: req.body.customerPhone || null,
        customerEmail: req.body.customerEmail || null,
        year: req.body.year || null,
        make: req.body.make || null,
        model: req.body.model || null,
        color: req.body.color || null,
        vin: req.body.vin || null,
        plate: req.body.plate || null,
        insuranceProvider: req.body.insuranceProvider || null,
        claimNumber: req.body.claimNumber || null,
        advisor: req.body.advisor || null,
        technician: req.body.technician || null,
        status: req.body.status || "ON_LOT",
        stage: req.body.stage || null,
        dateIn: req.body.dateIn ? new Date(req.body.dateIn) : null,
        promisedDate: req.body.promisedDate ? new Date(req.body.promisedDate) : null,
        estimatedHours: Number(req.body.estimatedHours || 0),
        hoursWorked: Number(req.body.hoursWorked || 0),
        partsOrdered: req.body.partsOrdered || null,
        partsEta: req.body.partsEta ? new Date(req.body.partsEta) : null,
        requiredItems: req.body.requiredItems || null,
        notes: req.body.notes || null,
        qcNotes: req.body.qcNotes || null,
        rentalNeeded: req.body.rentalNeeded === "true",
        customerPortalToken: `portal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      }
    });

    req.flash("success", "Job created.");
    res.redirect(`/jobs/${job.id}`);
  } catch (error) {
    req.flash("error", "Could not create job. RO number may already exist.");
    res.redirect("/jobs/new");
  }
});

app.get("/jobs/:id", requireAuth, async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id }
  });

  if (!job) {
    req.flash("error", "Job not found.");
    return res.redirect("/dashboard");
  }

  res.render("jobs/form", {
    title: `Edit Job ${job.roNumber}`,
    job
  });
});

app.post("/jobs/:id", requireAuth, async (req, res) => {
  try {
    await prisma.job.update({
      where: { id: req.params.id },
      data: {
        roNumber: req.body.roNumber,
        customerName: req.body.customerName,
        customerPhone: req.body.customerPhone || null,
        customerEmail: req.body.customerEmail || null,
        year: req.body.year || null,
        make: req.body.make || null,
        model: req.body.model || null,
        color: req.body.color || null,
        vin: req.body.vin || null,
        plate: req.body.plate || null,
        insuranceProvider: req.body.insuranceProvider || null,
        claimNumber: req.body.claimNumber || null,
        advisor: req.body.advisor || null,
        technician: req.body.technician || null,
        status: req.body.status || "ON_LOT",
        stage: req.body.stage || null,
        dateIn: req.body.dateIn ? new Date(req.body.dateIn) : null,
        promisedDate: req.body.promisedDate ? new Date(req.body.promisedDate) : null,
        estimatedHours: Number(req.body.estimatedHours || 0),
        hoursWorked: Number(req.body.hoursWorked || 0),
        partsOrdered: req.body.partsOrdered || null,
        partsEta: req.body.partsEta ? new Date(req.body.partsEta) : null,
        requiredItems: req.body.requiredItems || null,
        notes: req.body.notes || null,
        qcNotes: req.body.qcNotes || null,
        rentalNeeded: req.body.rentalNeeded === "true"
      }
    });

    req.flash("success", "Job updated.");
    res.redirect(`/jobs/${req.params.id}`);
  } catch (error) {
    req.flash("error", "Could not update job.");
    res.redirect(`/jobs/${req.params.id}`);
  }
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

server.listen(PORT, () => {
  console.log(`Body Shop Cloud running on port ${PORT}`);
});
