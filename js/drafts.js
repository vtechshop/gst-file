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

function checkForDraft(formKey, fieldIds, bannerContainerId) {
  const raw = localStorage.getItem(draftKey(formKey));
  if (!raw) return;
  let draft;
  try { draft = JSON.parse(raw); } catch { return; }
  if (!draft?.fields) return;

  const container = document.getElementById(bannerContainerId);
  if (!container) return;

  const when = new Date(draft.savedAt).toLocaleString('en-IN');
  container.innerHTML = `
    <div class="banner-success mb-16">
      <i class="fas fa-clock-rotate-left"></i>
      <div class="banner-text d-flex align-center gap-10 flex-wrap">
        <span>You have an unsaved draft from ${when}.</span>
        <button type="button" class="btn btn-primary btn-sm" onclick="restoreDraft('${formKey}', ${JSON.stringify(fieldIds).replace(/"/g, '&quot;')})">Restore</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="discardDraft('${formKey}', '${bannerContainerId}')">Discard</button>
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
