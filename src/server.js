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

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  return res.redirect("/login");
});

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

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };

  req.flash("success", `Welcome back, ${user.name}.`);
  res.redirect("/dashboard");
});

app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

app.get("/dashboard", requireAuth, async (req, res) => {
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

  const [jobs] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }]
    })
  ]);

  res.send(`Jobs loaded: ${jobs.length}`);
});

app.get("/jobs/new", requireAuth, (req, res) => {
  res.send("New Job page coming soon");
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
    where: { id: req.params.id }
  });

  if (!job) {
    req.flash("error", "Job not found.");
    return res.redirect("/dashboard");
  }

  res.send(`Job ${job.roNumber} page coming soon`);
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

  emitRefresh();
  req.flash("success", "Job updated.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/jobs/:id/updates", requireAuth, async (req, res) => {
  res.send("Job updates coming soon");
});

app.post("/jobs/:id/photos", requireAuth, upload.single("photo"), async (req, res) => {
  if (!req.file) {
    req.flash("error", "No photo uploaded.");
    return res.redirect(`/jobs/${req.params.id}`);
  }

  await saveUploadedFile(req.file);
  emitRefresh();
  req.flash("success", "Photo uploaded.");
  res.redirect(`/jobs/${req.params.id}`);
});

app.post("/jobs/:id/parts", requireAuth, async (req, res) => {
  res.send("Parts route coming soon");
});

app.post("/parts/:id/status", requireAuth, async (req, res) => {
  res.send("Part status route coming soon");
});

app.post("/jobs/:id/supplements", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Supplements route coming soon");
});

app.post("/supplements/:id/status", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Supplement status route coming soon");
});

app.get("/timeclock", requireAuth, async (req, res) => {
  res.send("Time Clock page coming soon");
});

app.post("/timeclock/in", requireAuth, async (req, res) => {
  res.send("Clock in route coming soon");
});

app.post("/timeclock/:id/out", requireAuth, async (req, res) => {
  res.send("Clock out route coming soon");
});

app.post("/jobs/:id/notifications", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Notifications route coming soon");
});

app.get("/reports", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Reports page coming soon");
});

app.get("/reports/productivity", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Productivity report coming soon");
});

app.get("/parts/receiving", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Parts receiving page coming soon");
});

app.get("/supplements/approvals", requireRole(["admin", "manager", "csr"]), async (req, res) => {
  res.send("Supplement approvals page coming soon");
});

app.get("/jobs/:id/document/estimate", requireAuth, async (req, res) => {
  res.send("Estimate page coming soon");
});

app.get("/jobs/:id/document/invoice", requireAuth, async (req, res) => {
  res.send("Invoice page coming soon");
});

app.get("/status/:token", async (req, res) => {
  res.send("Customer status page coming soon");
});

app.get("/admin/users", requireRole(["admin"]), async (req, res) => {
  res.send("Admin users page coming soon");
});

app.post("/admin/users", requireRole(["admin"]), async (req, res) => {
  res.send("Create admin user route coming soon");
});

app.post("/admin/users/:id/toggle", requireRole(["admin"]), async (req, res) => {
  res.send("Toggle admin user route coming soon");
});

app.get("/password/request", (req, res) => {
  res.send("Password reset request page coming soon");
});

app.post("/password/request", async (req, res) => {
  res.send("Password reset request route coming soon");
});

app.get("/password/reset/:token", async (req, res) => {
  res.send("Password reset page coming soon");
});

app.post("/password/reset/:token", async (req, res) => {
  res.send("Password reset submit route coming soon");
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
