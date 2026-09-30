import React, { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Input, InputNumber, Progress, Segmented, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  ProfileOutlined,
  ReloadOutlined,
  TeamOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { clean, fmtTime, has, joinParts } from '../api.js';
import { getJobManagementDemo, JOB_STATUS_META } from '../fixtures/job-management-demo.js';
import { analyzeJdRecommendationRisk } from '../fixtures/jd-recommendation-diagnostics.js';
import { SabcBadge } from './CandidateList.jsx';
import {
  createJobManagementActionAdapter,
  JOB_MANAGEMENT_ACTION_SCHEMA,
  JOB_MANAGEMENT_SECTIONS,
  JobManagementWorkspace,
} from './job-management-workspace.jsx';

const { Paragraph, Text, Title } = Typography;

async function copyTextToClipboard(text) {
  if (!present(text)) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

function percent(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 1)) * 100)));
}

function statusMeta(status) {
  return JOB_STATUS_META[status] || JOB_STATUS_META.published;
}

function statusTag(status) {
  const meta = statusMeta(status);
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function actionTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function compareCandidatePriority(a, b) {
  const rank = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  const tierDiff = (rank[clean(a.sabc).toUpperCase()] ?? 5) - (rank[clean(b.sabc).toUpperCase()] ?? 5);
  if (tierDiff !== 0) return tierDiff;
  const createdDiff = clean(b.created_at).localeCompare(clean(a.created_at));
  if (createdDiff !== 0) return createdDiff;
  return clean(b.internal_id).localeCompare(clean(a.internal_id));
}

function countByText(candidates, pattern) {
  return candidates.filter((candidate) => pattern.test(`${candidate.comm_status || ''} ${candidate.disposition_status || ''}`)).length;
}

function deriveFunnel(candidates, demo) {
  const total = candidates.length || demo.demoFunnel.recommended;
  const scored = candidates.length
    ? candidates.filter((candidate) => has(candidate.sabc)).length
    : Math.max(0, Math.round(total * 0.68));
  const untouched = candidates.length
    ? candidates.filter((candidate) => clean(candidate.comm_status) === '未打招呼').length
    : Math.max(0, Math.round(total * 0.42));
  const contacted = candidates.length
    ? candidates.filter((candidate) => clean(candidate.comm_status) && clean(candidate.comm_status) !== '未打招呼').length
    : demo.demoFunnel.contacted;
  const replied = candidates.length
    ? countByText(candidates, /回复|沟通|有意向|面试|约面/)
    : demo.demoFunnel.replied;
  const interview = candidates.length
    ? countByText(candidates, /面试|约面|待面|已面/)
    : demo.demoFunnel.interview;

  return [
    { key: 'exposure', label: '曝光/浏览', value: demo.demoFunnel.viewed, total: demo.demoFunnel.exposure, hint: `${demo.demoFunnel.exposure} 次曝光` },
    { key: 'recommended', label: '推荐候选人', value: total, total: Math.max(total, demo.demoFunnel.recommended), hint: candidates.length ? '本地已入库' : '样例估算' },
    { key: 'scored', label: '已评级', value: scored, total, hint: 'S/A/B/C/D 规则/人工评级' },
    { key: 'untouched', label: '待联系', value: untouched, total, hint: '未打招呼' },
    { key: 'contacted', label: '已沟通', value: contacted, total, hint: '已触达或已回复' },
    { key: 'interview', label: '面试中', value: interview, total, hint: '约面/面试状态' },
  ];
}

function deriveRisks({ demo, candidates, status }) {
  const rows = [];
  const total = candidates.length;
  const unscored = total ? candidates.filter((candidate) => !has(candidate.sabc)).length : 0;

  if (demo.isFixture) {
    rows.push({ level: 'medium', title: '测试岗位', desc: '当前岗位来自 fixture，只适合离线验收。' });
  }
  if (status === 'paused') {
    rows.push({ level: 'medium', title: '岗位暂停中', desc: '候选人池会继续展示，但发布、刷新等动作在本页只做演示。' });
  }
  if (status === 'closed') {
    rows.push({ level: 'medium', title: '岗位已关闭', desc: '当前只是在本地视图中关闭。' });
  }
  const jdSource = demo.jdAssistant || demo.jdAiDraft || {};
  const jdMissingCount = (jdSource.missingInfo || jdSource.missingFields || []).length;
  const complianceItems = jdSource.complianceChecks || jdSource.complianceRiskCheck?.items || [];
  const jdWarningCount = complianceItems.filter((item) => /warn|risk|medium|high|warning/i.test(String(item.status || item.level || ''))).length;
  if (jdMissingCount || jdWarningCount) {
    rows.push({ level: 'medium', title: '职位描述待补全', desc: `AI 帮写发现 ${jdMissingCount + jdWarningCount} 个信息缺口，发布前建议 HR 人工确认。` });
  }
  if (!total) {
    rows.push({ level: 'high', title: '候选池为空', desc: '岗位还没有本地候选人，无法判断漏斗质量。' });
  } else if (percent(unscored, total) >= 40) {
    rows.push({ level: 'medium', title: '评级覆盖不足', desc: `${unscored} 位候选人还没有 SABC 规则或人工评级，排序参考价值有限。` });
  }
  return [...rows, ...demo.risks].slice(0, 5);
}

function present(value) {
  if (value == null) return false;
  if (typeof value === 'string') return clean(value).length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function readFirst(source, keys, fallback) {
  if (!source) return fallback;
  for (const key of keys) {
    if (present(source[key])) return source[key];
  }
  return fallback;
}

function displayText(value) {
  if (!present(value)) return '';
  if (Array.isArray(value)) return value.map(displayText).filter(present).join('、');
  if (typeof value === 'object') {
    return clean(
      value.text ||
      value.label ||
      value.title ||
      value.name ||
      value.field ||
      value.desc ||
      value.detail ||
      value.message ||
      value.suggestion ||
      value.value ||
      Object.values(value).map(displayText).filter(present).join('、')
    );
  }
  return clean(String(value));
}

function normalizeEditDraft(draft) {
  return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
}

function getLocalEditDraft(local) {
  return normalizeEditDraft(local?.editDraft);
}

function hasDraftValue(draft, key) {
  return Object.prototype.hasOwnProperty.call(draft || {}, key);
}

function readDraftValue(draft, key, fallback) {
  if (!hasDraftValue(draft, key)) return fallback;
  return present(draft[key]) ? draft[key] : fallback;
}

function textEditorValue(draft, key, fallback) {
  const value = hasDraftValue(draft, key) ? draft[key] : fallback;
  return value == null ? '' : String(value);
}

function numberEditorValue(draft, key, fallback) {
  const value = hasDraftValue(draft, key) ? draft[key] : fallback;
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function deriveDisplayJob(demo, localEditDraft, job) {
  const form = demo.publishForm || {};
  const profile = demo.profile || {};
  const jdSource = demo.jdAssistant || demo.jdAiDraft || {};
  const fallbackJobTitle = form.jobTitle || job?.name || profile.title || demo.name || '当前岗位';
  const fallbackSimpleNeed = readFirst(
    jdSource,
    ['simpleNeed', 'simpleRequirement', 'need', 'prompt', 'brief', 'requirementBrief'],
    demo.hiringGoal || form.descriptionHint || profile.summary || `为${fallbackJobTitle}生成职位描述`
  );
  const draft = normalizeEditDraft(localEditDraft);
  return {
    jobTitle: readDraftValue(draft, 'jobTitle', fallbackJobTitle),
    city: readDraftValue(draft, 'city', demo.city),
    salary: readDraftValue(draft, 'salary', demo.salary),
    headcount: readDraftValue(draft, 'headcount', demo.headcount),
    openDays: readDraftValue(draft, 'openDays', demo.openDays),
    simpleNeed: readDraftValue(draft, 'simpleNeed', fallbackSimpleNeed),
    jdDescription: readDraftValue(draft, 'jdDescription', ''),
  };
}

function toTextList(value) {
  if (!present(value)) return [];
  if (Array.isArray(value)) return value.map(displayText).filter(present);
  if (typeof value === 'object') {
    if (Array.isArray(value.items)) return toTextList(value.items);
    return Object.entries(value).map(([key, item]) => {
      if (!present(item)) return '';
      if (typeof item === 'boolean') return `${key}：${item ? '通过' : '需处理'}`;
      return `${key}：${displayText(item)}`;
    }).filter(present);
  }
  return clean(String(value)).split(/\n+/).map((item) => clean(item)).filter(present);
}

function normalizeCheckItems(value, fallback) {
  const raw = present(value) ? value : fallback;
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && (raw.label || raw.title || raw.name)
      ? [raw]
      : raw && typeof raw === 'object'
        ? Object.entries(raw).map(([label, item]) => ({
          label,
          status: typeof item === 'boolean' ? (item ? 'pass' : 'warn') : item && typeof item === 'object' ? readFirst(item, ['status', 'level'], 'neutral') : item,
          detail: item && typeof item === 'object' ? displayText(item.detail || item.desc || item.message) : '',
        }))
        : [raw];

  return items.map((item, index) => {
    if (!present(item)) return null;
    if (typeof item === 'string') {
      return { key: `${item}-${index}`, label: item, status: 'neutral', detail: '' };
    }
    if (typeof item !== 'object') {
      const label = displayText(item);
      return { key: `${label}-${index}`, label, status: 'neutral', detail: '' };
    }
    const label = displayText(item.label || item.title || item.name || item.text || item.message || item.detail || item.desc || item.key);
    const status = item.status || item.level || (item.pass === true ? 'pass' : item.pass === false ? 'warn' : 'neutral');
    return {
      key: item.key || label || `check-${index}`,
      label,
      status,
      detail: displayText(item.detail || item.desc || (item.label || item.title || item.name || item.text ? item.message : '')),
    };
  }).filter((item) => item && present(item.label));
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function uniqueList(items) {
  return [...new Set((items || []).map((item) => clean(item)).filter(Boolean))];
}

function formatJdFullText({ goal, responsibilities, requirements, benefits }) {
  const sections = [
    ['岗位目标', toTextList(goal)],
    ['岗位职责', toTextList(responsibilities)],
    ['任职要求', toTextList(requirements)],
    ['岗位福利', toTextList(benefits)],
  ];
  return sections
    .filter(([, items]) => items.length)
    .map(([title, items]) => `【${title}】\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`)
    .join('\n\n');
}

function buildOptimizedJdDraft(demo, displayJob, version) {
  const inputText = clean(`${displayJob.jobTitle || ''} ${displayJob.simpleNeed || ''} ${displayJob.jdDescription || ''}`);
  const jobTitle = displayJob.jobTitle || demo.profile?.title || demo.name || '电商运营';
  const isDouyin = includesAny(inputText, ['抖音', '千川', '商品卡', '巨量', '达人', '短视频']);
  const isCrossBorder = /跨境|Amazon|亚马逊|Shopee|TikTok Shop|独立站|Listing/i.test(inputText);
  const isDomestic = includesAny(inputText, ['天猫', '淘宝', '京东', '拼多多', '电商', '店铺', '活动']);
  const hasMetrics = /GMV|ROI|CTR|CVR|转化|曝光|点击|客单价|投产/i.test(inputText);
  const hasBenefits = /福利|社保|五险|双休|单休|大小周|上班|作息|提成|绩效|奖金/.test(inputText);
  const hasCategory = /品类|类目|美妆|滋补|食品|服饰|家居|SKU|客单价|商品/.test(inputText);
  const hasBudget = /预算|日限额|月预算|投放|千川|直通车|万相台|广告/.test(inputText);
  const hasTeam = /团队|汇报|协同|设计|客服|仓储|供应链|达人/.test(inputText);

  let goal;
  let responsibilities;
  let requirements;
  let scenario;

  if (isDouyin) {
    scenario = '抖音店铺增长型运营';
    goal = `围绕${jobTitle}岗位，通过商品卡自然流量、千川投流、达人分发和数据复盘组合策略，提升店铺 GMV、ROI、CTR 与 CVR。`;
    responsibilities = [
      '负责抖音商品卡流量获取与优化，围绕标题、入池、搜索权重和活动报名提升商品曝光与成交转化。',
      '主导千川计划搭建、短视频素材投流、人群定向和出价策略，持续优化 ROI、CTR、CVR 等核心指标。',
      '推进达人建联、寄样、内容产出跟进和爆品素材筛选，形成“达人内容 + 付费投流”联动。',
      '按日/周复盘 GMV、ROI、素材效果和人群表现，输出调整方案并协同商品、设计、客服、仓储落地。',
    ];
    requirements = [
      '大专及以上学历，具备抖音店铺运营、千川投流或商品卡增长相关经验。',
      '熟悉抖音商品卡、巨量千川、抖店或电商罗盘等后台，能独立拆解数据问题。',
      '有可复盘的 GMV、ROI 或转化率提升案例，能讲清本人负责范围、预算规模和优化动作。',
      '具备数据分析、跨团队沟通和执行推进能力，能在节奏变化中快速调整运营策略。',
    ];
  } else if (isCrossBorder) {
    scenario = '跨境电商运营';
    goal = `围绕${jobTitle}岗位，通过 Listing 优化、广告投放、站点运营和履约协同，提升跨境店铺销售额、转化率与广告 ROI。`;
    responsibilities = [
      '负责跨境平台店铺日常运营，包括产品上架、Listing 优化、活动报名、库存和价格协同。',
      '跟进站点规则、广告数据和销售表现，围绕曝光、点击、转化和 ROI 持续优化运营策略。',
      '协同供应链、客服、物流等团队，保障订单履约、库存周转和客户体验。',
      '定期复盘站点、SKU、广告预算和转化表现，输出问题诊断与增长动作。',
    ];
    requirements = [
      '具备 Amazon、Shopee、TikTok Shop、独立站等跨境平台运营经验。',
      '熟悉 Listing 优化、广告投放、站点规则和基础英文读写。',
      '能基于销售额、转化率、ACOS/ROI 等指标做数据复盘并推动优化。',
      '具备跨部门沟通能力，能协调供应链、客服、物流等角色共同推进目标。',
    ];
  } else if (isDomestic) {
    scenario = '国内电商运营';
    goal = `围绕${jobTitle}岗位，通过商品运营、活动运营、推广投放和数据复盘，提升店铺 GMV、转化率和运营效率。`;
    responsibilities = [
      '负责店铺日常运营，包括商品上新、标题卖点优化、页面承接、活动报名和价格策略跟进。',
      '监控 GMV、转化率、客单价、ROI 等核心指标，定位流量、商品、价格和页面问题。',
      '协同设计、客服、仓储等团队，保障活动上线、库存周转和客户服务质量。',
      '跟进平台规则变化和竞品动态，及时调整商品、活动和推广方案。',
    ];
    requirements = [
      '具备淘宝、天猫、京东、拼多多、抖音等平台店铺运营经验。',
      '能讲清负责店铺规模、核心指标、本人职责和具体优化动作。',
      '具备基础数据分析能力，能围绕 GMV、转化率、客单价或 ROI 做复盘。',
      '沟通协调能力强，能推动商品、设计、客服、仓储等协作环节落地。',
    ];
  } else {
    scenario = '电商运营通用岗位';
    goal = `围绕${jobTitle}岗位，明确业务目标、核心职责和可衡量结果，提升候选人理解和匹配效率。`;
    responsibilities = [
      '负责岗位相关日常运营工作，拆解业务目标并推进执行。',
      '跟进关键数据和过程问题，定期复盘并输出优化建议。',
      '协同内部团队完成商品、内容、客服或履约等相关工作。',
      '沉淀可复用流程，提升岗位对应业务模块的执行效率。',
    ];
    requirements = [
      '具备相关岗位经验，能清晰说明过往项目、本人职责和结果。',
      '具备基础数据分析、沟通协调和问题解决能力。',
      '执行力强，能按计划推进任务并及时反馈风险。',
      '有同平台、同品类或同业务场景经验优先。',
    ];
  }

  const benefits = [
    '薪资结构、绩效奖金、社保、作息制度和成长通道以公司真实制度为准。',
    '建议 HR 补充上班时间、休假安排、团队配置和晋升机制，提升求职者转化。',
  ];
  const missingInfo = [
    !hasCategory ? { field: '经营品类/商品范围', severity: 'medium', suggestion: '补充主营品类、SKU 数、客单价或爆品情况。' } : null,
    !hasBudget ? { field: '预算/指标口径', severity: 'medium', suggestion: '补充日预算、月预算、GMV/ROI/CTR/CVR 目标或历史基线。' } : null,
    !hasBenefits ? { field: '工作制与福利', severity: 'low', suggestion: '补充上班时间、单双休、社保、绩效或提成规则。' } : null,
    !hasTeam ? { field: '团队协作边界', severity: 'low', suggestion: '补充汇报对象、团队配置和需要协同的角色。' } : null,
  ].filter(Boolean);
  const complianceItems = [
    { key: 'contact', status: /(电话|手机号|微信|VX|QQ|邮箱|加v|联系我)/i.test(inputText) ? 'warning' : 'pass', message: /(电话|手机号|微信|VX|QQ|邮箱|加v|联系我)/i.test(inputText) ? '检测到疑似联系方式，正式发布前应删除。' : '未检测到电话、微信等联系方式。' },
    { key: 'specialSymbol', status: /[★◆●]/.test(inputText) ? 'warning' : 'pass', message: /[★◆●]/.test(inputText) ? '检测到可能影响平台发布的特殊符号。' : '未检测到明显特殊符号风险。' },
    { key: 'discrimination', status: /(限男|限女|男性|女性|已婚|未婚|35岁|年龄|户籍|本地人)/.test(inputText) ? 'warning' : 'pass', message: /(限男|限女|男性|女性|已婚|未婚|35岁|年龄|户籍|本地人)/.test(inputText) ? '检测到可能涉及歧视或不合理限制的表达。' : '未检测到性别、婚育、年龄、地域等明显歧视表达。' },
    { key: 'laborLaw', status: hasBenefits ? 'pass' : 'warning', message: hasBenefits ? '福利/工作制已有线索，仍需按真实制度复核。' : '福利和工作时间缺失，正式发布前建议补充真实信息。' },
  ];
  const qualityItems = [
    { key: 'scenario', label: '岗位场景', status: scenario ? 'pass' : 'warning', detail: scenario },
    { key: 'metric', label: '指标口径', status: hasMetrics ? 'pass' : 'warning', detail: hasMetrics ? '已包含 GMV/ROI/转化等指标线索。' : '建议补充 GMV、ROI、CTR、CVR 或转化率目标。' },
    { key: 'module', label: '职责模块', status: responsibilities.length >= 4 ? 'pass' : 'warning', detail: '已拆为可面试追问的职责模块。' },
    { key: 'attraction', label: '吸引力', status: hasBenefits ? 'pass' : 'warning', detail: hasBenefits ? '已有福利线索。' : '福利、作息和成长信息仍偏弱。' },
  ];
  const fullText = formatJdFullText({ goal, responsibilities, requirements, benefits });

  return {
    sourceLabel: '本地 AI 规则优化',
    optimizedAt: actionTime(),
    version,
    simpleNeed: displayJob.simpleNeed,
    generated: {
      jobGoal: goal,
      responsibilities,
      requirements,
      benefits,
    },
    generatedDescription: fullText,
    fullText,
    missingInfo,
    complianceRiskCheck: { blocked: complianceItems.some((item) => item.status === 'error'), items: complianceItems },
    qualityCheck: { score: qualityItems.filter((item) => item.status === 'pass').length * 20 + (hasMetrics ? 10 : 0), grade: hasMetrics && hasBenefits ? 'A-' : 'B+', items: qualityItems },
  };
}

function deriveJdAssistant(demo, version, displayJob, optimizedJd) {
  const source = optimizedJd || demo.jdAssistant || demo.jdAiDraft || {};
  const generated = source.generated || source.inferred || source.draft || source.llmInference || {};
  const form = demo.publishForm || {};
  const profile = demo.profile || {};
  const jobTitle = displayJob?.jobTitle || form.jobTitle || profile.title || demo.name || '当前岗位';
  const simpleNeed = readFirst(
    displayJob,
    ['simpleNeed'],
    readFirst(
      source,
      ['simpleNeed', 'simpleRequirement', 'need', 'prompt', 'brief', 'requirementBrief'],
      demo.hiringGoal || form.descriptionHint || profile.summary || `为${jobTitle}生成职位描述`
    )
  );
  const goal = readFirst(
    generated,
    ['goal', 'jobGoal', 'hiringGoal', 'positionGoal', 'target'],
    readFirst(source, ['goal', 'jobGoal', 'hiringGoal', 'positionGoal'], demo.hiringGoal || profile.summary)
  );
  const responsibilities = toTextList(readFirst(
    generated,
    ['responsibilities', 'duties', 'jobDuties', 'workContent'],
    readFirst(source, ['responsibilities', 'duties', 'jobDuties'], [])
  ));
  const requirements = toTextList(readFirst(
    generated,
    ['requirements', 'qualifications', 'mustHaves'],
    readFirst(source, ['requirements', 'qualifications', 'mustHaves'], profile.mustHaves || [])
  ));
  const benefits = toTextList(readFirst(
    generated,
    ['benefits', 'welfare', 'perks'],
    readFirst(source, ['benefits', 'welfare', 'perks'], [])
  ));
  const missingInfo = toTextList(readFirst(source, ['missingInfo', 'missing', 'missingFields'], [
    '上班时间',
    '岗位福利',
    '团队规模',
    '具体平台 / 品类 / 店铺规模',
  ]));
  const goalText = displayText(goal);
  const responsibilityItems = responsibilities.length ? responsibilities : [
    `负责${jobTitle}相关业务目标拆解、日常推进和跨团队协作。`,
    '围绕 GMV、ROI、曝光、转化等指标跟进运营动作，并持续复盘优化。',
    '联动商品、设计、客服、仓储或投放角色，保障活动和内容落地。',
  ];
  const benefitItems = benefits.length ? benefits : ['岗位福利、上班时间和团队配置待 HR 补充。'];
  const complianceChecks = normalizeCheckItems(source.complianceChecks || source.complianceRiskCheck?.items || source.compliance, [
    { label: '联系方式 / 微信 / 电话未直接写入', status: 'pass', detail: '保持平台内沟通，降低账号风险。' },
    { label: '未出现性别、年龄等歧视表达', status: 'pass' },
    { label: '薪资、试用期、加班等劳动法敏感信息', status: 'warn', detail: '需要 HR 在正式发布前最终确认。' },
  ]);
  const qualityChecks = normalizeCheckItems(source.qualityChecks || source.qualityCheck?.items || source.quality, [
    { label: '岗位目标清晰', status: present(goalText) ? 'pass' : 'warn' },
    { label: '职责和要求已分层', status: responsibilityItems.length && requirements.length ? 'pass' : 'warn' },
    { label: '指标口径可追问', status: /GMV|ROI|转化|曝光|平台|品类|店铺/.test(`${goalText} ${responsibilityItems.join(' ')}`) ? 'pass' : 'warn' },
    { label: '福利和上班时间', status: benefits.length ? 'pass' : 'warn', detail: benefits.length ? '' : '缺少吸引求职者的信息。' },
  ]);

  return {
    version,
    title: source.title || source.uiMock?.title || 'AI 职位描述助手 / JD 质量检查',
    sourceLabel: source.sourceLabel || (optimizedJd ? '本地 AI 规则优化' : 'Fixture 示例'),
    optimizedAt: source.optimizedAt || '',
    simpleNeed,
    goal: goalText || `${jobTitle}需要围绕业务增长目标完成岗位职责，并给候选人清晰说明核心成果。`,
    responsibilities: responsibilityItems,
    requirements,
    benefits: benefitItems,
    missingInfo,
    complianceChecks,
    qualityChecks,
    fullText: source.fullText || source.generatedDescription || formatJdFullText({ goal: goalText, responsibilities: responsibilityItems, requirements, benefits: benefitItems }),
  };
}

function nextEvent(label, detail) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: actionTime(),
    label,
    detail,
  };
}

function PublishDraftCard({ demo, displayJob }) {
  const form = demo.publishForm || {};
  const jobTitle = displayJob?.jobTitle || form.jobTitle || demo.name;
  const titleCount = clean(jobTitle).length;
  const locked = form.lockedAfterPublish || [];
  const categoryPath = [form.firstCategory, form.secondCategory, form.thirdCategory].filter(has);
  return (
    <Card className="job-management-card job-management-publish-card">
      <div className="job-management-card-head">
        <div>
          <Text className="job-management-kicker">Fixture 模拟发布资料</Text>
          <Title level={4}>职位草稿预览</Title>
        </div>
        <Tag color="gold">隔离预览</Tag>
      </div>
      <div className="job-management-form-grid">
        <div className="job-management-form-field">
          <span>招聘类型</span>
          <strong>{form.recruitType || demo.channel}</strong>
        </div>
        <div className="job-management-form-field">
          <span>职位名称</span>
          <strong>{jobTitle}</strong>
          <em>{titleCount}/{form.titleLimit || 20}</em>
        </div>
        <div className="job-management-form-field wide">
          <span>职位类型</span>
          <div className="job-management-category-path">
            {categoryPath.map((item) => <Tag key={item}>{item}</Tag>)}
          </div>
        </div>
        <div className="job-management-form-field wide">
          <span>职位描述</span>
          <div className="job-management-jd-preview">
            <FileTextOutlined />
            <div>
              <strong>{form.descriptionPlaceholder || '介绍工作内容、职位要求'}</strong>
              <p>{displayJob?.jdDescription || displayJob?.simpleNeed || form.descriptionHint || '建议先写清岗位目标、核心职责和必须经验。'}</p>
            </div>
            <Tag color="purple">Fixture 规则草稿</Tag>
          </div>
        </div>
      </div>
      <div className="job-management-lock-note">
        <EditOutlined />
        <span>正式发布后通常不可改：{locked.join('、') || '招聘类型、职位名称、职位类型、工作城市'}；此处不执行发布。</span>
      </div>
    </Card>
  );
}

function LocalJobEditCard({ draft, displayJob, locked, onChange, onReset, onSave }) {
  return (
    <Card className="job-management-card job-management-local-edit-card">
      <div className="job-management-card-head">
        <div>
          <Text className="job-management-kicker">本地编辑</Text>
          <Title level={4}>职位信息与 JD 简单需求</Title>
        </div>
        <Tag color="gold">Fixture 隔离草稿</Tag>
      </div>

      <div className="job-management-form-grid job-management-local-edit-grid">
        <div className="job-management-form-field">
          <span>职位名称</span>
          <Input
            className="job-management-local-edit-input"
            aria-label="职位名称"
            name="job-management-title"
            autoComplete="off"
            disabled={locked}
            value={textEditorValue(draft, 'jobTitle', displayJob.jobTitle)}
            onChange={(event) => onChange('jobTitle', event.target.value)}
          />
        </div>
        <div className="job-management-form-field">
          <span>城市</span>
          <Input
            className="job-management-local-edit-input"
            aria-label="城市"
            name="job-management-city"
            autoComplete="off"
            disabled={locked}
            value={textEditorValue(draft, 'city', displayJob.city)}
            onChange={(event) => onChange('city', event.target.value)}
          />
        </div>
        <div className="job-management-form-field">
          <span>薪资</span>
          <Input
            className="job-management-local-edit-input"
            aria-label="薪资"
            name="job-management-salary"
            autoComplete="off"
            disabled={locked}
            value={textEditorValue(draft, 'salary', displayJob.salary)}
            onChange={(event) => onChange('salary', event.target.value)}
          />
        </div>
        <div className="job-management-form-field">
          <span>HC</span>
          <InputNumber
            className="job-management-local-edit-input"
            aria-label="HC"
            name="job-management-headcount"
            autoComplete="off"
            inputMode="numeric"
            disabled={locked}
            min={0}
            value={numberEditorValue(draft, 'headcount', displayJob.headcount)}
            onChange={(value) => onChange('headcount', value)}
          />
        </div>
        <div className="job-management-form-field">
          <span>开放天数</span>
          <InputNumber
            className="job-management-local-edit-input"
            aria-label="开放天数"
            name="job-management-open-days"
            autoComplete="off"
            inputMode="numeric"
            disabled={locked}
            min={0}
            value={numberEditorValue(draft, 'openDays', displayJob.openDays)}
            onChange={(value) => onChange('openDays', value)}
          />
        </div>
        <div className="job-management-form-field job-management-local-edit-wide">
          <span>JD 简单需求</span>
          <Input.TextArea
            className="job-management-local-edit-textarea"
            aria-label="JD 简单需求"
            name="job-management-simple-need"
            autoComplete="off"
            disabled={locked}
            autoSize={{ minRows: 3, maxRows: 5 }}
            value={textEditorValue(draft, 'simpleNeed', displayJob.simpleNeed)}
            onChange={(event) => onChange('simpleNeed', event.target.value)}
          />
        </div>
        <div className="job-management-form-field job-management-local-edit-wide">
          <span>当前职位描述</span>
          <Input.TextArea
            className="job-management-local-edit-textarea"
            aria-label="当前职位描述"
            name="job-management-jd-description"
            autoComplete="off"
            disabled={locked}
            autoSize={{ minRows: 4, maxRows: 8 }}
            placeholder="AI 优化后可填入这里，也可以手动修改。"
            value={textEditorValue(draft, 'jdDescription', displayJob.jdDescription)}
            onChange={(event) => onChange('jdDescription', event.target.value)}
          />
        </div>
      </div>

      <div className="job-management-lock-note">
        <EditOutlined />
        <span>仅更新 Fixture 隔离草稿；不会调用生产 IPC 或外部服务。</span>
        <Space wrap>
          <Button size="small" disabled={locked} onClick={onReset}>恢复 Fixture 样例</Button>
          <Button size="small" type="primary" disabled={locked} onClick={onSave}>模拟保存 JD 草稿</Button>
        </Space>
      </div>
    </Card>
  );
}

function checkTone(status) {
  if (status === true || /pass|success|ok|low/i.test(String(status))) return { color: 'green', label: '通过' };
  if (/fail|error|high|block/i.test(String(status))) return { color: 'red', label: '风险' };
  if (/warn|medium|missing|todo/i.test(String(status))) return { color: 'orange', label: '需补充' };
  return { color: 'default', label: '待确认' };
}

function JdAssistantSection({ title, items, tone }) {
  const rows = toTextList(items);
  return (
    <section className={`job-management-jd-section ${tone || ''}`}>
      <strong>{title}</strong>
      {rows.length === 1 ? (
        <p>{rows[0]}</p>
      ) : (
        <ul>
          {rows.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </section>
  );
}

function JdCheckList({ title, items }) {
  return (
    <section className="job-management-jd-check-list">
      <strong>{title}</strong>
      <div>
        {items.map((item) => {
          const tone = checkTone(item.status);
          return (
            <div className="job-management-jd-check" key={item.key}>
              <Tag color={tone.color}>{tone.label}</Tag>
              <span>{item.label}</span>
              {item.detail && <small>{item.detail}</small>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function JdAssistantCard({ assistant, locked, onAction }) {
  return (
    <Card className="job-management-card job-management-jd-assistant-card">
      <div className="job-management-card-head">
        <div>
          <Text className="job-management-kicker">JD 帮写</Text>
          <Title level={4}>{assistant.title}</Title>
        </div>
        <Space size={6} wrap>
          {assistant.sourceLabel && <Tag color="green">{assistant.sourceLabel}</Tag>}
          {assistant.optimizedAt && <Tag color="cyan">{assistant.optimizedAt}</Tag>}
          <Tag color="purple">第 {assistant.version} 版</Tag>
        </Space>
      </div>

      <div className="job-management-jd-brief">
        <span>简单需求</span>
        <Paragraph>{assistant.simpleNeed}</Paragraph>
      </div>

      <div className="job-management-jd-section-grid">
        <JdAssistantSection title="岗位目标" items={[assistant.goal]} tone="goal" />
        <JdAssistantSection title="岗位职责" items={assistant.responsibilities} tone="duty" />
        <JdAssistantSection title="任职要求" items={assistant.requirements} tone="requirement" />
        <JdAssistantSection title="岗位福利" items={assistant.benefits} tone="benefit" />
      </div>

      <div className="job-management-jd-fulltext">
        <strong>优化后可填入职位描述</strong>
        <Paragraph copyable={{ text: assistant.fullText }}>{assistant.fullText}</Paragraph>
      </div>

      <div className="job-management-jd-review-grid">
        <section className="job-management-jd-missing">
          <strong>缺失信息</strong>
          <Space size={[6, 6]} wrap>
            {assistant.missingInfo.length ? assistant.missingInfo.map((item) => <Tag key={item} color="gold">{item}</Tag>) : <Tag color="green">信息完整</Tag>}
          </Space>
        </section>
        <JdCheckList title="合规检查" items={assistant.complianceChecks} />
        <JdCheckList title="质量检查" items={assistant.qualityChecks} />
      </div>

      <div className="job-management-jd-actions">
        <Button disabled={locked} icon={<ReloadOutlined />} onClick={() => onAction('regenerate')}>
          模拟优化 JD
        </Button>
        <Button disabled={locked} icon={<CopyOutlined />} onClick={() => onAction('copy')}>
          一键复制
        </Button>
        <Button disabled={locked} icon={<FileTextOutlined />} onClick={() => onAction('append')}>
          模拟填入内容下方
        </Button>
        <Button disabled={locked} type="primary" icon={<EditOutlined />} onClick={() => onAction('replace')}>
          模拟替换原内容
        </Button>
        <Button disabled={locked} icon={<CloudUploadOutlined />} onClick={() => onAction('manual-publish-draft')}>
          生成模拟手工发布稿
        </Button>
        <Text type="secondary">所有动作都是 Fixture 隔离模拟；不会调用外部模型、生产 IPC 或任何外部写入接口。</Text>
      </div>
    </Card>
  );
}

const DIAGNOSTIC_RISK_META = {
  low: { color: 'green', label: '低风险' },
  medium: { color: 'orange', label: '中风险' },
  high: { color: 'red', label: '高风险' },
};

function DiagnosticPillList({ items, emptyText }) {
  const rows = toTextList(items);
  return (
    <div className="job-management-diagnostic-pill-list">
      {rows.length ? rows.map((item) => <span key={item}>{item}</span>) : <span>{emptyText}</span>}
    </div>
  );
}

function DiagnosticList({ items, emptyText }) {
  const rows = toTextList(items);
  return rows.length ? (
    <ul className="job-management-diagnostic-list">
      {rows.map((item) => <li key={item}>{item}</li>)}
    </ul>
  ) : (
    <p>{emptyText}</p>
  );
}

function JdRecommendationDiagnosticCard({ diagnostic }) {
  const meta = DIAGNOSTIC_RISK_META[diagnostic.riskLevel] || DIAGNOSTIC_RISK_META.medium;
  const missingRows = diagnostic.missing || [];
  const profile = diagnostic.recommendationProfile || {};
  return (
    <Card className="job-management-diagnostic-card">
      <div className="job-management-diagnostic-head">
        <div>
          <Text className="job-management-kicker">推荐流诊断 · 本地推理</Text>
          <strong>JD 是否会把候选人推荐跑偏</strong>
          <span>{diagnostic.summary}</span>
        </div>
        <div className="job-management-diagnostic-score">
          <strong>{diagnostic.score}</strong>
          <span>清晰度</span>
        </div>
      </div>

      <Space size={6} wrap>
        <Tag color={meta.color}>{meta.label}</Tag>
        <Tag>只读诊断</Tag>
        <Tag color="cyan">不调用外部 API</Tag>
      </Space>

      <div className="job-management-diagnostic-grid">
        <section className="job-management-diagnostic-section">
          <strong>平台 / 渠道</strong>
          <DiagnosticPillList items={diagnostic.detected.platforms} emptyText="未识别平台" />
        </section>
        <section className="job-management-diagnostic-section">
          <strong>职责模块</strong>
          <DiagnosticPillList items={diagnostic.detected.workModules} emptyText="未识别模块" />
        </section>
        <section className="job-management-diagnostic-section">
          <strong>指标 / 上下文</strong>
          <DiagnosticPillList items={[...(diagnostic.detected.metrics || []), ...(diagnostic.detected.categories || [])]} emptyText="缺少指标锚点" />
        </section>
      </div>

      <section className="job-management-diagnostic-section">
        <strong>需要 HR 补齐的信息</strong>
        {missingRows.length ? (
          <div className="job-management-diagnostic-list">
            {missingRows.slice(0, 6).map((item) => (
              <div className="job-management-diagnostic-warning" key={item.key || item.label}>
                <strong>{item.label}</strong>
                <span>{item.impact}</span>
                <span>{item.suggestion}</span>
              </div>
            ))}
          </div>
        ) : (
          <p>当前 JD 已覆盖主要推荐画像信息，发布前仍建议人工复核真实福利和工作制。</p>
        )}
      </section>

      <div className="job-management-diagnostic-grid">
        <section className="job-management-diagnostic-profile">
          <strong>推荐流必备项</strong>
          <DiagnosticList items={profile.mustHaves} emptyText="等待补充岗位画像。" />
        </section>
        <section className="job-management-diagnostic-profile">
          <strong>加分项</strong>
          <DiagnosticList items={profile.niceToHaves} emptyText="等待补充加分经验。" />
        </section>
        <section className="job-management-diagnostic-profile">
          <strong>硬性排除项</strong>
          <DiagnosticList items={profile.hardBars} emptyText="等待补充淘汰口径。" />
        </section>
      </div>

      <div className="job-management-diagnostic-grid">
        <section className="job-management-diagnostic-section">
          <strong>面试追问</strong>
          <DiagnosticList items={profile.interviewQuestions} emptyText="等待生成面试追问。" />
        </section>
        <section className="job-management-diagnostic-section">
          <strong>跑偏预警</strong>
          <DiagnosticList items={(diagnostic.driftWarnings || []).map((item) => `${item.title}：${item.desc}`)} emptyText="暂无明显优化漂移。" />
        </section>
        <section className="job-management-diagnostic-section">
          <strong>改写建议</strong>
          <DiagnosticList items={diagnostic.rewriteHints} emptyText="暂无额外改写建议。" />
        </section>
      </div>
    </Card>
  );
}

function FunnelStage({ stage }) {
  const stagePercent = percent(stage.value, stage.total);
  return (
    <div className="job-management-funnel-stage">
      <div>
        <strong>{stage.label}</strong>
        <span>{stage.value}</span>
      </div>
      <Progress percent={stagePercent} size="small" showInfo={false} />
      <Text type="secondary">{stage.hint}</Text>
    </div>
  );
}

function ProfileColumn({ title, items, tone }) {
  return (
    <section className={`job-management-profile-column ${tone || ''}`}>
      <strong>{title}</strong>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </section>
  );
}

function RiskItem({ risk }) {
  const high = risk.level === 'high';
  const low = risk.level === 'low';
  return (
    <div className={`job-management-risk ${high ? 'high' : low ? 'low' : 'medium'}`}>
      <span>{high ? <WarningOutlined /> : <ExclamationCircleOutlined />}</span>
      <div>
        <strong>{risk.title}</strong>
        <p>{risk.desc}</p>
      </div>
    </div>
  );
}

function PrimaryJobActions({ status, onSectionChange, onAction }) {
  const needsPublish = status !== 'published';
  return (
    <div className="job-management-actions">
      <Button icon={<EditOutlined />} onClick={() => onSectionChange('jd')}>
        优化 JD
      </Button>
      <Button icon={<TeamOutlined />} onClick={() => onSectionChange('funnel')}>
        看候选
      </Button>
      <Button
        type="primary"
        icon={needsPublish ? <PlayCircleOutlined /> : <ReloadOutlined />}
        onClick={() => onAction(needsPublish ? 'publish' : 'refresh')}
      >
        {needsPublish ? '模拟发布职位' : '模拟曝光刷新'}
      </Button>
    </div>
  );
}

function PriorityStrip({ risks, diagnostic, untouched, status, statusLabel, onSectionChange, onAction }) {
  const highRiskCount = risks.filter((risk) => risk.level === 'high').length;
  const warningRiskCount = risks.length - highRiskCount;
  const diagnosticRisk = diagnostic.riskLevel === 'high' ? 'JD 高风险' : diagnostic.riskLevel === 'medium' ? 'JD 待补强' : 'JD 可用';
  const needsPublish = status !== 'published';
  const candidateFirst = !needsPublish && untouched > 0;
  return (
    <div className="job-management-priority-strip">
      <section className="job-management-priority-card">
        <Text className="job-management-kicker">今日建议</Text>
        <strong>{needsPublish ? '先确认岗位是否需要发布' : untouched > 0 ? '优先处理待联系候选人' : '保持岗位曝光和画像稳定'}</strong>
        <span>{needsPublish ? `当前状态为${statusLabel}，模拟发布只记录 Fixture 隔离状态。` : `当前还有 ${untouched} 位候选人未打招呼。`}</span>
        <div className="job-management-priority-actions">
          <Button
            size="small"
            type="primary"
            className="job-management-priority-action job-management-priority-action-primary"
            onClick={() => {
              if (candidateFirst) onSectionChange('funnel');
              else onAction(needsPublish ? 'publish' : 'refresh');
            }}
          >
            {needsPublish ? '模拟确认发布' : candidateFirst ? '查看待联系' : '模拟刷新曝光'}
          </Button>
          <Button
            size="small"
            className="job-management-priority-action"
            onClick={() => {
              if (needsPublish) onSectionChange('jd');
              else if (candidateFirst) onAction('refresh');
              else onSectionChange('funnel');
            }}
          >
            {needsPublish ? '检查 JD' : candidateFirst ? '模拟刷新曝光' : '查看候选'}
          </Button>
        </div>
      </section>
      <section className="job-management-priority-card">
        <Text className="job-management-kicker">风险</Text>
        <strong>{highRiskCount ? `${highRiskCount} 个高风险` : warningRiskCount ? `${warningRiskCount} 个提醒` : '暂无高风险'}</strong>
        <span>{risks[0]?.desc || '岗位状态、登录态和候选池暂无明显阻断。'}</span>
        <div className="job-management-priority-actions">
          <Button size="small" className="job-management-priority-action" onClick={() => onSectionChange('overview')}>查看风险</Button>
        </div>
      </section>
      <section className="job-management-priority-card">
        <Text className="job-management-kicker">推荐画像</Text>
        <strong>{diagnosticRisk} · {diagnostic.score} 分</strong>
        <span>{diagnostic.summary}</span>
        <div className="job-management-priority-actions">
          <Button size="small" className="job-management-priority-action" onClick={() => onSectionChange('profile')}>查看画像</Button>
          <Button size="small" className="job-management-priority-action" onClick={() => onSectionChange('jd')}>优化 JD</Button>
        </div>
      </section>
    </div>
  );
}

function SectionTabs({ value, onChange }) {
  return (
    <div className="job-management-section-tabs">
      <Segmented options={JOB_MANAGEMENT_SECTIONS} value={value} onChange={onChange} />
      <Text type="secondary">按 HR 任务流分层：先看状态，再处理 JD、画像、候选和日志。</Text>
    </div>
  );
}

function EventLogCard({ events }) {
  return (
    <Card className="job-management-card">
      <div className="job-management-card-head">
        <div>
          <Text className="job-management-kicker">流程动作</Text>
          <Title level={4}>发布 / 关闭 / JD 留痕</Title>
        </div>
        <Tag>本地留痕</Tag>
      </div>
      <div className="job-management-event-list">
        {(events.length ? events : [
          { id: 'seed-1', time: '--:--', label: '等待 HR 操作', detail: '点击发布、暂停、刷新或 JD 动作后，会在这里显示本地留痕。' },
        ]).map((event) => (
          <div className="job-management-event" key={event.id}>
            <span>{event.time}</span>
            <div>
              <strong>{event.label}</strong>
              <p>{event.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function JobManagementDemo({
  jobs,
  jobId,
  candidates,
  readOnly,
  onJobChange,
  onReturnLedger,
}) {
  const { message, modal } = AntApp.useApp();
  const [localStates, setLocalStates] = useState({});
  const [activeSection, setActiveSection] = useState('jd');
  const selectedJob = jobs.find((job) => String(job.id) === String(jobId)) || jobs[0] || null;
  const selectedIndex = selectedJob ? jobs.findIndex((job) => String(job.id) === String(selectedJob.id)) : 0;
  const demo = useMemo(() => getJobManagementDemo(selectedJob, selectedIndex), [selectedJob, selectedIndex]);
  const local = selectedJob ? localStates[String(selectedJob.id)] || {} : {};
  const localEditDraft = getLocalEditDraft(local);
  const displayJob = useMemo(() => deriveDisplayJob(demo, localEditDraft, selectedJob), [demo, localEditDraft, selectedJob]);
  const status = local.status || demo.status;
  const fixtureLocked = readOnly || selectedJob?.status === 'closed' || status === 'closed';
  const jdAssistantVersion = Math.max(1, Number(local.jdAssistantVersion || 1));
  const jdAssistant = useMemo(() => deriveJdAssistant(demo, jdAssistantVersion, displayJob, local.optimizedJd), [demo, jdAssistantVersion, displayJob, local.optimizedJd]);
  const jdRecommendationDiagnostic = useMemo(
    () => analyzeJdRecommendationRisk({
      jobTitle: displayJob.jobTitle,
      simpleNeed: displayJob.simpleNeed,
      jdDescription: displayJob.jdDescription,
      optimizedText: jdAssistant.fullText,
    }),
    [displayJob.jobTitle, displayJob.simpleNeed, displayJob.jdDescription, jdAssistant.fullText]
  );
  function pushLocalState(patch, event) {
    if (!selectedJob || fixtureLocked) return false;
    const key = String(selectedJob.id);
    setLocalStates((prev) => {
      const before = prev[key] || {};
      return {
        ...prev,
        [key]: {
          ...before,
          ...patch,
          events: event ? [event, ...(before.events || [])].slice(0, 5) : before.events,
        },
      };
    });
    return true;
  }

  function updateLocalEditDraft(field, value) {
    if (!selectedJob || fixtureLocked) return false;
    const key = String(selectedJob.id);
    setLocalStates((prev) => {
      const before = prev[key] || {};
      const editDraft = getLocalEditDraft(before);
      return {
        ...prev,
        [key]: {
          ...before,
          editDraft: {
            ...editDraft,
            [field]: value,
          },
          ...(['jobTitle', 'simpleNeed', 'jdDescription'].includes(field) ? { optimizedJd: undefined } : {}),
          lastOperation: `Fixture 模拟编辑草稿 · ${actionTime()}`,
        },
      };
    });
    return true;
  }

  function resetLocalEditDraft() {
    if (fixtureLocked) return false;
    pushLocalState(
      {
        editDraft: {},
        lastOperation: `恢复 Fixture 样例值 · ${actionTime()}`,
      },
      nextEvent('恢复 Fixture 样例职位信息', '清空隔离编辑草稿，页面重新回退到 Fixture 样例值。')
    );
    message.info('已恢复 Fixture 样例值，不会写入真实岗位数据。');
    return true;
  }

  async function handleJdAssistantAction(type) {
    if (!selectedJob || fixtureLocked) return false;
    const nextVersion = type === 'regenerate' ? jdAssistant.version + 1 : jdAssistant.version;
    const nextOptimizedJd = type === 'regenerate'
      ? buildOptimizedJdDraft(demo, displayJob, nextVersion)
      : local.optimizedJd;
    const fullText = (nextOptimizedJd && (nextOptimizedJd.fullText || nextOptimizedJd.generatedDescription)) || jdAssistant.fullText || '';
    const editDraft = getLocalEditDraft(local);
    const currentDescription = textEditorValue(editDraft, 'jdDescription', displayJob.jdDescription);
    if (type === 'copy') {
      const ok = await copyTextToClipboard(fullText);
      if (!ok) {
        message.error('复制失败，请手动复制优化后的职位描述。');
        return;
      }
      pushLocalState(
        {
          jdAssistantLastAction: `Fixture 复制 JD · ${actionTime()}`,
          lastOperation: `Fixture 复制 JD · ${actionTime()}`,
        },
        nextEvent('Fixture 复制 JD', '已把模拟优化后的职位描述复制到系统剪贴板，没有写入真实岗位数据。')
      );
      message.success('已复制 Fixture 模拟优化后的 JD。');
      return;
    }
    if (type === 'manual-publish-draft') {
      let draftCreated = false;
      modal.confirm({
        title: '生成 Fixture 模拟手工发布稿？',
        content: '只会在 Fixture 隔离状态保存一份模拟稿，不调用生产 IPC 或外部写入接口，也不会自动提交。',
        okText: '生成模拟稿',
        cancelText: '取消',
        onOk: () => {
          pushLocalState(
            {
              manualPublishDraft: {
                status: 'manual_publish_draft',
                jobTitle: displayJob.jobTitle,
                content: fullText,
                updatedAt: new Date().toISOString(),
                gateReason: '仅供 HR 手工复制发布；不会自动写入外部渠道',
              },
              jdAssistantLastAction: `生成 Fixture 模拟发布稿 · ${actionTime()}`,
              lastOperation: `生成 Fixture 模拟发布稿 · ${actionTime()}`,
            },
            nextEvent('生成 Fixture 模拟发布稿', '已记录隔离模拟稿；不会自动或延迟提交。')
          );
          draftCreated = true;
        },
        // The success notice waits for afterClose so it never fires under the
        // still-closing confirm dialog.
        afterClose: () => {
          if (draftCreated) message.success('已创建 Fixture 隔离模拟稿。');
        },
      });
      return;
    }
    const meta = {
      regenerate: {
        label: '模拟优化 JD',
        detail: `基于 Fixture 简单需求生成第 ${nextVersion} 版模拟职位描述，不调用外部模型、生产 IPC 或发布接口。`,
        message: '已生成一版 Fixture 模拟 JD，不会调用外部模型或发布接口。',
      },
      append: {
        label: '模拟填入内容下方',
        detail: '已将 Fixture 模拟 JD 追加到隔离草稿，没有写入真实岗位数据。',
        message: '已模拟填入隔离草稿，不会提交真实岗位。',
      },
      replace: {
        label: '模拟替换原内容',
        detail: '已将 Fixture 模拟 JD 替换到隔离草稿，没有写入真实岗位数据。',
        message: '已模拟替换隔离草稿，不会提交真实岗位。',
      },
    }[type];
    if (!meta) return;
    const nextEditDraft = type === 'append'
      ? {
        ...editDraft,
        jdDescription: [currentDescription, fullText].filter(present).join('\n\n'),
      }
      : type === 'replace'
        ? {
          ...editDraft,
          jdDescription: fullText,
        }
        : editDraft;
    pushLocalState(
      {
        jdAssistantVersion: nextVersion,
        ...(nextOptimizedJd ? { optimizedJd: nextOptimizedJd } : {}),
        ...(type === 'append' || type === 'replace' ? { editDraft: nextEditDraft } : {}),
        jdAssistantLastAction: `${meta.label} · ${actionTime()}`,
        lastOperation: `${meta.label} · ${actionTime()}`,
      },
      nextEvent(meta.label, meta.detail)
    );
    message.success(meta.message);
  }

  function recordFixtureContractAction(kind) {
    if (fixtureLocked) return false;
    const meta = {
      saveJd: ['模拟保存 JD 草稿', '只更新 Fixture 隔离留痕，不创建正式 JD 版本。'],
      activateJd: ['模拟启用 JD 版本', '只更新 Fixture 隔离留痕，不启用正式 JD。'],
      saveProfile: ['模拟保存岗位画像草稿', '只更新 Fixture 隔离留痕，不创建正式岗位画像。'],
      confirmProfile: ['模拟确认岗位画像版本', '只更新 Fixture 隔离留痕，不确认正式岗位画像。'],
    }[kind];
    if (!meta) return false;
    const [label, detail] = meta;
    pushLocalState({ lastOperation: `${label} · ${actionTime()}` }, nextEvent(label, detail));
    message.info(`${label}完成；未调用生产 IPC 或外部服务。`);
    return true;
  }

  const actionAdapter = createJobManagementActionAdapter({
    locked: fixtureLocked,
    handlers: {
      [JOB_MANAGEMENT_ACTION_SCHEMA.navigateSection.id]: setActiveSection,
      [JOB_MANAGEMENT_ACTION_SCHEMA.editDraft.id]: (field, value) => (
        field === '__assistant_action__'
          ? handleJdAssistantAction(value)
          : updateLocalEditDraft(field, value)
      ),
      [JOB_MANAGEMENT_ACTION_SCHEMA.resetDraft.id]: resetLocalEditDraft,
      [JOB_MANAGEMENT_ACTION_SCHEMA.optimizeJd.id]: () => handleJdAssistantAction('regenerate'),
      [JOB_MANAGEMENT_ACTION_SCHEMA.copyJd.id]: () => handleJdAssistantAction('copy'),
      [JOB_MANAGEMENT_ACTION_SCHEMA.saveJdDraft.id]: () => recordFixtureContractAction('saveJd'),
      [JOB_MANAGEMENT_ACTION_SCHEMA.activateJdVersion.id]: () => recordFixtureContractAction('activateJd'),
      [JOB_MANAGEMENT_ACTION_SCHEMA.saveProfileDraft.id]: () => recordFixtureContractAction('saveProfile'),
      [JOB_MANAGEMENT_ACTION_SCHEMA.confirmProfileVersion.id]: () => recordFixtureContractAction('confirmProfile'),
      [JOB_MANAGEMENT_ACTION_SCHEMA.refreshData.id]: () => false,
    },
  });

  function executeFixtureJdAction(type) {
    if (type === 'regenerate') {
      return actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.optimizeJd.id);
    }
    if (type === 'copy') {
      return actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.copyJd.id);
    }
    return actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.editDraft.id, '__assistant_action__', type);
  }

  if (!selectedJob) {
    return (
      <div className="job-management-shell">
        <Empty description="暂无岗位，先在顶部同步岗位或导入本地测试数据" />
      </div>
    );
  }

  return (
    <JobManagementWorkspace
      title={displayJob.jobTitle || selectedJob.name || `岗位 ${selectedJob.id}`}
      status={status}
      mode="fixture"
      readOnly={fixtureLocked}
      activeSection={activeSection}
      actionAdapter={actionAdapter}
      onReturnLedger={onReturnLedger}
      description={joinParts([
        displayJob.city,
        displayJob.salary,
        present(displayJob.headcount) ? `${displayJob.headcount} HC` : '',
        present(displayJob.openDays) ? `开放 ${displayJob.openDays} 天` : '',
        demo.channel,
      ])}
    >
        {fixtureLocked && (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message="Fixture 当前只读"
            description="所有输入与模拟状态动作均已禁用；不会修改 localStorage、调用生产 IPC 或访问外部服务。"
          />
        )}
        {activeSection === 'jd' && (
          <div className="job-management-section-panel job-management-jd-workspace">
            <PublishDraftCard demo={demo} displayJob={displayJob} />
            <LocalJobEditCard
              draft={localEditDraft}
              displayJob={displayJob}
              locked={fixtureLocked}
              onChange={(field, value) => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.editDraft.id, field, value)}
              onReset={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.resetDraft.id)}
              onSave={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.saveJdDraft.id)}
            />
            <JdAssistantCard assistant={jdAssistant} locked={fixtureLocked} onAction={executeFixtureJdAction} />
          </div>
        )}

        {activeSection === 'profile' && (
          <div className="job-management-section-panel job-management-profile-workspace">
            <JdRecommendationDiagnosticCard diagnostic={jdRecommendationDiagnostic} />
            <Card className="job-management-card">
              <div className="job-management-card-head">
                <div>
                  <Text className="job-management-kicker">岗位画像</Text>
                  <Title level={4}>{demo.profile.title}</Title>
                </div>
                <ProfileOutlined className="job-management-head-icon" />
              </div>
              <div className="job-management-tab-note">
                <strong>Fixture 隔离画像</strong>
                <span>上方由当前 Fixture JD 在本地确定性推理，下方为样例筛选口径；不会写入正式岗位画像。</span>
              </div>
              <Paragraph className="job-management-profile-summary">{demo.profile.summary}</Paragraph>
              <div className="job-management-profile-grid">
                <ProfileColumn title="核心要求" items={demo.profile.mustHaves} />
                <ProfileColumn title="加分项" items={demo.profile.niceToHaves} tone="positive" />
                <ProfileColumn title="淘汰风险" items={demo.profile.hardBars} tone="risk" />
                <ProfileColumn title="面试核实" items={demo.profile.interviewSignals} tone="question" />
              </div>
              <Space wrap style={{ marginTop: 12 }}>
                <Button
                  disabled={fixtureLocked}
                  onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.saveProfileDraft.id)}
                >
                  模拟保存岗位画像草稿
                </Button>
                <Button
                  type="primary"
                  disabled={fixtureLocked}
                  onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.confirmProfileVersion.id)}
                >
                  模拟确认岗位画像版本
                </Button>
              </Space>
            </Card>
          </div>
        )}
    </JobManagementWorkspace>
  );
}
