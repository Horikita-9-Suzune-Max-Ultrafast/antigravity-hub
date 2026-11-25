/**
 * Modal lifecycle controller aligned with closed-state display:none GPU guarantee.
 */

export const DEFAULT_MODAL_IDS = [
  'capsuleModal',
  'quotaModal',
  'addMemModal',
  'i18nPatchConfirmModal',
  'i18nEntryModal',
  'i18nImportModal',
  'appRotationPoolModal',
  'restartIdeModal',
  'assetInspectorModal',
  'reviewImportModal',
];

export function createModalController({ onOpen, onClose, modalIds = DEFAULT_MODAL_IDS } = {}) {
  function openModal(id) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.open = 'true';
    onOpen?.(id, el);
  }

  function closeModal(id) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.dataset.open !== 'false') {
      el.dataset.open = 'false';
      onClose?.(id, el);
    }
  }

  function closeAllModals() {
    for (const id of modalIds) {
      closeModal(id);
    }
    if (typeof document !== 'undefined') {
      document.getElementById('govLintFixModal')?.classList.add('hidden');
      document.getElementById('govConfirmModal')?.classList.add('hidden');
      document.getElementById('govPreviewModal')?.classList.add('hidden');
    }
  }

  function isModalOpen(id) {
    if (typeof document === 'undefined') return false;
    return document.getElementById(id)?.dataset.open === 'true';
  }

  return {
    openModal,
    closeModal,
    closeAllModals,
    isModalOpen,
  };
}
