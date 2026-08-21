// =============================================
// Draft Autosave + Recovery
// Generic helper used by entry forms (B2B, B2C, ...).
// Saves field values to localStorage as the user types and
// offers to restore them if the page is reopened before save.
// =============================================

function draftKey(formKey) { return `gst_draft_${formKey}`; }

function setupDraftAutosave(formKey, fieldIds) {
  let timer = null;
  const save = () => {
    const fields = {};
    fieldIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) fields[id] = el.value;
    });
    // Don't persist a draft that's entirely empty.
    if (Object.values(fields).every(v => !v)) return;
    localStorage.setItem(draftKey(formKey), JSON.stringify({ fields, savedAt: new Date().toISOString() }));
  };
  fieldIds.forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(save, 500);
    });
  });
}

// restoreFnName/discardFnName are optional — pass them (each called with
// just formKey) when a form needs to restore/discard more than the fixed
// fields here (e.g. B2B/B2C invoice entry also has a dynamic product
// line-item table tracked separately by js/invoice-items.js). Omit them
// to keep today's exact behavior.
function checkForDraft(formKey, fieldIds, bannerContainerId, restoreFnName, discardFnName) {
  const raw = localStorage.getItem(draftKey(formKey));
  let draft = null;
  if (raw) { try { draft = JSON.parse(raw); } catch { draft = null; } }
  const hasFieldDraft = !!draft?.fields && Object.values(draft.fields).some(v => v);
  const hasItemsDraftForForm = typeof hasItemsDraft === 'function' && hasItemsDraft(formKey);
  if (!hasFieldDraft && !hasItemsDraftForForm) return;

  const container = document.getElementById(bannerContainerId);
  if (!container) return;

  const when = draft?.savedAt ? new Date(draft.savedAt).toLocaleString('en-IN') : 'a previous session';
  const restoreCall = restoreFnName ? `${restoreFnName}('${formKey}')` : `restoreDraft('${formKey}', ${JSON.stringify(fieldIds).replace(/"/g, '&quot;')})`;
  const discardCall = discardFnName ? `${discardFnName}('${formKey}')` : `discardDraft('${formKey}', '${bannerContainerId}')`;

  container.innerHTML = `
    <div class="banner-success mb-16">
      <i class="fas fa-clock-rotate-left"></i>
      <div class="banner-text d-flex align-center gap-10 flex-wrap">
        <span>You have an unsaved draft from ${when}.</span>
        <button type="button" class="btn btn-primary btn-sm" onclick="${restoreCall}">Restore</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="${discardCall}">Discard</button>
      </div>
    </div>`;
}

function restoreDraft(formKey, fieldIds) {
  const raw = localStorage.getItem(draftKey(formKey));
  if (!raw) return;
  let draft;
  try { draft = JSON.parse(raw); } catch { return; }
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (el && draft.fields[id] !== undefined) {
      el.value = draft.fields[id];
      el.dispatchEvent(new Event('input'));
    }
  });
  showToast('Draft restored.', 'success');
}

function discardDraft(formKey, bannerContainerId) {
  localStorage.removeItem(draftKey(formKey));
  const container = document.getElementById(bannerContainerId);
  if (container) container.innerHTML = '';
}

function clearDraft(formKey) {
  localStorage.removeItem(draftKey(formKey));
}
