require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

const app = express();

app.set("trust proxy", 1);

/* Security */
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

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
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
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

  if (local.startsWith("061") || local.startsWith("062")) {
    return "HALOPESA";
  }

  return null;
}

function makeTxRef() {
  const random = Math.random().toString(36).substring(2,8).toUpperCase(); // 6 chars
  const time = Date.now().toString().slice(-10); // last 10 digits of timestamp
  return `UVP${time}${random}`.slice(0,20); // ensure max length 20
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
    return res.status(400).json({ success:false, error:"Phone required" });
  }

  const cleanPhone = phone.trim();

  if (!isValidTanzanianPhone(cleanPhone)) {
    return res.status(400).json({ success:false, error:"Invalid phone" });
  }

  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount < 100) {
    return res.status(400).json({ success:false, error:"Invalid amount" });
  }

  const orderId = makeTxRef();
  const intlPhone = toInternational(cleanPhone);
  const channel = detectChannel(cleanPhone);

  if (!channel) {
    return res.status(400).json({
      success: false,
      error: "Unsupported network prefix. Use Halotel (062), YAS (074/075/076), or Airtel (068/069/078)."
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

    // 2. Initiate USSD push request
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

    // Health-check response means ClickPesa rejected the request (wrong endpoint or bad payload)
    const isHealthCheck = data.version && data.status === "up";
    if (isHealthCheck) {
      console.error("ClickPesa returned health-check – payload or endpoint rejected");
      return res.status(400).json({ success: false, error: "Payment gateway rejected the request." });
    }

    // ClickPesa echoes back the payload with a unique `name` when the USSD push is queued
    // e.g. {"name":"clickpesa-core-XXXXXX","amount":500,"currency":"TZS","customerMsisdn":"255..."}
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

    // ClickPesa responded but indicated failure
    console.error("ClickPesa non-success response:", JSON.stringify(data));
    return res.status(400).json({
      success: false,
      error: data.message || data.error || "Payment could not be initiated"
    });

  } catch(err) {

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
app.post("/webhook/clickpesa", (req,res)=>{

  console.log("Webhook event:", req.body);

  res.status(200).end();
});

/* Health */
app.get("/", (req,res)=>{
  res.json({ status:"ok" });
});

/* Start server */
const PORT = process.env.PORT || 4000;

app.listen(PORT, ()=>{
  console.log("Server running on port", PORT);
});
