import React from 'react';
import { Typography } from 'antd';

const { Text, Title, Paragraph } = Typography;

/*
 * VL P0 shared page header (设计稿-VL-P0-四组件API-20260802).
 * Standardizes the hand-rolled hero blocks: optional kicker, visual title,
 * description, and a right-hand slot for actions or meta tags. The visual
 * title is aria-hidden by design — the real page h1 stays with App's
 * ModuleSemanticHeading, which the skip link targets; heroes that skipped
 * the attribute were double-announcing the page name.
 * When migrating a surface, pass its existing hero className through:
 * gates and CSS address heroes by those names.
 */
export default function PageHeader({ className = '', kicker, title, description, actions, titleLevel = 2 }) {
  return (
    <div className={className ? `vl-page-header ${className}` : 'vl-page-header'}>
      <div>
        {kicker ? <Text className="vl-page-header-kicker">{kicker}</Text> : null}
        <Title level={titleLevel} aria-hidden="true">{title}</Title>
        {description ? <Paragraph className="vl-page-header-copy">{description}</Paragraph> : null}
      </div>
      {actions || null}
    </div>
  );
}
