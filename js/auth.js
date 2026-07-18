// =============================================
// Authentication Module
// =============================================

async function requireAuth() {
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return null; }
    if (typeof syncProductsIfNeeded === 'function') syncProductsIfNeeded(session.user.id);
    return session.user;
  } catch {
    window.location.href = 'index.html';
    return null;
  }
}

async function getCurrentUser() {
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    return session ? session.user : null;
  } catch {
    return null;
  }
}

async function logout() {
  // apiClient.js's signOut() already redirects to index.html itself.
  await _supabase.auth.signOut();
}

function initNavUser(user) {
  const el = document.getElementById('navUserName');
  if (el && user) {
    el.textContent = user.name || user.user_metadata?.name || user.email || 'GST Manager';
  }
}

function setupLogoutBtn() {
  const btn = document.getElementById('logoutBtn');
  if (btn) btn.addEventListener('click', logout);
}
