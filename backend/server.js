require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

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

  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount < 100 || parsedAmount > 1_000_000) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid payment amount." });
  }

  const txRef = makeTxRef();
  const intlPhone = toInternational(cleanPhone);

  try {
    const flwRes = await fetch(
      "https://api.flutterwave.com/v3/charges?type=mobile_money_tanzania",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone_number: intlPhone,
          amount: parsedAmount,
          currency: "TZS",
          tx_ref: txRef,
          // Flutterwave requires an email field; use a placeholder
          email: "pay@unlockvip.com",
        }),
      }
    );

    const data = await flwRes.json();

    // Flutterwave returns status "success" when the STK push is dispatched
    if (
      data.status === "success" ||
      (data.message && data.message.toLowerCase().includes("initiated"))
    ) {
      return res.json({
        success: true,
        message: "Payment request sent to your phone. Please confirm.",
        tx_ref: txRef,
      });
    }

    // Gateway returned an error
    console.error("Flutterwave error response:", JSON.stringify(data));
    return res.status(400).json({
      success: false,
      error: data.message || "Payment could not be initiated.",
    });
  } catch (err) {
    console.error("Payment processing error:", err.message);
    return res
      .status(500)
      .json({ success: false, error: "Server error. Please try again." });
  }
});

/* ─── POST /webhook/flutterwave (payment confirmation) ─────── */
// Flutterwave calls this URL after the customer confirms on their phone.
// Set this URL in your Flutterwave dashboard → Webhooks.
app.post("/webhook/flutterwave", express.json(), (req, res) => {
  const secretHash = process.env.FLW_WEBHOOK_SECRET;
  const signature = req.headers["verif-hash"];

  // Reject requests that don't carry the secret hash
  if (!signature || signature !== secretHash) {
    return res.status(401).end();
  }

  const event = req.body;
  const { status, tx_ref, amount, currency } = event.data || {};

  if (status === "successful") {
    // TODO: mark the order as paid in your database using tx_ref
    console.log(`Payment confirmed: ${tx_ref} – ${amount} ${currency}`);
  } else {
    console.log(`Payment not successful: ${tx_ref} – status: ${status}`);
  }

  // Always respond 200 so Flutterwave stops retrying
  res.status(200).end();
});

/* ─── Health check ──────────────────────────────────────────── */
app.get("/", (_req, res) => res.json({ status: "ok" }));

/* ─── Start server ──────────────────────────────────────────── */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
