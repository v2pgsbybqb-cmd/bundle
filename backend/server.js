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
  return `UVP-${Date.now()}-${Math.random().toString(36).substring(2,8).toUpperCase()}`;
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

  try {

    const { data } = await axios.post(
      "https://api.clickpesa.com/third-parties/v2/pay",
      {
        order_id: orderId,
        amount: 500,
        currency: "TZS",
        phone_number: intlPhone,
        channel: "AIRTEL-MONEY",
        description: "Internet Bundle"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.CLICKPESA_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("ClickPesa response:", data);
    console.log("ClickPesa full response payload:", JSON.stringify(data));

    return res.json({
      success: true,
      message: "Payment request sent to your phone",
      payment: data
    });

  } catch(err) {

    console.error("ClickPesa error", err.response?.data || err.message);

    return res.status(500).json({
      success:false,
      error:"Payment failed"
    });

  }
});

/* Webhook */
app.post("/webhook/clickpesa", (req,res)=>{

  const signature = req.headers["x-clickpesa-signature"];

  if(signature !== process.env.CLICKPESA_WEBHOOK_SECRET){
    return res.status(401).end();
  }

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
