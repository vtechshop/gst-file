// =============================================
// Authentication Module
// =============================================

async function requireAuth() {
  try {
    const { data: { session }, reason } = await _supabase.auth.getSession();
    if (!session) {
      // A session can be absent for two very different reasons, and
      // treating them alike was wrong: the server REJECTED the token (it
      // is expired or invalid — sign in again), or the check never
      // reached the server at all (offline, backend asleep, or a reload
      // racing the request). apiClient.js already takes care not to
      // discard a still-valid token in the second case; bouncing to the
      // login page anyway undid that, dumping the user out of a session
      // that was fine. So the network case now stays put and says so.
      if (reason === 'network') {
        if (typeof showToast === 'function') {
          showToast('Could not reach the server — your session is still active. Reload once it is back.', 'warning');
        }
        return null;
      }
      window.location.href = 'index.html';
      return null;
    }
    if (typeof syncProductsIfNeeded === 'function') syncProductsIfNeeded(session.user.id);
    return session.user;
  } catch (err) {
    console.error('[auth] session check failed unexpectedly', err);
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
