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
    allowedHeaders: ["Content-Type"],
  })
);
