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
  process.env.ALLOWED_ORIGINS,
  "https://bundle-ls5z.onrender.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
].filter(Boolean);

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

function makeTxRef() {
  return `UVP${Date.now()}${Math.random().toString(36).substring(2,8).toUpperCase()}`;
}

/* Create payment */
app.post("/create-payment", paymentLimiter, async (req, res) => {
  const { phone } = req.body;

  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ success:false, error:"Phone required" });
  }

  const cleanPhone = phone.trim();

  if (!isValidTanzanianPhone(cleanPhone)) {
    return res.status(400).json({ success:false, error:"Invalid phone" });
  }

  const orderId = makeTxRef();
  const intlPhone = toInternational(cleanPhone);

  const payload = {
    amount: "500",
    currency: "TZS",
    orderReference: orderId,
    phoneNumber: intlPhone,
    channel: "AIRTEL-MONEY"
  };

  console.log("Sending to ClickPesa:", JSON.stringify(payload));
  console.log("Using API key prefix:", process.env.CLICKPESA_API_KEY?.substring(0, 8));

  try {

    // 1. Generate ClickPesa token
    const tokenResponse = await axios.post(
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

    // 2. Initiate USSD push request
    const { data, status: httpStatus } = await axios.post(
      "https://api.clickpesa.com/third-parties/payments/initiate-ussd-push-request",
      payload,
      {
        headers: {
          Authorization: token,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("ClickPesa HTTP status:", httpStatus);
    console.log("ClickPesa response payload:", JSON.stringify(data));

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
