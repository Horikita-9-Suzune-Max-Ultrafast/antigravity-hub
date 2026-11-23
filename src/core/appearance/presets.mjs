/**
 * 100% original pure-CSS ambient gradient presets (0 external images, 0 copyright risk).
 */
export const WALLPAPER_PRESETS = [
  {
    id: 'aurora-mist',
    name: '极光蓝青',
    desc: '深邃静谧的蓝青微光渐变，暗色/浅色主题均柔和护眼。',
    darkCss:
      'radial-gradient(120% 90% at 15% 12%, rgba(56, 189, 248, 0.55), transparent 58%), radial-gradient(100% 80% at 88% 22%, rgba(16, 185, 129, 0.45), transparent 55%), radial-gradient(95% 85% at 50% 95%, rgba(59, 130, 246, 0.42), transparent 62%), linear-gradient(145deg, #0b1630 0%, #102a43 52%, #0c262c 100%)',
    lightCss:
      'radial-gradient(115% 85% at 14% 12%, rgba(59, 130, 246, 0.42), transparent 58%), radial-gradient(100% 80% at 86% 24%, rgba(16, 185, 129, 0.36), transparent 55%), radial-gradient(95% 85% at 48% 92%, rgba(14, 165, 233, 0.34), transparent 62%), linear-gradient(145deg, #dbeafe 0%, #d1fae5 52%, #e0f2fe 100%)',
  },
  {
    id: 'nebula-dusk',
    name: '星云紫金',
    desc: '低饱和度暮色紫与暖琥珀流光，适合长时间沉浸编码。',
    darkCss:
      'radial-gradient(110% 85% at 18% 18%, rgba(167, 139, 250, 0.52), transparent 58%), radial-gradient(95% 80% at 85% 78%, rgba(251, 191, 36, 0.38), transparent 56%), radial-gradient(90% 70% at 72% 14%, rgba(244, 114, 182, 0.36), transparent 54%), linear-gradient(150deg, #1e1038 0%, #2b1848 55%, #26182c 100%)',
    lightCss:
      'radial-gradient(110% 85% at 18% 18%, rgba(139, 92, 246, 0.38), transparent 58%), radial-gradient(95% 80% at 85% 78%, rgba(245, 158, 11, 0.34), transparent 56%), radial-gradient(90% 70% at 72% 14%, rgba(236, 72, 153, 0.28), transparent 54%), linear-gradient(150deg, #ede9fe 0%, #fef3c7 55%, #fce7f3 100%)',
  },
  {
    id: 'minimal-paper',
    name: '极简晨雾',
    desc: '温润雾蓝与浅青岚层次，克制耐看不干扰阅读。',
    darkCss:
      'radial-gradient(100% 75% at 80% 10%, rgba(148, 163, 184, 0.42), transparent 56%), radial-gradient(90% 80% at 12% 88%, rgba(52, 211, 153, 0.34), transparent 58%), linear-gradient(160deg, #162032 0%, #1e293b 55%, #16282a 100%)',
    lightCss:
      'radial-gradient(100% 75% at 80% 10%, rgba(100, 116, 139, 0.32), transparent 56%), radial-gradient(90% 80% at 12% 88%, rgba(20, 184, 166, 0.28), transparent 58%), linear-gradient(160deg, #e2e8f0 0%, #cbd5e1 55%, #ccfbf1 100%)',
  },
];

export function getPresetById(id) {
  return WALLPAPER_PRESETS.find((p) => p.id === id) || WALLPAPER_PRESETS[0];
}
