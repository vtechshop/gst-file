// =============================================
// Authentication Module
// =============================================

async function requireAuth() {
  if (IS_LOCAL_MODE) return LOCAL_USER;
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return null; }
    return session.user;
  } catch {
    return LOCAL_USER;
  }
}

async function getCurrentUser() {
  if (IS_LOCAL_MODE) return LOCAL_USER;
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    return session ? session.user : LOCAL_USER;
  } catch {
    return LOCAL_USER;
  }
}

async function logout() {
  if (!IS_LOCAL_MODE) await _supabase.auth.signOut();
  window.location.href = 'index.html';
}

async function getProfile(userId) {
  const { data, error } = await _supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) return null;
  return data;
}

async function updateProfile(userId, updates) {
  return await _supabase.from('profiles').update(updates).eq('id', userId);
}

function initNavUser(user) {
  const el = document.getElementById('navUserName');
  if (el && user) {
    el.textContent = user.user_metadata?.name || user.email || 'GST Manager';
  }
}

function setupLogoutBtn() {
  const btn = document.getElementById('logoutBtn');
  if (btn) btn.addEventListener('click', logout);
}
