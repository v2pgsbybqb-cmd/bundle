require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const submissionsFile = path.join(__dirname, "data", "customer-submissions.json");
const adminStaticDir = path.join(__dirname, "public");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-admin";
const MAX_SUBMISSIONS_LOGS = Number(process.env.MAX_SUBMISSIONS_LOGS || 50000);
const CUSTOMER_CODE_VALIDITY_MINUTES = Number(process.env.CUSTOMER_CODE_VALIDITY_MINUTES || 30);
const usePostgres = Boolean(process.env.DATABASE_URL);
const requireDatabaseInProduction = String(process.env.REQUIRE_DATABASE_IN_PRODUCTION || "true") === "true";

const pool = usePostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

app.set("trust proxy", 1);

if (!process.env.ADMIN_PASSWORD) {
  console.warn("ADMIN_PASSWORD is not set. Using insecure default password: change-me-admin");
}

if (process.env.NODE_ENV === "production" && requireDatabaseInProduction && !usePostgres) {
  console.error("DATABASE_URL is required in production. Refusing to start with ephemeral JSON storage.");
  process.exit(1);
}

/* Security */
app.use(helmet());
app.use(express.json({
  limit: "10kb",
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith("/webhook")) {
      req.rawBody = buf.toString("utf8");
    }
  }
}));

/* Serve admin panel (static files, not affected by CORS) */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(adminStaticDir, "admin.html"));
});

app.get("/admin/", (req, res) => {
  res.sendFile(path.join(adminStaticDir, "admin.html"));
});

app.use("/admin", express.static(adminStaticDir, { index: "admin.html" }));

/* CORS */
app.use(
  cors({
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["Content-Type", "x-admin-password"]
  })
);

/* Rate limit */
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20
});

/* Helpers */
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");

  if (/^255[67]\d{8}$/.test(digits)) {
    return `0${digits.slice(3)}`;
  }

  if (/^[67]\d{8}$/.test(digits)) {
    return `0${digits}`;
  }

  return digits;
}

function isValidTanzanianPhone(phone) {
  return /^0[67]\d{8}$/.test(normalizePhone(phone));
}

function hasUsablePhone(phone) {
  const local = normalizePhone(phone);
  return /^0\d{9}$/.test(local);
}

function isValidCustomerCode(code) {
  return /^\d{4}$/.test(String(code || "").trim());
}

function normalizeCustomerCode(code) {
  return String(code || "").trim();
}

function toInternational(phone) {
  const local = normalizePhone(phone);
  return local.startsWith("0") ? `255${local.slice(1)}` : local;
}

function detectChannel(phone) {
  const local = normalizePhone(phone);

  if (local.startsWith("068") || local.startsWith("069") || local.startsWith("078")) {
    return "AIRTEL-MONEY";
  }

  if (local.startsWith("065") || local.startsWith("067") || local.startsWith("071") || local.startsWith("077")) {
    return "TIGO-PESA";
  }

  if (local.startsWith("074") || local.startsWith("075") || local.startsWith("076")) {
    return "M-PESA";
  }

  if (local.startsWith("061") || local.startsWith("062") || local.startsWith("063")) {
    return "HALOPESA";
  }

  return null;
}

function makeTxRef() {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  const time = Date.now().toString().slice(-10);
  return `UVP${time}${random}`.slice(0, 20);
}

function mapDbSubmission(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    phone: row.phone,
    customerCode: row.customer_code,
    allocated: row.allocated,
    allocatedAt: row.allocated_at,
    allocationNote: row.allocation_note,
    codeConsumedAt: row.code_consumed_at,
    paymentOrderId: row.payment_order_id,
    paymentCompletedAt: row.payment_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function initPostgres() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_submissions (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      customer_code TEXT NOT NULL,
      allocated BOOLEAN NOT NULL DEFAULT FALSE,
      allocated_at TIMESTAMPTZ NULL,
      allocation_note TEXT NOT NULL DEFAULT '',
      code_consumed_at TIMESTAMPTZ NULL,
      payment_order_id TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query("ALTER TABLE customer_submissions ADD COLUMN IF NOT EXISTS code_consumed_at TIMESTAMPTZ NULL");
  await pool.query("ALTER TABLE customer_submissions ADD COLUMN IF NOT EXISTS payment_order_id TEXT NULL");
  await pool.query("ALTER TABLE customer_submissions ADD COLUMN IF NOT EXISTS payment_completed_at TIMESTAMPTZ NULL");

  await pool.query("CREATE INDEX IF NOT EXISTS idx_customer_submissions_phone ON customer_submissions(phone)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_customer_submissions_updated_at ON customer_submissions(updated_at DESC)");
}

async function prunePostgresSubmissions() {
  if (!MAX_SUBMISSIONS_LOGS || MAX_SUBMISSIONS_LOGS < 1) {
    return;
  }

  await pool.query(
    `
      DELETE FROM customer_submissions
      WHERE id IN (
        SELECT id
        FROM customer_submissions
        ORDER BY updated_at DESC
        OFFSET $1
      )
    `,
    [MAX_SUBMISSIONS_LOGS]
  );
}

async function ensureSubmissionsFile() {
  try {
    // Ensure data directory exists
    await fs.mkdir(path.dirname(submissionsFile), { recursive: true });
    // Check if file exists
    await fs.access(submissionsFile);
  } catch {
    // Create file if it doesn't exist
    await fs.mkdir(path.dirname(submissionsFile), { recursive: true });
    await fs.writeFile(submissionsFile, "[]\n", "utf8");
  }
}

async function readSubmissions() {
  if (usePostgres) {
    const { rows } = await pool.query(
      `
        SELECT id, phone, customer_code, allocated, allocated_at, allocation_note, created_at, updated_at
        FROM customer_submissions
        ORDER BY updated_at DESC
      `
    );

    return rows.map(mapDbSubmission);
  }

  await ensureSubmissionsFile();
  const raw = await fs.readFile(submissionsFile, "utf8");

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeSubmissions(submissions) {
  if (usePostgres) {
    throw new Error("writeSubmissions is not used with PostgreSQL storage");
  }

  await fs.writeFile(submissionsFile, `${JSON.stringify(submissions, null, 2)}\n`, "utf8");
}

function sortSubmissions(submissions) {
  return [...submissions].sort((left, right) => {
    return new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime();
  });
}

function getLatestSubmissionForPhone(submissions, phone) {
  const normalizedPhone = normalizePhone(phone);
  const byPhone = submissions.filter((item) => normalizePhone(item.phone) === normalizedPhone);

  if (!byPhone.length) {
    return null;
  }

  return byPhone.sort((left, right) => {
    return new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime();
  })[0];
}

async function getLatestSubmissionForPhoneFromStorage(phone) {
  if (usePostgres) {
    const normalizedPhone = normalizePhone(phone);
    const { rows } = await pool.query(
      `
        SELECT id, phone, customer_code, allocated, allocated_at, allocation_note, code_consumed_at, payment_order_id, payment_completed_at, created_at, updated_at
        FROM customer_submissions
        WHERE phone = $1
          AND code_consumed_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [normalizedPhone]
    );

    return mapDbSubmission(rows[0]);
  }

  const submissions = await readSubmissions();
  const latest = getLatestSubmissionForPhone(submissions, phone);
  if (!latest) {
    return null;
  }

  return latest.codeConsumedAt ? null : latest;
}

async function createSubmissionInStorage(record) {
  if (usePostgres) {
    await pool.query(
      `
        INSERT INTO customer_submissions
          (id, phone, customer_code, allocated, allocated_at, allocation_note, code_consumed_at, payment_order_id, payment_completed_at, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        record.id,
        record.phone,
        record.customerCode,
        record.allocated,
        record.allocatedAt,
        record.allocationNote,
        record.codeConsumedAt,
        record.paymentOrderId,
        record.paymentCompletedAt,
        record.createdAt,
        record.updatedAt
      ]
    );

    await prunePostgresSubmissions();
    return record;
  }

  const submissions = await readSubmissions();
  submissions.push(record);

  if (submissions.length > MAX_SUBMISSIONS_LOGS) {
    submissions.splice(0, submissions.length - MAX_SUBMISSIONS_LOGS);
  }

  await writeSubmissions(submissions);
  return record;
}

async function updateSubmissionInStorage(id, allocated, allocationNote) {
  if (usePostgres) {
    const now = new Date().toISOString();
    const { rows } = await pool.query(
      `
        UPDATE customer_submissions
        SET allocated = $2,
            allocated_at = $3,
            allocation_note = $4,
            updated_at = $5
        WHERE id = $1
        RETURNING id, phone, customer_code, allocated, allocated_at, allocation_note, code_consumed_at, payment_order_id, payment_completed_at, created_at, updated_at
      `,
      [id, allocated, allocated ? now : null, String(allocationNote || "").trim(), now]
    );

    return mapDbSubmission(rows[0]);
  }

  const submissions = await readSubmissions();
  const index = submissions.findIndex((item) => item.id === id);

  if (index === -1) {
    return null;
  }

  const now = new Date().toISOString();
  const updated = {
    ...submissions[index],
    allocated,
    allocatedAt: allocated ? now : null,
    allocationNote: String(allocationNote || "").trim(),
    updatedAt: now
  };

  submissions[index] = updated;
  await writeSubmissions(submissions);
  return updated;
}

async function consumeSubmissionCodeInStorage(id, paymentOrderId) {
  if (usePostgres) {
    const now = new Date().toISOString();
    await pool.query(
      `
        UPDATE customer_submissions
        SET code_consumed_at = $2,
            payment_order_id = $3,
            updated_at = $2
        WHERE id = $1
          AND code_consumed_at IS NULL
      `,
      [id, now, paymentOrderId]
    );
    return;
  }

  const submissions = await readSubmissions();
  const index = submissions.findIndex((item) => item.id === id);

  if (index === -1) {
    return;
  }

  if (submissions[index].codeConsumedAt) {
    return;
  }

  const now = new Date().toISOString();
  submissions[index] = {
    ...submissions[index],
    codeConsumedAt: now,
    paymentOrderId,
    updatedAt: now
  };

  await writeSubmissions(submissions);
}

async function initStorage() {
  if (usePostgres) {
    await initPostgres();
    return;
  }

  await ensureSubmissionsFile();
}

function isSubmissionFresh(submission) {
  if (!submission) {
    return false;
  }

  const submittedAt = new Date(submission.updatedAt || submission.createdAt).getTime();
  if (!Number.isFinite(submittedAt)) {
    return false;
  }

  const maxAgeMs = CUSTOMER_CODE_VALIDITY_MINUTES * 60 * 1000;
  return Date.now() - submittedAt <= maxAgeMs;
}

function requireAdminAuth(req, res, next) {
  if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  next();
}

const SNIPPE_API_KEY = process.env.SNIPPE_API_KEY;
const SNIPPE_TIMEOUT_MS = Number(process.env.SNIPPE_TIMEOUT_MS || 15000);

const snippeApi = axios.create({
  baseURL: "https://api.snippe.sh/api/v1",
  timeout: SNIPPE_TIMEOUT_MS
});

if (!SNIPPE_API_KEY) {
  console.warn("Missing Snippe auth config. Set SNIPPE_API_KEY in your environment.");
}


app.post("/customer-codes", async (req, res) => {
  const { phone, customerCode } = req.body || {};

  if (!phone || typeof phone !== "string" || !hasUsablePhone(phone)) {
    return res.status(400).json({ success: false, error: "Phone number is required" });
  }

  if (!isValidCustomerCode(customerCode)) {
    return res.status(400).json({ success: false, error: "Customer code must be exactly 4 digits" });
  }

  const cleanPhone = normalizePhone(phone);
  const normalizedCode = normalizeCustomerCode(customerCode);
  const now = new Date().toISOString();

  try {
    const record = {
      id: `SUB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      phone: cleanPhone,
      customerCode: normalizedCode,
      allocated: false,
      allocatedAt: null,
      allocationNote: "",
      codeConsumedAt: null,
      paymentOrderId: null,
      paymentCompletedAt: null,
      createdAt: now,
      updatedAt: now
    };

    await createSubmissionInStorage(record);
    return res.json({ success: true, record });
  } catch (error) {
    console.error("Failed to store customer code:", error.message);
    return res.status(500).json({ success: false, error: "Could not save customer code" });
  }
});

app.get("/debug-db", async (req, res) => {
  try {
    if (!usePostgres) return res.json({ error: "Not using Postgres" });
    const { rows } = await pool.query("SELECT id, phone, customer_code, payment_order_id, payment_completed_at, created_at, updated_at FROM customer_submissions ORDER BY updated_at DESC LIMIT 5");
    return res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/submissions", requireAdminAuth, async (req, res) => {
  try {
    const submissions = await readSubmissions();
    return res.json({ success: true, submissions: sortSubmissions(submissions) });
  } catch (error) {
    console.error("Failed to read submissions:", error.message);
    return res.status(500).json({ success: false, error: "Could not load submissions" });
  }
});

app.patch("/admin/api/submissions/:id", requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const { allocated, allocationNote } = req.body || {};

  if (typeof allocated !== "boolean") {
    return res.status(400).json({ success: false, error: "Allocated must be true or false" });
  }

  if (allocationNote !== undefined && typeof allocationNote !== "string") {
    return res.status(400).json({ success: false, error: "Allocation note must be text" });
  }

  try {
    const updated = await updateSubmissionInStorage(id, allocated, allocationNote);

    if (!updated) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }

    return res.json({ success: true, record: updated });
  } catch (error) {
    console.error("Failed to update submission:", error.message);
    return res.status(500).json({ success: false, error: "Could not update submission" });
  }
});

/* Create payment */
app.post("/create-payment", paymentLimiter, async (req, res) => {
  const { phone, amount } = req.body;
  const requestStartedAt = Date.now();

  if (!SNIPPE_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "Server payment configuration is incomplete."
    });
  }

  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ success: false, error: "Phone required" });
  }

  const cleanPhone = normalizePhone(phone);

  if (!hasUsablePhone(cleanPhone)) {
    return res.status(400).json({ success: false, error: "Invalid phone" });
  }

  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount < 100) {
    return res.status(400).json({ success: false, error: "Invalid amount" });
  }

  let latestSubmission;
  try {
    latestSubmission = await getLatestSubmissionForPhoneFromStorage(cleanPhone);
  } catch (error) {
    console.error("Failed to read submissions before payment:", error.message);
    return res.status(500).json({ success: false, error: "Could not validate customer code" });
  }

  if (!latestSubmission || !isValidCustomerCode(latestSubmission.customerCode)) {
    return res.status(400).json({ success: false, error: "Enter customer code first" });
  }

  if (!isSubmissionFresh(latestSubmission)) {
    return res.status(400).json({
      success: false,
      error: `Customer code expired. Enter a new 4-digit code (valid for ${CUSTOMER_CODE_VALIDITY_MINUTES} minutes).`
    });
  }

  const orderId = makeTxRef();

  const payload = {
    payment_type: "mobile",
    details: {
      amount: parsedAmount,
      currency: "TZS"
    },
    phone_number: cleanPhone,
    customer: {
      firstname: cleanPhone,
      lastname: "–",
      email: `${cleanPhone}@bundletz.com`,
      phone: cleanPhone
    },
    webhook_url: "https://backend-ut99.onrender.com/webhook/snippe"
  };

  console.log("Sending to Snippe:", JSON.stringify(payload));

  try {
    const { data, status: httpStatus } = await snippeApi.post(
      "/payments",
      payload,
      {
        headers: {
          Authorization: `Bearer ${SNIPPE_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": orderId
        }
      }
    );

    console.log("Snippe HTTP status:", httpStatus);
    console.log("Snippe response payload:", JSON.stringify(data));
    console.log("Create-payment duration(ms):", Date.now() - requestStartedAt);

    // Mobile money is async — API returns status "pending" on success
    const paymentData = data.data || data;
    if (data.status === "success" && paymentData.reference) {
      await consumeSubmissionCodeInStorage(latestSubmission.id, paymentData.reference);

      return res.json({
        success: true,
        message: "Payment request sent to your phone. Please confirm.",
        order_id: orderId
      });
    }

    console.error("Snippe non-success response:", JSON.stringify(data));
    return res.status(400).json({
      success: false,
      error: data.message || data.error || "Payment could not be initiated"
    });
  } catch (err) {
    const errBody = err.response?.data;
    console.error("Snippe HTTP error status:", err.response?.status);
    console.error("Snippe error body:", JSON.stringify(errBody));
    console.error("Snippe error message:", err.message);
    console.error("Create-payment duration(ms):", Date.now() - requestStartedAt);

    return res.status(500).json({
      success: false,
      error: errBody?.message || errBody?.error || "Payment failed"
    });
  }
});

/* Webhook verification */
function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret || !payload) return false;
  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (e) {
    return false;
  }
}

/* Webhook */
app.post("/webhook/snippe", async (req, res) => {
  console.log("Snippe webhook event:", JSON.stringify(req.body));
  
  const secret = process.env.SNIPPE_WEBHOOK_SECRET;
  const signature = req.headers["x-webhook-signature"];

  if (secret) {
    if (!verifyWebhookSignature(req.rawBody, signature, secret)) {
      console.warn("Invalid Snippe webhook signature detected. Ignored.");
      return res.status(401).send("Invalid signature");
    }
  }

  const { type, data } = req.body || {};
  
  if (type === "payment.completed" && data && data.status === "completed" && data.reference) {
    const reference = data.reference;
    try {
      if (usePostgres) {
        await pool.query(
          "UPDATE customer_submissions SET payment_completed_at = CURRENT_TIMESTAMP WHERE payment_order_id = $1",
          [reference]
        );
      } else {
        const submissions = await readSubmissions();
        let changed = false;
        for (const sub of submissions) {
          if (sub.paymentOrderId === reference && !sub.paymentCompletedAt) {
            sub.paymentCompletedAt = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) {
          await writeSubmissions(submissions);
        }
      }
      console.log(`Payment mapped as complete for ref ${reference}`);
    } catch (err) {
      console.error("Failed to update payment status from Snippe webhook:", err.message);
    }
  }

  res.status(200).end();
});

/* Health */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    storage: usePostgres ? "postgres" : "json-file",
    requireDatabaseInProduction
  });
});

/* Start server */
const PORT = process.env.PORT || 4000;

initStorage()
  .then(() => {
    console.log(`Storage engine: ${usePostgres ? "PostgreSQL" : "JSON file"}`);
    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize storage:", error.message);
    process.exit(1);
  });
