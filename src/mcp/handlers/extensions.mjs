import { handleI18nAction } from '../../core/i18n/index.mjs';
import { handleGovernanceAction } from '../../core/governance/index.mjs';
import { handleAppearanceAction } from '../../core/appearance/index.mjs';

function toolOk(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export async function handleI18nManage(args, options) {
  const res = await handleI18nAction(args, options);
  return toolOk('ok', res);
}

export function handleGovernanceManage(args, options) {
  const res = handleGovernanceAction(args, options);
  return toolOk('ok', res);
}

export async function handleAppearanceManage(args, options) {
  const res = await handleAppearanceAction(args, options);
  return toolOk('ok', res);
}
