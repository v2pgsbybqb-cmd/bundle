require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

const app = express();

/* ─── Security headers ─────────────────────────────────────── */
app.use(helmet());

/* ─── CORS – only allow your frontend origin ────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Always allow localhost for local development
allowedOrigins.push("http://localhost:5500", "http://127.0.0.1:5500");

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl/Postman) only in development
      if (!origin && process.env.NODE_ENV !== "production") {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

/* ─── Body parser (limit to 10 KB to prevent large payload attacks) ─── */
app.use(express.json({ limit: "10kb" }));

/* ─── Rate limiting – 20 payment attempts per IP per 15 min ─── */
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many payment requests. Please try again later.",
  },
});

/* ─── Helpers ───────────────────────────────────────────────── */

// Accept: 07XXXXXXXX or 255XXXXXXXXX (Tanzania numbers)
function isValidTanzanianPhone(phone) {
  return /^(0[67]\d{8}|255[67]\d{8})$/.test(phone.replace(/\s+/g, ""));
}

// Convert 07XXXXXXXX → 2557XXXXXXXX for the API
function toInternational(phone) {
  const clean = phone.replace(/\s+/g, "");
  return clean.startsWith("0") ? "255" + clean.slice(1) : clean;
}

// Generate a unique transaction reference
function makeTxRef() {
  return `UVP-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

/* ─── POST /create-payment ──────────────────────────────────── */
app.post("/create-payment", paymentLimiter, async (req, res) => {
  const { phone, amount } = req.body;

  // --- Input validation ---
  if (!phone || typeof phone !== "string") {
    return res
      .status(400)
      .json({ success: false, error: "Phone number is required." });
  }

  const cleanPhone = phone.trim();
  if (!isValidTanzanianPhone(cleanPhone)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid Tanzanian phone number." });
  }

  const parsedAmount = 500; // force 500 TZS for testing
  if (!parsedAmount || parsedAmount < 100 || parsedAmount > 1_000_000) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid payment amount." });
  }

  const orderId = makeTxRef();
  const intlPhone = toInternational(cleanPhone);

  try {
    const { data } = await axios.post(
      "https://api.clickpesa.com/third-parties/v2/pay",
      {
        order_id: orderId,
        amount: parsedAmount,
        currency: "TZS",
        phone_number: intlPhone,
        description: "Internet Bundle – UnlockVIP",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.CLICKPESA_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ClickPesa returns { status: "PENDING" } or { status: "SUCCESS" }
    // when the STK push has been dispatched successfully.
    if (data.status === "PENDING" || data.status === "SUCCESS") {
      return res.json({
        success: true,
        message: "Payment request sent to your phone. Please confirm.",
        order_id: orderId,
      });
    }

    console.error("ClickPesa unexpected response:", JSON.stringify(data));
    return res.status(400).json({
      success: false,
      error: data.message || "Payment could not be initiated.",
    });
  } catch (err) {
    const errData = err.response?.data;
    console.error("ClickPesa error:", errData || err.message);
    return res.status(400).json({
      success: false,
      error: (errData && errData.message) || "Payment could not be initiated.",
    });
  }
});

/* ─── POST /webhook/clickpesa ───────────────────────────────── */
// ClickPesa calls this URL after the customer confirms on their phone.
// Set this URL in your ClickPesa dashboard → Settings → Webhooks.
app.post("/webhook/clickpesa", (req, res) => {
  const signature = req.headers["x-clickpesa-signature"];

  if (!signature || signature !== process.env.CLICKPESA_WEBHOOK_SECRET) {
    console.warn("Webhook: invalid signature – request rejected.");
    return res.status(401).end();
  }

  const { event, data } = req.body || {};
  const { order_id, amount, currency, status } = data || {};

  if (event === "payment.received" || status === "PAID" || status === "SUCCESS") {
    console.log(`[webhook] payment.received – order: ${order_id} | ${amount} ${currency}`);
    // TODO: fulfil the order in your database here
  } else if (event === "payment.failed" || status === "FAILED") {
    console.log(`[webhook] payment.failed – order: ${order_id}`);
  } else {
    console.log(`[webhook] unhandled event: ${event || status} – order: ${order_id}`);
  }

  // Always respond 200 so ClickPesa stops retrying
  res.status(200).end();
});

/* ─── Health check ──────────────────────────────────────────── */
app.get("/", (_req, res) => res.json({ status: "ok" }));

/* ─── Start server ──────────────────────────────────────────── */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
