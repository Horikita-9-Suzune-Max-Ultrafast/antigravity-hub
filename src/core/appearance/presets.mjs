/**
 * Built-in ambient gradient presets were removed in v1.5.4.
 * Retained only for backward-compatible legacy config detection and empty export safety.
 */
export const LEGACY_WALLPAPER_PRESET_IDS = new Set([
  'aurora-mist',
  'nebula-dusk',
  'minimal-paper',
]);

export const WALLPAPER_PRESETS = [];

export function isLegacyPresetId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('preset:')) return true;
  return LEGACY_WALLPAPER_PRESET_IDS.has(trimmed);
}

export function getPresetById() {
  return null;
}
