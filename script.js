/* ── PAYMENT ──────────────────────────────────────────────── */

const BACKEND = "https://backend-ut99.onrender.com";

async function buy(btn) {
  const phone = document.getElementById("phone").value.trim();

  if (!phone) {
    showToast("⚠️ Please enter your phone number first");
    document.getElementById("phone").focus();
    return;
  }

  if (!/^0[67]\d{8}$/.test(phone)) {
    showToast("⚠️ Enter a valid Tanzanian number (07/06XXXXXXXX)");
    return;
  }

  // Disable all buy buttons while processing
  document.querySelectorAll(".buy-btn").forEach(b => b.disabled = true);

  showStatus("loading");

  try {
    const res = await fetch(`${BACKEND}/create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, amount: 3000 })
    });

    const data = await res.json();

    if (data.success) {
      showStatus("success");
      showToast("✅ Payment prompt sent! Check your phone.");
    } else {
      showStatus("none");
      showToast("❌ " + (data.error || "Payment failed. Try again."));
    }
  } catch (err) {
    showStatus("none");
    showToast("❌ Could not reach server. Check your connection.");
  } finally {
    document.querySelectorAll(".buy-btn").forEach(b => b.disabled = false);
  }
}

function showStatus(state) {
  document.getElementById("loading").classList.toggle("show", state === "loading");
  document.getElementById("success").classList.toggle("show", state === "success");
  document.getElementById("error-msg").classList.remove("show");
}

/* ── TOAST ────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

/* ── PHONE PREFIX DETECTION ──────────────────────────────── */
const phoneInput = document.getElementById("phone");
const cards = document.querySelectorAll(".card");
const badge = document.getElementById("network-badge");

const networkColors = {
  halotel: { bg: "rgba(0,180,120,.2)", text: "#00e676", label: "HALOTEL" },
  yas:     { bg: "rgba(255,180,0,.2)",  text: "#ffd600", label: "YAS"     },
  airtel:  { bg: "rgba(255,60,0,.2)",   text: "#ff6b00", label: "AIRTEL"  },
};

phoneInput.addEventListener("input", () => {
  const num = phoneInput.value.trim();
  let detected = null;

  if (num.startsWith("062")) {
    detected = "halotel";
  } else if (num.startsWith("074") || num.startsWith("075") || num.startsWith("076")) {
    detected = "yas";
  } else if (num.startsWith("068") || num.startsWith("069") || num.startsWith("078")) {
    detected = "airtel";
  }

  // Update cards
  cards.forEach(card => {
    card.classList.toggle("active-network", card.dataset.network === detected);
  });

  // Update badge
  if (detected && num.length >= 3) {
    const c = networkColors[detected];
    badge.textContent = c.label;
    badge.style.background = c.bg;
    badge.style.color = c.text;
    badge.classList.add("show");
  } else {
    badge.classList.remove("show");
  }
});

/* ── LIVE ACTIVITY ────────────────────────────────────────── */
const usersEl  = document.getElementById("usersOnline");
const speedEl  = document.getElementById("networkSpeed");
const soldEl   = document.getElementById("bundlesSold");
const loadEl   = document.getElementById("networkLoad");

let bundles = 1247;

function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function updateLive() {
  usersEl.textContent  = rnd(18, 64);
  speedEl.textContent  = rnd(22, 118) + " Mbps";
  bundles += rnd(0, 3);
  soldEl.textContent   = bundles.toLocaleString();
  loadEl.textContent   = rnd(58, 96) + "%";
}

updateLive();
setInterval(updateLive, 2500);

/* ── FAKE PURCHASE TOASTS ─────────────────────────────────── */
const names  = ["John", "Asha", "Kelvin", "Maria", "Ali", "Fatma", "David", "Zara"];
const cities = ["Dar es Salaam", "Arusha", "Mwanza", "Dodoma", "Mbeya"];

function fakePurchase() {
  const name = names[rnd(0, names.length - 1)];
  const city = cities[rnd(0, cities.length - 1)];
  showToast(`🟢 ${name} from ${city} just bought 23GB`);
}

// Start fake purchases after 6s, then every 7–12s
setTimeout(() => {
  fakePurchase();
  setInterval(fakePurchase, rnd(7000, 12000));
}, 6000);

/* ── CHOOSE NETWORK SLIDE-IN ─────────────────────────────── */
const bundlesSection = document.getElementById("bundles");

if (bundlesSection) {
  const revealBundles = () => bundlesSection.classList.add("in-view");

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            revealBundles();
            observer.disconnect();
          }
        });
      },
      { threshold: 0.2 }
    );
    observer.observe(bundlesSection);
  } else {
    // Fallback for older browsers
    revealBundles();
  }
}
