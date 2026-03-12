const STORAGE_KEY = "bundletz-admin-password";

const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const messageEl = document.getElementById("message");
const rowsEl = document.getElementById("rows");
const searchInput = document.getElementById("search");
const totalCountEl = document.getElementById("totalCount");
const pendingCountEl = document.getElementById("pendingCount");
const allocatedCountEl = document.getElementById("allocatedCount");

let submissions = [];

function getPassword() {
  return sessionStorage.getItem(STORAGE_KEY) || "";
}

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle("error", isError);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function renderStats(items) {
  totalCountEl.textContent = items.length;
  pendingCountEl.textContent = items.filter((item) => !item.allocated).length;
  allocatedCountEl.textContent = items.filter((item) => item.allocated).length;
}

function renderRows(items) {
  if (!items.length) {
    rowsEl.innerHTML = '<tr><td colspan="7" class="muted">No customer codes saved yet.</td></tr>';
    return;
  }

  rowsEl.innerHTML = items
    .map((item) => {
      const statusClass = item.allocated ? "status-allocated" : "status-pending";
      const statusText = item.allocated ? "Allocated" : "Pending";
      const buttonClass = item.allocated ? "secondary" : "primary";
      const buttonText = item.allocated ? "Mark Pending" : "Mark Allocated";

      return `
        <tr>
          <td>${escapeHtml(item.phone)}</td>
          <td><strong>${escapeHtml(item.customerCode)}</strong></td>
          <td><span class="status-pill ${statusClass}">${statusText}</span></td>
          <td>${formatDate(item.createdAt)}</td>
          <td>${formatDate(item.allocatedAt)}</td>
          <td>
            <textarea class="row-note" data-note-for="${escapeHtml(item.id)}" placeholder="Optional note">${escapeHtml(item.allocationNote)}</textarea>
          </td>
          <td>
            <div class="row-actions">
              <button class="${buttonClass}" data-toggle-id="${escapeHtml(item.id)}" data-next-state="${String(!item.allocated)}">${buttonText}</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function applySearch() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = !query
    ? submissions
    : submissions.filter((item) => {
        return item.phone.toLowerCase().includes(query) || item.customerCode.toLowerCase().includes(query);
      });

  renderStats(filtered);
  renderRows(filtered);
}

async function fetchSubmissions() {
  const password = passwordInput.value.trim() || getPassword();

  if (!password) {
    setMessage("Enter the admin password first.", true);
    passwordInput.focus();
    return;
  }

  setMessage("Loading...");

  try {
    const res = await fetch("/admin/api/submissions", {
      headers: { "x-admin-password": password }
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Could not load submissions");
    }

    sessionStorage.setItem(STORAGE_KEY, password);
    submissions = data.submissions;
    applySearch();
    setMessage(`Loaded ${submissions.length} submissions.`);
  } catch (error) {
    setMessage(error.message || "Could not load submissions", true);
  }
}

async function updateSubmission(id, allocated) {
  const password = getPassword() || passwordInput.value.trim();
  const noteField = document.querySelector(`[data-note-for="${CSS.escape(id)}"]`);
  const allocationNote = noteField ? noteField.value : "";

  setMessage("Saving...");

  try {
    const res = await fetch(`/admin/api/submissions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-password": password
      },
      body: JSON.stringify({ allocated, allocationNote })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Could not update submission");
    }

    submissions = submissions.map((item) => (item.id === id ? data.record : item));
    applySearch();
    setMessage("Submission updated.");
  } catch (error) {
    setMessage(error.message || "Could not update submission", true);
  }
}

loginBtn.addEventListener("click", fetchSubmissions);
refreshBtn.addEventListener("click", fetchSubmissions);
logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem(STORAGE_KEY);
  passwordInput.value = "";
  submissions = [];
  renderStats([]);
  rowsEl.innerHTML = '<tr><td colspan="7" class="muted">Enter the admin password to load submissions.</td></tr>';
  setMessage("Password cleared.");
});

searchInput.addEventListener("input", applySearch);

rowsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-id]");
  if (!button) {
    return;
  }

  updateSubmission(button.dataset.toggleId, button.dataset.nextState === "true");
});

const savedPassword = getPassword();
if (savedPassword) {
  passwordInput.value = savedPassword;
  fetchSubmissions();
}
