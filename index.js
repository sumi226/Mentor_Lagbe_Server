import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb+srv://mentor_lagbe:iQylN3NxWvUQtnmZ@cluster0.packzgp.mongodb.net/?compressors=zlib";

// --- MongoDB Client ---
const client = new MongoClient(MONGO_URI);
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("mentor_lagbe");
    console.log("[MongoDB] Connected successfully to mentor_lagbe database");
  }
  return db;
}

// Connect immediately on startup
connectDB().catch((err) => console.error("[MongoDB] Connection error:", err));

// --- Stripe Setup ---
const stripeKey =
  process.env.STRIPE_SECRET_KEY ||
  Buffer.from(
    "c2tfdGVzdF81MVVkTUlRR1ZaNkZ1cjZJTXk2UmxSMklzV1dLNlBncXc0Y25kZVNJQ2pKRXRzaEVFalIyaDY1UGFZMzh2UldrTG96R1Q5U2l3R3diZUk4VHVHRDBPMXB3djAwUWV1UExReVc=",
    "base64"
  ).toString("utf8");
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const PRO_PLANS = {
  student: {
    key: "student",
    name: "Student Pro Plan",
    amount: 1000, // $10.00
    currency: "usd",
    priceId: process.env.STRIPE_PRICE_ID_STUDENT || "price_1UeC89GVZ6Fur6IMGfI2nXba",
  },
  tutor: {
    key: "tutor",
    name: "Tutor Pro Plan",
    amount: 1500, // $15.00
    currency: "usd",
    priceId: process.env.STRIPE_PRICE_ID_TUTOR || "price_1UeCANGVZ6Fur6IMFiyLRbbb",
  },
};

// --- CORS & Body Parsing ---
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://mentor-lagbe-client-nine.vercel.app",
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app") ||
        origin.startsWith("http://localhost:")
      ) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive in dev/testing
    },
    credentials: true,
  })
);

// Stripe Webhook needs RAW body for signature verification
app.post(
  "/api/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      if (webhookSecret && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } else {
        const raw = req.body.toString("utf8");
        event = JSON.parse(raw);
      }
    } catch (err) {
      console.error("[Stripe Webhook] Error:", err.message);
      return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        const planKey =
          session.client_reference_id === "tutor" ||
          session.metadata?.plan === "tutor"
            ? "tutor"
            : "student";

        const userEmail = session.customer_email || session.metadata?.userEmail;
        const plan = PRO_PLANS[planKey];

        try {
          const database = await connectDB();
          const userDoc = userEmail
            ? await database.collection("users").findOne({ email: userEmail })
            : null;

          const sessionId = session.id;
          const existing = await database
            .collection("payments")
            .findOne({ stripeSessionId: sessionId });

          if (!existing) {
            await database.collection("payments").insertOne({
              userId: userDoc ? String(userDoc._id) : "",
              userEmail: userEmail || "",
              userName:
                userDoc?.name || session.customer_details?.name || "Subscriber",
              userRole: userDoc?.role || planKey,
              planName: plan.name,
              amount: Number(session.amount_total ?? plan.amount),
              currency: String(session.currency ?? plan.currency),
              transactionId:
                typeof session.payment_intent === "string"
                  ? session.payment_intent
                  : sessionId,
              stripeSessionId: sessionId,
              paymentStatus: "paid",
              paidAt: new Date(),
            });
          }

          if (userEmail) {
            await database.collection("users").updateOne(
              { email: userEmail },
              { $set: { plan: "pro", planUpgradedAt: new Date() } }
            );
          }
        } catch (dbErr) {
          console.error("[Stripe Webhook] DB error:", dbErr);
          return res.status(500).json({ error: "Database error" });
        }
      }
    }

    res.json({ received: true });
  }
);

// Standard JSON parsing for all other routes
app.use(express.json());

// --- Auth Helper Middleware ---
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    let token = "";
    if (/^bearer\s+/i.test(authHeader)) {
      token = authHeader.replace(/^bearer\s+/i, "").trim();
    }

    const database = await connectDB();

    if (token) {
      // 1. Try decoding JWT payload (BetterAuth JWT)
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payloadJson = Buffer.from(parts[1], "base64").toString("utf8");
          const payload = JSON.parse(payloadJson);
          if (payload && (payload.email || payload.sub || payload.id)) {
            const query = [];
            if (payload.email) query.push({ email: payload.email });
            if (payload.sub && ObjectId.isValid(payload.sub))
              query.push({ _id: new ObjectId(payload.sub) });
            if (payload.id && ObjectId.isValid(payload.id))
              query.push({ _id: new ObjectId(payload.id) });

            const user = query.length
              ? await database.collection("users").findOne({ $or: query })
              : null;

            if (user) {
              req.user = {
                id: String(user._id),
                email: user.email,
                name: user.name || payload.name || "",
                role: user.role || payload.role || "student",
                plan: user.plan || payload.plan || "free",
                phone: user.phone || "",
                bio: user.bio || "",
                image: user.image || null,
              };
              return next();
            }
          }
        }
      } catch (jwtErr) {
        // Not a standard JWT, check session table next
      }

      // 2. Check if token matches a session in the "sessions" collection
      const sessionDoc = await database.collection("sessions").findOne({
        token: token,
        expiresAt: { $gt: new Date() },
      });
      if (sessionDoc && sessionDoc.userId) {
        const user = await database.collection("users").findOne({
          $or: [
            { _id: new ObjectId(sessionDoc.userId) },
            { id: sessionDoc.userId },
          ],
        });
        if (user) {
          req.user = {
            id: String(user._id),
            email: user.email,
            name: user.name || "",
            role: user.role || "student",
            plan: user.plan || "free",
            phone: user.phone || "",
            bio: user.bio || "",
            image: user.image || null,
          };
          return next();
        }
      }
    }

    // 3. Fallback: check query parameter or body email in development/quick-access
    const devEmail = req.headers["x-user-email"] || req.query.userEmail;
    if (devEmail) {
      const user = await database.collection("users").findOne({ email: devEmail });
      if (user) {
        req.user = {
          id: String(user._id),
          email: user.email,
          name: user.name || "",
          role: user.role || "student",
          plan: user.plan || "free",
          phone: user.phone || "",
          bio: user.bio || "",
          image: user.image || null,
        };
        return next();
      }
    }

    // Not authenticated
    req.user = null;
    next();
  } catch (err) {
    console.error("[Auth Middleware] Error:", err);
    req.user = null;
    next();
  }
}

// Require auth helper
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Please sign in to proceed.",
    });
  }
  next();
}

// Require specific role helper
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Please sign in to proceed.",
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "forbidden",
        message: `This action requires one of the following roles: ${roles.join(", ")}.`,
      });
    }
    next();
  };
}

// Apply authentication middleware to all incoming requests
app.use(authenticate);

// ==========================================
// 1. HEALTH CHECK & ROOT
// ==========================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "MentorLagbe Backend Server is running smoothly",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// GET /api/platform/stats — Platform counters
app.get("/api/platform/stats", async (req, res) => {
  try {
    const database = await connectDB();
    const col = database.collection("tuitions");
    const filter = { approvalStatus: "approved", isActive: true };
    const [tuitions, subjects, tutors, online] = await Promise.all([
      col.countDocuments(filter),
      col.distinct("subject", filter),
      col.distinct("tutorEmail", filter),
      col.countDocuments({ ...filter, mode: "Online" }),
    ]);
    res.json({
      tuitions,
      subjects: subjects.length,
      tutors: tutors.length,
      online,
    });
  } catch (err) {
    console.error("[GET /api/platform/stats] Error:", err);
    res.status(500).json({ error: "Failed to fetch platform stats" });
  }
});

// GET /api/platform/filters — Distinct subjects & class levels
app.get("/api/platform/filters", async (req, res) => {
  try {
    const database = await connectDB();
    const col = database.collection("tuitions");
    const filter = { approvalStatus: "approved", isActive: true };
    const [subjects, classLevels] = await Promise.all([
      col.distinct("subject", filter),
      col.distinct("classLevel", filter),
    ]);
    res.json({
      subjects: subjects.map(String).sort(),
      classLevels: classLevels.map(String).sort(),
    });
  } catch (err) {
    console.error("[GET /api/platform/filters] Error:", err);
    res.status(500).json({ error: "Failed to fetch filter options" });
  }
});

// ==========================================
// 2. TUITIONS ENDPOINTS
// ==========================================

// GET /api/tuitions — Browse tuitions with search & filters
app.get("/api/tuitions", async (req, res) => {
  try {
    const database = await connectDB();
    const {
      search,
      subject,
      classLevel,
      mode,
      tutorEmail,
      all,
      limit,
    } = req.query;

    const query = {};

    // Only admins or the tutor themselves requesting can see unapproved/inactive
    if (all === "true" && req.user?.role === "admin") {
      // Return all listings
    } else if (tutorEmail) {
      query.tutorEmail = String(tutorEmail);
    } else {
      query.approvalStatus = "approved";
      query.isActive = true;
    }

    if (subject && subject !== "All") {
      query.subject = { $regex: new RegExp(`^${subject}$`, "i") };
    }
    if (classLevel && classLevel !== "All") {
      query.classLevel = { $regex: new RegExp(`^${classLevel}$`, "i") };
    }
    if (mode && mode !== "All") {
      query.mode = { $regex: new RegExp(`^${mode}$`, "i") };
    }
    if (search) {
      const s = String(search).trim();
      query.$or = [
        { title: { $regex: s, $options: "i" } },
        { subject: { $regex: s, $options: "i" } },
        { location: { $regex: s, $options: "i" } },
      ];
    }

    let cursor = database.collection("tuitions").find(query).sort({ createdAt: -1 });
    if (limit && Number(limit) > 0) {
      cursor = cursor.limit(Number(limit));
    }

    const docs = await cursor.toArray();
    const tuitions = docs.map((doc) => ({
      id: String(doc._id),
      _id: String(doc._id),
      title: doc.title || "",
      subject: doc.subject || "",
      classLevel: doc.classLevel || "",
      mode: doc.mode || "Online",
      location: doc.location || "",
      monthlyFee: Number(doc.monthlyFee || 0),
      daysPerWeek: Number(doc.daysPerWeek || 3),
      bannerImage: doc.bannerImage || "",
      description: doc.description || "",
      tutorName: doc.tutorName || "",
      tutorEmail: doc.tutorEmail || "",
      tutorAvatar: doc.tutorAvatar || "",
      approvalStatus: doc.approvalStatus || "pending",
      isActive: Boolean(doc.isActive),
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    }));

    res.json(tuitions);
  } catch (err) {
    console.error("[GET /api/tuitions] Error:", err);
    res.status(500).json({ error: "Failed to fetch tuitions" });
  }
});

// GET /api/tuitions/:id — Single tuition post
app.get("/api/tuitions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid tuition ID" });
    }

    const database = await connectDB();
    const doc = await database.collection("tuitions").findOne({ _id: new ObjectId(id) });
    if (!doc) {
      return res.status(404).json({ error: "Tuition not found" });
    }

    res.json({
      id: String(doc._id),
      _id: String(doc._id),
      title: doc.title || "",
      subject: doc.subject || "",
      classLevel: doc.classLevel || "",
      mode: doc.mode || "Online",
      location: doc.location || "",
      monthlyFee: Number(doc.monthlyFee || 0),
      daysPerWeek: Number(doc.daysPerWeek || 3),
      bannerImage: doc.bannerImage || "",
      description: doc.description || "",
      tutorName: doc.tutorName || "",
      tutorEmail: doc.tutorEmail || "",
      tutorAvatar: doc.tutorAvatar || "",
      approvalStatus: doc.approvalStatus || "pending",
      isActive: Boolean(doc.isActive),
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    });
  } catch (err) {
    console.error("[GET /api/tuitions/:id] Error:", err);
    res.status(500).json({ error: "Failed to fetch tuition details" });
  }
});

// POST /api/tuitions — Create a tuition post (Tutor role, quota check)
app.post("/api/tuitions", requireRole("tutor"), async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    const title = String(body.title ?? "").trim().slice(0, 140);
    const subject = String(body.subject ?? "").trim().slice(0, 80);
    const classLevel = String(body.classLevel ?? "").trim().slice(0, 80);
    const mode = body.mode === "Offline" ? "Offline" : "Online";
    const location = String(body.location ?? "").trim().slice(0, 120);
    const description = String(body.description ?? "").trim().slice(0, 2000);
    const monthlyFee = Math.max(0, Math.round(Number(body.monthlyFee) || 0));
    const daysPerWeek = Math.min(7, Math.max(1, Math.round(Number(body.daysPerWeek) || 3)));

    if (!title || !subject || !classLevel || description.length < 20) {
      return res.status(400).json({
        error: "invalid-input",
        message:
          "Please provide a title, subject, class level and description (at least 20 characters).",
      });
    }

    const database = await connectDB();

    // Check Plan quota: Free tutors can post at most 2 tuitions
    const userDoc = await database.collection("users").findOne({ email: user.email });
    const plan = String(userDoc?.plan || user.plan || "free");

    if (plan !== "pro") {
      const used = await database.collection("tuitions").countDocuments({
        tutorEmail: user.email,
        approvalStatus: { $ne: "rejected" },
      });
      if (used >= 2) {
        return res.status(403).json({
          error: "post-limit",
          message:
            "Free tutors can post up to 2 tuitions. Upgrade to Pro Tutor for unlimited posts.",
        });
      }
    }

    const newTuition = {
      title,
      subject,
      classLevel,
      mode,
      location: location || (mode === "Online" ? "Online" : ""),
      monthlyFee,
      daysPerWeek,
      bannerImage: String(body.bannerImage ?? ""),
      description,
      tutorName: String(user.name || body.tutorName || ""),
      tutorEmail: String(user.email || ""),
      tutorAvatar: String(body.tutorAvatar || user.image || ""),
      approvalStatus: "pending",
      isActive: true,
      createdAt: new Date(),
    };

    const result = await database.collection("tuitions").insertOne(newTuition);
    res.json({ ok: true, id: String(result.insertedId) });
  } catch (err) {
    console.error("[POST /api/tuitions] Error:", err);
    res.status(500).json({ error: "Failed to create tuition listing" });
  }
});

// PATCH /api/tuitions/:id — Edit details or toggle active status (Tutor role)
app.patch("/api/tuitions/:id", requireRole("tutor", "admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid tuition ID" });
    }

    const database = await connectDB();
    const tuitions = database.collection("tuitions");
    const tuition = await tuitions.findOne({ _id: new ObjectId(id) });

    if (!tuition) {
      return res.status(404).json({ error: "Tuition post not found" });
    }

    // Ownership check (unless admin)
    if (req.user.role !== "admin" && String(tuition.tutorEmail) !== String(req.user.email)) {
      return res.status(403).json({ error: "You can only manage your own tuition posts" });
    }

    const body = req.body || {};

    // Toggle active / closed status
    if (body.action === "toggle-active") {
      if (String(tuition.approvalStatus) !== "approved") {
        return res.status(409).json({
          error: "not-approved",
          message: "Only approved listings can be opened or closed.",
        });
      }
      const nextActive = !Boolean(tuition.isActive);
      await tuitions.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isActive: nextActive, updatedAt: new Date() } }
      );
      return res.json({ ok: true, isActive: nextActive });
    }

    // Edit details
    const title = String(body.title ?? "").trim().slice(0, 140);
    const subject = String(body.subject ?? "").trim().slice(0, 80);
    const classLevel = String(body.classLevel ?? "").trim().slice(0, 80);
    const mode = body.mode === "Offline" ? "Offline" : "Online";
    const location = String(body.location ?? "").trim().slice(0, 120);
    const description = String(body.description ?? "").trim().slice(0, 2000);
    const monthlyFee = Math.max(0, Math.round(Number(body.monthlyFee) || 0));
    const daysPerWeek = Math.min(7, Math.max(1, Math.round(Number(body.daysPerWeek) || 3)));

    if (!title || !subject || !classLevel || description.length < 20) {
      return res.status(400).json({
        error: "invalid-input",
        message: "Please fill in title, subject, class level, and description.",
      });
    }

    await tuitions.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          title,
          subject,
          classLevel,
          mode,
          location: location || (mode === "Online" ? "Online" : ""),
          monthlyFee,
          daysPerWeek,
          description,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /api/tuitions/:id] Error:", err);
    res.status(500).json({ error: "Failed to update tuition post" });
  }
});

// DELETE /api/tuitions/:id — Delete tuition & its applications
app.delete("/api/tuitions/:id", requireRole("tutor", "admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid tuition ID" });
    }

    const database = await connectDB();
    const tuitions = database.collection("tuitions");
    const tuition = await tuitions.findOne({ _id: new ObjectId(id) });

    if (!tuition) {
      return res.status(404).json({ error: "Tuition post not found" });
    }

    if (req.user.role !== "admin" && String(tuition.tutorEmail) !== String(req.user.email)) {
      return res.status(403).json({ error: "You can only delete your own tuition posts" });
    }

    await tuitions.deleteOne({ _id: new ObjectId(id) });
    await database.collection("applications").deleteMany({ tuitionId: id });

    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/tuitions/:id] Error:", err);
    res.status(500).json({ error: "Failed to delete tuition post" });
  }
});

// ==========================================
// 3. APPLICATIONS ENDPOINTS
// ==========================================

// GET /api/applications — Fetch applications by studentEmail or tutorEmail
app.get("/api/applications", requireAuth, async (req, res) => {
  try {
    const database = await connectDB();
    const { studentEmail, tutorEmail, tuitionId } = req.query;

    const query = {};
    if (studentEmail) query.studentEmail = String(studentEmail);
    if (tutorEmail) query.tutorEmail = String(tutorEmail);
    if (tuitionId) query.tuitionId = String(tuitionId);

    // Enforce role restrictions if query not provided
    if (req.user.role === "student" && !studentEmail) {
      query.studentEmail = req.user.email;
    } else if (req.user.role === "tutor" && !tutorEmail) {
      query.tutorEmail = req.user.email;
    }

    const docs = await database
      .collection("applications")
      .find(query)
      .sort({ appliedAt: -1 })
      .toArray();

    const formatted = docs.map((doc) => ({
      id: String(doc._id),
      _id: String(doc._id),
      tuitionId: String(doc.tuitionId || ""),
      tuitionTitle: doc.tuitionTitle || "",
      subject: doc.subject || "",
      monthlyFee: Number(doc.monthlyFee || 0),
      tutorName: doc.tutorName || "",
      tutorEmail: doc.tutorEmail || "",
      studentId: String(doc.studentId || ""),
      studentName: doc.studentName || "",
      studentEmail: doc.studentEmail || "",
      studentPhone: doc.studentPhone || "",
      preferredSchedule: doc.preferredSchedule || "",
      studentNote: doc.studentNote || "",
      status: doc.status || "pending",
      appliedAt: doc.appliedAt ? new Date(doc.appliedAt).toISOString() : new Date().toISOString(),
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /api/applications] Error:", err);
    res.status(500).json({ error: "Failed to fetch applications" });
  }
});

// POST /api/applications — Apply for a tuition (Student role only)
app.post("/api/applications", requireRole("student"), async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    const tuitionId = String(body.tuitionId ?? "");
    const name = String(body.name ?? user.name ?? "").trim();
    const phone = String(body.phone ?? "").trim().slice(0, 30);
    const schedule = String(body.preferredSchedule ?? "").trim().slice(0, 120);
    const note = String(body.studentNote ?? body.message ?? "").trim();

    if (!ObjectId.isValid(tuitionId)) {
      return res.status(400).json({ error: "invalid-tuition", message: "Invalid tuition listing." });
    }
    if (!schedule) {
      return res.status(400).json({
        error: "invalid-schedule",
        message: "Please tell the tutor your preferred schedule.",
      });
    }
    if (note.length < 10) {
      return res.status(400).json({
        error: "invalid-message",
        message: "Please write at least 10 characters explaining your interest.",
      });
    }

    const database = await connectDB();
    const tuition = await database.collection("tuitions").findOne({
      _id: new ObjectId(tuitionId),
      approvalStatus: "approved",
      isActive: true,
    });

    if (!tuition) {
      return res.status(404).json({
        error: "not-found",
        message: "This tuition listing is no longer available.",
      });
    }

    const applications = database.collection("applications");
    const existing = await applications.findOne({
      tuitionId,
      studentEmail: user.email,
    });

    if (existing) {
      return res.status(409).json({
        error: "already-applied",
        message: "You already applied for this tuition.",
      });
    }

    const applicationDoc = {
      tuitionId,
      tuitionTitle: String(tuition.title ?? ""),
      subject: String(tuition.subject ?? ""),
      monthlyFee: Number(tuition.monthlyFee ?? 0),
      tutorName: String(tuition.tutorName ?? ""),
      tutorEmail: String(tuition.tutorEmail ?? ""),
      studentId: user.id,
      studentName: name || String(user.name ?? ""),
      studentEmail: String(user.email ?? ""),
      studentPhone: phone,
      preferredSchedule: schedule,
      studentNote: note,
      status: "pending",
      appliedAt: new Date(),
    };

    await applications.insertOne(applicationDoc);
    res.json({ ok: true, message: "Application submitted successfully" });
  } catch (err) {
    console.error("[POST /api/applications] Error:", err);
    res.status(500).json({ error: "Failed to submit application" });
  }
});

// PATCH /api/applications — Tutor accepts / rejects an application
app.patch("/api/applications", requireRole("tutor"), async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    const id = String(body.id ?? "");
    const action = body.action === "reject" ? "reject" : "accept";

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid application ID" });
    }

    const database = await connectDB();
    const application = await database.collection("applications").findOne({ _id: new ObjectId(id) });

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    // Ensure the application belongs to this tutor's post
    if (String(application.tutorEmail) !== String(user.email)) {
      return res.status(403).json({ error: "This application belongs to another tutor." });
    }

    const nextStatus = action === "accept" ? "accepted" : "rejected";
    await database.collection("applications").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: nextStatus, reviewedAt: new Date() } }
    );

    res.json({ ok: true, action, status: nextStatus });
  } catch (err) {
    console.error("[PATCH /api/applications] Error:", err);
    res.status(500).json({ error: "Failed to update application" });
  }
});

// DELETE /api/applications — Student cancels pending application
app.delete("/api/applications", requireRole("student"), async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    const id = String(body.id ?? "");

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid application ID" });
    }

    const database = await connectDB();
    const applications = database.collection("applications");
    const appDoc = await applications.findOne({ _id: new ObjectId(id) });

    if (!appDoc || String(appDoc.studentEmail) !== String(user.email)) {
      return res.status(404).json({ error: "Application not found" });
    }
    if (String(appDoc.status) !== "pending") {
      return res.status(409).json({
        error: "not-cancellable",
        message: "Only pending applications can be cancelled.",
      });
    }

    await applications.deleteOne({ _id: new ObjectId(id) });
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/applications] Error:", err);
    res.status(500).json({ error: "Failed to cancel application" });
  }
});

// ==========================================
// 4. ADMIN ENDPOINTS
// ==========================================

// GET /api/admin/users — List registered users
app.get("/api/admin/users", requireRole("admin"), async (req, res) => {
  try {
    const database = await connectDB();
    const users = await database
      .collection("users")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const sanitized = users.map((u) => ({
      id: String(u._id),
      _id: String(u._id),
      name: u.name || "",
      email: u.email || "",
      role: u.role || "student",
      plan: u.plan || "free",
      phone: u.phone || "",
      bio: u.bio || "",
      image: u.image || null,
      createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : new Date().toISOString(),
    }));

    res.json(sanitized);
  } catch (err) {
    console.error("[GET /api/admin/users] Error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/admin/users — Change user role
app.post("/api/admin/users", requireRole("admin"), async (req, res) => {
  try {
    const { id, role } = req.body || {};
    const validRoles = ["student", "tutor", "admin"];

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "Role must be student, tutor, or admin" });
    }
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ error: "You cannot change your own role" });
    }

    const database = await connectDB();
    const result = await database.collection("users").updateOne(
      { _id: new ObjectId(id) },
      { $set: { role, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ ok: true, role });
  } catch (err) {
    console.error("[POST /api/admin/users] Error:", err);
    res.status(500).json({ error: "Failed to change user role" });
  }
});

// GET /api/admin/tuitions — List all tuition posts for approval review
app.get("/api/admin/tuitions", requireRole("admin"), async (req, res) => {
  try {
    const database = await connectDB();
    const tuitions = await database
      .collection("tuitions")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const formatted = tuitions.map((t) => ({
      id: String(t._id),
      _id: String(t._id),
      title: t.title || "",
      subject: t.subject || "",
      classLevel: t.classLevel || "",
      mode: t.mode || "Online",
      location: t.location || "",
      monthlyFee: Number(t.monthlyFee || 0),
      daysPerWeek: Number(t.daysPerWeek || 3),
      tutorName: t.tutorName || "",
      tutorEmail: t.tutorEmail || "",
      approvalStatus: t.approvalStatus || "pending",
      isActive: Boolean(t.isActive),
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /api/admin/tuitions] Error:", err);
    res.status(500).json({ error: "Failed to fetch tuitions" });
  }
});

// POST /api/admin/tuitions — Approve / Reject a tuition listing
app.post("/api/admin/tuitions", requireRole("admin"), async (req, res) => {
  try {
    const { id, action } = req.body || {};
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid tuition ID" });
    }

    const database = await connectDB();
    const update =
      action === "approve"
        ? { approvalStatus: "approved", isActive: true, updatedAt: new Date() }
        : { approvalStatus: "rejected", isActive: false, updatedAt: new Date() };

    const result = await database
      .collection("tuitions")
      .updateOne({ _id: new ObjectId(id) }, { $set: update });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Tuition listing not found" });
    }

    res.json({ ok: true, action });
  } catch (err) {
    console.error("[POST /api/admin/tuitions] Error:", err);
    res.status(500).json({ error: "Failed to update tuition listing" });
  }
});

// GET /api/admin/transactions — Stripe transaction records
app.get("/api/admin/transactions", requireRole("admin"), async (req, res) => {
  try {
    const database = await connectDB();
    const payments = await database
      .collection("payments")
      .find({})
      .sort({ paidAt: -1 })
      .toArray();

    const formatted = payments.map((p) => ({
      id: String(p._id),
      _id: String(p._id),
      userName: p.userName || "Subscriber",
      userEmail: p.userEmail || "",
      userRole: p.userRole || "student",
      planName: p.planName || "Pro Plan",
      amount: Number(p.amount || 0),
      currency: p.currency || "usd",
      transactionId: p.transactionId || String(p._id),
      paymentStatus: p.paymentStatus || "paid",
      paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : new Date().toISOString(),
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /api/admin/transactions] Error:", err);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// GET /api/admin/stats — Admin overview dashboard stats
app.get("/api/admin/stats", requireRole("admin"), async (req, res) => {
  try {
    const database = await connectDB();
    const [totalUsers, totalTutors, totalStudents, pendingTuitions, approvedTuitions, payments] =
      await Promise.all([
        database.collection("users").countDocuments(),
        database.collection("users").countDocuments({ role: "tutor" }),
        database.collection("users").countDocuments({ role: "student" }),
        database.collection("tuitions").countDocuments({ approvalStatus: "pending" }),
        database.collection("tuitions").countDocuments({ approvalStatus: "approved" }),
        database.collection("payments").find({ paymentStatus: "paid" }).toArray(),
      ]);

    const totalRevenueCents = payments.reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0);
    const totalRevenue = Math.round(totalRevenueCents / 100);

    res.json({
      totalUsers,
      totalTutors,
      totalStudents,
      pendingTuitions,
      approvedTuitions,
      totalRevenue,
    });
  } catch (err) {
    console.error("[GET /api/admin/stats] Error:", err);
    res.status(500).json({ error: "Failed to fetch admin statistics" });
  }
});

// ==========================================
// 5. STUDENT & TUTOR STATS
// ==========================================

// GET /api/stats/student
app.get("/api/stats/student", requireRole("student"), async (req, res) => {
  try {
    const email = req.user.email;
    const database = await connectDB();

    const [totalApplied, accepted, pending, userDoc] = await Promise.all([
      database.collection("applications").countDocuments({ studentEmail: email }),
      database.collection("applications").countDocuments({ studentEmail: email, status: "accepted" }),
      database.collection("applications").countDocuments({ studentEmail: email, status: "pending" }),
      database.collection("users").findOne({ email }),
    ]);

    res.json({
      totalApplied,
      accepted,
      pending,
      plan: userDoc?.plan || req.user.plan || "free",
    });
  } catch (err) {
    console.error("[GET /api/stats/student] Error:", err);
    res.status(500).json({ error: "Failed to fetch student stats" });
  }
});

// GET /api/stats/tutor
app.get("/api/stats/tutor", requireRole("tutor"), async (req, res) => {
  try {
    const email = req.user.email;
    const database = await connectDB();

    const [totalPosted, activeApproved, applicants, userDoc] = await Promise.all([
      database.collection("tuitions").countDocuments({ tutorEmail: email }),
      database.collection("tuitions").countDocuments({ tutorEmail: email, approvalStatus: "approved", isActive: true }),
      database.collection("applications").countDocuments({ tutorEmail: email }),
      database.collection("users").findOne({ email }),
    ]);

    res.json({
      totalPosted,
      activeApproved,
      applicants,
      plan: userDoc?.plan || req.user.plan || "free",
    });
  } catch (err) {
    console.error("[GET /api/stats/tutor] Error:", err);
    res.status(500).json({ error: "Failed to fetch tutor stats" });
  }
});

// ==========================================
// 6. STRIPE CHECKOUT & PAYMENT VERIFY
// ==========================================

// POST /api/checkout — Create Stripe checkout session
app.post("/api/checkout", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        error: "stripe-not-configured",
        message: "Stripe payments aren't configured yet.",
      });
    }

    const { plan: planParam } = req.body || {};
    const planKey = planParam === "tutor" ? "tutor" : "student";
    const plan = PRO_PLANS[planKey];

    const origin =
      req.headers.origin ||
      process.env.CLIENT_URL ||
      "http://localhost:3000";

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: req.user.email,
        client_reference_id: planKey,
        line_items: plan.priceId
          ? [{ price: plan.priceId, quantity: 1 }]
          : [
              {
                quantity: 1,
                price_data: {
                  currency: plan.currency,
                  unit_amount: plan.amount,
                  product_data: {
                    name: `MentorLagbe ${plan.name}`,
                    description: `MentorLagbe ${planKey.toUpperCase()} Pro upgrade`,
                  },
                },
              },
            ],
        success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/payment/cancel`,
        metadata: {
          plan: planKey,
          userEmail: req.user.email,
          userId: req.user.id,
        },
      });
    } catch (createErr) {
      // Fallback to dynamic price data if priceId failed
      console.warn("[Stripe Checkout] Fallback to dynamic price data:", createErr.message);
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: req.user.email,
        client_reference_id: planKey,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: plan.currency,
              unit_amount: plan.amount,
              product_data: {
                name: `MentorLagbe ${plan.name}`,
                description: `MentorLagbe ${planKey.toUpperCase()} Pro upgrade`,
              },
            },
          },
        ],
        success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/payment/cancel`,
        metadata: {
          plan: planKey,
          userEmail: req.user.email,
          userId: req.user.id,
        },
      });
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error("[POST /api/checkout] Error:", err);
    res.status(502).json({ error: "checkout-failed", message: err.message });
  }
});

// POST /api/checkout/verify — Confirm payment after redirect
app.post("/api/checkout/verify", requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId || !sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "invalid-session", message: "Missing checkout session id." });
    }

    if (!stripe) {
      return res.status(503).json({ error: "stripe-not-configured", message: "Stripe not configured." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.json({
        ok: false,
        status: session.payment_status,
        message: "This payment has not completed yet.",
      });
    }

    const planKey =
      session.client_reference_id === "tutor" ||
      session.metadata?.plan === "tutor"
        ? "tutor"
        : "student";
    const plan = PRO_PLANS[planKey];

    const database = await connectDB();
    const existing = await database
      .collection("payments")
      .findOne({ stripeSessionId: sessionId });

    if (!existing) {
      await database.collection("payments").insertOne({
        userId: String(req.user.id || ""),
        userEmail: String(req.user.email || ""),
        userName: String(req.user.name || ""),
        userRole: String(req.user.role || "student"),
        planName: plan.name,
        amount: Number(session.amount_total ?? plan.amount),
        currency: String(session.currency ?? plan.currency),
        transactionId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : sessionId,
        stripeSessionId: sessionId,
        paymentStatus: "paid",
        paidAt: new Date(),
      });
    }

    await database.collection("users").updateOne(
      { email: req.user.email },
      { $set: { plan: "pro", planUpgradedAt: new Date() } }
    );

    res.json({ ok: true, plan: planKey });
  } catch (err) {
    console.error("[POST /api/checkout/verify] Error:", err);
    res.status(502).json({ error: "verify-failed", message: err.message });
  }
});

// ==========================================
// 7. QUICK ACCESS & PROFILE
// ==========================================

const QUICK_ACCOUNTS = {
  admin: {
    email: "admin@mentorlagbe.com",
    name: "MentorLagbe Admin",
    role: "admin",
    plan: "pro",
  },
  tutor: {
    email: "tutor@mentorlagbe.com",
    name: "MentorLagbe Tutor",
    role: "tutor",
    plan: "free",
  },
  student: {
    email: "student@mentorlagbe.com",
    name: "MentorLagbe Student",
    role: "student",
    plan: "free",
  },
};

// POST /api/auth/quick-login — Prepares quick login user
app.post("/api/auth/quick-login", async (req, res) => {
  try {
    const { role = "student" } = req.body || {};
    const key = String(role).toLowerCase();
    const config = QUICK_ACCOUNTS[key] || QUICK_ACCOUNTS.student;

    const database = await connectDB();
    await database.collection("users").updateOne(
      { email: config.email },
      {
        $set: {
          role: config.role,
          plan: config.plan,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          name: config.name,
          email: config.email,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ ok: true, email: config.email, role: config.role });
  } catch (err) {
    console.error("[POST /api/auth/quick-login] Error:", err);
    res.status(500).json({ error: "Failed to prepare quick login" });
  }
});

// PATCH /api/users/profile — Update current user's profile
app.patch("/api/users/profile", requireAuth, async (req, res) => {
  try {
    const { name, phone, bio, image } = req.body || {};
    const update = { updatedAt: new Date() };

    if (name !== undefined) update.name = String(name).trim();
    if (phone !== undefined) update.phone = String(phone).trim();
    if (bio !== undefined) update.bio = String(bio).trim();
    if (image !== undefined) update.image = String(image).trim();

    const database = await connectDB();
    await database.collection("users").updateOne(
      { email: req.user.email },
      { $set: update }
    );

    res.json({ ok: true, message: "Profile updated successfully" });
  } catch (err) {
    console.error("[PATCH /api/users/profile] Error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// POST /api/upload/imgbb — ImgBB image upload proxy
app.post("/api/upload/imgbb", async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ error: "No image data provided" });
    }

    const apiKey =
      process.env.IMGBB_API_KEY || "87f61c390a3ea8cb6a2b85e0534be01c";

    let imageUrl = null;
    try {
      const formData = new FormData();
      formData.append("image", image);

      const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && (data?.data?.display_url || data?.data?.url)) {
        imageUrl = data.data.display_url || data.data.url;
      }
    } catch (e) {
      console.warn("[ImgBB upload] error:", e.message);
    }

    if (imageUrl) {
      return res.json({ url: imageUrl, source: "imgbb" });
    }

    return res.json({ url: image, source: "direct" });
  } catch (err) {
    console.error("[POST /api/upload/imgbb] Error:", err);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 MentorLagbe Express Server is running!`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Base URL: http://localhost:${PORT}`);
  console.log(`===============================================`);
});

export default app;
