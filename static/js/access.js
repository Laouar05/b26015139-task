/* Same-origin session, permissions and administration. */
const access = (id) => document.getElementById(id);
const authState = { user: null, roles: [], permissions: new Set(), csrf: null, epoch: 0 };
const pendingRequests = new Set();
let identityRefresh;
let csrfRequest;
let registrationEnabled = false;
const authDialog = access('auth-dialog');
const adminDialog = access('admin-dialog');
const transferDialog = access('transfer-dialog');
const roleNames = { admin: '管理员', member: '普通成员', viewer: '只读访客' };
const hasPermissions = (...codes) => Boolean(authState.user) && codes.every((code) => authState.permissions.has(code));
const mayWriteTask = (task) => hasPermissions('task:read', 'task:write') &&
  (task.owner_id === authState.user.id || hasPermissions('task:read_all', 'task:write_all'));
const canUseTab = (tab) => tab === 'recommend' ? hasPermissions('task:read', 'ai:recommend') : hasPermissions('ai:decompose');
const jsonOptions = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const abortError = () => new DOMException('请求已取消', 'AbortError');

class RequestError extends Error {
  constructor(status, body) {
    super(body.error || `请求失败（${status}）`);
    this.status = status;
    this.code = body.code;
  }
}

function getCsrf() {
  if (!csrfRequest) {
    const current = request('/api/auth/csrf').then((data) => {
      authState.csrf = data.csrf_token;
      registrationEnabled = data.registration_enabled;
      access('auth-switch').hidden = !registrationEnabled;
      return authState.csrf;
    });
    csrfRequest = current;
    const release = () => { if (csrfRequest === current) csrfRequest = null; };
    current.then(release, release);
  }
  return csrfRequest;
}

async function request(url, options = {}) {
  const epoch = authState.epoch;
  const controller = new AbortController();
  pendingRequests.add(controller);
  try {
    const headers = new Headers(options.headers);
    if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) {
      headers.set('X-CSRF-Token', authState.csrf || await getCsrf());
    }
    if (epoch !== authState.epoch) throw abortError();
    const response = await fetch(url, { ...options, headers, signal: controller.signal, credentials: 'same-origin' });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (epoch !== authState.epoch) throw abortError();
    if (response.ok) return data;
    const error = new RequestError(response.status, data || {});
    if (error.code === 'AUTH_REQUIRED') {
      if (authState.user) applyIdentity(null);
      if (url !== '/api/auth/me') {
        openAuth();
        throw abortError();
      }
    } else if (error.code === 'PERMISSION_DENIED') {
      showToast('没有执行此操作的权限。', 'error');
      refreshIdentity();
    } else if (error.code === 'CSRF_INVALID') {
      authState.csrf = null;
      getCsrf().catch(() => {});
    } else if (error.code === 'TASK_NOT_FOUND') {
      showToast('任务不可用，正在刷新列表。', 'error');
      loadTasks();
    }
    throw error;
  } finally {
    pendingRequests.delete(controller);
  }
}

function clearPrivateData() {
  ++authState.epoch;
  csrfRequest = null;
  for (const controller of pendingRequests) controller.abort();
  ++taskLoadVersion;
  allTasks = [];
  searchQuery = searchInput.value = '';
  taskForm.reset();
  titleCounter.textContent = '0 / 200';
  titleCounter.classList.remove('is-warn');
  collapseComposer(true);
  closeEditModal();
  editForm.reset();
  closeDeleteConfirm();
  confirmDesc.textContent = '删除后无法恢复。';
  recommendForm.reset();
  recommendResults.replaceChildren();
  recommendStatus.textContent = '';
  setButtonLoading(recommendSubmit, false, '正在分析排期…', '生成行动建议');
  breakdownForm.reset();
  breakdownResults.replaceChildren();
  draftGoal = null;
  breakdownBusy = false;
  setButtonLoading(breakdownGenerate, false, '正在拆解目标…', '生成子任务草稿');
  setButtonLoading(breakdownSave, false, '正在加入列表…', '批量加入任务列表');
  setBreakdownStatus('');
  updateBreakdownControls();
  closeChatDrawer();
  activeChat = null;
  chatThreads.clear();
  chatForm.reset();
  chatLog.replaceChildren();
  chatStatus.textContent = chatContextTitle.textContent = chatContextDesc.textContent = '';
  if (adminDialog.open) adminDialog.close();
  if (transferDialog.open) transferDialog.close();
  access('admin-list').replaceChildren();
  access('admin-role-options').replaceChildren();
  access('admin-roles').replaceChildren();
  access('admin-target').textContent = '';
  access('admin-edit').hidden = true;
  access('admin-search').reset();
  access('transfer-search').reset();
  access('transfer-user').replaceChildren();
  access('transfer-task-name').textContent = '';
  adminTarget = transferTask = null;
  roleCatalog = [];
  updateProgressAndBadges();
  changeFilter('all');
}

function renderPermissions() {
  document.body.removeAttribute('data-auth-pending');
  const signedIn = Boolean(authState.user);
  const read = hasPermissions('task:read');
  const write = hasPermissions('task:write');
  const chat = hasPermissions('ai:chat');
  const recommend = canUseTab('recommend');
  const decompose = canUseTab('breakdown');
  access('account-state').textContent = signedIn
    ? `${authState.user.username}${authState.roles.length ? ' · ' + authState.roles.map((code) => roleNames[code] || code).join(' / ') : ''}${read && !write ? ' · 仅能查看，不可修改' : ''}`
    : '登录后查看任务';
  access('auth-open').hidden = signedIn;
  access('auth-logout').hidden = !signedIn;
  access('admin-open').hidden = !hasPermissions('role:manage') && !hasPermissions('user:manage');
  access('chat-open').hidden = access('mobile-chat-btn').hidden = !chat;
  document.querySelector('.tasks-section').hidden = !read;
  document.querySelector('.header-tools').hidden = !read;
  document.querySelector('.mobile-filters').hidden = !read;
  document.querySelector('.sidebar').hidden = !read;
  composerCard.hidden = !write;
  breakdownSave.hidden = !write;
  access('recommend-scope-wrap').hidden = !hasPermissions('task:read_all');
  access('ai-studio').hidden = !recommend && !decompose;
  document.querySelector('.studio-shell').classList.toggle('without-ai', !recommend && !decompose);
  aiTabs.forEach((tab) => { tab.hidden = !canUseTab(tab.dataset.aiTab); });
  aiShortcuts.forEach((item) => { item.hidden = !canUseTab(item.dataset.aiJump); });
  if (recommend || decompose) switchAiTab(recommend ? 'recommend' : 'breakdown');
  renderTaskList();
}

function applyIdentity(data) {
  const permissions = new Set(data?.permissions || []);
  const nextUser = data?.user || null;
  const changed = authState.user?.id !== nextUser?.id || permissions.size !== authState.permissions.size ||
    [...permissions].some((code) => !authState.permissions.has(code));
  authState.user = nextUser;
  authState.roles = data?.roles || [];
  authState.permissions = permissions;
  if (changed) {
    authState.csrf = data?.csrf_token || null;
    clearPrivateData();
  }
  if (data?.csrf_token) authState.csrf = data.csrf_token;
  renderPermissions();
  if (changed && hasPermissions('task:read')) loadTasks();
}

function refreshIdentity() {
  if (!identityRefresh) {
    identityRefresh = request('/api/auth/me').then(applyIdentity).catch((error) => {
      if (error.code === 'AUTH_REQUIRED') {
        applyIdentity(null);
        openAuth();
      } else if (error.name !== 'AbortError') {
        if (!authState.user) renderPermissions();
        showToast(error.message, 'error');
      }
    }).finally(() => { identityRefresh = null; });
  }
  return identityRefresh;
}

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  access('auth-heading').textContent = registering ? '注册澄序账号' : '登录澄序';
  access('auth-submit').textContent = registering ? '注册' : '登录';
  access('auth-switch').textContent = registering ? '返回登录' : '注册账号';
  access('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  access('auth-password').value = '';
  access('auth-feedback').textContent = '';
}

function openAuth() {
  if (authDialog.open) return;
  setAuthMode('login');
  authDialog.showModal();
  getCsrf().catch((error) => {
    if (error.name !== 'AbortError') access('auth-feedback').textContent = error.message;
  });
}

document.querySelectorAll('[data-dialog-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
authDialog.addEventListener('close', () => { access('auth-password').value = ''; });
access('auth-open').addEventListener('click', openAuth);
access('auth-switch').addEventListener('click', () => {
  if (registrationEnabled) setAuthMode(authMode === 'login' ? 'register' : 'login');
});
access('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = access('auth-feedback');
  const submit = access('auth-submit');
  const mode = authMode;
  const payload = { username: access('auth-username').value, password: access('auth-password').value };
  submit.disabled = access('auth-switch').disabled = true;
  feedback.textContent = '';
  try {
    const data = await request(`/api/auth/${mode}`, jsonOptions('POST', payload));
    if (mode === 'register') {
      setAuthMode('login');
      access('auth-username').value = data.username;
      feedback.textContent = '注册成功，请登录。';
      access('auth-password').focus();
    } else {
      applyIdentity(data);
      access('auth-form').reset();
      authDialog.close();
      access('auth-logout').focus();
    }
  } catch (error) {
    if (error.name !== 'AbortError') feedback.textContent = error.message;
  } finally {
    access('auth-password').value = '';
    submit.disabled = access('auth-switch').disabled = false;
  }
});
access('auth-logout').addEventListener('click', async () => {
  const button = access('auth-logout');
  button.disabled = true;
  try {
    await request('/api/auth/logout', { method: 'POST' });
    applyIdentity(null);
    openAuth();
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

let roleCatalog = [];
let adminTarget = null;
let adminPage = 1;
let adminListVersion = 0;
let adminDetailVersion = 0;
let transferTask = null;
let transferSearchVersion = 0;
const adminFeedback = (message) => { access('admin-feedback').textContent = message; };
const transferFeedback = (message) => { access('transfer-feedback').textContent = message; };

function showRoleCatalog(roles) {
  roleCatalog = roles;
  access('admin-roles').replaceChildren(...roles.map((role) => {
    const box = document.createElement('details');
    const heading = document.createElement('summary');
    heading.textContent = role.name;
    const description = document.createElement('p');
    description.textContent = `${role.description}：${role.permissions.join('、')}`;
    box.append(heading, description);
    return box;
  }));
}

async function selectAdminUser(id) {
  const version = ++adminDetailVersion;
  adminFeedback('');
  try {
    const user = await request(`/api/admin/users/${id}`);
    if (!adminDialog.open || version !== adminDetailVersion) return;
    adminTarget = user;
    const own = id === authState.user.id;
    access('admin-edit').hidden = false;
    access('admin-target').textContent = `${user.username}${own ? '（本人）' : ''}`;
    access('admin-role-fields').hidden = !hasPermissions('role:manage');
    access('admin-role-fields').disabled = own;
    access('admin-role-options').replaceChildren(...roleCatalog.map((role) => {
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = role.code;
      check.checked = user.roles.includes(role.code);
      label.append(check, ` ${role.name}`);
      return label;
    }));
    const toggle = access('admin-toggle-active');
    toggle.textContent = user.is_active ? '禁用账号' : '启用账号';
    toggle.disabled = own;
  } catch (error) {
    if (error.name !== 'AbortError' && version === adminDetailVersion) adminFeedback(error.message);
  }
}

async function loadAdminUsers(page = 1) {
  const version = ++adminListVersion;
  try {
    const query = new URLSearchParams({ page, limit: 20, q: access('admin-query').value.trim() });
    const { items, total, limit } = await request(`/api/admin/users?${query}`);
    if (!adminDialog.open || version !== adminListVersion) return;
    adminPage = page;
    access('admin-page').textContent = `第 ${page} 页 · 共 ${total} 人`;
    access('admin-prev').disabled = page <= 1;
    access('admin-next').disabled = page * limit >= total;
    access('admin-list').replaceChildren(...items.map((user) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-subtle';
      button.textContent = `${user.username} · ${user.roles.map((code) => roleNames[code] || code).join(' / ')} · ${user.is_active ? '有效' : '已禁用'}`;
      button.addEventListener('click', () => selectAdminUser(user.id));
      item.append(button);
      return item;
    }));
  } catch (error) {
    if (error.name !== 'AbortError' && version === adminListVersion) adminFeedback(error.message);
  }
}

access('admin-open').addEventListener('click', async () => {
  adminTarget = null;
  access('admin-edit').hidden = true;
  access('admin-users').hidden = !hasPermissions('user:manage');
  access('admin-role-catalog').hidden = !hasPermissions('role:manage');
  access('admin-list').replaceChildren();
  access('admin-roles').replaceChildren();
  adminFeedback('');
  adminDialog.showModal();
  if (hasPermissions('role:manage')) {
    try {
      const { roles } = await request('/api/admin/roles');
      if (adminDialog.open) showRoleCatalog(roles);
    } catch (error) {
      if (error.name !== 'AbortError') adminFeedback(error.message);
    }
  }
  if (hasPermissions('user:manage') && adminDialog.open) loadAdminUsers();
});
access('admin-search').addEventListener('submit', (event) => { event.preventDefault(); loadAdminUsers(); });
access('admin-prev').addEventListener('click', () => loadAdminUsers(adminPage - 1));
access('admin-next').addEventListener('click', () => loadAdminUsers(adminPage + 1));

async function saveAdminUser(path, options, button, id) {
  button.disabled = true;
  let notice = '';
  try {
    await request(path, options);
    notice = '已更新账号。';
    if (adminTarget?.id === id && adminDialog.open) await selectAdminUser(id);
    await loadAdminUsers(adminPage);
  } catch (error) {
    if (error.name === 'AbortError') return;
    notice = error.message;
    if (error.status === 409 && adminTarget?.id === id) await selectAdminUser(id);
  } finally {
    button.disabled = adminTarget?.id === authState.user?.id;
  }
  if (adminDialog.open) adminFeedback(notice);
}

access('admin-edit').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = adminTarget;
  if (!target || target.id === authState.user.id) return;
  const roles = [...access('admin-role-options').querySelectorAll(':checked')].map((input) => input.value);
  if (!roles.length) { adminFeedback('请至少选择一个角色。'); return; }
  if (!window.confirm(`将 ${target.username} 的全部角色替换为「${roles.map((role) => roleNames[role] || role).join('、')}」？`)) return;
  saveAdminUser(`/api/admin/users/${target.id}/roles`, jsonOptions('PUT', { roles }), access('admin-save-roles'), target.id);
});
access('admin-toggle-active').addEventListener('click', (event) => {
  const target = adminTarget;
  if (!target || target.id === authState.user.id) return;
  if (!window.confirm(`${target.is_active ? '禁用' : '启用'} ${target.username}？`)) return;
  saveAdminUser(`/api/admin/users/${target.id}`, jsonOptions('PATCH', { is_active: !target.is_active }), event.currentTarget, target.id);
});

function openTransfer(task) {
  transferTask = task;
  access('transfer-search').reset();
  access('transfer-task-name').textContent = task.title;
  transferDialog.showModal();
  loadTransferUsers();
}

async function loadTransferUsers() {
  const version = ++transferSearchVersion;
  const select = access('transfer-user');
  select.replaceChildren();
  access('transfer-submit').disabled = true;
  transferFeedback('正在查找用户…');
  try {
    const query = new URLSearchParams({ limit: 50, q: access('transfer-query').value.trim() });
    const { items } = await request(`/api/admin/users?${query}`);
    if (!transferDialog.open || version !== transferSearchVersion) return;
    const users = items.filter((user) => user.is_active && user.id !== transferTask.owner_id);
    select.replaceChildren(new Option('请选择', ''), ...users.map((user) => new Option(user.username, String(user.id))));
    transferFeedback(users.length ? '转交后，原归属人不再拥有此任务。' : '未找到可转交的用户，请换个关键词。');
  } catch (error) {
    if (error.name !== 'AbortError' && version === transferSearchVersion) transferFeedback(error.message);
  }
}

access('transfer-search').addEventListener('submit', (event) => { event.preventDefault(); loadTransferUsers(); });
access('transfer-user').addEventListener('change', () => { access('transfer-submit').disabled = !access('transfer-user').value; });
access('transfer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = access('transfer-user');
  const task = transferTask;
  if (!task || !target.value || !window.confirm(`确认把任务转交给 ${target.selectedOptions[0].textContent}？`)) return;
  const button = access('transfer-submit');
  button.disabled = true;
  try {
    await request(`/api/admin/tasks/${task.id}/owner`, jsonOptions('PUT', { owner_id: Number(target.value) }));
    if (transferTask === task) transferDialog.close();
    showToast('任务已转交。', 'success');
    await loadTasks();
  } catch (error) {
    if (error.name !== 'AbortError') transferFeedback(error.message);
  } finally {
    button.disabled = !target.value;
  }
});

refreshIdentity();
