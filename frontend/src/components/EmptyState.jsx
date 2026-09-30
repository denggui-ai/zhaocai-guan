import React from 'react';
import { Empty } from 'antd';

/*
 * VL P0 shared empty surface (设计稿-VL-P0-四组件API-20260802).
 * Empty means "no data yet", never "read failed": failures stay on inline
 * alerts, so an EmptyState must not carry an error message. Compact is the
 * default — the reaudit scored the raw empty areas as oversized dead zones;
 * pass compact={false} only where the empty state owns its whole pane.
 */
export default function EmptyState({ title, hint, action, compact = true, ...rest }) {
  return (
    <Empty
      className={compact ? 'vl-empty-state vl-empty-state-compact' : 'vl-empty-state'}
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={(
        <span className="vl-empty-state-description">
          <strong className="vl-empty-state-title">{title}</strong>
          {hint ? <span className="vl-empty-state-hint">{hint}</span> : null}
        </span>
      )}
      {...rest}
    >
      {action || null}
    </Empty>
  );
}
