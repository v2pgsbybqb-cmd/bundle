require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const submissionsFile = path.join(__dirname, "data", "customer-submissions.json");
const adminStaticDir = path.join(__dirname, "public");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-admin";

app.set("trust proxy", 1);

if (!process.env.ADMIN_PASSWORD) {
  console.warn("ADMIN_PASSWORD is not set. Using insecure default password: change-me-admin");
}

/* Security */
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

/* Serve admin panel (static files, not affected by CORS) */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(adminStaticDir, "admin.html"));
});

app.get("/admin/", (req, res) => {
  res.sendFile(path.join(adminStaticDir, "admin.html"));
});

app.use("/admin", express.static(adminStaticDir, { index: "admin.html" }));

/* Allowed origins */
const allowedOrigins = [
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  "https://bundle-ls5z.onrender.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("Blocked origin:", origin);
      callback(new Error("Not allowed by CORS"));
    },
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
function isValidTanzanianPhone(phone) {
  return /^(0[67]\d{8}|255[67]\d{8})$/.test(phone.replace(/\s+/g, ""));
}

function isValidCustomerCode(code) {
  return /^\d{4}$/.test(String(code || "").trim());
}

function normalizeCustomerCode(code) {
  return String(code || "").trim();
}

function toInternational(phone) {
  const clean = phone.replace(/\s+/g, "");
  return clean.startsWith("0") ? "255" + clean.slice(1) : clean;
}

function detectChannel(phone) {
  const clean = phone.replace(/\s+/g, "");
  const local = clean.startsWith("255") ? `0${clean.slice(3)}` : clean;

  if (local.startsWith("068") || local.startsWith("069") || local.startsWith("078")) {
    return "AIRTEL-MONEY";
  }

  if (local.startsWith("074") || local.startsWith("075") || local.startsWith("076")) {
    return "TIGO-PESA";
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
  await fs.writeFile(submissionsFile, `${JSON.stringify(submissions, null, 2)}\n`, "utf8");
}

function sortSubmissions(submissions) {
  return [...submissions].sort((left, right) => {
    return new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime();
  });
}

function requireAdminAuth(req, res, next) {
  if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  next();
}

const hasStaticToken = Boolean(process.env.CLICKPESA_TOKEN);
const hasClientCredentials = Boolean(process.env.CLICKPESA_CLIENT_ID && process.env.CLICKPESA_API_KEY);
const CLICKPESA_TIMEOUT_MS = Number(process.env.CLICKPESA_TIMEOUT_MS || 15000);

const clickPesaApi = axios.create({ timeout: CLICKPESA_TIMEOUT_MS });

let cachedBearerToken = null;
let cachedTokenExpiryMs = 0;

if (!hasStaticToken && !hasClientCredentials) {
  console.warn("Missing ClickPesa auth config. Set CLICKPESA_TOKEN or both CLICKPESA_CLIENT_ID and CLICKPESA_API_KEY.");
}

function getTokenExpiryMs(token) {
  try {
    const jwt = token.startsWith("Bearer ") ? token.slice(7) : token;
    const payloadBase64 = jwt.split(".")[1];
    if (!payloadBase64) return 0;

    const payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);

    if (!payload.exp) return 0;
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

async function getClickPesaAuthToken() {
  if (process.env.CLICKPESA_TOKEN) {
    return process.env.CLICKPESA_TOKEN.startsWith("Bearer ")
      ? process.env.CLICKPESA_TOKEN
      : `Bearer ${process.env.CLICKPESA_TOKEN}`;
  }

  const now = Date.now();
  if (cachedBearerToken && now < cachedTokenExpiryMs - 30_000) {
    return cachedBearerToken;
  }

  const tokenResponse = await clickPesaApi.post(
    "https://api.clickpesa.com/third-parties/generate-token",
    {},
    {
      headers: {
        "client-id": process.env.CLICKPESA_CLIENT_ID,
        "api-key": process.env.CLICKPESA_API_KEY
      }
    }
  );

  const token = tokenResponse.data.token;
  const bearerToken = token && token.startsWith("Bearer ") ? token : `Bearer ${token}`;

  cachedBearerToken = bearerToken;
  cachedTokenExpiryMs = getTokenExpiryMs(bearerToken) || now + 10 * 60 * 1000;

  return cachedBearerToken;
}

app.post("/customer-codes", async (req, res) => {
  const { phone, customerCode } = req.body || {};

  if (!phone || typeof phone !== "string" || !isValidTanzanianPhone(phone.trim())) {
    return res.status(400).json({ success: false, error: "Valid phone number is required" });
  }

  if (!isValidCustomerCode(customerCode)) {
    return res.status(400).json({ success: false, error: "Customer code must be exactly 4 digits" });
  }

  const cleanPhone = phone.trim();
  const normalizedCode = normalizeCustomerCode(customerCode);
  const now = new Date().toISOString();

  try {
    const submissions = await readSubmissions();
    const existingIndex = submissions.findIndex((item) => item.phone === cleanPhone);

    let record;
    if (existingIndex >= 0) {
      record = {
        ...submissions[existingIndex],
        customerCode: normalizedCode,
        updatedAt: now
      };
      submissions[existingIndex] = record;
    } else {
      record = {
        id: `SUB-${Date.now()}`,
        phone: cleanPhone,
        customerCode: normalizedCode,
        allocated: false,
        allocatedAt: null,
        allocationNote: "",
        createdAt: now,
        updatedAt: now
      };
      submissions.push(record);
    }

    await writeSubmissions(submissions);
    return res.json({ success: true, record });
  } catch (error) {
    console.error("Failed to store customer code:", error.message);
    return res.status(500).json({ success: false, error: "Could not save customer code" });
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
    const submissions = await readSubmissions();
    const index = submissions.findIndex((item) => item.id === id);

    if (index === -1) {
      return res.status(404).json({ success: false, error: "Submission not found" });
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

  if (!hasStaticToken && !hasClientCredentials) {
    return res.status(500).json({
      success: false,
      error: "Server payment configuration is incomplete."
    });
  }

  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ success: false, error: "Phone required" });
  }

  const cleanPhone = phone.trim();

  if (!isValidTanzanianPhone(cleanPhone)) {
    return res.status(400).json({ success: false, error: "Invalid phone" });
  }

  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount < 100) {
    return res.status(400).json({ success: false, error: "Invalid amount" });
  }

  const orderId = makeTxRef();
  const intlPhone = toInternational(cleanPhone);
  const channel = detectChannel(cleanPhone);

  if (!channel) {
    return res.status(400).json({
      success: false,
      error: "Unsupported network prefix. Use Halotel (061/062/063), YAS (074/075/076), or Airtel (068/069/078)."
    });
  }

  const payload = {
    amount: parsedAmount,
    currency: "TZS",
    orderReference: orderId,
    phoneNumber: intlPhone,
    channel
  };

  console.log("Sending to ClickPesa:", JSON.stringify(payload));

  try {
    const authToken = await getClickPesaAuthToken();
    const { data, status: httpStatus } = await clickPesaApi.post(
      "https://api.clickpesa.com/third-parties/payments/initiate-ussd-push-request",
      payload,
      {
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("ClickPesa HTTP status:", httpStatus);
    console.log("ClickPesa response payload:", JSON.stringify(data));
    console.log("Create-payment duration(ms):", Date.now() - requestStartedAt);

    const isHealthCheck = data.version && data.status === "up";
    if (isHealthCheck) {
      console.error("ClickPesa returned health-check - payload or endpoint rejected");
      return res.status(400).json({ success: false, error: "Payment gateway rejected the request." });
    }

    const isEchoSuccess = data.status === "PROCESSING" || data.id;

    if (
      data.status === "PENDING" ||
      data.status === "SUCCESS" ||
      data.status === "success" ||
      data.message?.toLowerCase().includes("success") ||
      data.message?.toLowerCase().includes("pending") ||
      isEchoSuccess
    ) {
      return res.json({
        success: true,
        message: "Payment request sent to your phone. Please confirm.",
        order_id: orderId
      });
    }

    console.error("ClickPesa non-success response:", JSON.stringify(data));
    return res.status(400).json({
      success: false,
      error: data.message || data.error || "Payment could not be initiated"
    });
  } catch (err) {
    const errBody = err.response?.data;
    console.error("ClickPesa HTTP error status:", err.response?.status);
    console.error("ClickPesa error body:", JSON.stringify(errBody));
    console.error("ClickPesa error message:", err.message);
    console.error("Create-payment duration(ms):", Date.now() - requestStartedAt);

    return res.status(500).json({
      success: false,
      error: errBody?.message || errBody?.error || "Payment failed"
    });
  }
});

/* Webhook */
app.post("/webhook/clickpesa", (req, res) => {
  console.log("Webhook event:", req.body);
  res.status(200).end();
});

/* Health */
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

/* Start server */
const PORT = process.env.PORT || 4000;

ensureSubmissionsFile()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize storage:", error.message);
    process.exit(1);
  });
