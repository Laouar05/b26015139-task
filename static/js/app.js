/* ---------- 任务管理器前端逻辑 ---------- */
const API_URL = "/api/tasks";

let currentFilter = "all";
let editingId = null;
let toastTimer = null;

// ----- DOM 元素 -----
const taskForm = document.getElementById("task-form");
const titleInput = document.getElementById("title-input");
const descInput = document.getElementById("desc-input");
const taskList = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const taskCount = document.getElementById("task-count");
const filterButtons = document.querySelectorAll(".filter-btn");

const editModal = document.getElementById("edit-modal");
const editTitle = document.getElementById("edit-title");
const editDesc = document.getElementById("edit-desc");
const editSave = document.getElementById("edit-save");
const editCancel = document.getElementById("edit-cancel");

const toastEl = document.getElementById("toast");

/* ---------- 辅助函数 ---------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("zh-CN");
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (type !== "info" ? " " + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = "toast"), 2500);
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 204) return null; // 无内容
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  return data;
}

const RECOMMEND_URL = "/api/recommendations/today";

const recommendForm = document.getElementById("recommend-form");
const recommendContext = document.getElementById("recommend-context");
const recommendSubmit = document.getElementById("recommend-submit");
const recommendStatus = document.getElementById("recommend-status");
const recommendResults = document.getElementById("recommend-results");

/* ---------- 任务推荐 ---------- */
async function generateRecommendations(event) {
  event.preventDefault();
  if (recommendSubmit.disabled) return;
  recommendSubmit.disabled = true;
  recommendSubmit.textContent = "正在生成…";
  recommendStatus.textContent = "正在分析未完成任务…";
  recommendStatus.classList.remove("is-error");
  recommendResults.replaceChildren();
  try {
    const { recommendations } = await request(RECOMMEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: recommendContext.value.trim() }),
    });
    recommendStatus.textContent = recommendations.length ? "建议已生成。" : "没有未完成的任务。";
    recommendations.forEach((item, index) => {
      const result = document.createElement("li");
      result.className = "recommend-result";
      const heading = document.createElement("h3");
      const link = document.createElement("a");
      link.href = `#task-${item.task_id}`;
      link.textContent = item.title;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        await jumpToTask(item.task_id);
      });
      heading.append(index === 0 ? "先做 · " : "接着做 · ", link);
      const reason = document.createElement("p");
      reason.textContent = item.reason;
      const firstStep = document.createElement("p");
      firstStep.textContent = `第一步 · ${item.first_step}`;
      result.append(heading, reason, firstStep);
      recommendResults.appendChild(result);
    });
  } catch (err) {
    recommendStatus.textContent = err.message;
    recommendStatus.classList.add("is-error");
  } finally {
    recommendSubmit.disabled = false;
    recommendSubmit.textContent = "生成建议";
  }
}

async function jumpToTask(id) {
  const itemId = `task-${id}`;
  let item = document.getElementById(itemId);
  if (!item && currentFilter !== "all") {
    await changeFilter("all");
    item = document.getElementById(itemId);
  }
  if (!item) {
    showToast("任务不在列表中，请刷新建议。", "error");
    return;
  }
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "center" });
}

/* ---------- 数据加载 ---------- */
async function changeFilter(filter) {
  currentFilter = filter;
  filterButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.filter === filter));
  await loadTasks();
}
let taskLoadVersion = 0;

async function loadTasks() {
  const version = ++taskLoadVersion;
  try {
    const tasks = await request(`${API_URL}?status=${currentFilter}`);
    if (version === taskLoadVersion) renderTasks(tasks);
  } catch (err) {
    if (version !== taskLoadVersion) return;
    showToast("加载任务失败：" + err.message, "error");
    renderTasks([]);
  }
}

function renderTasks(tasks) {
  taskList.innerHTML = "";
  tasks.forEach((task) => taskList.appendChild(buildTaskItem(task)));

  emptyState.style.display = tasks.length ? "none" : "block";
  emptyState.textContent =
    currentFilter === "completed"
      ? "还没有已完成的任务。"
      : currentFilter === "active"
      ? "没有进行中的任务 — 干得漂亮！"
      : "还没有任务，先在上方添加一个吧 🎉";

  updateCount(tasks);
}

function buildTaskItem(task) {
  const li = document.createElement("li");
  li.className = "task-item" + (task.completed ? " is-completed" : "");
  li.dataset.id = task.id;
  li.id = `task-${task.id}`;
  li.tabIndex = -1;

  li.innerHTML = `
    <input type="checkbox" class="task-check" ${task.completed ? "checked" : ""} />
    <div class="task-body">
      <div class="task-title">${escapeHtml(task.title)}</div>
      ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ""}
      <div class="task-meta">创建于 ${formatDate(task.created_at)}</div>
    </div>
    <div class="task-actions">
      <button class="icon-btn edit-btn" title="编辑">✏️</button>
      <button class="icon-btn danger delete-btn" title="删除">🗑️</button>
    </div>
  `;

  li.querySelector(".task-check").addEventListener("change", () => toggleTask(task.id));
  li.querySelector(".edit-btn").addEventListener("click", () => openEditModal(task));
  li.querySelector(".delete-btn").addEventListener("click", () => deleteTask(task.id));
  return li;
}

async function updateCount(tasks) {
  // 处于筛选状态时，额外获取全部任务用于计算“已完成 X / 共 Y”。
  let all = tasks;
  if (currentFilter !== "all") {
    try {
      all = await request(`${API_URL}?status=all`);
    } catch (e) {
      all = tasks;
    }
  }
  const total = all.length;
  const done = all.filter((t) => t.completed).length;
  taskCount.textContent = total ? `已完成 ${done} / 共 ${total}` : "";
}

/* ---------- 操作 ---------- */
async function addTask(event) {
  event.preventDefault();
  const title = titleInput.value.trim();
  const description = descInput.value.trim();
  if (!title) {
    showToast("请输入任务标题", "error");
    return;
  }
  try {
    await request(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    titleInput.value = "";
    descInput.value = "";
    showToast("任务已添加", "success");
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function toggleTask(id) {
  try {
    await request(`${API_URL}/${id}/toggle`, { method: "PATCH" });
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
    loadTasks();
  }
}

async function deleteTask(id) {
  if (!confirm("确定要删除这个任务吗？")) return;
  try {
    await request(`${API_URL}/${id}`, { method: "DELETE" });
    showToast("任务已删除", "success");
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function openEditModal(task) {
  editingId = task.id;
  editTitle.value = task.title;
  editDesc.value = task.description || "";
  editModal.classList.remove("is-hidden");
  editTitle.focus();
}

function closeEditModal() {
  editingId = null;
  editModal.classList.add("is-hidden");
}

async function saveEdit() {
  const title = editTitle.value.trim();
  if (!title) {
    showToast("标题不能为空", "error");
    return;
  }
  try {
    await request(`${API_URL}/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: editDesc.value.trim() }),
    });
    showToast("任务已更新", "success");
    closeEditModal();
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ---------- 事件绑定 ---------- */
taskForm.addEventListener("submit", addTask);
recommendForm.addEventListener("submit", generateRecommendations);

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => changeFilter(btn.dataset.filter));
});

editSave.addEventListener("click", saveEdit);
editCancel.addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEditModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !editModal.classList.contains("is-hidden")) closeEditModal();
});

// 首次加载
loadTasks();
