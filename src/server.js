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
const multer = require("multer");
const { PrismaClient } = require("@prisma/client");

const { requireAuth, requireRole } = require("./middleware/auth");
const { statusLabel, formatDateInput, hoursLeft, statusOptions } = require("./utils/viewHelpers");

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  }
});
const upload = multer({ storage });

async function writeAudit(userId, jobId, action, details = null) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
        jobId: jobId || null,
        action,
        details
      }
    });
  } catch (error) {
    console.error("AUDIT ERROR:", error.message);
  }
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
  res.locals.isOverdue = (job) => {
    if (!job.promisedDate || job.status === "DELIVERED") return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const promised = new Date(job.promisedDate);
    promised.setHours(0, 0, 0, 0);
    return promised < today;
  };
  res.locals.isDueSoon = (job) => {
    if (!job.promisedDate || job.status === "DELIVERED") return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const promised = new Date(job.promisedDate);
    promised.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((promised - today) / (1000 * 60 * 60 * 24));
    return diffDays >= 0 && diffDays <= 2;
  };
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
  try {
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

    await writeAudit(user.id, null, "LOGIN", `User ${user.email} logged in`);
    req.flash("success", `Welcome back, ${user.name}.`);
    res.redirect("/dashboard");
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    req.flash("error", "Login failed.");
    res.redirect("/login");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const filterStatus = req.query.status || "";
    const q = (req.query.q || "").trim();

    const where = {
      AND: [
        filterStatus ? { status: filterStatus } : {},
        q
          ? {
              OR: [
                { roNumber: { contains: q, mode: "insensitive" } },
                { customerName: { contains: q, mode: "insensitive" } },
                { make: { contains: q, mode: "insensitive" } },
                { model: { contains: q, mode: "insensitive" } },
                { vin: { contains: q, mode: "insensitive" } },
                { plate: { contains: q, mode: "insensitive" } }
              ]
            }
          : {}
      ]
    };

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 50
    });

    const allJobs = await prisma.job.findMany();
    const activeEntries = await prisma.timeEntry.findMany({
      where: { status: "CLOCKED_IN" }
    });

    const activeTechsSet = new Set(
      allJobs
        .filter((j) => !!j.technician && j.status !== "DELIVERED")
        .map((j) => j.technician)
    );

    const stats = {
      totalJobs: allJobs.length,
      openJobs: allJobs.filter((j) => j.status !== "DELIVERED").length,
      waitingParts: allJobs.filter((j) => j.status === "WAITING_PARTS").length,
      readyToDeliver: allJobs.filter((j) => j.status === "READY_TO_DELIVER").length,
      clockedIn: activeEntries.length,
      activeTechs: activeTechsSet.size
    };

    res.render("dashboard/index", {
      title: "Dashboard",
      jobs,
      stats,
      filterStatus,
      q
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).send("Error loading dashboard");
  }
});

app.get("/production", requireAuth, async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: {
        status: { not: "DELIVERED" }
      },
      orderBy: { updatedAt: "desc" }
    });

    res.render("production/index", {
      title: "Production Board",
      jobs
    });
  } catch (error) {
    console.error("PRODUCTION ERROR:", error);
    res.status(500).send("Error loading production board");
  }
});

app.get("/jobs/new", requireAuth, (req, res) => {
  res.render("jobs/form", {
    title: "New Job",
    job: null,
    updates: [],
    parts: [],
    photos: []
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

    await writeAudit(req.session.user.id, job.id, "JOB_CREATED", `Created job ${job.roNumber}`);
    req.flash("success", "Job created.");
    res.redirect(`/jobs/${job.id}`);
  } catch (error) {
    console.error("CREATE JOB ERROR:", error);
    req.flash("error", "Could not create job. RO number may already exist.");
    res.redirect("/jobs/new");
  }
});

app.get("/jobs/:id", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id }
    });

    if (!job) {
      req.flash("error", "Job not found.");
      return res.redirect("/dashboard");
    }

    let updates = [];
    let parts = [];
    let photos = [];

    try {
      updates = await prisma.jobUpdate.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: "desc" }
      });
    } catch (e) {
      console.log("Updates load failed:", e.message);
    }

    try {
      parts = await prisma.part.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: "desc" }
      });
    } catch (e) {
      console.log("Parts load failed:", e.message);
    }

    try {
      photos = await prisma.jobPhoto.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: "desc" }
      });
    } catch (e) {
      console.log("Photos load failed:", e.message);
    }

    res.render("jobs/form", {
      title: `Edit Job ${job.roNumber}`,
      job,
      updates,
      parts,
      photos
    });
  } catch (error) {
    console.error("JOB LOAD ERROR:", error);
    res.status(500).send("Error loading job");
  }
});

app.get("/jobs/:id/print", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id }
    });

    if (!job) {
      return res.status(404).send("Job not found");
    }

    const updates = await prisma.jobUpdate.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: "desc" }
    });

    const parts = await prisma.part.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: "desc" }
    });

    res.render("jobs/print", {
      layout: false,
      job,
      updates,
      parts,
      statusLabel,
      hoursLeft
    });
  } catch (error) {
    console.error("PRINT ERROR:", error);
    res.status(500).send("Error generating print view");
  }
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

    await writeAudit(req.session.user.id, req.params.id, "JOB_UPDATED", "Updated job details");
    req.flash("success", "Job updated.");
    res.redirect(`/jobs/${req.params.id}`);
  } catch (error) {
    console.error("UPDATE JOB ERROR:", error);
    req.flash("error", "Could not update job.");
    res.redirect(`/jobs/${req.params.id}`);
  }
});

app.post("/jobs/:id/photos", requireAuth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      req.flash("error", "Please select a photo.");
      return res.redirect(`/jobs/${req.params.id}`);
    }

    await prisma.jobPhoto.create({
      data: {
        jobId: req.params.id,
        originalName: req.file.originalname,
        filePath: `/uploads/${req.file.filename}`,
        caption: req.body.caption || null
      }
    });

    await writeAudit(req.session.user.id, req.params.id, "PHOTO_UPLOADED", req.file.originalname);
    req.flash("success", "Photo uploaded.");
    res.redirect(`/jobs/${req.params.id}`);
  } catch (error) {
    console.error("PHOTO UPLOAD ERROR:", error);
    req.flash("error", "Could not upload photo.");
    res.redirect(`/jobs/${req.params.id}`);
  }
});

app.post("/photos/:id/delete", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  try {
    const photo = await prisma.jobPhoto.findUnique({
      where: { id: req.params.id }
    });

    if (photo) {
      const absolutePath = path.join(process.cwd(), photo.filePath.replace(/^\//, ""));
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
      await prisma.jobPhoto.delete({
        where: { id: req.params.id }
      });
      await writeAudit(req.session.user.id, req.body.jobId, "PHOTO_DELETED", photo.originalName);
    }

    req.flash("success", "Photo deleted.");
    res.redirect(`/jobs/${req.body.jobId}`);
  } catch (error) {
    console.error("PHOTO DELETE ERROR:", error);
    req.flash("error", "Could not delete photo.");
    res.redirect(`/jobs/${req.body.jobId}`);
  }
});

app.post("/jobs/:id/updates", requireAuth, async (req, res) => {
  try {
    await prisma.jobUpdate.create({
      data: {
        jobId: req.params.id,
        message: req.body.message,
        customerVisible: req.body.customerVisible === "true"
      }
    });

    await writeAudit(req.session.user.id, req.params.id, "JOB_UPDATE_ADDED", req.body.message);
    req.flash("success", "Update added.");
    res.redirect(`/jobs/${req.params.id}`);
  } catch (error) {
    console.error("ADD UPDATE ERROR:", error);
    req.flash("error", "Could not add update.");
    res.redirect(`/jobs/${req.params.id}`);
  }
});

app.post("/jobs/:id/parts", requireAuth, async (req, res) => {
  try {
    await prisma.part.create({
      data: {
        jobId: req.params.id,
        name: req.body.name,
        vendor: req.body.vendor || null,
        quantity: Number(req.body.quantity || 1),
        eta: req.body.eta ? new Date(req.body.eta) : null,
        status: req.body.status,
        notes: req.body.notes || null
      }
    });

    await writeAudit(req.session.user.id, req.params.id, "PART_ADDED", req.body.name);
    req.flash("success", "Part added.");
    res.redirect(`/jobs/${req.params.id}`);
  } catch (error) {
    console.error("ADD PART ERROR:", error);
    req.flash("error", "Could not add part.");
    res.redirect(`/jobs/${req.params.id}`);
  }
});

app.post("/parts/:id/status", requireAuth, async (req, res) => {
  try {
    await prisma.part.update({
      where: { id: req.params.id },
      data: {
        status: req.body.status
      }
    });

    await writeAudit(req.session.user.id, req.body.jobId, "PART_STATUS_UPDATED", `Set to ${req.body.status}`);
    req.flash("success", "Part status updated.");
    res.redirect(`/jobs/${req.body.jobId}`);
  } catch (error) {
    console.error("PART STATUS ERROR:", error);
    req.flash("error", "Could not update part status.");
    res.redirect(`/jobs/${req.body.jobId}`);
  }
});

app.post("/jobs/:id/deliver", requireAuth, async (req, res) => {
  try {
    await prisma.job.update({
      where: { id: req.params.id },
      data: {
        status: "DELIVERED",
        stage: "Completed / Delivered"
      }
    });

    await writeAudit(req.session.user.id, req.params.id, "JOB_DELIVERED", "Marked delivered");
    req.flash("success", "Job marked delivered.");
    res.redirect(`/jobs/${req.params.id}`);
  } catch (error) {
    console.error("DELIVER JOB ERROR:", error);
    req.flash("error", "Could not mark job delivered.");
    res.redirect(`/jobs/${req.params.id}`);
  }
});

app.get("/timeclock", requireAuth, async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { status: { not: "DELIVERED" } },
      orderBy: { updatedAt: "desc" }
    });

    const activeEntries = await prisma.timeEntry.findMany({
      where: { status: "CLOCKED_IN" },
      orderBy: { startedAt: "asc" },
      include: { user: true, job: true }
    });

    const techMap = new Map();

    jobs
      .filter((job) => !!job.technician)
      .forEach((job) => {
        const tech = job.technician || "Unassigned";
        if (!techMap.has(tech)) {
          techMap.set(tech, {
            technician: tech,
            jobCount: 0,
            estimatedHours: 0,
            hoursWorked: 0,
            hoursLeft: 0
          });
        }

        const row = techMap.get(tech);
        row.jobCount += 1;
        row.estimatedHours += Number(job.estimatedHours || 0);
        row.hoursWorked += Number(job.hoursWorked || 0);
        row.hoursLeft += Math.max(Number(job.estimatedHours || 0) - Number(job.hoursWorked || 0), 0);
      });

    const rows = Array.from(techMap.values()).sort((a, b) => b.hoursLeft - a.hoursLeft);

    res.render("timeclock/index", {
      title: "Technician Hours Board",
      rows,
      jobs,
      activeEntries
    });
  } catch (error) {
    console.error("TIMECLOCK ERROR:", error);
    res.status(500).send("Error loading technician board");
  }
});

app.post("/timeclock/in", requireRole(["admin", "manager", "tech"]), async (req, res) => {
  try {
    await prisma.timeEntry.create({
      data: {
        userId: req.session.user.id,
        jobId: req.body.jobId || null,
        technicianName: req.session.user.name,
        startedAt: new Date(),
        status: "CLOCKED_IN",
        notes: req.body.notes || null
      }
    });

    await writeAudit(req.session.user.id, req.body.jobId || null, "CLOCKED_IN", req.body.notes || "Clocked in");
    req.flash("success", "Punched in.");
    res.redirect("/timeclock");
  } catch (error) {
    console.error("CLOCK IN ERROR:", error);
    req.flash("error", "Could not punch in.");
    res.redirect("/timeclock");
  }
});

app.post("/timeclock/:id/out", requireRole(["admin", "manager", "tech"]), async (req, res) => {
  try {
    const entry = await prisma.timeEntry.findUnique({
      where: { id: req.params.id }
    });

    if (!entry) {
      req.flash("error", "Time entry not found.");
      return res.redirect("/timeclock");
    }

    if (
      req.session.user.role !== "admin" &&
      req.session.user.role !== "manager" &&
      req.session.user.id !== entry.userId
    ) {
      req.flash("error", "You do not have access to punch out this entry.");
      return res.redirect("/timeclock");
    }

    await prisma.timeEntry.update({
      where: { id: req.params.id },
      data: {
        endedAt: new Date(),
        status: "CLOCKED_OUT"
      }
    });

    await writeAudit(req.session.user.id, entry.jobId || null, "CLOCKED_OUT", "Punched out");
    req.flash("success", "Punched out.");
    res.redirect("/timeclock");
  } catch (error) {
    console.error("CLOCK OUT ERROR:", error);
    req.flash("error", "Could not punch out.");
    res.redirect("/timeclock");
  }
});

app.get("/admin/users", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" }
    });

    res.render("admin/users", {
      title: "Staff Management",
      users
    });
  } catch (error) {
    console.error("ADMIN USERS ERROR:", error);
    res.status(500).send("Error loading staff page");
  }
});

app.post("/admin/users", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const passwordHash = await bcrypt.hash(req.body.password, 10);

    await prisma.user.create({
      data: {
        name: req.body.name,
        email: req.body.email.toLowerCase().trim(),
        passwordHash,
        role: req.body.role,
        isActive: true
      }
    });

    await writeAudit(
      req.session.user.id,
      null,
      "USER_CREATED",
      `Created staff user ${req.body.email}`
    );

    req.flash("success", "Staff user created.");
    res.redirect("/admin/users");
  } catch (error) {
    console.error("CREATE USER ERROR:", error);
    req.flash("error", "Could not create staff user.");
    res.redirect("/admin/users");
  }
});

app.post("/admin/users/:id/toggle", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id }
    });

    if (!user) {
      req.flash("error", "User not found.");
      return res.redirect("/admin/users");
    }

    await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: !user.isActive }
    });

    await writeAudit(
      req.session.user.id,
      null,
      "USER_STATUS_CHANGED",
      `${user.email} => ${!user.isActive ? "active" : "inactive"}`
    );

    req.flash("success", "User updated.");
    res.redirect("/admin/users");
  } catch (error) {
    console.error("TOGGLE USER ERROR:", error);
    req.flash("error", "Could not update user.");
    res.redirect("/admin/users");
  }
});

app.get("/admin/audit", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: true,
        job: true
      }
    });

    res.render("admin/audit", {
      title: "Audit Log",
      logs
    });
  } catch (error) {
    console.error("AUDIT PAGE ERROR:", error);
    res.status(500).send("Error loading audit log");
  }
});

app.get("/status/:token", async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { customerPortalToken: req.params.token }
    });

    if (!job) {
      return res.status(404).send("Status page not found");
    }

    let updates = [];
    let photos = [];

    try {
      updates = await prisma.jobUpdate.findMany({
        where: {
          jobId: job.id,
          customerVisible: true
        },
        orderBy: { createdAt: "desc" }
      });
    } catch (e) {
      console.log("Customer updates load failed:", e.message);
    }

    try {
      photos = await prisma.jobPhoto.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: "desc" }
      });
    } catch (e) {
      console.log("Customer photos load failed:", e.message);
    }

    res.render("customers/status", {
      title: `Status ${job.roNumber}`,
      job,
      updates,
      photos
    });
  } catch (error) {
    console.error("CUSTOMER STATUS ERROR:", error);
    res.status(500).send("Error loading status page");
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
