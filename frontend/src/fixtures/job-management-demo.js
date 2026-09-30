const DOUYIN_PROFILE = {
  city: '广州 番禺',
  owner: '张HR',
  status: 'published',
  channel: '社招全职',
  salary: '8000-10000元',
  headcount: 2,
  openDays: 12,
  refreshPlan: '今日 16:00',
  hiringGoal: '围绕商品卡自然流量、短视频千川投流、达人分发和数据复盘，招一位能直接拉动 GMV、ROI、CTR、CVR 的抖音运营。',
  publishForm: {
    recruitType: '社招全职',
    firstCategory: '客服/运营',
    secondCategory: '电商运营',
    thirdCategory: '国内电商运营',
    jobTitle: '抖音运营（商品卡/千川投流）',
    titleLimit: 20,
    descriptionPlaceholder: '介绍工作内容、职位要求',
    descriptionHint: '建议写清商品卡、千川投流、达人分发、GMV/ROI/CTR/CVR、协作对象和到岗要求。',
    lockedAfterPublish: ['招聘类型', '职位名称', '职位类型', '工作城市'],
  },
  jdAiDraft: {
    inputMode: 'simple_requirement',
    simpleRequirement: '招抖音运营，负责商品卡自然流量、千川短视频投流、达人分发和数据复盘，目标是提升店铺 GMV 与 ROI。',
    uiMock: {
      title: '已为你生成职位描述',
      subtitle: '内容仅供参考，可继续补充岗位福利、上班时间和品类信息。',
      regenerateLabel: '重新生成',
      insertLabel: '填入内容下方',
      replaceLabel: '替换原内容',
      generatedBy: '内容由 AI 生成',
    },
    llmInference: {
      jobGoal: '通过商品卡自然流量增长、短视频投流、达人分发等组合策略，持续提升店铺 GMV 与 ROI。',
      responsibilities: [
        '商品卡运营：负责抖音商品卡流量获取与优化，提升商品曝光、搜索权重和成交转化。',
        '千川投流：主导短视频素材投流及千川计划搭建，持续优化 ROI、CTR、CVR 等核心指标。',
        '达人分发：负责达人建联、寄样、跟进内容产出，筛选爆品素材并放大投流，形成“达人+付费”联动。',
        '数据复盘：监控投放数据与素材效果，及时调整人群定向、出价策略及素材方向。',
      ],
      requirements: [
        '大专及以上学历，1年以上抖音运营或千川投流相关经验。',
        '熟悉抖音短视频投流逻辑及千川后台操作，有实际 ROI、GMV 增长案例。',
        '了解商品卡流量获取方式，如标题优化、商品入池、活动报名、搜索权重提升等。',
        '具备基础数据分析能力，能围绕 GMV、ROI、CTR、CVR 做复盘和优化。',
      ],
      benefits: [
        '提供岗位相关福利待遇。',
        '可补充绩效奖金、项目提成、社保、上班时间、大小周等真实信息。',
      ],
    },
    generatedDescription: '【岗位目标】\n通过商品卡自然流量增长、短视频投流、达人分发等组合策略，持续提升店铺 GMV 与 ROI。\n\n【岗位职责】\n1. 商品卡运营：负责抖音商品卡流量获取与优化，提升商品曝光及搜索权重，直接拉动 GMV 增长。\n2. 千川投流：主导短视频素材投流及千川计划搭建，持续优化 ROI、CTR、CVR 等核心指标。\n3. 达人分发：负责达人建联、寄样、跟进内容产出，筛选爆品素材并放大投流，形成“达人+付费”联动。\n4. 数据复盘：监控投放数据与素材效果，及时调整人群定向、出价策略及素材方向。\n\n【任职要求】\n1. 大专及以上学历，1年以上抖音运营或千川投流相关经验。\n2. 熟悉抖音短视频投流逻辑及千川后台操作，有实际 ROI、GMV 增长案例。\n3. 了解商品卡流量获取方式，如标题优化、商品入池、活动报名等。\n4. 具备数据分析能力，能围绕 GMV、ROI、CTR、CVR 做复盘和优化。\n\n【岗位福利】\n提供岗位相关福利待遇。',
    missingInfo: [
      { field: '经营品类', severity: 'medium', suggestion: '补充主营品类、客单价区间和是否已有爆品素材。' },
      { field: '投放预算', severity: 'medium', suggestion: '补充日预算/月预算、ROI 底线和素材产出频率。' },
      { field: '工作制与福利', severity: 'low', suggestion: '补充上班时间、单双休、社保、绩效或提成规则。' },
    ],
    complianceRiskCheck: {
      blocked: false,
      items: [
        { key: 'contact', status: 'pass', message: '未包含电话、微信等联系方式。' },
        { key: 'specialSymbol', status: 'pass', message: '未使用影响发布的特殊符号。' },
        { key: 'discrimination', status: 'pass', message: '未出现性别、年龄、地域等歧视性表述。' },
        { key: 'laborLaw', status: 'warning', message: '福利和工作时间仍需 HR 按真实制度补全，避免承诺不清。' },
      ],
    },
    qualityCheck: {
      score: 88,
      grade: 'A-',
      summary: '职责和指标足够具体，建议补充品类、预算和团队协作边界后发布。',
      items: [
        { key: 'goal', label: '岗位目标', status: 'pass', detail: '明确指向 GMV 与 ROI。' },
        { key: 'responsibility', label: '职责颗粒度', status: 'pass', detail: '覆盖商品卡、千川、达人、复盘四个关键模块。' },
        { key: 'requirement', label: '任职要求', status: 'pass', detail: '写清经验年限、平台能力和指标案例。' },
        { key: 'attraction', label: '吸引力', status: 'warning', detail: '福利较泛，需要补真实薪酬结构和作息。' },
      ],
    },
  },
  commerceTalentPersona: {
    scenario: '抖音店铺增长型运营',
    keywords: ['商品卡', '千川投流', '达人分发', '短视频素材', '数据复盘', 'GMV', 'ROI', 'CTR', 'CVR'],
    coreMetrics: [
      { key: 'GMV', label: '成交规模', targetHint: '能说明本人直接拉动的月 GMV 或活动 GMV。' },
      { key: 'ROI', label: '投放回报', targetHint: '能拆解付费计划、素材和人群带来的 ROI 变化。' },
      { key: 'CTR', label: '点击率', targetHint: '能讲清标题、封面、素材钩子或商品卡点击优化。' },
      { key: 'CVR', label: '转化率', targetHint: '能解释详情页、价格、评价、达人内容对转化的影响。' },
    ],
    operatingModules: [
      { name: '商品卡', signals: ['标题优化', '商品入池', '搜索权重', '活动报名', '自然流量增长'] },
      { name: '千川投流', signals: ['计划搭建', '短视频素材投放', '出价策略', '人群定向', 'ROI 优化'] },
      { name: '达人分发', signals: ['达人建联', '寄样跟进', '内容产出', '爆品素材筛选', '达人+付费联动'] },
      { name: '数据复盘', signals: ['GMV', 'ROI', 'CTR', 'CVR', '素材效果', '人群调整'] },
    ],
    screeningQuestions: [
      '最近一个月负责店铺的 GMV、ROI、CTR、CVR 分别是多少？',
      '商品卡自然流量是通过标题、入池、活动还是搜索权重提升拉起来的？',
      '千川投流里哪类素材效果最好，如何判断是否加预算？',
      '达人寄样后如何筛选可放大的爆品素材？',
    ],
  },
  demoFunnel: {
    exposure: 1840,
    viewed: 292,
    recommended: 52,
    contacted: 18,
    replied: 7,
    interview: 3,
    offer: 0,
  },
  profile: {
    title: '抖音运营（商品卡/千川投流）',
    summary: '重点识别同时懂商品卡自然流量、千川投流、达人分发和数据复盘的人选，避免只会泛运营或只做执行协助。',
    mustHaves: ['有抖音店铺运营或千川投流经验', '能讲清 GMV、ROI、CTR、CVR 的优化动作', '理解商品卡流量获取、标题优化、入池和活动报名', '能独立做投放与素材复盘'],
    niceToHaves: ['有美妆、滋补、食品、服饰或家居品类经验', '能搭达人分发链路并筛选爆品素材', '熟悉巨量千川、罗盘或抖店后台'],
    hardBars: ['只做客服、上架或跟单，未参与运营决策', '只写投流但说不清预算、ROI 和素材变量', '无法说明本人负责模块和真实数据口径'],
    interviewSignals: ['追问最近一个店铺的 GMV、ROI、CTR、CVR', '让候选人拆一次商品卡自然流量增长动作', '核实千川计划、达人内容、素材复盘分别由谁负责'],
  },
  risks: [
    { level: 'medium', title: '投流真实性待核实', desc: '千川经验容易被简历泛化，需要追问预算、计划结构、素材变量和 ROI 口径。' },
    { level: 'medium', title: '商品卡经验待拆分', desc: '确认候选人是否真的做过标题优化、商品入池、活动报名和搜索权重提升。' },
    { level: 'low', title: '刷新窗口', desc: '岗位热度依赖刷新节奏，建议把高活跃时段留给 A/B 候选人触达。' },
  ],
};

const OPS_PROFILE = {
  city: '广州',
  owner: '张HR',
  status: 'published',
  channel: '社招全职',
  salary: '8K-15K',
  headcount: 2,
  openDays: 12,
  refreshPlan: '今日 16:00',
  hiringGoal: '先把国内电商运营岗位发布信息补齐，再围绕 GMV、ROI、平台经验和店铺操盘深度筛人。',
  publishForm: {
    recruitType: '社招全职',
    firstCategory: '客服/运营',
    secondCategory: '电商运营',
    thirdCategory: '国内电商运营',
    jobTitle: '国内电商运营',
    titleLimit: 20,
    descriptionPlaceholder: '介绍工作内容、职位要求',
    descriptionHint: '建议写清平台、品类、店铺规模、GMV/ROI 目标、协作对象和到岗要求。',
    lockedAfterPublish: ['招聘类型', '职位名称', '职位类型', '工作城市'],
  },
  jdAiDraft: {
    inputMode: 'simple_requirement',
    simpleRequirement: '招国内电商运营，负责天猫、京东、拼多多或抖音店铺日常运营、活动、商品和数据复盘，提升 GMV 和转化率。',
    uiMock: {
      title: '已为你生成职位描述',
      subtitle: '内容仅供参考，可继续补充平台、品类、店铺规模和福利信息。',
      regenerateLabel: '重新生成',
      insertLabel: '填入内容下方',
      replaceLabel: '替换原内容',
      generatedBy: '内容由 AI 生成',
    },
    llmInference: {
      jobGoal: '通过商品运营、活动运营、推广投放和数据复盘，提升店铺 GMV、转化率和运营效率。',
      responsibilities: [
        '负责国内电商平台店铺日常运营，包括商品上新、页面优化、活动策划及执行。',
        '分析平台数据，监控 GMV、转化率、客单价、ROI 等指标，调整运营策略。',
        '协同设计、客服、仓储等团队，保障活动上线、库存周转和客户体验。',
        '跟进平台规则变化，及时调整商品、价格、活动和推广方案。',
      ],
      requirements: [
        '具备电商平台运营相关经验，熟悉主流国内电商平台操作模式。',
        '具备数据分析、沟通协调和问题解决能力。',
        '能够独立完成运营任务，有较强责任心和执行力。',
      ],
      benefits: ['提供岗位相关福利待遇。'],
    },
    generatedDescription: '岗位职责：\n1. 负责国内电商平台店铺日常运营，包括商品上新、页面优化、活动策划及执行。\n2. 分析平台数据，监控 GMV、转化率、客单价、ROI 等指标，制定并调整运营策略。\n3. 协同设计、客服、仓储等团队，保障活动上线、库存周转和客户体验。\n4. 跟进平台规则变化，及时调整运营方案，确保合规运营。\n\n任职要求：\n1. 具备电商平台运营相关经验，熟悉主流国内电商平台操作模式。\n2. 具备良好的数据分析能力、沟通协调能力和问题解决能力。\n3. 能够独立完成运营任务，有较强的责任心和执行力。\n\n岗位福利：\n提供岗位相关福利待遇。',
    missingInfo: [
      { field: '目标平台', severity: 'medium', suggestion: '补充具体平台，如天猫、京东、拼多多、抖音。' },
      { field: '店铺规模', severity: 'medium', suggestion: '补充月 GMV、SKU 数、团队配置或投放预算。' },
      { field: '福利制度', severity: 'low', suggestion: '补充社保、绩效、奖金和作息。' },
    ],
    complianceRiskCheck: {
      blocked: false,
      items: [
        { key: 'contact', status: 'pass', message: '未包含电话、微信等联系方式。' },
        { key: 'discrimination', status: 'pass', message: '未出现歧视性表述。' },
        { key: 'promise', status: 'warning', message: '薪酬福利需要按真实制度补充，避免过度承诺。' },
      ],
    },
    qualityCheck: {
      score: 82,
      grade: 'B+',
      summary: '适合通用电商岗位发布，建议补充平台、品类和店铺规模以提升匹配度。',
      items: [
        { key: 'goal', label: '岗位目标', status: 'pass', detail: '明确围绕 GMV 与转化率。' },
        { key: 'platform', label: '平台信息', status: 'warning', detail: '需要补具体平台。' },
        { key: 'benefit', label: '福利信息', status: 'warning', detail: '福利内容偏泛。' },
      ],
    },
  },
  commerceTalentPersona: {
    scenario: '国内电商店铺运营',
    keywords: ['平台运营', '商品上新', '活动报名', '页面优化', '数据复盘', 'GMV', 'ROI', '转化率', '客单价'],
    coreMetrics: [
      { key: 'GMV', label: '成交规模', targetHint: '能说明负责店铺月 GMV 或活动增长结果。' },
      { key: 'ROI', label: '投放回报', targetHint: '能讲清推广费用、产出和优化动作。' },
      { key: 'CVR', label: '转化率', targetHint: '能解释页面、价格、活动和评价对转化的影响。' },
    ],
    operatingModules: [
      { name: '商品运营', signals: ['商品上新', '标题卖点', '价格策略', '库存协同'] },
      { name: '活动运营', signals: ['活动报名', '大促节奏', '优惠机制', '页面承接'] },
      { name: '推广投放', signals: ['直通车', '万相台', '千川', 'ROI 优化'] },
      { name: '数据复盘', signals: ['GMV', '转化率', '客单价', '复购', '库存周转'] },
    ],
    screeningQuestions: [
      '最近一个店铺的月 GMV、客单价、转化率分别是多少？',
      '你本人负责商品、活动、推广还是数据复盘？',
      '一次活动前中后分别做了哪些动作？',
    ],
  },
  demoFunnel: {
    exposure: 1280,
    viewed: 214,
    recommended: 36,
    contacted: 11,
    replied: 4,
    interview: 2,
    offer: 0,
  },
  profile: {
    title: '国内电商运营',
    summary: '前期职位管理只抓电商招聘最关键的发布信息和筛选口径：平台、品类、店铺规模、GMV/ROI、本人职责、协作对象。',
    mustHaves: ['淘宝/天猫/抖音/拼多多任一平台运营经验', '能讲清店铺 GMV、转化率、客单价或 ROI', '熟悉活动报名、商品上新、库存和价格协同', '能独立做日常数据复盘'],
    niceToHaves: ['美妆、保健、服饰或家居品类经验', '会看生意参谋/千川/巨量后台', '能输出商品标题、卖点和基础页面建议'],
    hardBars: ['只做客服或上架，未参与运营决策', '无法说明负责店铺规模和关键指标', '只会泛泛说活动，没有具体动作和结果'],
    interviewSignals: ['追问最近一个店铺的 GMV、毛利和 ROI 目标', '让候选人拆一次活动前中后的运营动作', '核实本人负责范围：选品、推广、活动、数据还是客服协助'],
  },
  risks: [
    { level: 'medium', title: '运营深度待核实', desc: '电商简历常写 GMV/ROI，需要追问平台后台、数据口径和本人职责。' },
    { level: 'low', title: '刷新窗口', desc: '岗位热度依赖刷新节奏，建议把高活跃时段留给 A/B 候选人触达。' },
  ],
};

const CROSS_BORDER_PROFILE = {
  city: '广州',
  owner: '张HR',
  status: 'published',
  channel: '社招全职',
  salary: '10K-18K',
  headcount: 2,
  openDays: 18,
  refreshPlan: '明日 10:30',
  hiringGoal: '优先找有 Amazon、Shopee、TikTok Shop 或独立站实操经验的人选。',
  publishForm: {
    recruitType: '社招全职',
    firstCategory: '客服/运营',
    secondCategory: '电商运营',
    thirdCategory: '跨境电商运营',
    jobTitle: '跨境电商运营',
    titleLimit: 20,
    descriptionPlaceholder: '介绍工作内容、职位要求',
    descriptionHint: '建议写清平台、站点、品类、广告预算、Listing 优化和英语要求。',
    lockedAfterPublish: ['招聘类型', '职位名称', '职位类型', '工作城市'],
  },
  jdAiDraft: {
    inputMode: 'simple_requirement',
    simpleRequirement: '招跨境电商运营，负责 Amazon、Shopee、TikTok Shop 或独立站店铺运营，做 Listing、广告、数据复盘和订单协同。',
    uiMock: {
      title: '已为你生成职位描述',
      subtitle: '内容仅供参考，可继续补充站点、品类、广告预算和语言要求。',
      regenerateLabel: '重新生成',
      insertLabel: '填入内容下方',
      replaceLabel: '替换原内容',
      generatedBy: '内容由 AI 生成',
    },
    llmInference: {
      jobGoal: '通过 Listing 优化、广告投放和站点运营，提升跨境店铺销售额、转化率和广告 ROI。',
      responsibilities: [
        '负责跨境平台店铺日常运营，包括产品上架、Listing 优化、活动报名和库存协同。',
        '跟进站点规则、广告投放和销售数据，持续优化曝光、点击、转化和 ROI。',
        '协同供应链、客服和物流团队，保障订单履约和客户体验。',
      ],
      requirements: [
        '有 Amazon、Shopee、TikTok Shop 或独立站运营经验。',
        '熟悉 Listing 优化、广告投放、站点规则和基础英文读写。',
        '能基于销售额、转化率、广告 ROI 做数据复盘。',
      ],
      benefits: ['提供岗位相关福利待遇。'],
    },
    generatedDescription: '岗位职责：\n1. 负责跨境平台店铺日常运营，包括产品上架、Listing 优化、活动报名和库存协同。\n2. 跟进站点规则、广告投放和销售数据，持续优化曝光、点击、转化和 ROI。\n3. 协同供应链、客服和物流团队，保障订单履约和客户体验。\n\n任职要求：\n1. 有 Amazon、Shopee、TikTok Shop 或独立站运营经验。\n2. 熟悉 Listing 优化、广告投放、站点规则和基础英文读写。\n3. 能基于销售额、转化率、广告 ROI 做数据复盘。\n\n岗位福利：\n提供岗位相关福利待遇。',
    missingInfo: [
      { field: '平台和站点', severity: 'high', suggestion: '补充具体平台、国家站点和主营品类。' },
      { field: '语言要求', severity: 'medium', suggestion: '补充英语或小语种读写要求。' },
      { field: '广告预算', severity: 'medium', suggestion: '补充日预算、月预算或 ACOS/ROI 目标。' },
    ],
    complianceRiskCheck: {
      blocked: false,
      items: [
        { key: 'contact', status: 'pass', message: '未包含电话、微信等联系方式。' },
        { key: 'discrimination', status: 'pass', message: '未出现歧视性表述。' },
        { key: 'language', status: 'warning', message: '语言要求需与岗位职责相关并保持合理。' },
      ],
    },
    qualityCheck: {
      score: 84,
      grade: 'B+',
      summary: '跨境关键模块完整，建议补充具体平台、站点和广告预算。',
      items: [
        { key: 'platform', label: '平台站点', status: 'warning', detail: '需要补具体平台与站点。' },
        { key: 'listing', label: 'Listing 能力', status: 'pass', detail: '已覆盖 Listing 优化和广告复盘。' },
        { key: 'fulfillment', label: '履约协同', status: 'pass', detail: '已覆盖供应链、客服和物流协同。' },
      ],
    },
  },
  commerceTalentPersona: {
    scenario: '跨境平台运营',
    keywords: ['Amazon', 'Shopee', 'TikTok Shop', '独立站', 'Listing', '广告 ROI', 'ACOS', 'CVR', '站点规则'],
    coreMetrics: [
      { key: 'Sales', label: '销售额', targetHint: '能说明站点、SKU 数和月销售额。' },
      { key: 'ROI', label: '广告回报', targetHint: '能拆广告预算、ACOS 或 ROI 优化动作。' },
      { key: 'CVR', label: '转化率', targetHint: '能解释 Listing、价格、评价和物流时效对转化的影响。' },
    ],
    operatingModules: [
      { name: 'Listing', signals: ['标题关键词', '主图卖点', 'A+ 页面', '评价优化'] },
      { name: '广告投放', signals: ['预算', 'ACOS', 'ROI', '关键词', '人群包'] },
      { name: '站点运营', signals: ['活动报名', '库存', '物流', '规则变化'] },
    ],
    screeningQuestions: [
      '负责过哪些平台和站点？对应月销售额是多少？',
      '最近一次 Listing 优化改了什么，数据如何变化？',
      '广告预算、ACOS/ROI 和转化率分别是多少？',
    ],
  },
  demoFunnel: {
    exposure: 980,
    viewed: 176,
    recommended: 28,
    contacted: 9,
    replied: 3,
    interview: 1,
    offer: 0,
  },
  profile: {
    title: '跨境电商运营',
    summary: '跨境岗位重点看平台、站点、Listing、广告投放和订单履约协同，避免只做客服或跟单的人选混入。',
    mustHaves: ['有跨境平台店铺运营经验', '能讲清广告预算、转化率和 Listing 优化', '了解站点规则、物流和库存协同', '具备基础英文读写能力'],
    niceToHaves: ['Amazon、Shopee、TikTok Shop 经验', '独立站或海外社媒投放经验', '熟悉新品冷启动'],
    hardBars: ['只做订单处理或客服回复', '没有站点、广告或 Listing 实操', '无法说明平台规则和数据指标'],
    interviewSignals: ['追问负责站点、SKU 数和月销售额', '让候选人讲一次 Listing 优化前后数据', '确认广告、选品、库存各自参与深度'],
  },
  risks: [
    { level: 'medium', title: '平台经验待核实', desc: '跨境岗位要区分店铺运营、客服跟单和广告投放，避免标题匹配但经验不匹配。' },
  ],
};

const GENERAL_PROFILE = {
  city: '广州',
  owner: '张HR',
  status: 'published',
  channel: '社招全职',
  salary: '面议',
  headcount: 2,
  openDays: 9,
  refreshPlan: '今日 18:00',
  hiringGoal: '前期先按电商运营通用口径管理岗位，后续再细分平台和品类。',
  publishForm: {
    recruitType: '社招全职',
    firstCategory: '客服/运营',
    secondCategory: '电商运营',
    thirdCategory: '国内电商运营',
    jobTitle: '国内电商运营',
    titleLimit: 20,
    descriptionPlaceholder: '介绍工作内容、职位要求',
    descriptionHint: '建议先写清平台、品类、运营目标和候选人必须有的实操经验。',
    lockedAfterPublish: ['招聘类型', '职位名称', '职位类型', '工作城市'],
  },
  jdAiDraft: {
    inputMode: 'simple_requirement',
    simpleRequirement: '招电商运营，先按通用岗位发布，后续根据候选人来源再细分平台、品类和指标。',
    uiMock: {
      title: '已为你生成职位描述',
      subtitle: '内容仅供参考，建议继续补充平台、品类和核心指标。',
      regenerateLabel: '重新生成',
      insertLabel: '填入内容下方',
      replaceLabel: '替换原内容',
      generatedBy: '内容由 AI 生成',
    },
    llmInference: {
      jobGoal: '负责电商店铺基础运营工作，通过商品、活动和数据复盘提升销售表现。',
      responsibilities: [
        '负责店铺日常运营，包括商品维护、活动执行、页面优化和数据整理。',
        '跟进平台规则和业务数据，及时调整运营方案。',
        '协同内部团队完成商品、客服、仓储等相关工作。',
      ],
      requirements: [
        '有电商运营或平台运营经验优先。',
        '具备基础数据分析和沟通协作能力。',
        '执行力强，能按计划推进运营任务。',
      ],
      benefits: ['提供岗位相关福利待遇。'],
    },
    generatedDescription: '岗位职责：\n1. 负责店铺日常运营，包括商品维护、活动执行、页面优化和数据整理。\n2. 跟进平台规则和业务数据，及时调整运营方案。\n3. 协同内部团队完成商品、客服、仓储等相关工作。\n\n任职要求：\n1. 有电商运营或平台运营经验优先。\n2. 具备基础数据分析和沟通协作能力。\n3. 执行力强，能按计划推进运营任务。\n\n岗位福利：\n提供岗位相关福利待遇。',
    missingInfo: [
      { field: '平台', severity: 'high', suggestion: '至少明确一个平台方向，否则推荐候选人会过于发散。' },
      { field: '品类', severity: 'medium', suggestion: '补充主营品类、SKU 数或客单价。' },
      { field: '指标', severity: 'medium', suggestion: '补充 GMV、ROI、转化率或活动目标。' },
    ],
    complianceRiskCheck: {
      blocked: false,
      items: [
        { key: 'contact', status: 'pass', message: '未包含电话、微信等联系方式。' },
        { key: 'discrimination', status: 'pass', message: '未出现歧视性表述。' },
        { key: 'specificity', status: 'warning', message: '岗位信息偏泛，可能影响推荐准确性。' },
      ],
    },
    qualityCheck: {
      score: 70,
      grade: 'B-',
      summary: '可用于占位发布，但平台、品类和指标缺失会降低匹配质量。',
      items: [
        { key: 'goal', label: '岗位目标', status: 'warning', detail: '目标较泛，需要补具体业务指标。' },
        { key: 'responsibility', label: '职责完整度', status: 'pass', detail: '覆盖基础运营动作。' },
        { key: 'requirement', label: '要求明确度', status: 'warning', detail: '缺少平台、年限和硬技能要求。' },
      ],
    },
  },
  commerceTalentPersona: {
    scenario: '电商运营通用画像',
    keywords: ['店铺运营', '商品维护', '活动执行', '数据复盘', 'GMV', 'ROI', 'CTR', 'CVR'],
    coreMetrics: [
      { key: 'GMV', label: '成交规模', targetHint: '优先确认候选人是否能提供可核实的业务指标。' },
      { key: 'ROI', label: '投入产出', targetHint: '如涉及推广，需要确认投放成本和产出。' },
      { key: 'CVR', label: '转化率', targetHint: '确认是否理解流量、页面、价格和客服对转化的影响。' },
    ],
    operatingModules: [
      { name: '基础运营', signals: ['商品维护', '活动执行', '页面优化', '客服协同'] },
      { name: '数据复盘', signals: ['GMV', 'ROI', 'CTR', 'CVR', '转化率'] },
    ],
    screeningQuestions: [
      '你最近负责哪个平台、什么品类、多少 SKU？',
      '能否提供一个明确的 GMV、ROI 或转化率优化案例？',
      '你本人在运营链路里负责哪一段？',
    ],
  },
  demoFunnel: {
    exposure: 720,
    viewed: 126,
    recommended: 18,
    contacted: 6,
    replied: 2,
    interview: 1,
    offer: 0,
  },
  profile: {
    title: '电商运营通用岗位',
    summary: '通用电商岗位先沉淀发布信息、岗位分类和筛选口径，避免岗位名称写得很宽导致推荐流人选发散。',
    mustHaves: ['有平台运营或店铺运营实操', '能提供可核实业务指标', '薪资和城市大体匹配', '近期求职意愿明确'],
    niceToHaves: ['同平台或同品类经验', '能做基础数据分析', '到岗周期短'],
    hardBars: ['简历信息严重不足', '没有电商实操证据', '关键事实前后矛盾'],
    interviewSignals: ['确认最近店铺规模和负责模块', '核实离职原因和到岗时间', '追问一个最能证明运营能力的结果'],
  },
  risks: [
    { level: 'low', title: '画像待精修', desc: '负责人访谈和候选人反馈积累后，需要继续收紧硬门槛。' },
  ],
};

function profileForName(name) {
  if (/跨境|亚马逊|Amazon|Shopee|TikTok|独立站|国际/i.test(name)) return CROSS_BORDER_PROFILE;
  if (/抖音|千川|巨量|商品卡|达人|投流|短视频/.test(name)) return DOUYIN_PROFILE;
  if (/运营|媒介|广告|淘宝|天猫|京东|拼多多|电商|店铺/.test(name)) return OPS_PROFILE;
  return GENERAL_PROFILE;
}

export function getJobManagementDemo(job, index = 0) {
  const name = job && job.name ? job.name : '未命名岗位';
  const base = profileForName(name);
  const fixture = !!(job && job.is_fixture);
  return {
    ...base,
    id: job && job.id,
    name,
    sequence: index + 1,
    status: fixture ? 'draft' : base.status,
    isFixture: fixture,
    owner: base.owner,
    jdAssistant: base.jdAssistant || base.jdAiDraft,
    lastOperation: fixture ? '测试数据岗位，仅用于离线演示' : `最近刷新：${base.refreshPlan}`,
  };
}

export const JOB_STATUS_META = {
  published: { label: '招聘中', color: 'green' },
  paused: { label: '已暂停', color: 'orange' },
  draft: { label: '草稿/测试', color: 'gold' },
  closed: { label: '已关闭', color: 'default' },
};
