export function deepProfileErrorMessage(error) {
  const raw = String(typeof error === 'string' ? error : error?.message || '').trim();
  if (/JOB_ACTIVE_JD_REQUIRED|还没有已启用 JD/.test(raw)) {
    return '当前岗位还没有已启用 JD。请先到“职位管理”启用 JD，再生成深度画像。';
  }
  if (/JOB_CURRENT_PROFILE_REQUIRED|当前 JD 还没有已确认画像/.test(raw)) {
    return '当前 JD 还没有已确认画像。请先到“职位管理”确认简版岗位画像，再生成深度画像。';
  }
  if (/JOB_INTERVIEW_REQUIRED|还没有访谈记录|还没有访谈材料/.test(raw)) {
    return '还没有访谈材料。请先在本页保存负责人访谈转写，再生成深度画像。';
  }
  if (/JOB_CLOSED|已关闭/.test(raw)) {
    return '当前岗位已关闭。请重新开启岗位后再生成深度画像。';
  }
  if (/JOB_PROFILE_CONTEXT_CHANGED|JD、画像或访谈材料已在生成期间变化/.test(raw)) {
    return '岗位 JD、画像或访谈材料已变化，本次旧结果未保存。请刷新后基于最新材料重新生成。';
  }
  const withoutIpcEnvelope = raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  if (!withoutIpcEnvelope || /Error invoking remote method/i.test(withoutIpcEnvelope)) {
    return '生成画像前置条件检查失败，请刷新后重试。';
  }
  return withoutIpcEnvelope;
}
