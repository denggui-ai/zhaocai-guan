const PLATFORM_DEFS = [
  { label: '抖音', patterns: [/抖音|抖店|douyin/i] },
  { label: '千川', patterns: [/千川|巨量千川/i] },
  { label: '巨量', patterns: [/巨量|巨量引擎|巨量千川|巨量云图/i] },
  { label: '天猫', patterns: [/天猫|tmall/i] },
  { label: '淘宝', patterns: [/淘宝|taobao/i] },
  { label: '京东', patterns: [/京东|京东商城|jd\.com/i] },
  { label: '拼多多', patterns: [/拼多多|pdd|多多买菜/i] },
  { label: 'Amazon', patterns: [/amazon|亚马逊/i] },
  { label: 'Shopee', patterns: [/shopee|虾皮/i] },
  { label: 'TikTok Shop', patterns: [/tiktok\s*shop|tiktok小店|tk店|tt\s*shop/i] },
  { label: '独立站', patterns: [/独立站|shopify|woocommerce|自建站/i] },
];

const METRIC_DEFS = [
  { label: 'GMV', patterns: [/\bgmv\b|成交额|交易额|销售额/i] },
  { label: 'ROI', patterns: [/\broi\b|投产|投放回报|投入产出/i] },
  { label: 'CTR', patterns: [/\bctr\b|点击率/i] },
  { label: 'CVR', patterns: [/\bcvr\b|转化率/i] },
  { label: '转化', patterns: [/转化|成交|下单|支付/i] },
  { label: '曝光', patterns: [/曝光|展现|展示量|流量/i] },
  { label: '点击', patterns: [/点击|访客|uv\b|pv\b/i] },
  { label: '预算', patterns: [/预算|日耗|消耗|花费|投放金额|广告费/i] },
  { label: '客单价', patterns: [/客单价|客单|aov\b/i] },
];

const WORK_MODULE_DEFS = [
  { label: '商品卡', patterns: [/商品卡|搜索权重|商品入池|标题优化|自然流量|搜索流量/i] },
  { label: '千川投流', patterns: [/千川|投流|广告计划|出价|人群定向|付费推广/i] },
  { label: '达人分发', patterns: [/达人|kol\b|koc\b|寄样|带货|佣金|分发/i] },
  { label: '短视频', patterns: [/短视频|视频素材|素材剪辑|脚本|拍摄|剪辑/i] },
  { label: '直播运营', patterns: [/直播|直播间|主播|场控/i] },
  { label: '店铺运营', patterns: [/店铺|店播|抖店|店群|日销|运营店铺/i] },
  { label: '数据复盘', patterns: [/复盘|数据分析|数据监控|看数|报表|归因/i] },
  { label: '货品运营', patterns: [/选品|爆品|sku\b|库存|上新|货盘/i] },
];

const PRODUCT_CATEGORY_DEFS = [
  { label: '品类信息', patterns: [/品类|类目|主营|货品|客单价|sku\b|爆品|选品/i] },
  { label: '美妆/护肤', patterns: [/美妆|护肤|彩妆|个护/i] },
  { label: '食品/滋补', patterns: [/食品|零食|滋补|保健|茶饮|酒水/i] },
  { label: '服饰鞋包', patterns: [/服饰|服装|女装|男装|童装|鞋|箱包/i] },
  { label: '家居/家具', patterns: [/家居|家具|家纺|厨具|收纳/i] },
  { label: '3C数码', patterns: [/3c|数码|手机|电脑|家电/i] },
  { label: '母婴', patterns: [/母婴|婴童|孕产/i] },
  { label: '宠物', patterns: [/宠物|猫粮|狗粮/i] },
  { label: '运动户外', patterns: [/运动|户外|健身|骑行/i] },
];

const CONTEXT_DEFS = [
  { label: '团队配置', patterns: [/团队|组织|部门|汇报|协作|投手|设计|客服|主播|编导|剪辑|助理|leader/i] },
  { label: '福利待遇', patterns: [/福利|五险|社保|公积金|奖金|绩效|提成|年终|餐补|带薪|薪资|底薪|分红/i] },
  { label: '作息安排', patterns: [/作息|上班|下班|单双休|大小周|双休|单休|排班|加班|朝九|晚班|周末/i] },
];

const RESPONSIBILITY_PATTERNS = [/负责|主导|搭建|优化|提升|跟进|监控|复盘|制定|推进/];
const REQUIREMENT_PATTERNS = [/任职|要求|经验|熟悉|具备|优先|年以上|大专|本科|能力/];

const unique = (items) => Array.from(new Set(items.filter(Boolean)));

const normalizeText = (...parts) =>
  parts
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join('\n');

const detectLabels = (defs, text) =>
  defs
    .filter((def) => def.patterns.some((pattern) => pattern.test(text)))
    .map((def) => def.label);

const hasAny = (patterns, text) => patterns.some((pattern) => pattern.test(text));

const pushMissing = (items, key, label, impact, suggestion) => {
  items.push({ key, label, impact, suggestion });
};

const findMissingLabels = (sourceLabels, targetLabels) =>
  sourceLabels.filter((label) => !targetLabels.includes(label));

function buildDriftWarnings(sourceText, optimizedText) {
  if (!sourceText || !optimizedText) {
    return [];
  }

  const sourcePlatforms = detectLabels(PLATFORM_DEFS, sourceText);
  const optimizedPlatforms = detectLabels(PLATFORM_DEFS, optimizedText);
  const sourceMetrics = detectLabels(METRIC_DEFS, sourceText);
  const optimizedMetrics = detectLabels(METRIC_DEFS, optimizedText);
  const sourceModules = detectLabels(WORK_MODULE_DEFS, sourceText);
  const optimizedModules = detectLabels(WORK_MODULE_DEFS, optimizedText);
  const sourceContext = detectLabels(CONTEXT_DEFS, sourceText);
  const optimizedContext = detectLabels(CONTEXT_DEFS, optimizedText);

  const warnings = [];
  const missingPlatforms = findMissingLabels(sourcePlatforms, optimizedPlatforms);
  const missingMetrics = findMissingLabels(sourceMetrics, optimizedMetrics);
  const missingModules = findMissingLabels(sourceModules, optimizedModules);
  const missingContext = findMissingLabels(sourceContext, optimizedContext);
  const addedPlatforms = optimizedPlatforms.filter((label) => !sourcePlatforms.includes(label));

  if (missingPlatforms.length > 0) {
    warnings.push({
      title: '平台范围被弱化',
      desc: `原始需求提到 ${missingPlatforms.join('、')}，优化文本未明确保留，推荐流可能放宽到泛电商人选。`,
    });
  }

  if (missingModules.length > 0) {
    warnings.push({
      title: '核心工作模块被弱化',
      desc: `原始需求中的 ${missingModules.join('、')} 没有在优化文本中清楚呈现，候选人画像会变宽。`,
    });
  }

  if (missingMetrics.length > 0) {
    warnings.push({
      title: '指标口径被弱化',
      desc: `原始需求提到 ${missingMetrics.join('、')}，优化文本未保留，后续筛选会缺少可追问的数据锚点。`,
    });
  }

  if (missingContext.length > 0) {
    warnings.push({
      title: '岗位上下文被弱化',
      desc: `原始需求包含 ${missingContext.join('、')} 信息，优化文本未覆盖，岗位吸引力和边界会变模糊。`,
    });
  }

  if (sourcePlatforms.length > 0 && addedPlatforms.length > 0) {
    warnings.push({
      title: '新增平台可能造成画像漂移',
      desc: `优化文本新增 ${addedPlatforms.join('、')}，若非真实需求，可能引入不匹配的平台经验。`,
    });
  }

  if (sourceText.length > 80 && optimizedText.length < sourceText.length * 0.35) {
    warnings.push({
      title: '优化文本压缩过度',
      desc: '优化后的 JD 明显短于原始信息，容易丢失平台、指标、品类或团队边界。',
    });
  }

  return warnings.slice(0, 6);
}

function buildMissingItems({
  analysisText,
  platforms,
  metrics,
  workModules,
  productCategories,
  contextCategories,
}) {
  const missing = [];
  const hasPlatform = platforms.length > 0;
  const hasMetric = metrics.length > 0;
  const hasBudget = metrics.includes('预算');
  const hasCategory = productCategories.length > 0;
  const hasTeam = contextCategories.includes('团队配置');
  const hasBenefits = contextCategories.includes('福利待遇');
  const hasSchedule = contextCategories.includes('作息安排');
  const hasResponsibilities = hasAny(RESPONSIBILITY_PATTERNS, analysisText);
  const hasRequirements = hasAny(REQUIREMENT_PATTERNS, analysisText);
  const isDouyinLike = platforms.some((label) => ['抖音', '千川', '巨量'].includes(label));
  const hasDouyinModule = workModules.some((label) =>
    ['商品卡', '千川投流', '达人分发', '短视频', '数据复盘'].includes(label)
  );

  if (!hasPlatform) {
    pushMissing(
      missing,
      'platformScope',
      '平台/渠道范围',
      '推荐流无法判断候选人应具备抖音、天猫、京东、跨境或独立站经验。',
      '补充主平台和后台工具，例如抖音/千川/巨量、天猫淘宝、京东、拼多多、Amazon、Shopee、TikTok Shop 或独立站。'
    );
  }

  if (isDouyinLike && !hasDouyinModule) {
    pushMissing(
      missing,
      'douyinWorkModules',
      '抖音运营模块',
      '只写抖音或千川会匹配到泛运营，难区分商品卡、短视频、达人或投流型人才。',
      '写清商品卡自然流量、千川投流、短视频素材、达人分发、直播间或数据复盘的具体职责。'
    );
  } else if (workModules.length === 0) {
    pushMissing(
      missing,
      'workModules',
      '工作模块',
      '职责颗粒度不足，推荐结果会偏向泛电商运营。',
      '补充店铺运营、货品运营、投流、短视频、达人、直播、数据复盘等模块，并说明主责和协作边界。'
    );
  }

  if (!hasMetric) {
    pushMissing(
      missing,
      'dataMetrics',
      '核心指标',
      '缺少数据锚点，系统难识别增长型、投流型或执行型候选人。',
      '补充 GMV、ROI、CTR、CVR、转化、曝光、点击、预算、客单价等指标，最好给出目标或历史规模。'
    );
  }

  if ((platforms.includes('千川') || workModules.includes('千川投流')) && !hasBudget) {
    pushMissing(
      missing,
      'adBudget',
      '投放预算',
      '投流岗位没有预算口径，面试时难判断候选人操盘深度。',
      '补充日预算/月预算、消耗规模、ROI 底线、加减预算判断和素材迭代频率。'
    );
  }

  if (!hasCategory) {
    pushMissing(
      missing,
      'productCategory',
      '经营品类',
      '不同品类的货盘、客单价、复购和素材打法差异大，缺失后会降低推荐精度。',
      '补充主营品类、客单价区间、SKU 数量、爆品阶段和是否已有成熟素材。'
    );
  }

  if (!hasTeam) {
    pushMissing(
      missing,
      'teamBoundary',
      '团队与协作边界',
      '候选人无法判断自己是独立操盘、协同投手，还是偏执行支持。',
      '补充汇报对象、团队配置，以及与投手、设计、客服、主播、编导、剪辑的分工。'
    );
  }

  if (!hasBenefits) {
    pushMissing(
      missing,
      'benefits',
      '福利待遇',
      '岗位吸引力不足，容易影响点击、沟通和转化。',
      '补充薪资结构、绩效/提成、社保公积金、奖金、餐补或其他真实福利。'
    );
  }

  if (!hasSchedule) {
    pushMissing(
      missing,
      'workSchedule',
      '作息安排',
      '电商岗位对直播、活动和投放节奏敏感，作息不清会增加沟通损耗。',
      '补充上班时间、单双休/大小周、活动期排班、是否需要晚班或周末支持。'
    );
  }

  if (!hasResponsibilities) {
    pushMissing(
      missing,
      'responsibilities',
      '职责动作',
      '缺少“负责/主导/优化/复盘”等动作，推荐流难判断岗位深度。',
      '用动作描述职责，例如主导千川计划搭建、优化商品卡标题、复盘达人素材转化。'
    );
  }

  if (!hasRequirements) {
    pushMissing(
      missing,
      'candidateRequirements',
      '任职要求',
      '缺少筛选门槛，系统和 HR 都难排除不匹配候选人。',
      '补充年限、学历、平台经验、数据能力、案例要求和加分项。'
    );
  }

  return missing;
}

function buildRecommendationProfile({ platforms, metrics, workModules, productCategories }) {
  const isDouyinLike = platforms.some((label) => ['抖音', '千川', '巨量'].includes(label));
  const isCrossBorder = platforms.some((label) =>
    ['Amazon', 'Shopee', 'TikTok Shop', '独立站'].includes(label)
  );
  const isDomesticShelf = platforms.some((label) => ['天猫', '淘宝', '京东', '拼多多'].includes(label));
  const categoryHint = productCategories.filter((label) => label !== '品类信息').join('、');
  const metricHint = metrics.length > 0 ? metrics.join('、') : 'GMV、ROI、CTR、CVR';
  const moduleHint = workModules.length > 0 ? workModules.join('、') : '平台运营、投流、内容和数据复盘';

  const mustHaves = [];
  const niceToHaves = [];
  const hardBars = [
    '只做客服、上架、跟单或基础执行，无法说明运营决策。',
    '写了投流或增长，但说不清预算、素材变量、ROI 或转化口径。',
    '无法区分本人负责模块、团队协作模块和店铺自然增长。',
  ];
  const interviewQuestions = [];

  if (isDouyinLike) {
    mustHaves.push('有抖音店铺、巨量千川或抖店后台实操经验。');
    mustHaves.push(`能围绕 ${metricHint} 拆解增长动作和复盘方法。`);
    mustHaves.push(`熟悉 ${moduleHint} 中至少一个主责模块，并能讲清本人贡献。`);
    niceToHaves.push('熟悉商品卡自然流量、标题优化、商品入池、搜索权重或活动报名。');
    niceToHaves.push('能把达人内容、短视频素材和千川投放串成可放大的素材链路。');
    interviewQuestions.push(`最近 30 天负责店铺的 ${metricHint} 分别是多少，哪些动作由你直接推动？`);
    interviewQuestions.push('商品卡自然流量是通过标题、入池、活动还是搜索权重提升拉起来的？');
    interviewQuestions.push('千川投流里哪类素材效果最好，你如何判断是否加预算或停计划？');
    interviewQuestions.push('达人寄样后如何筛选可放大的内容素材，失败素材怎么复盘？');
  } else if (isCrossBorder) {
    mustHaves.push(`有 ${platforms.join('、')} 平台运营或投放经验。`);
    mustHaves.push('能说明选品、Listing、广告、转化和库存周转之间的关系。');
    mustHaves.push(`能围绕 ${metricHint} 做数据复盘和增长判断。`);
    niceToHaves.push('熟悉跨境内容种草、站外引流、独立站转化或本地化素材测试。');
    interviewQuestions.push('最近负责的站点、类目、客单价和月销售额分别是多少？');
    interviewQuestions.push('你如何拆解广告消耗、点击、转化和毛利之间的关系？');
    interviewQuestions.push('Listing 或商品页最近一次优化改了什么，结果如何验证？');
  } else if (isDomesticShelf) {
    mustHaves.push(`有 ${platforms.join('、')} 店铺运营经验，能独立看数和推进活动节奏。`);
    mustHaves.push(`能围绕 ${metricHint} 说明店铺增长、活动转化或投放优化案例。`);
    mustHaves.push('理解货品、价格、页面、评价、活动和流量入口对转化的影响。');
    niceToHaves.push('熟悉生意参谋、京东商智、多多后台或平台营销活动报名。');
    interviewQuestions.push('最近一次大促你负责什么模块，GMV、转化和客单价有什么变化？');
    interviewQuestions.push('如果点击高但转化低，你会从货品、页面、价格还是评价先排查？');
    interviewQuestions.push('店铺自然流量和付费流量分别由哪些动作驱动？');
  } else {
    mustHaves.push('能说明最近负责的平台、店铺规模、品类和本人主责范围。');
    mustHaves.push(`能围绕 ${metricHint} 拆解运营结果，而不是只描述日常执行。`);
    mustHaves.push(`能讲清 ${moduleHint} 的动作、协作方和复盘方式。`);
    niceToHaves.push('有从需求拆解、执行推进到数据复盘的完整闭环案例。');
    interviewQuestions.push('你最近负责的电商平台、店铺规模、品类和核心指标是什么？');
    interviewQuestions.push('你负责的是策略、投放、货品、内容、活动还是执行支持？');
    interviewQuestions.push('最近一次明显改善数据的动作是什么，如何证明是你的动作带来的？');
  }

  if (categoryHint) {
    niceToHaves.unshift(`有 ${categoryHint} 相关品类经验，理解客单价、复购和素材打法。`);
  } else {
    niceToHaves.push('有与目标品类相近的客单价、复购周期或内容素材经验。');
  }

  interviewQuestions.push('团队里投手、设计、客服、主播或编导如何分工，你负责到哪一步？');
  interviewQuestions.push('如果入职第一个月只能改三件事，你会先看哪些数据和流程？');

  return {
    mustHaves: unique(mustHaves).slice(0, 5),
    niceToHaves: unique(niceToHaves).slice(0, 5),
    hardBars,
    interviewQuestions: unique(interviewQuestions).slice(0, 6),
  };
}

function calculateScore({
  jobTitle,
  analysisText,
  platforms,
  metrics,
  workModules,
  productCategories,
  contextCategories,
  missing,
  driftWarnings,
}) {
  const hasCategory = productCategories.length > 0;
  const hasTeam = contextCategories.includes('团队配置');
  const hasBenefits = contextCategories.includes('福利待遇');
  const hasSchedule = contextCategories.includes('作息安排');
  const hasResponsibilities = hasAny(RESPONSIBILITY_PATTERNS, analysisText);
  const hasRequirements = hasAny(REQUIREMENT_PATTERNS, analysisText);
  const hasQuantifiedTarget = /(\d+(\.\d+)?\s*%|\d+\s*(万|w|k|元|单|人|天|月|年))/i.test(analysisText);

  let score = 0;
  score += jobTitle ? 4 : 0;
  score += analysisText.length >= 24 ? 4 : 0;
  score += platforms.length > 0 ? Math.min(10 + (platforms.length - 1) * 4, 18) : 0;
  score += Math.min(workModules.length * 5, 22);
  score += Math.min(metrics.length * 4, 18);
  score += hasCategory ? 5 : 0;
  score += hasTeam ? 4 : 0;
  score += hasBenefits ? 3 : 0;
  score += hasSchedule ? 4 : 0;
  score += hasResponsibilities ? 7 : 0;
  score += hasRequirements ? 7 : 0;
  score += hasQuantifiedTarget ? 4 : 0;

  score -= Math.min(missing.length * 2, 12);
  score -= Math.min(driftWarnings.length * 4, 12);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildSummary({ score, riskLevel, platforms, metrics, workModules, missing, driftWarnings }) {
  if (score === 0) {
    return '当前信息不足，推荐流无法形成稳定候选人画像。';
  }

  const platformText = platforms.length > 0 ? platforms.join('、') : '平台范围';
  const moduleText = workModules.length > 0 ? workModules.join('、') : '工作模块';
  const metricText = metrics.length > 0 ? metrics.join('、') : '核心指标';

  if (riskLevel === 'low') {
    return `JD 推荐画像较清晰，已覆盖 ${platformText}、${moduleText} 和 ${metricText}；发布前可继续补强缺失的上下文。`;
  }

  if (riskLevel === 'medium') {
    return `JD 已具备基础方向，但仍有 ${missing.length} 个信息缺口；若不补齐，推荐流可能混入泛运营或执行型候选人。`;
  }

  const driftText = driftWarnings.length > 0 ? '，且存在优化漂移风险' : '';
  return `JD 画像偏泛${driftText}，平台、模块、指标或岗位上下文不足，推荐流高概率放宽到不匹配人选。`;
}

function buildRewriteHints({ missing, driftWarnings, platforms, metrics, workModules }) {
  const hints = missing.map((item) => item.suggestion);

  if (platforms.length > 1) {
    hints.push('如果岗位覆盖多个平台，请标注主平台、辅助平台和入职后优先负责的平台。');
  }

  if (metrics.length > 0 && !metrics.includes('预算') && workModules.includes('千川投流')) {
    hints.push('投流相关 JD 建议补充预算规模、ROI 底线和素材测试节奏。');
  }

  if (workModules.length > 2) {
    hints.push('模块较多时建议写清“主责模块”和“协作模块”，避免候选人误判为全能岗。');
  }

  if (driftWarnings.length > 0) {
    hints.push('优化文案时保留原始需求里的平台、模块和指标词，避免 AI 改写后画像变宽。');
  }

  return unique(hints).slice(0, 8);
}

export function analyzeJdRecommendationRisk({
  jobTitle = '',
  simpleNeed = '',
  jdDescription = '',
  optimizedText = '',
} = {}) {
  const finalBodyText = normalizeText(optimizedText) || normalizeText(jdDescription) || normalizeText(simpleNeed);
  const analysisText = normalizeText(jobTitle, finalBodyText);
  const sourceText = normalizeText(jobTitle, simpleNeed, jdDescription);
  const platforms = unique(detectLabels(PLATFORM_DEFS, analysisText));
  const metrics = unique(detectLabels(METRIC_DEFS, analysisText));
  const workModules = unique(detectLabels(WORK_MODULE_DEFS, analysisText));
  const productCategories = unique(detectLabels(PRODUCT_CATEGORY_DEFS, analysisText));
  const contextCategories = unique(detectLabels(CONTEXT_DEFS, analysisText));
  const categories = unique([...productCategories, ...contextCategories]);
  const driftWarnings = buildDriftWarnings(sourceText, optimizedText);
  const missing = buildMissingItems({
    analysisText,
    platforms,
    metrics,
    workModules,
    productCategories,
    contextCategories,
  });
  const score = calculateScore({
    jobTitle: normalizeText(jobTitle),
    analysisText,
    platforms,
    metrics,
    workModules,
    productCategories,
    contextCategories,
    missing,
    driftWarnings,
  });
  const riskLevel = score >= 75 ? 'low' : score >= 55 ? 'medium' : 'high';

  return {
    score,
    riskLevel,
    summary: buildSummary({ score, riskLevel, platforms, metrics, workModules, missing, driftWarnings }),
    detected: {
      platforms,
      categories,
      metrics,
      workModules,
    },
    missing,
    recommendationProfile: buildRecommendationProfile({
      platforms,
      metrics,
      workModules,
      productCategories,
    }),
    driftWarnings,
    rewriteHints: buildRewriteHints({ missing, driftWarnings, platforms, metrics, workModules }),
  };
}

export default analyzeJdRecommendationRisk;
