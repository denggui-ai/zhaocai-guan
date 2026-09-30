'use strict';

const CATALOG_SCHEMA_VERSION = 'ecommerce_job_template_catalog_v1';
const CATALOG_VERSION = '2026.07.16.1';

const HR_VARIABLE_DEFINITIONS = {
  business_model: { label: '经营模式', prompt: '请说明品牌自营、经销、代运营或其他经营模式。' },
  platform_channels: { label: '平台与渠道', prompt: '请确认该岗位实际负责的平台、店铺、账号或渠道范围。' },
  product_category: { label: '商品类目', prompt: '请填写主营商品类目、客单特点和需要理解的核心产品。' },
  business_scale: { label: '业务规模', prompt: '请补充店铺、账号、订单、用户或内容的大致业务规模。' },
  team_context: { label: '团队情况', prompt: '请说明团队配置、协作角色和该岗位在团队中的位置。' },
  reporting_line: { label: '汇报与协作', prompt: '请填写汇报对象和主要跨部门协作对象。' },
  key_kpis: { label: '关键目标', prompt: '请填写试用期及日常关注的业务目标；不要把未确认目标写成承诺。' },
  salary_structure: { label: '薪资结构', prompt: '请由 HR 填写真实薪资范围、构成和发放口径。' },
  incentive_structure: { label: '奖金或提成', prompt: '如有奖金、绩效或提成，请填写真实计算口径；没有则留空。' },
  work_location: { label: '工作地点', prompt: '请填写真实办公地点以及是否需要外出或驻场。' },
  work_schedule: { label: '工作时间', prompt: '请填写真实工作时间、休息安排、班次或直播时段。' },
  experience_expectation: { label: '经验期望', prompt: '请确认期望的相关经验及可接受的替代经验。' },
  tool_stack: { label: '工具与系统', prompt: '请填写岗位实际使用的平台后台、软件、设备或业务系统。' },
  must_have_preferences: { label: '必须项确认', prompt: '请逐条确认真正不可替代的要求；未确认内容不得作为硬门槛。' },
  nice_to_have_preferences: { label: '加分项确认', prompt: '请确认哪些能力仅为加分项，避免误写成必须条件。' },
  management_scope: { label: '管理范围', prompt: '如岗位带团队，请填写人数、层级和管理责任；不带团队则留空。' },
  service_channels: { label: '服务渠道', prompt: '请填写在线聊天、电话、平台工单或其他实际服务渠道。' },
  service_volume: { label: '服务量与峰值', prompt: '请说明日常咨询、工单或订单量级以及大促峰值特点。' },
  target_users: { label: '目标用户', prompt: '请描述核心用户、会员或社群人群及其主要需求。' },
  content_channels: { label: '内容渠道', prompt: '请填写需要运营的内容平台、账号矩阵和内容载体。' },
  content_cadence: { label: '内容节奏', prompt: '请说明日常更新频率、活动节点和内容产能预期。' },
  live_schedule: { label: '直播安排', prompt: '请填写直播平台、场次、时段和是否需要轮班。' },
  design_deliverables: { label: '设计交付物', prompt: '请列出主图、详情页、活动视觉、包装或其他实际交付物。' },
  brand_guidelines: { label: '品牌规范', prompt: '请补充已有品牌调性、视觉规范和不可改变的产品事实。' },
  market_language: { label: '市场与语言', prompt: '请填写目标国家或地区、工作语言及本地化要求。' },
  recruitment_scope: { label: '招聘范围', prompt: '请填写主要招聘岗位、招聘量和当前最急的用人场景。' },
  hr_scope: { label: '人力工作范围', prompt: '请确认招聘、入离职、员工关系、考勤或培训等实际职责边界。' },
  admin_scope: { label: '行政工作范围', prompt: '请确认办公、采购、资产、供应商或接待等实际职责边界。' },
  accounting_scope: { label: '核算范围', prompt: '请填写负责主体、账套、平台账单、税务和报表范围。' },
  entity_and_tax: { label: '主体与税务', prompt: '请说明公司主体数量、纳税类型及是否涉及跨境业务。' },
};

function variant(definition) {
  return definition;
}

const families = [
  {
    family_key: 'content-new-media',
    display_name: '内容与新媒体运营',
    source_codes: ['C1', 'C2', 'C4', 'C5'],
    variants: [
      variant({
        variant_key: 'video-operations',
        source_codes: ['C1'],
        job_title: '视频运营',
        boss_category_hint: ['客服/运营', '内容运营', '视频运营'],
        core_responsibilities_draft: [
          '围绕商品卖点和用户场景制定短视频选题、发布节奏与账号栏目。',
          '协同拍摄、剪辑或出镜人员推进内容制作，并对脚本和成片的商品信息负责。',
          '跟踪播放、互动、引流和成交相关数据，复盘选题与素材表现并提出迭代方案。',
        ],
        optional_responsibilities_draft: ['维护达人或素材合作清单。', '沉淀可复用的商品视频素材库。'],
        job_requirements_draft: {
          must_have: ['能独立完成视频账号的选题、发布和数据复盘闭环。', '能把商品事实转化为清楚、合规的内容表达。'],
          nice_to_have: ['有电商短视频引流或转化经验。', '具备基础脚本、拍摄或剪辑能力。'],
        },
        profile_draft: {
          role_mission: '持续产出能解释商品价值并带来有效用户行动的视频内容。',
          suggested_positive_signals: ['能提供从选题到复盘的完整案例。', '能区分播放热度与有效转化。', '能说明如何校验商品卖点真实性。'],
          points_to_verify: ['本人在案例中的具体职责。', '内容产能与质量如何平衡。', '数据不达预期时如何调整。'],
        },
        interview_focus: ['请拆解一条代表性视频从需求到复盘的全过程。', '给定一个陌生商品，如何确定前三个测试选题？', '如何避免为了流量夸大商品效果？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'content_channels', 'content_cadence', 'key_kpis', 'team_context', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'new-media-operations',
        source_codes: ['C2'],
        job_title: '新媒体运营',
        boss_category_hint: ['客服/运营', '内容运营', '新媒体运营'],
        core_responsibilities_draft: [
          '根据品牌和商品经营目标规划新媒体账号矩阵、内容日历与阶段主题。',
          '组织图文、短视频或直播预告等内容的生产、发布和互动维护。',
          '分析粉丝增长、互动、引流和线索质量，形成周期复盘并调整渠道策略。',
        ],
        optional_responsibilities_draft: ['策划节日或新品传播活动。', '协同达人、社群或店铺运营放大优质内容。'],
        job_requirements_draft: {
          must_have: ['能管理至少一种新媒体渠道的完整运营节奏。', '具备内容策划、编辑和基础数据分析能力。'],
          nice_to_have: ['有消费品或电商品牌账号经验。', '有跨渠道内容复用和活动协同经验。'],
        },
        profile_draft: {
          role_mission: '用稳定的内容运营建立品牌触达，并把关注转化为可衡量的业务机会。',
          suggested_positive_signals: ['有连续运营而非单次爆款案例。', '能解释不同渠道的用户差异。', '复盘中同时关注内容和业务指标。'],
          points_to_verify: ['账号成果是否由本人主导。', '是否会只追求粉丝量。', '跨团队推进内容的方式。'],
        },
        interview_focus: ['如何为一个新品制定首月内容日历？', '某渠道粉丝增长但店铺引流下降时如何排查？', '如何统一品牌口径又适配不同平台？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'content_channels', 'content_cadence', 'target_users', 'key_kpis', 'team_context', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'content-operations',
        source_codes: ['C4'],
        job_title: '内容运营',
        boss_category_hint: ['客服/运营', '内容运营', '内容运营'],
        core_responsibilities_draft: [
          '围绕用户决策链路规划商品教育、场景种草、购买答疑和复购内容。',
          '建立选题、审核、发布和归档机制，协调内外部资源稳定交付内容。',
          '结合搜索、互动、停留和转化反馈识别内容缺口，持续优化内容结构。',
        ],
        optional_responsibilities_draft: ['维护内容标签和素材复用规则。', '参与商品知识库与客服内容建设。'],
        job_requirements_draft: {
          must_have: ['能从用户问题和商品信息中提炼内容主题。', '具备文字编辑、项目推进和内容效果复盘能力。'],
          nice_to_have: ['有内容中台或多渠道分发经验。', '有商品知识库、SEO 或搜索内容经验。'],
        },
        profile_draft: {
          role_mission: '建立覆盖用户决策过程的内容供给，让商品信息清楚、可信且可复用。',
          suggested_positive_signals: ['能展示体系化内容规划。', '能说明内容如何解决真实用户问题。', '有审核和事实校验习惯。'],
          points_to_verify: ['是否仅擅长单一文体。', '如何判断内容缺口。', '如何处理多方修改意见。'],
        },
        interview_focus: ['请用一个商品说明用户决策链路需要哪些内容。', '如何把客服高频问题转成内容计划？', '内容效果无法直接归因成交时如何评价价值？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'target_users', 'content_channels', 'content_cadence', 'key_kpis', 'team_context', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'wechat-operations',
        source_codes: ['C5'],
        job_title: '微信运营',
        boss_category_hint: ['客服/运营', '内容运营', '微信运营'],
        core_responsibilities_draft: [
          '负责公众号、视频号或企业微信相关内容的规划、编辑、发布与日常维护。',
          '设计从内容触达到加企微、入群、咨询或复购的承接路径，并协同客服执行。',
          '跟踪阅读、互动、用户沉淀和转化反馈，持续优化菜单、自动回复和内容栏目。',
        ],
        optional_responsibilities_draft: ['策划会员或私域主题活动。', '维护微信生态素材与用户问题库。'],
        job_requirements_draft: {
          must_have: ['熟悉至少一种微信生态账号的内容和用户承接流程。', '能独立完成图文编辑、发布和基础数据复盘。'],
          nice_to_have: ['有企业微信或私域协同经验。', '有视频号内容或直播联动经验。'],
        },
        profile_draft: {
          role_mission: '在微信生态内提供持续、可信的用户触达并承接咨询与复购。',
          suggested_positive_signals: ['能区分公众号、视频号和企微的作用。', '能展示用户承接路径案例。', '关注留存和服务体验而非只看阅读量。'],
          points_to_verify: ['是否真实操作过后台。', '个人信息和群发边界意识。', '内容与客服如何交接。'],
        },
        interview_focus: ['如何把一篇公众号内容承接到后续咨询？', '微信渠道打开率下降时会检查哪些环节？', '如何避免频繁群发造成用户流失？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'target_users', 'content_channels', 'content_cadence', 'key_kpis', 'team_context', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'ecommerce-customer-service',
    display_name: '电商客服序列',
    source_codes: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'H4'],
    variants: [
      variant({
        variant_key: 'customer-service-specialist',
        source_codes: ['S1'],
        job_title: '客服专员',
        boss_category_hint: ['客服/运营', '客服', '客服专员'],
        core_responsibilities_draft: [
          '通过约定渠道接待商品、订单、物流和售后咨询，准确记录并及时处理。',
          '依据商品与服务口径解答问题，对无法独立解决的事项清楚升级并跟踪结果。',
          '整理高频问题和异常反馈，为商品说明、流程和客服知识库优化提供信息。',
        ],
        optional_responsibilities_draft: ['参与大促排班和应急支持。', '协助维护快捷回复与知识库。'],
        job_requirements_draft: {
          must_have: ['表达清楚、记录准确，能在多任务环境中保持服务质量。', '具备基本的客户问题判断和跨部门跟进能力。'],
          nice_to_have: ['有电商订单或平台客服经验。', '熟悉常见客服或工单工具。'],
        },
        profile_draft: {
          role_mission: '准确、高效地解决客户问题，并让未解决事项有明确的跟进结果。',
          suggested_positive_signals: ['能给出完整服务案例。', '重视记录与闭环。', '面对情绪客户仍能保持事实表达。'],
          points_to_verify: ['实际服务渠道和业务量。', '异常升级判断。', '班次接受情况需由 HR 单独确认。'],
        },
        interview_focus: ['请复盘一次较复杂的客户问题如何闭环。', '同时收到多类咨询时如何排序？', '遇到口径不清的问题会怎么回复和升级？'],
        hr_variables: ['platform_channels', 'product_category', 'service_channels', 'service_volume', 'team_context', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'customer-service-supervisor',
        source_codes: ['S2'],
        job_title: '客服主管',
        boss_category_hint: ['客服/运营', '客服', '客服主管'],
        core_responsibilities_draft: [
          '安排客服排班和任务分配，保障日常及活动峰值期间的服务承接。',
          '抽检会话与工单，辅导团队改善响应、解决率和服务口径。',
          '处理一线升级和典型客诉，推动商品、物流或售后问题形成闭环。',
        ],
        optional_responsibilities_draft: ['组织新人带教和情景演练。', '维护服务日报与异常案例库。'],
        job_requirements_draft: {
          must_have: ['有一线客服经验并能承担现场排班、质检和辅导。', '能基于服务数据定位具体问题并推动整改。'],
          nice_to_have: ['有大促客服现场管理经验。', '有客服知识库或质检规则建设经验。'],
        },
        profile_draft: {
          role_mission: '让客服团队在日常与峰值场景下保持稳定服务并持续改进。',
          suggested_positive_signals: ['能量化说明带队改善。', '既看指标也能拆会话案例。', '有明确的升级和复盘机制。'],
          points_to_verify: ['真实管理人数和职责。', '如何处理指标与体验冲突。', '是否亲自处理过重大客诉。'],
        },
        interview_focus: ['大促咨询量突增时如何排班和分流？', '如何从一次质检问题推进到团队改善？', '请举例说明一次跨部门客诉闭环。'],
        hr_variables: ['platform_channels', 'product_category', 'service_channels', 'service_volume', 'team_context', 'management_scope', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'customer-service-manager',
        source_codes: ['S3'],
        job_title: '客服经理',
        boss_category_hint: ['客服/运营', '客服', '客服经理'],
        core_responsibilities_draft: [
          '制定客服阶段目标、人员配置和服务流程，保障多渠道服务稳定运行。',
          '建立培训、质检、升级和复盘机制，持续改善客户体验与问题解决效率。',
          '联动商品、仓储、物流和运营团队治理重复出现的客户问题。',
        ],
        optional_responsibilities_draft: ['规划客服工具和知识库优化。', '参与服务供应商评估与管理。'],
        job_requirements_draft: {
          must_have: ['有客服团队管理和流程建设经验。', '能将服务指标、客户反馈与跨部门整改结合。'],
          nice_to_have: ['管理过多平台或多业务线客服。', '有客服系统选型或外包管理经验。'],
        },
        profile_draft: {
          role_mission: '建立可执行的客服管理机制，稳定解决问题并减少重复客诉。',
          suggested_positive_signals: ['有从问题到机制的改进案例。', '能说明人员配置依据。', '关注客户体验和经营损失两端。'],
          points_to_verify: ['管理范围是否匹配岗位。', '关键改善是否有可核验过程。', '对一线业务的熟悉程度。'],
        },
        interview_focus: ['请拆解一次客服流程改造及结果。', '如何确定团队编制和峰值保障方案？', '当跨部门长期不解决根因时如何推进？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'service_channels', 'service_volume', 'team_context', 'management_scope', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'online-customer-service',
        source_codes: ['S4'],
        job_title: '网络客服',
        boss_category_hint: ['客服/运营', '客服', '网络客服'],
        core_responsibilities_draft: [
          '通过店铺聊天、私信或在线工单及时承接客户咨询，保持准确且一致的书面口径。',
          '结合商品、库存、活动和订单状态给出可执行答复，并记录待跟进事项。',
          '识别异常会话、集中问题和潜在客诉，及时升级并反馈给相关业务。',
        ],
        optional_responsibilities_draft: ['优化快捷回复与机器人转人工规则。', '整理聊天场景案例用于培训。'],
        job_requirements_draft: {
          must_have: ['具备清楚、快速的在线文字沟通能力。', '能同时处理多会话并保持信息准确。'],
          nice_to_have: ['熟悉电商平台聊天后台。', '有在线咨询转化或工单经验。'],
        },
        profile_draft: {
          role_mission: '在在线高并发场景中快速给出准确答复并保证问题有去向。',
          suggested_positive_signals: ['文字表达简洁且有步骤。', '能说明多会话管理方法。', '会主动确认库存活动等动态信息。'],
          points_to_verify: ['打字速度不替代服务判断。', '是否能识别高风险客诉。', '是否接受实际班次需由 HR 确认。'],
        },
        interview_focus: ['请现场组织一段商品缺货咨询的回复。', '五个会话同时到达时如何管理？', '发现活动口径可能错误时如何处理？'],
        hr_variables: ['platform_channels', 'product_category', 'service_channels', 'service_volume', 'team_context', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'telephone-customer-service',
        source_codes: ['S5'],
        job_title: '电话客服',
        boss_category_hint: ['客服/运营', '客服', '电话客服'],
        core_responsibilities_draft: [
          '按业务要求接听或回拨客户电话，核实问题事实并提供清楚的处理方案。',
          '完整记录沟通要点、客户诉求和后续节点，按承诺时间持续跟进。',
          '识别投诉、退款、物流或安全类高风险事项，并按流程及时升级。',
        ],
        optional_responsibilities_draft: ['参与服务话术和录音质检优化。', '汇总电话渠道的高频问题。'],
        job_requirements_draft: {
          must_have: ['普通话表达清楚，具备倾听、追问和事实确认能力。', '能在通话后准确记录并持续跟进事项。'],
          nice_to_have: ['有呼叫中心或电商电话服务经验。', '有投诉安抚和升级处理经验。'],
        },
        profile_draft: {
          role_mission: '通过有效通话澄清问题、稳定情绪，并留下可追踪的处理记录。',
          suggested_positive_signals: ['能复述客户诉求再给方案。', '有通话记录和回访习惯。', '清楚何时必须升级。'],
          points_to_verify: ['是否只依赖固定话术。', '高压通话中的情绪稳定性。', '通话与后续工单如何衔接。'],
        },
        interview_focus: ['如何接待一位重复来电且情绪激动的客户？', '请描述一次通过追问找到真实问题的案例。', '电话承诺无法按时完成时怎么处理？'],
        hr_variables: ['business_model', 'product_category', 'service_channels', 'service_volume', 'team_context', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'after-sales-customer-service',
        source_codes: ['S6'],
        job_title: '售后客服',
        boss_category_hint: ['客服/运营', '客服', '售后客服'],
        core_responsibilities_draft: [
          '处理退换货、退款、维修、物流异常和投诉等售后事项，核实材料并推进闭环。',
          '依据平台规则和公司政策给出方案，清楚记录责任、进度和客户反馈。',
          '归纳商品质量、包装、仓配和服务问题，推动减少重复售后。',
        ],
        optional_responsibilities_draft: ['维护售后案例与政策变更记录。', '参与重大客诉和平台申诉材料准备。'],
        job_requirements_draft: {
          must_have: ['能在规则范围内判断售后问题并推进多方处理。', '具备耐心沟通、证据记录和时效管理能力。'],
          nice_to_have: ['熟悉相关电商平台售后规则。', '有质量问题归因或平台申诉经验。'],
        },
        profile_draft: {
          role_mission: '让售后问题得到公平、及时且可追踪的处理，并推动减少问题复发。',
          suggested_positive_signals: ['能区分安抚客户与解决根因。', '有证据和时效意识。', '能把个案归纳成业务改进。'],
          points_to_verify: ['复杂责任判断方法。', '是否随意承诺赔付。', '如何处理平台规则与内部口径冲突。'],
        },
        interview_focus: ['请拆解一次复杂退换货或客诉处理。', '客户证据不足但情绪强烈时怎么做？', '如何把重复售后问题反馈成可执行改进？'],
        hr_variables: ['platform_channels', 'product_category', 'service_channels', 'service_volume', 'team_context', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'pre-sales-customer-service',
        source_codes: ['S7'],
        job_title: '售前客服',
        boss_category_hint: ['客服/运营', '客服', '售前客服'],
        core_responsibilities_draft: [
          '理解客户需求并准确介绍商品差异、适用场景、库存、活动和下单流程。',
          '通过专业答疑和合理推荐降低购买疑虑，推动符合需求的客户完成下单。',
          '记录未成交原因与高频疑问，反馈商品表达、活动规则和页面信息问题。',
        ],
        optional_responsibilities_draft: ['协助维护商品问答和推荐话术。', '参与新品知识培训与情景演练。'],
        job_requirements_draft: {
          must_have: ['能快速掌握商品知识并基于真实需求推荐。', '具备在线沟通、需求判断和基础转化意识。'],
          nice_to_have: ['有相关类目售前经验。', '有大促或多商品组合推荐经验。'],
        },
        profile_draft: {
          role_mission: '帮助客户理解商品并做出适合自己的购买选择，而不是机械推销。',
          suggested_positive_signals: ['先提问再推荐。', '能解释商品不适用场景。', '关注咨询到成交的真实原因。'],
          points_to_verify: ['是否夸大商品效果。', '是否只会背固定话术。', '未成交复盘能力。'],
        },
        interview_focus: ['面对需求含糊的客户会问哪些问题？', '客户只比较价格时如何继续沟通？', '如何处理商品并不适合客户的情况？'],
        hr_variables: ['platform_channels', 'product_category', 'service_channels', 'service_volume', 'team_context', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'customer-service-director',
        source_codes: ['H4'],
        job_title: '客服总监',
        boss_category_hint: ['客服/运营', '高端运营职位', '客服总监'],
        core_responsibilities_draft: [
          '根据业务规划制定客户服务策略、组织能力和阶段性服务目标。',
          '统筹多渠道客服、重大客诉与峰值保障，明确管理机制和升级责任。',
          '推动商品、供应链和运营团队治理系统性体验问题，并评估改善成效。',
        ],
        optional_responsibilities_draft: ['规划客服工具、供应商和成本效率。', '建立管理者培养与关键岗位梯队。'],
        job_requirements_draft: {
          must_have: ['有较完整的客户服务体系和多层团队管理经验。', '能把客户问题转化为跨部门经营改进。'],
          nice_to_have: ['经历过业务快速增长或服务体系重建。', '有自建与外包客服协同经验。'],
        },
        profile_draft: {
          role_mission: '从经营层面建立稳定、可改善的客户服务能力，降低系统性体验损失。',
          suggested_positive_signals: ['能讲清服务策略与经营目标关系。', '有可核验的跨部门治理案例。', '能区分组织问题和工具问题。'],
          points_to_verify: ['管理规模和复杂度。', '重大改善中的本人决策。', '是否脱离一线服务事实。'],
        },
        interview_focus: ['如何判断客服体系当前最需要改善的三件事？', '请讲一个跨部门治理客户问题的案例。', '如何配置自建、外包和工具投入？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'service_channels', 'service_volume', 'team_context', 'management_scope', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'domestic-ecommerce-operations',
    display_name: '国内电商运营',
    source_codes: ['E1', 'E4', 'E5', 'E6', 'E7'],
    variants: [
      variant({
        variant_key: 'domestic-ecommerce-operations-general',
        source_codes: ['E1'],
        job_title: '国内电商运营',
        boss_category_hint: ['客服/运营', '电商运营', '国内电商运营'],
        core_responsibilities_draft: [
          '负责约定国内电商渠道的商品上架、页面维护、活动执行和日常经营跟进。',
          '结合销售、流量、转化、客单、库存和售后数据定位经营问题并推进改善。',
          '协同商品、内容、客服和仓配团队落实经营计划，确保信息与履约口径一致。',
        ],
        optional_responsibilities_draft: ['参与新品节奏和商品组合规划。', '沉淀跨平台活动与经营复盘模板。'],
        job_requirements_draft: {
          must_have: ['理解电商店铺从商品到履约的基本经营链路。', '能独立完成日常运营执行和基础数据复盘。'],
          nice_to_have: ['有多平台协同运营经验。', '有相关商品类目经验。'],
        },
        profile_draft: {
          role_mission: '让店铺日常经营稳定运转，并通过数据与协作持续改善经营结果。',
          suggested_positive_signals: ['能拆解经营指标而非只报销售额。', '有完整活动或商品运营案例。', '主动关注库存和售后影响。'],
          points_to_verify: ['本人负责的平台和权限范围。', '经营结果中的实际贡献。', '遇到数据异常的排查路径。'],
        },
        interview_focus: ['请拆解一次完整店铺经营复盘。', '流量增长但成交下降时如何排查？', '如何协调活动需求与库存履约风险？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'taobao-operations',
        source_codes: ['E4'],
        job_title: '淘宝运营',
        boss_category_hint: ['客服/运营', '电商运营', '淘宝运营'],
        core_responsibilities_draft: [
          '负责淘宝店铺商品发布、标题与页面维护、店内内容和日常活动执行。',
          '跟踪搜索、推荐、访客、收藏加购和成交数据，持续优化商品与店铺运营动作。',
          '协调客服、设计、内容和仓配处理活动准备、商品问题与订单反馈。',
        ],
        optional_responsibilities_draft: ['参与淘宝内容场域和会员运营。', '维护竞品与市场变化记录。'],
        job_requirements_draft: {
          must_have: ['熟悉淘宝店铺日常运营后台和商品管理流程。', '能根据流量与转化数据提出具体优化动作。'],
          nice_to_have: ['有淘宝活动或内容场域运营经验。', '有相关类目从新品到稳定销售的案例。'],
        },
        profile_draft: {
          role_mission: '通过商品、内容和店铺运营提升淘宝渠道的有效流量与成交效率。',
          suggested_positive_signals: ['能说清搜索与推荐流量差异。', '有商品层级的优化案例。', '关注活动后的利润和售后反馈。'],
          points_to_verify: ['是否真实操作过淘宝后台。', '案例是否仅依赖大额投放。', '活动前后如何复盘。'],
        },
        interview_focus: ['一个商品搜索流量持续下降会检查什么？', '请复盘一次淘宝活动的准备和结果。', '怎样判断详情页还是流量人群出了问题？'],
        hr_variables: ['business_model', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'tmall-operations',
        source_codes: ['E5'],
        job_title: '天猫运营',
        boss_category_hint: ['客服/运营', '电商运营', '天猫运营'],
        core_responsibilities_draft: [
          '负责天猫店铺商品结构、页面、活动报名和大促节奏的日常运营。',
          '结合品牌目标分析流量、转化、会员、客单和商品表现，推动运营改善。',
          '统筹大促节点的商品、视觉、客服和库存准备，跟踪执行风险与结果。',
        ],
        optional_responsibilities_draft: ['参与会员和品牌人群运营。', '协助维护平台规则与店铺健康事项。'],
        job_requirements_draft: {
          must_have: ['熟悉天猫店铺经营和平台活动的基本流程。', '能组织多角色完成活动准备并进行经营复盘。'],
          nice_to_have: ['有品牌旗舰店或大促项目经验。', '有会员经营或新品运营经验。'],
        },
        profile_draft: {
          role_mission: '在品牌与经营目标之间组织天猫店铺运营，稳定完成日常和大促节奏。',
          suggested_positive_signals: ['有跨角色大促推进清单。', '能同时分析商品与人群。', '重视店铺健康和履约体验。'],
          points_to_verify: ['候选人在大促中的真实职责。', '是否只看成交不看成本。', '平台规则变化的应对方式。'],
        },
        interview_focus: ['如何制定一次天猫大促的倒排计划？', '会员成交下降时会从哪些维度检查？', '活动目标与库存风险冲突时怎么取舍？'],
        hr_variables: ['business_model', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'jd-operations',
        source_codes: ['E6'],
        job_title: '京东运营',
        boss_category_hint: ['客服/运营', '电商运营', '京东运营'],
        core_responsibilities_draft: [
          '负责京东相关店铺或业务模式下的商品、价格、页面和活动日常运营。',
          '分析流量、转化、商品、订单和履约数据，识别影响经营结果的关键环节。',
          '与采销、供应链、客服或平台接口协同推进活动和异常处理。',
        ],
        optional_responsibilities_draft: ['维护平台资源和活动节点清单。', '参与库存周转与补货建议。'],
        job_requirements_draft: {
          must_have: ['理解京东自营、POP 等实际业务模式中的一种及其运营流程。', '能结合商品与履约数据做日常经营判断。'],
          nice_to_have: ['有京东平台活动或采销协同经验。', '有库存周转和供应链协同经验。'],
        },
        profile_draft: {
          role_mission: '在明确的京东业务模式下推动商品、活动与履约协同，改善经营效率。',
          suggested_positive_signals: ['能准确说明负责的京东业务模式。', '同时关注前台和履约数据。', '有平台或采销协同案例。'],
          points_to_verify: ['业务模式是否与本岗匹配。', '候选人可控制的经营变量。', '库存异常的处理经验。'],
        },
        interview_focus: ['请说明你负责的京东业务模式和工作边界。', '某商品有流量但库存周转变差时如何处理？', '怎样推进平台活动中的多方协作？'],
        hr_variables: ['business_model', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'pinduoduo-operations',
        source_codes: ['E7'],
        job_title: '拼多多运营',
        boss_category_hint: ['客服/运营', '电商运营', '拼多多运营'],
        core_responsibilities_draft: [
          '负责拼多多店铺商品发布、价格活动、页面信息和日常经营维护。',
          '跟踪曝光、点击、成交、推广、退款和商品竞争变化，及时调整运营动作。',
          '协同商品、仓配和客服保障活动供货、发货时效与售后口径。',
        ],
        optional_responsibilities_draft: ['维护竞品价格与商品对比记录。', '参与新品测试和商品淘汰建议。'],
        job_requirements_draft: {
          must_have: ['熟悉拼多多商品与活动的日常运营流程。', '能结合价格、流量、转化和售后做经营分析。'],
          nice_to_have: ['有相关类目商品运营经验。', '有活动资源和库存协同经验。'],
        },
        profile_draft: {
          role_mission: '在价格、商品和履约约束下提升拼多多店铺的有效成交与经营稳定性。',
          suggested_positive_signals: ['不以低价作为唯一策略。', '能解释退款与履约对经营的影响。', '有商品测试和退出标准。'],
          points_to_verify: ['是否忽略利润与售后。', '活动结果中的本人作用。', '价格变化时的判断依据。'],
        },
        interview_focus: ['竞品突然降价时你会怎么判断是否跟进？', '请复盘一个拼多多商品从测试到放量的过程。', '退款率上升时如何区分商品与服务问题？'],
        hr_variables: ['business_model', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'cross-border-ecommerce-operations',
    display_name: '跨境电商运营',
    source_codes: ['E2', 'E8'],
    variants: [
      variant({
        variant_key: 'cross-border-ecommerce-operations-general',
        source_codes: ['E2'],
        job_title: '跨境电商运营',
        boss_category_hint: ['客服/运营', '电商运营', '跨境电商运营'],
        core_responsibilities_draft: [
          '负责约定海外市场和电商平台的商品刊登、本地化内容、活动及日常经营。',
          '分析流量、转化、广告、库存、物流和售后数据，形成市场与商品优化建议。',
          '协同商品、供应链和客服处理合规、库存、履约与客户反馈问题。',
        ],
        optional_responsibilities_draft: ['跟踪市场与竞品变化。', '参与新品市场测试和本地化素材规划。'],
        job_requirements_draft: {
          must_have: ['熟悉至少一种跨境电商平台的完整运营链路。', '能处理基础本地化、数据复盘和跨时区协作。'],
          nice_to_have: ['有目标国家或相关类目经验。', '有跨境物流、合规或广告协同经验。'],
        },
        profile_draft: {
          role_mission: '在目标市场、平台规则和履约约束下稳定推进跨境店铺经营。',
          suggested_positive_signals: ['能明确说明平台和市场边界。', '关注合规与库存而非只看销售。', '有本地化测试案例。'],
          points_to_verify: ['工作语言的实际使用程度。', '跨境结果是否由本人负责。', '规则或履约异常的处理经验。'],
        },
        interview_focus: ['请拆解一个海外市场商品运营案例。', '如何验证本地化内容是否有效？', '销量增长但跨境库存风险上升时怎么处理？'],
        hr_variables: ['business_model', 'platform_channels', 'market_language', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'amazon-operations',
        source_codes: ['E8'],
        job_title: '亚马逊运营',
        boss_category_hint: ['客服/运营', '电商运营', '亚马逊运营'],
        core_responsibilities_draft: [
          '负责亚马逊站点的 Listing、价格、促销和日常账号运营，并维护商品信息准确。',
          '分析搜索、转化、广告、评价、库存和利润相关数据，持续优化商品表现。',
          '跟进账号健康、库存补货、客户反馈和平台风险，协调相关团队及时处理。',
        ],
        optional_responsibilities_draft: ['参与新品调研和上架计划。', '维护关键词、竞品和运营实验记录。'],
        job_requirements_draft: {
          must_have: ['实际操作过亚马逊卖家后台并理解 Listing 与账号健康。', '能结合广告、转化和库存数据做运营判断。'],
          nice_to_have: ['有目标站点或相关类目经验。', '有新品冷启动、FBA 或申诉协同经验。'],
        },
        profile_draft: {
          role_mission: '在账号安全和库存约束下提升亚马逊商品的可见度、转化与经营质量。',
          suggested_positive_signals: ['能展示具体 Listing 优化过程。', '广告复盘不只看销售。', '主动监控账号和库存风险。'],
          points_to_verify: ['负责站点与类目。', '广告和利润口径是否真实。', '账号风险处理中的本人职责。'],
        },
        interview_focus: ['一个 Listing 转化下降会依次检查什么？', '请说明一次广告调整的依据与结果。', '如何平衡补货、断货和库存积压风险？'],
        hr_variables: ['business_model', 'market_language', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'user-community-operations',
    display_name: '用户与社群运营',
    source_codes: ['B3', 'B6'],
    variants: [
      variant({
        variant_key: 'user-operations',
        source_codes: ['B3'],
        job_title: '用户运营',
        boss_category_hint: ['客服/运营', '业务运营', '用户运营'],
        core_responsibilities_draft: [
          '根据用户生命周期和行为特征划分重点人群，设计触达、激活、留存或复购动作。',
          '协同内容、客服和店铺运营执行用户活动，并跟踪参与和后续行为。',
          '分析用户反馈与经营数据，识别流失、需求和体验问题并提出改进建议。',
        ],
        optional_responsibilities_draft: ['参与会员权益和用户标签优化。', '建设用户访谈与反馈样本库。'],
        job_requirements_draft: {
          must_have: ['能把用户目标拆成具体运营动作和验证指标。', '具备基础用户分层、活动执行和数据复盘能力。'],
          nice_to_have: ['有电商会员或复购运营经验。', '有用户调研或精细化触达经验。'],
        },
        profile_draft: {
          role_mission: '理解不同阶段用户的真实需求，并通过可验证的运营动作提升长期价值。',
          suggested_positive_signals: ['能解释用户分层依据。', '同时关注短期转化和长期留存。', '有从反馈到产品或服务改进的案例。'],
          points_to_verify: ['是否把群发当用户运营。', '数据口径和样本是否可靠。', '个人信息使用边界。'],
        },
        interview_focus: ['如何为首购后未复购用户设计验证方案？', '请举例说明用户分层如何改变运营动作。', '活动参与高但留存低时怎么复盘？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'target_users', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'community-operations',
        source_codes: ['B6'],
        job_title: '社群运营',
        boss_category_hint: ['客服/运营', '业务运营', '社群运营'],
        core_responsibilities_draft: [
          '负责社群入群、欢迎、内容、互动、活动和问题反馈的日常运营节奏。',
          '围绕用户需求设计群内服务与转化动作，维护群秩序并控制打扰频率。',
          '跟踪活跃、参与、咨询、转化和流失反馈，持续优化社群分层与内容。',
        ],
        optional_responsibilities_draft: ['培养核心用户或群内共创机制。', '沉淀群运营 SOP 与常见问题。'],
        job_requirements_draft: {
          must_have: ['有持续运营社群并处理用户问题的实际经验。', '能规划内容活动并进行基础数据复盘。'],
          nice_to_have: ['有电商复购或会员社群经验。', '有多群分层和群主协同经验。'],
        },
        profile_draft: {
          role_mission: '用有价值、不过度打扰的社群服务建立用户关系并承接业务需求。',
          suggested_positive_signals: ['能说明社群分层与节奏。', '重视群规则和用户体验。', '有低活跃或冲突场景的处理案例。'],
          points_to_verify: ['是否只会频繁发促销。', '真实负责的群规模。', '用户隐私和敏感信息处理。'],
        },
        interview_focus: ['新群建立后的前七天如何运营？', '群活跃下降时如何判断是否需要干预？', '怎样处理群内投诉同时避免扩大冲突？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'target_users', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'content_cadence', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'general-operations-leadership',
    display_name: '综合运营职级序列',
    source_codes: ['B1', 'H1', 'H2', 'H3'],
    variants: [
      variant({
        variant_key: 'operations-assistant-specialist',
        source_codes: ['B1'],
        job_title: '运营助理/专员',
        boss_category_hint: ['客服/运营', '业务运营', '运营助理/专员'],
        core_responsibilities_draft: [
          '按运营计划完成商品信息、活动资料、数据表和日常流程的准确维护。',
          '跟进跨部门任务节点，及时记录问题、同步进度并推动责任人闭环。',
          '整理基础经营数据和业务反馈，为运营复盘提供清楚、可核对的材料。',
        ],
        optional_responsibilities_draft: ['协助竞品与市场信息整理。', '维护日常运营清单和操作文档。'],
        job_requirements_draft: {
          must_have: ['做事细致，能按节点管理多项日常任务。', '具备基础表格、沟通和信息核对能力。'],
          nice_to_have: ['有电商运营实习或执行经验。', '熟悉一种店铺或内容平台后台。'],
        },
        profile_draft: {
          role_mission: '准确承接运营执行与信息流转，让日常任务有记录、有节点、有结果。',
          suggested_positive_signals: ['能展示任务管理方法。', '会主动核对信息而非机械录入。', '能从重复工作中提出小改进。'],
          points_to_verify: ['细致程度的真实案例。', '遇到模糊任务如何确认。', '多任务冲突时如何排序。'],
        },
        interview_focus: ['请讲一次你同时跟进多项任务的经历。', '收到信息不完整的活动需求会怎么处理？', '如何检查一份运营数据表是否可靠？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'operations-manager-supervisor',
        source_codes: ['H1'],
        job_title: '运营经理/主管',
        boss_category_hint: ['客服/运营', '高端运营职位', '运营经理/主管'],
        core_responsibilities_draft: [
          '把阶段经营目标拆成团队计划、责任人和关键节点，组织日常执行。',
          '跟踪核心业务数据和项目进度，及时识别问题、调整资源并推进闭环。',
          '辅导团队成员，协调商品、内容、客服和供应链完成共同目标。',
        ],
        optional_responsibilities_draft: ['完善团队 SOP 和复盘机制。', '参与招聘、培养和绩效反馈。'],
        job_requirements_draft: {
          must_have: ['有独立业务模块和小团队管理或项目牵头经验。', '能将目标拆解为可执行计划并用数据复盘。'],
          nice_to_have: ['有电商多角色协作经验。', '有从混乱流程建立稳定机制的经历。'],
        },
        profile_draft: {
          role_mission: '将经营目标转化为团队可执行的计划，并持续解决影响交付的问题。',
          suggested_positive_signals: ['能清楚说明目标拆解。', '管理案例包含具体辅导动作。', '遇到变化能及时调整而非只追责。'],
          points_to_verify: ['真实管理人数与权限。', '结果中的个人和团队贡献。', '跨部门冲突的处理方式。'],
        },
        interview_focus: ['请拆解一个季度目标如何变成团队周计划。', '团队连续未达成目标时如何诊断？', '请举例说明一次跨部门资源冲突。'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'team_context', 'management_scope', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'operations-director',
        source_codes: ['H2'],
        job_title: '运营总监',
        boss_category_hint: ['客服/运营', '高端运营职位', '运营总监'],
        core_responsibilities_draft: [
          '根据公司经营方向制定渠道、商品或用户运营策略与年度阶段计划。',
          '统筹运营团队、预算和跨部门资源，建立经营复盘与关键问题决策机制。',
          '持续评估增长、效率、库存、服务和组织能力，推动系统性改善。',
        ],
        optional_responsibilities_draft: ['规划新渠道或新业务试验。', '建设运营管理者与关键岗位梯队。'],
        job_requirements_draft: {
          must_have: ['有较完整的电商运营策略和多团队管理经验。', '能同时处理增长、利润、库存和组织约束。'],
          nice_to_have: ['经历过业务转型或规模变化。', '有多渠道经营或品牌与渠道协同经验。'],
        },
        profile_draft: {
          role_mission: '建立可落地的运营策略和组织机制，推动业务在约束条件下持续改善。',
          suggested_positive_signals: ['能用经营事实解释战略选择。', '有停止低效项目的决策案例。', '能建立而不只是亲自救火。'],
          points_to_verify: ['负责业务的实际规模与复杂度。', '成果是否依赖公司自然增长。', '关键失败和复盘深度。'],
        },
        interview_focus: ['请讲一个你主动调整运营战略的案例。', '如何决定预算和人力投向哪个渠道？', '增长、利润和库存冲突时如何做决策？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'team_context', 'management_scope', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'chief-operating-officer',
        source_codes: ['H3'],
        job_title: 'COO',
        boss_category_hint: ['客服/运营', '高端运营职位', 'COO'],
        core_responsibilities_draft: [
          '承接公司经营目标，统筹商品、渠道、供应链、客服与组织的运营计划和执行节奏。',
          '建立关键经营数据和决策机制，识别影响收入、利润、现金与交付的核心问题。',
          '推动管理团队形成明确责任与协作机制，并对重大经营项目持续复盘。',
        ],
        optional_responsibilities_draft: ['参与新业务和重要合作评估。', '推动关键管理岗位建设与组织调整。'],
        job_requirements_draft: {
          must_have: ['有跨多个经营职能的实际负责人经验。', '能在不完整信息下做有依据的经营取舍并跟踪结果。'],
          nice_to_have: ['有电商品牌或零售业务整体经营经验。', '经历过增长、收缩或业务重整阶段。'],
        },
        profile_draft: {
          role_mission: '把公司经营目标转化为跨职能执行系统，并及时处理影响现金、利润和交付的关键矛盾。',
          suggested_positive_signals: ['能穿透部门指标看整体经营。', '重大决策有事实、取舍和后续复盘。', '能够建立管理节奏而非依赖个人盯办。'],
          points_to_verify: ['实际经营授权范围。', '结果与外部环境的关系。', '失败决策与纠偏能力。'],
        },
        interview_focus: ['请拆解一个跨职能经营问题的决策过程。', '当收入增长但现金和库存恶化时如何处理？', '如何判断一个管理机制真正有效？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'team_context', 'management_scope', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'live-operations-support',
    display_name: '直播运营与支持',
    source_codes: ['C3', 'LS1', 'LS2'],
    variants: [
      variant({
        variant_key: 'live-operations',
        source_codes: ['C3', 'LS1'],
        job_title: '直播运营',
        boss_category_hint: ['直播', '直播支持', '直播运营'],
        core_responsibilities_draft: [
          '根据商品和场次目标制定直播排期、货盘顺序、内容节奏与人员分工。',
          '协调主播、中控、投流、客服和供应链完成开播准备并处理场中异常。',
          '复盘观看、互动、商品点击、成交、退款和库存反馈，持续优化场次策略。',
        ],
        optional_responsibilities_draft: ['组织直播脚本和彩排。', '沉淀场次复盘与商品表现档案。'],
        job_requirements_draft: {
          must_have: ['理解直播从选品排品到场后复盘的完整流程。', '能在直播现场协调多角色并快速处理问题。'],
          nice_to_have: ['有相关平台或类目直播经验。', '有直播间冷启动或稳定放量经验。'],
        },
        profile_draft: {
          role_mission: '把商品、内容、人员和现场执行组织成稳定可复盘的直播场次。',
          suggested_positive_signals: ['能拆解单场直播数据。', '关注退款与履约而非只看成交。', '有现场异常预案。'],
          points_to_verify: ['候选人真实负责的环节。', '成绩是否主要依赖主播或投流。', '场次失败后的调整方法。'],
        },
        interview_focus: ['请拆解一场直播从准备到复盘的全过程。', '场中在线人数突然下降会如何判断？', '高成交商品库存不足时如何调整排品？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'live_schedule', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'live-control-floor-assistant',
        source_codes: ['LS2'],
        job_title: '中控/场控/助播',
        boss_category_hint: ['直播', '直播支持', '中控/场控/助播'],
        core_responsibilities_draft: [
          '按场次脚本准确完成商品上下架、链接、优惠信息、节奏提示和后台操作。',
          '观察直播画面、声音、互动和库存等现场状态，及时提醒主播并处理可控异常。',
          '记录关键节点、商品表现和现场问题，配合运营完成场后复盘与物料归档。',
        ],
        optional_responsibilities_draft: ['协助设备检查和彩排。', '维护直播物料、口令和后台操作清单。'],
        job_requirements_draft: {
          must_have: ['注意力稳定，能在快节奏现场准确执行多项操作。', '能理解直播脚本、商品信息和基础后台操作。'],
          nice_to_have: ['有中控、场控或助播实操经验。', '能处理基础设备或网络异常。'],
        },
        profile_draft: {
          role_mission: '保证直播现场信息、后台和节奏准确衔接，让异常被及时发现和处理。',
          suggested_positive_signals: ['有明确的开播检查清单。', '能讲清多任务优先级。', '商品与优惠信息核对细致。'],
          points_to_verify: ['实际操作过哪些后台。', '高压场景的失误处理。', '具体班次由 HR 确认。'],
        },
        interview_focus: ['开播前你会检查哪些项目？', '主播口播与后台优惠不一致时怎么处理？', '请复盘一次直播现场异常。'],
        hr_variables: ['platform_channels', 'product_category', 'business_scale', 'live_schedule', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'commerce-live-host',
    display_name: '带货主播',
    source_codes: ['A1'],
    variants: [
      variant({
        variant_key: 'commerce-live-host',
        source_codes: ['A1'],
        job_title: '带货主播',
        boss_category_hint: ['直播', '主播', '带货主播'],
        core_responsibilities_draft: [
          '根据真实商品信息完成直播讲解、演示、互动答疑和购买引导。',
          '参与商品学习、脚本讨论和彩排，准确掌握卖点、限制与活动口径。',
          '结合场次复盘持续优化表达、节奏和用户互动，不夸大商品效果。',
        ],
        optional_responsibilities_draft: ['参与短视频或直播预热内容。', '反馈用户问题和商品表达难点。'],
        job_requirements_draft: {
          must_have: ['镜头表达自然，能快速理解商品并进行真实、清楚的讲解。', '具备现场互动、节奏调整和团队配合能力。'],
          nice_to_have: ['有相关类目带货或讲解经验。', '能参与脚本共创和场后复盘。'],
        },
        profile_draft: {
          role_mission: '用可信、清楚且有感染力的表达帮助用户理解商品并做购买判断。',
          suggested_positive_signals: ['能根据用户问题即时调整讲解。', '主动说明商品适用与不适用场景。', '有基于回放改进表达的案例。'],
          points_to_verify: ['历史数据与本人场次的对应关系。', '是否依赖夸张承诺。', '实际时段和出镜要求由 HR 确认。'],
        },
        interview_focus: ['请现场讲解一个陌生商品并说明提问思路。', '场中用户反复质疑价格时如何回应？', '如何处理商品效果不能承诺的情况？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'business_scale', 'live_schedule', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'ecommerce-visual-design',
    display_name: '电商视觉设计',
    source_codes: ['V2', 'V5', 'V9'],
    variants: [
      variant({
        variant_key: 'ecommerce-art-designer',
        source_codes: ['V2'],
        job_title: '美工',
        boss_category_hint: ['设计', '视觉/交互设计', '美工'],
        core_responsibilities_draft: [
          '根据商品事实和平台规范制作主图、详情页、活动页及日常店铺视觉素材。',
          '按运营节奏完成尺寸适配、信息修改、素材导出和归档，保障交付准确及时。',
          '结合点击、停留、转化和用户反馈持续优化商品信息层级与视觉表达。',
        ],
        optional_responsibilities_draft: ['参与商品拍摄选片和基础修图。', '维护常用版式与电商素材库。'],
        job_requirements_draft: {
          must_have: ['能独立完成常见电商图片和详情页设计交付。', '熟悉图像处理与排版工具，重视商品信息准确。'],
          nice_to_have: ['有相关类目电商页面经验。', '具备基础摄影、修图或动效能力。'],
        },
        profile_draft: {
          role_mission: '把真实商品信息转化为清楚、有购买引导力且符合平台要求的视觉素材。',
          suggested_positive_signals: ['作品能说明商业目标和信息层级。', '有多尺寸高频交付方法。', '会根据数据和反馈迭代。'],
          points_to_verify: ['作品中的本人贡献。', '素材与商品事实如何核对。', '高频修改下的版本管理。'],
        },
        interview_focus: ['请拆解一套详情页的需求与设计过程。', '运营要求突出多个卖点时如何排序？', '怎样判断主图需要改版？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'design_deliverables', 'brand_guidelines', 'content_cadence', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'visual-designer',
        source_codes: ['V5'],
        job_title: '视觉设计师',
        boss_category_hint: ['设计', '视觉/交互设计', '视觉设计师'],
        core_responsibilities_draft: [
          '围绕品牌和经营主题提出视觉方向，完成活动主视觉、内容视觉及渠道延展。',
          '建立并维护颜色、字体、版式和图形等视觉规范，保障跨渠道表达一致。',
          '与运营、内容和商品团队澄清目标，管理从概念到多尺寸落地的设计质量。',
        ],
        optional_responsibilities_draft: ['参与品牌视觉升级或新品视觉定义。', '指导外部设计资源或初级设计协作。'],
        job_requirements_draft: {
          must_have: ['具备从概念到完整视觉落地的作品与设计说明能力。', '能在品牌一致性和渠道效率之间做有依据的取舍。'],
          nice_to_have: ['有电商品牌活动或整合营销视觉经验。', '有基础动效、三维或拍摄指导能力。'],
        },
        profile_draft: {
          role_mission: '建立清晰一致的品牌视觉，并把商业需求转化为可落地的视觉方案。',
          suggested_positive_signals: ['能解释设计决策而非只展示成图。', '作品跨渠道延展完整。', '能根据约束主动收敛方案。'],
          points_to_verify: ['作品真实性和本人职责。', '如何处理主观修改意见。', '是否理解电商交付节奏。'],
        },
        interview_focus: ['请选择一个项目说明视觉策略如何形成。', '品牌规范与平台高转化表达冲突时怎么办？', '如何保障多人协作下的视觉一致性？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'design_deliverables', 'brand_guidelines', 'content_channels', 'content_cadence', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
      variant({
        variant_key: 'packaging-designer',
        source_codes: ['V9'],
        job_title: '包装设计',
        boss_category_hint: ['设计', '视觉/交互设计', '包装设计'],
        core_responsibilities_draft: [
          '根据产品、品牌、渠道和生产约束完成包装结构表面、信息层级和系列化视觉设计。',
          '与商品、采购和供应商核对尺寸、材质、刀版、印刷工艺和法定信息，跟进打样。',
          '管理包装文件版本、样品反馈和量产前确认，减少信息错误与生产返工。',
        ],
        optional_responsibilities_draft: ['参与包装成本和开箱体验优化。', '维护包装规范、刀版和供应商样品库。'],
        job_requirements_draft: {
          must_have: ['有可说明生产落地过程的包装作品。', '理解印刷、材质、刀版与文件交付的基础要求。'],
          nice_to_have: ['有相关商品类目或系列化包装经验。', '有供应商打样和量产跟进经验。'],
        },
        profile_draft: {
          role_mission: '在品牌、法规、成本与生产约束下交付准确可量产的商品包装。',
          suggested_positive_signals: ['作品包含打样和量产过程。', '主动核对包装信息与商品事实。', '能解释结构、材质和视觉的取舍。'],
          points_to_verify: ['作品是否真正量产。', '本人对结构与供应商的参与程度。', '版本错误的预防方式。'],
        },
        interview_focus: ['请拆解一款包装从需求到量产的过程。', '视觉方案与成本或工艺冲突时如何调整？', '怎样降低包装文字或版本出错风险？'],
        hr_variables: ['business_model', 'platform_channels', 'product_category', 'design_deliverables', 'brand_guidelines', 'team_context', 'reporting_line', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'incentive_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'human-resources',
    display_name: '人力资源',
    source_codes: ['F1'],
    variants: [
      variant({
        variant_key: 'human-resources',
        source_codes: ['F1'],
        job_title: '人力资源',
        boss_category_hint: ['人力/行政/法务', '人力资源'],
        core_responsibilities_draft: [
          '根据实际分工承接招聘、入转调离、员工信息或员工关系等日常人力工作。',
          '与业务负责人澄清用人需求和人员问题，按流程记录、跟进并反馈结果。',
          '维护人力台账、制度材料和关键节点，确保信息准确且敏感资料妥善处理。',
        ],
        optional_responsibilities_draft: ['协助培训、文化或绩效沟通。', '整理基础人力数据和流程改进建议。'],
        job_requirements_draft: {
          must_have: ['具备与实际职责范围匹配的人力实务经验。', '沟通稳妥、记录细致并能保护员工敏感信息。'],
          nice_to_have: ['有电商或快节奏团队招聘经验。', '有独立推动一项人力流程改善的案例。'],
        },
        profile_draft: {
          role_mission: '让明确范围内的人力事务可靠运转，并为业务和员工提供清楚的流程支持。',
          suggested_positive_signals: ['能清楚说明专业边界。', '人力案例兼顾业务事实和员工体验。', '有敏感信息与合规意识。'],
          points_to_verify: ['实际覆盖的人力模块。', '招聘量和岗位类型。', '遇到超出权限事项的处理方式。'],
        },
        interview_focus: ['请说明你独立负责过哪些人力模块。', '遇到业务急招但需求不清时如何推进？', '如何处理需要保密的员工问题？'],
        hr_variables: ['business_model', 'business_scale', 'team_context', 'reporting_line', 'recruitment_scope', 'hr_scope', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'administration',
    display_name: '行政',
    source_codes: ['F2'],
    variants: [
      variant({
        variant_key: 'administration',
        source_codes: ['F2'],
        job_title: '行政',
        boss_category_hint: ['人力/行政/法务', '行政'],
        core_responsibilities_draft: [
          '根据实际范围负责办公用品、资产、环境、接待、会议或日常行政事项。',
          '跟进采购、维修、供应商和费用材料，确保需求、审批、交付和记录完整。',
          '维护行政台账、通知和应急联系信息，及时发现影响办公的问题并协调处理。',
        ],
        optional_responsibilities_draft: ['协助团队活动和员工关怀事项。', '优化常用行政流程和供应商清单。'],
        job_requirements_draft: {
          must_have: ['做事细致可靠，能管理多项日常事务和时间节点。', '具备供应商沟通、记录和基础费用意识。'],
          nice_to_have: ['有办公资产或采购管理经验。', '有中小团队综合行政经验。'],
        },
        profile_draft: {
          role_mission: '让办公支持事项有序、及时、可追踪，并减少日常运营中的行政中断。',
          suggested_positive_signals: ['能展示清单和台账习惯。', '面对突发事项能快速判断优先级。', '关注成本但不牺牲基本服务。'],
          points_to_verify: ['实际负责的行政范围。', '供应商和费用处理权限。', '应急事项的处理经验。'],
        },
        interview_focus: ['请讲一次你同时处理多项突发行政需求的经历。', '如何评估和管理一个办公供应商？', '怎样避免资产或采购记录失真？'],
        hr_variables: ['business_model', 'business_scale', 'team_context', 'reporting_line', 'admin_scope', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
  {
    family_key: 'accounting',
    display_name: '会计',
    source_codes: ['M1'],
    variants: [
      variant({
        variant_key: 'accounting',
        source_codes: ['M1'],
        job_title: '会计',
        boss_category_hint: ['财务/审计/税务', '会计'],
        core_responsibilities_draft: [
          '按实际核算范围完成凭证、账务、往来、费用和月结等基础会计工作。',
          '核对平台、支付、银行、订单、退款和发票等资料，跟进差异并保留依据。',
          '配合税务申报、管理报表、审计或资料归档，确保数据准确和节点可追踪。',
        ],
        optional_responsibilities_draft: ['参与库存、成本或渠道利润核算。', '提出对账和财务资料流程的改进建议。'],
        job_requirements_draft: {
          must_have: ['具备与实际账套和业务范围匹配的会计实务能力。', '重视凭证依据、对账差异和时间节点。'],
          nice_to_have: ['有电商平台账单、退款或库存核算经验。', '熟悉公司实际使用的财务或进销存工具。'],
        },
        profile_draft: {
          role_mission: '准确记录和核对经营事实，让账务、税务与业务数据有清楚依据。',
          suggested_positive_signals: ['能拆解平台订单到财务入账。', '发现差异会追根因并留证。', '熟悉月结节点和资料管理。'],
          points_to_verify: ['负责主体和账套数量。', '电商财务经验的具体深度。', '异常账务与敏感数据处理。'],
        },
        interview_focus: ['请说明电商平台账单与银行到账如何核对。', '发现订单、退款和账务不一致时怎么处理？', '月结期间如何管理资料和优先级？'],
        hr_variables: ['business_model', 'platform_channels', 'business_scale', 'team_context', 'reporting_line', 'accounting_scope', 'entity_and_tax', 'key_kpis', 'tool_stack', 'work_location', 'work_schedule', 'experience_expectation', 'salary_structure', 'must_have_preferences', 'nice_to_have_preferences'],
      }),
    ],
  },
];

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const ECOMMERCE_JOB_TEMPLATE_CATALOG = deepFreeze({
  schema_version: CATALOG_SCHEMA_VERSION,
  catalog_version: CATALOG_VERSION,
  source: 'BOSS_SCREENSHOT_OWNER_SELECTION_20260716',
  usage_notice: '本目录只生成供 HR 编辑确认的本地草稿，不发布到 Boss，不生成评分、档位、硬门槛或候选人处置。',
  hr_variable_definitions: HR_VARIABLE_DEFINITIONS,
  families,
});

module.exports = {
  CATALOG_SCHEMA_VERSION,
  CATALOG_VERSION,
  ECOMMERCE_JOB_TEMPLATE_CATALOG,
};
