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
const multer = require("multer");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const dayjs = require("dayjs");
const { PrismaClient } = require("@prisma/client");

const { requireAuth, requireRole } = require("./middleware/auth");
const { statusLabel, formatDateInput, hoursLeft, statusOptions } = require("./utils/viewHelpers");
const { sendQueuedNotifications, canSendReal } = require("./services/notifications");
const { saveUploadedFile } = require("./services/storage");

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`)
});
const upload = multer({ storage });

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
  res.locals.baseUrl = BASE_URL;
  res.locals.notificationsMode = canSendReal() ? "LIVE" : "DEMO";
  next();
});

function emitRefresh() {
  io.emit("dashboard:refresh", { at: new Date().toISOString() });
}

app.get("/", (req, res) => (req.session.user ? res.redirect("/dashboard") : res.redirect("/login")));

app.get("/login", (req, res) => {
  res.send("Login page coming soon");
});

app.post("/login", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.isActive || !(await bcrypt.compare(req.body.password || "", user.passwordHash))) {
    req.flash("error", "Invalid login.");
    return res.redirect("/login");
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  req.flash("success", `Welcome back, ${user.name}.`);
  res.redirect("/dashboard");
});

app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

app.get("/dashboard", requireAuth, async (req, res) => {
  res.send("Dashboard coming soon");
});
  const q = (req.query.q || "").trim();
  const status = (req.query.status || "").trim();

  const where = {
    AND: [
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
        : {},
      status ? { status } : {}
    ]
  };

  const [jobs, queuedNotifications, waitingPartsCount, submittedSupplements, partsBackordered] =
    await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: [{ promisedDate: "asc" }, { updatedAt: "desc" }],
        include: { parts: true, supplements: true }
      }),
      prisma.notification.count({ where: { status: "QUEUED" } }),
      prisma.job.count({ where: { status: "WAITING_PARTS" } }),
      prisma.supplement.count({ where: { status: "SUBMITTED" } }),
      prisma.part.count({ where: { status: "BACKORDERED" } })
    ]);

  const allJobs = await prisma.job.findMany();

  const stats = {
    openJobs: allJobs.filter((j) => j.status !== "DELIVERED").length,
    hoursLeft: allJobs
      .filter((j) => j.status !== "DELIVERED")
      .reduce((sum, j) => sum + Math.max((j.estimatedHours || 0) - (j.hoursWorked || 0), 0), 0),
    overdue: allJobs.filter(
      (j) => j.status !== "DELIVERED" && j.promisedDate && dayjs(j.promisedDate).isBefore(dayjs(), "day")
    ).length,
    queuedNotifications,
    waitingPartsCount,
    submittedSupplements,
    partsBackordered
  };

  res.render("dashboard/index", {
    title: "Dashboard",
    jobs,
    stats,
    filters: { q, status }
  });
});

app.get("/jobs/new", requireAuth, (req, res) => {
  res.render("jobs/form", { title: "New Job", job: null, portalUrl: null });
});

app.post("/jobs", requireAuth, async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString("hex");

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
        customerPortalToken: token
      }
    });

    await prisma.jobUpdate.create({
      data: {
        jobId: job.id,
        authorId: req.session.user.id,
        message: "Job created.",
        customerVisible: false
      }
    });

    emitRefresh();
    req.flash("success", "Job created.");
    res.redirect(`/jobs/${job.id}`);
  } catch (err) {
    req.flash("error", "Could not create job. Check RO number uniqueness.");
    res.redirect("/jobs/new");
  }
});

app.get("/jobs/:id", requireAuth, async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: {
      photos: { orderBy: { createdAt: "desc" } },
      updates: { orderBy: { createdAt: "desc" }, include: { author: true } },
      parts: { orderBy: { createdAt: "desc" } },
      supplements: { orderBy: { createdAt: "desc" } },
      notifications: { orderBy: { createdAt: "desc" } },
      timeEntries: { orderBy: { createdAt: "desc" }, include: { user: true } }
    }
  });

  if (!job) {
    req.flash("error", "Job not found.");
    return res.redirect("/dashboard");
  }

  res.render("jobs/form", {
    title: `Job ${job.roNumber}`,
    job,
    portalUrl: `${BASE_URL}/status/${job.customerPortalToken}`
  });
});

app.post("/jobs/:id", requireAuth, async (req, res) => {
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

  await prisma.jobUpdate.create({
    data: {
      jobId: req.params.id,
      authorId: req.session.user.id,
      message: "Job updated.",
      customerVisible: false
    }
  });

  emitRefresh();
  req.flash("success", "Job updated.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/jobs/:id/updates", requireAuth, async (req, res) => {
  if (!req.body.message || !req.body.message.trim()) {
    req.flash("error", "Update message is required.");
    return res.redirect(`/jobs/${req.params.id}`);
  }

  await prisma.jobUpdate.create({
    data: {
      jobId: req.params.id,
      authorId: req.session.user.id,
      message: req.body.message.trim(),
      customerVisible: req.body.customerVisible === "on"
    }
  });

  emitRefresh();
  req.flash("success", "Update added.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/jobs/:id/photos", requireAuth, upload.single("photo"), async (req, res) => {
  if (!req.file) {
    req.flash("error", "No photo uploaded.");
    return res.redirect(`/jobs/${req.params.id}`);
  }

  const saved = await saveUploadedFile(req.file);

  await prisma.jobPhoto.create({
    data: {
      jobId: req.params.id,
      originalName: req.file.originalname,
      filePath: saved.filePath,
      storageKey: saved.storageKey,
      caption: req.body.caption || null,
      uploadedById: req.session.user.id
    }
  });

  emitRefresh();
  req.flash("success", "Photo uploaded.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/jobs/:id/parts", requireAuth, async (req, res) => {
  await prisma.part.create({
    data: {
      jobId: req.params.id,
      name: req.body.name,
      vendor: req.body.vendor || null,
      quantity: Number(req.body.quantity || 1),
      eta: req.body.eta ? new Date(req.body.eta) : null,
      status: req.body.status || "ORDERED",
      notes: req.body.notes || null
    }
  });

  emitRefresh();
  req.flash("success", "Part added.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/parts/:id/status", requireAuth, async (req, res) => {
  const status = req.body.status || "ORDERED";

  await prisma.part.update({
    where: { id: req.params.id },
    data: {
      status,
      receivedAt: status === "RECEIVED" ? new Date() : null
    }
  });

  emitRefresh();
  req.flash("success", "Part status updated.");
  res.redirect("back");
});

app.post("/jobs/:id/supplements", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const status = req.body.status || "DRAFT";

  await prisma.supplement.create({
    data: {
      jobId: req.params.id,
      title: req.body.title,
      amount: Number(req.body.amount || 0),
      description: req.body.description || null,
      status,
      submittedAt: status === "SUBMITTED" ? new Date() : null
    }
  });

  emitRefresh();
  req.flash("success", "Supplement added.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/supplements/:id/status", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const status = req.body.status || "DRAFT";

  await prisma.supplement.update({
    where: { id: req.params.id },
    data: {
      status,
      submittedAt: status === "SUBMITTED" ? new Date() : undefined,
      decisionAt: ["APPROVED", "DECLINED"].includes(status) ? new Date() : null
    }
  });

  emitRefresh();
  req.flash("success", "Supplement status updated.");
  res.redirect("back");
});

app.get("/timeclock", requireAuth, async (req, res) => {
  const [openEntries, jobs] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { status: "CLOCKED_IN" },
      include: { user: true, job: true },
      orderBy: { startedAt: "asc" }
    }),
    prisma.job.findMany({ where: { status: { not: "DELIVERED" } }, orderBy: { roNumber: "asc" } })
  ]);

  res.render("timeclock/index", { title: "Time Clock", openEntries, jobs });
});

app.post("/timeclock/in", requireAuth, async (req, res) => {
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

  emitRefresh();
  req.flash("success", "Clocked in.");
  res.redirect("/timeclock");
});

app.post("/timeclock/:id/out", requireAuth, async (req, res) => {
  await prisma.timeEntry.update({
    where: { id: req.params.id },
    data: { endedAt: new Date(), status: "CLOCKED_OUT" }
  });

  emitRefresh();
  req.flash("success", "Clocked out.");
  res.redirect("/timeclock");
});

app.post("/jobs/:id/notifications", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });

  if (!job) {
    req.flash("error", "Job not found.");
    return res.redirect("/dashboard");
  }

  const type = req.body.type || "SMS";
  const recipient =
    type === "SMS"
      ? req.body.recipient || job.customerPhone || ""
      : req.body.recipient || job.customerEmail || "";

  if (!recipient) {
    req.flash("error", "Recipient is required.");
    return res.redirect(`/jobs/${req.params.id}`);
  }

  await prisma.notification.create({
    data: {
      jobId: req.params.id,
      userId: req.session.user.id,
      type,
      recipient,
      subject: req.body.subject || null,
      message: req.body.message || ""
    }
  });

  emitRefresh();
  req.flash("success", "Notification queued.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.get("/reports", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const [jobs, supplements, timeEntries, notifications] = await Promise.all([
    prisma.job.findMany({ include: { parts: true, supplements: true } }),
    prisma.supplement.findMany(),
    prisma.timeEntry.findMany({ where: { status: "CLOCKED_OUT" }, include: { user: true, job: true } }),
    prisma.notification.findMany()
  ]);

  const report = {
    openJobs: jobs.filter((j) => j.status !== "DELIVERED").length,
    overdueJobs: jobs.filter(
      (j) => j.status !== "DELIVERED" && j.promisedDate && dayjs(j.promisedDate).isBefore(dayjs(), "day")
    ).length,
    waitingParts: jobs.filter((j) => j.status === "WAITING_PARTS").length,
    supplementTotalSubmitted: supplements
      .filter((s) => ["SUBMITTED", "APPROVED"].includes(s.status))
      .reduce((sum, s) => sum + s.amount, 0),
    supplementTotalApproved: supplements
      .filter((s) => s.status === "APPROVED")
      .reduce((sum, s) => sum + s.amount, 0),
    notificationsQueued: notifications.filter((n) => n.status === "QUEUED").length,
    notificationsSent: notifications.filter((n) => n.status === "SENT").length,
    techHours: {}
  };

  for (const entry of timeEntries) {
    const name = entry.user?.name || entry.technicianName || "Unknown";
    const hours = entry.endedAt ? (new Date(entry.endedAt) - new Date(entry.startedAt)) / 3600000 : 0;
    report.techHours[name] = (report.techHours[name] || 0) + hours;
  }

  res.render("reports/index", { title: "Reports", report, jobs });
});

app.get("/reports/productivity", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const start = req.query.start || dayjs().startOf("month").format("YYYY-MM-DD");
  const end = req.query.end || dayjs().endOf("month").format("YYYY-MM-DD");

  const entries = await prisma.timeEntry.findMany({
    where: {
      status: "CLOCKED_OUT",
      startedAt: {
        gte: new Date(start),
        lte: dayjs(end).endOf("day").toDate()
      }
    },
    include: { user: true, job: true },
    orderBy: { startedAt: "asc" }
  });

  const byTech = {};
  for (const entry of entries) {
    const name = entry.user?.name || entry.technicianName || "Unknown";
    const hours = entry.endedAt ? (new Date(entry.endedAt) - new Date(entry.startedAt)) / 3600000 : 0;
    if (!byTech[name]) byTech[name] = { hours: 0, jobs: new Set() };
    byTech[name].hours += hours;
    if (entry.job?.roNumber) byTech[name].jobs.add(entry.job.roNumber);
  }

  const rows = Object.entries(byTech)
    .map(([name, data]) => ({
      name,
      hours: data.hours,
      jobsCount: data.jobs.size
    }))
    .sort((a, b) => b.hours - a.hours);

  res.render("reports/productivity", {
    title: "Productivity Report",
    start,
    end,
    rows
  });
});

app.get("/parts/receiving", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const parts = await prisma.part.findMany({
    where: { status: { in: ["ORDERED", "BACKORDERED"] } },
    include: { job: true },
    orderBy: [{ eta: "asc" }, { createdAt: "asc" }]
  });

  res.render("parts/receiving", { title: "Parts Receiving", parts });
});

app.get("/supplements/approvals", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  const supplements = await prisma.supplement.findMany({
    where: { status: { in: ["DRAFT", "SUBMITTED"] } },
    include: { job: true },
    orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }]
  });

  res.render("supplements/approvals", { title: "Supplement Approvals", supplements });
});

app.get("/jobs/:id/document/estimate", requireAuth, async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: { parts: true, supplements: true }
  });

  if (!job) return res.redirect("/dashboard");

  res.render("documents/estimate", {
    title: `Estimate ${job.roNumber}`,
    job,
    printMode: req.query.print === "1"
  });
});

app.get("/jobs/:id/document/invoice", requireAuth, async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: { parts: true, supplements: true }
  });

  if (!job) return res.redirect("/dashboard");

  res.render("documents/invoice", {
    title: `Invoice ${job.roNumber}`,
    job,
    printMode: req.query.print === "1"
  });
});

app.get("/status/:token", async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { customerPortalToken: req.params.token },
    include: {
      updates: { where: { customerVisible: true }, orderBy: { createdAt: "desc" } },
      photos: { orderBy: { createdAt: "desc" }, take: 8 }
    }
  });

  if (!job) return res.status(404).render("customers/not-found", { title: "Not Found" });

  res.render("customers/status", { title: `Status ${job.roNumber}`, job });
});

app.get("/admin/users", requireRole(["admin"]), async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  res.render("admin/users", { title: "Staff Users", users });
});

app.post("/admin/users", requireRole(["admin"]), async (req, res) => {
  try {
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    await prisma.user.create({
      data: {
        name: req.body.name,
        email: req.body.email.toLowerCase().trim(),
        passwordHash,
        role: req.body.role
      }
    });
    req.flash("success", "Staff user created.");
  } catch (err) {
    req.flash("error", "Could not create user.");
  }

  res.redirect("/admin/users");
});

app.post("/admin/users/:id/toggle", requireRole(["admin"]), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  await prisma.user.update({ where: { id: req.params.id }, data: { isActive: !user.isActive } });
  req.flash("success", "User updated.");
  res.redirect("/admin/users");
});

app.get("/password/request", (req, res) =>
  res.render("password/request", { title: "Request Password Reset" })
);

app.post("/password/request", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    const token = crypto.randomBytes(24).toString("hex");
    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt: dayjs().add(1, "hour").toDate() }
    });
    req.flash("success", `Reset token created. Demo link: ${BASE_URL}/password/reset/${token}`);
  } else {
    req.flash("success", "If that email exists, a reset link would be generated.");
  }

  res.redirect("/password/request");
});

app.get("/password/reset/:token", async (req, res) => {
  const record = await prisma.passwordResetToken.findUnique({ where: { token: req.params.token } });

  if (!record || record.usedAt || dayjs(record.expiresAt).isBefore(dayjs())) {
    req.flash("error", "Reset link invalid or expired.");
    return res.redirect("/login");
  }

  res.render("password/reset", { title: "Reset Password", token: req.params.token });
});

app.post("/password/reset/:token", async (req, res) => {
  const record = await prisma.passwordResetToken.findUnique({ where: { token: req.params.token } });

  if (!record || record.usedAt || dayjs(record.expiresAt).isBefore(dayjs())) {
    req.flash("error", "Reset link invalid or expired.");
    return res.redirect("/login");
  }

  await prisma.user.update({
    where: { id: record.userId },
    data: { passwordHash: await bcrypt.hash(req.body.password, 10) }
  });

  await prisma.passwordResetToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() }
  });

  req.flash("success", "Password changed.");
  res.redirect("/login");
});

io.on("connection", (socket) => {
  socket.emit("connected", { ok: true });
});

setInterval(() => {
  sendQueuedNotifications(prisma).catch((err) => console.error("Notification queue error:", err));
}, 10000);

server.listen(PORT, () => {
  console.log(`Body Shop Cloud V4 running on port ${PORT}`);
});
