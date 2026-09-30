import React from 'react';
import { Tag } from 'antd';

/*
 * Visual Language v1 status dictionary (VL-001).
 * One module owns the status-semantics-to-color mapping so a surface can
 * never pick a reversed color again (green 已关闭, gold 非阻断 — the class
 * of defects the 2026-07-31 reaudit demoted the status-semantics score for).
 * New status tags go through SemanticTag; raw <Tag color> stays only where
 * the color is not a status statement.
 */
export const STATUS_KIND_COLORS = Object.freeze({
  success: 'green', // 正向结果：已完成、已通过、已归档、无待办
  active: 'blue', // 正在进行：运行中、读取中、正在测试
  waiting: 'gold', // 等待人工：待处理、待确认、需复检
  degraded: 'orange', // 需注意但未终止：降级、旧数据可重试、渠道已中断
  failure: 'red', // 失败或终止：错误、预检未通过、已撤销
  neutral: 'default', // 状态说明与历史事实：操作只读、岗位已关闭、原因回溯
});

export default function SemanticTag({ kind = 'neutral', ...rest }) {
  return <Tag color={STATUS_KIND_COLORS[kind] || STATUS_KIND_COLORS.neutral} {...rest} />;
}
