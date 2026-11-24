export const DEFAULT_UI_LANG = 'zh-CN';
export const SUPPORTED_UI_LANGS = ['zh-CN', 'en'];

const ZH_CN = {
  // Common
  'common.save': '保存',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.close': '关闭',
  'common.refresh': '刷新',
  'common.loading': '加载中...',
  'common.empty': '暂无数据',
  'common.enabled': '已启用',
  'common.disabled': '已关闭',
  'common.running': '运行中',
  'common.stopped': '已停止',
  'common.back': '返回',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.expand': '展开',
  'common.collapse': '收起',
  'common.all': '全部',
  'common.reset': '恢复默认',
  'common.settings': '设置',
  'common.popout': '悬浮窗',
  'common.restart': '重启',
  'common.restarting': '重启中...',
  'common.justNow': '刚刚',
  'common.minutesAgo': '{n} 分钟前',
  'common.hoursAgo': '{n} 小时前',
  'common.daysAgo': '{n} 天前',

  // Navigation rail & topbar
  'nav.ariaModules': 'Antigravity Hub 模块导航',
  'nav.ariaSwitch': '模块切换',
  'nav.monitor': '监控',
  'nav.monitorTitle': '上下文监控',
  'nav.governance': '治理',
  'nav.governanceTitle': '生态治理',
  'nav.governanceAlertTitle': '检测到待处理告警',
  'nav.appearance': '壁纸',
  'nav.appearanceTitle': '外观壁纸',
  'nav.i18n': '汉化',
  'nav.i18nTitle': '界面汉化',
  'nav.i18nAlertTitle': '客户端已更新，汉化待重打',
  'nav.settings': '设置',
  'nav.settingsTitle': '插件设置',
  'nav.popout': '悬浮窗',
  'nav.popoutTitle': '打开或唤醒独立悬浮窗',

  // Frameless native titlebar
  'titlebar.dragTitle': '拖动窗口，双击放大或还原',
  'titlebar.tpsTitle': '有效输出速度',
  'titlebar.modelTitle': '当前模型',
  'titlebar.pinned': '已固定',
  'titlebar.pin': '置顶',
  'titlebar.pinnedTitle': '已置顶，点击取消',
  'titlebar.unpinnedTitle': '未置顶，点击置顶',
  'titlebar.collapseTitle': '收缩或展开迷你条',
  'titlebar.minimizeTitle': '最小化',
  'titlebar.maximizeTitle': '放大或还原',
  'titlebar.closeTitle': '关闭悬浮窗',
  'titlebar.miniSummary': '{pct}% / {cache}% 缓存',
  'titlebar.miniSummaryTitle': '上下文 {pct}% / 缓存命中 {cache}%（{mode}）',
  'titlebar.modelBadgeTitle': '模型：{model}（{mode}）',
  'titlebar.tpsBadgeTitle': '输出速度：{tps} tok/s（{mode}）',
  'titlebar.tpsWaitingTitle': '等待输出数据（{mode}）',
  'titlebar.modeAggregate': '运行汇总',
  'titlebar.modeAuto': '自动跟随',
  'titlebar.modePinned': '已锁定',

  // Global launcher card
  'launcher.titleRunning': '独立悬浮窗已启动',
  'launcher.titleStopped': '独立悬浮窗已关闭',
  'launcher.subRunning': '127.0.0.1:{port} / 自动跟随活跃对话',
  'launcher.subStopped': '本地端口已释放，可随时重新打开',
  'launcher.statusRunning': '运行中',
  'launcher.statusStopped': '已关闭',
  'launcher.desc': '悬浮窗支持拖动、缩放并记忆位置，自动跟随当前活跃对话；关闭后自动释放本地端口。',
  'launcher.currentSession': '当前跟踪对话',
  'launcher.autoFollowLatest': '自动跟随活跃对话',
  'launcher.btnFocus': '聚焦悬浮窗',
  'launcher.btnEmbedded': '页内查看',
  'launcher.btnClose': '关闭悬浮窗',

  // Global i18n update banner
  'banner.i18nOutdated': 'Antigravity 已更新，汉化补丁待重打',
  'banner.i18nGo': '前往重打',
  'banner.i18nLater': '稍后',

  // Monitor tabs & header
  'monitor.tab.context': '上下文',
  'monitor.tab.calls': '明细',
  'monitor.tab.quota': '额度',
  'monitor.tab.vault': '记忆库',
  'monitor.header.followAutoTitle': '自动跟随活跃对话，点击锁定当前对话',
  'monitor.header.followPinnedTitle': '已锁定当前对话，点击恢复自动跟随',
  'monitor.header.pollTitle': '切换轮询周期',
  'monitor.header.popoutTitle': '打开独立悬浮窗',
  'monitor.header.refreshTitle': '立即刷新',
  'monitor.header.settingsTitle': '插件设置',
  'monitor.header.restartBtn': '重启',
  'monitor.header.restartTitle': '重启 Antigravity 客户端',
  'monitor.header.alertsCount': '{count} 项预警',
  'monitor.header.alertsTitle': '异常预警',
  'monitor.header.alertsCollapse': '收起',
  'monitor.header.alertsEmpty': '当前无异常预警',
  'monitor.header.noGit': '非 Git 目录',
  'monitor.header.gitDirtyTitle': '存在未提交改动',
  'monitor.kv.label': 'KV 保鲜',
  'monitor.kv.active': '保活中',
  'monitor.kv.expired': '可能失效',
  'monitor.kv.waiting': '待计时',
  'monitor.kv.helpTitle': '关于 Gemini KV Cache 倒计时',
  'monitor.kv.helpBody1': 'Antigravity 当前使用 Gemini 云端隐式前缀缓存（Implicit Caching），由上游算力池按空闲时长与负载动态回收（LRU），并没有固定不变的硬超时秒表。',
  'monitor.kv.helpBody2': '如果长时间停顿不继续对话，缓存可能被提前驱逐，下次发消息会触发重新全量预填充。此倒计时基于实测经验提供三态参考预警：蓝（稳保）→ 黄（开始偶发驱逐）→ 红（高失效风险），方便按需续对话。',
  'monitor.kv.titleSafe': 'Gemini KV 缓存稳保中（预计剩余 {rem}，参考窗口 {ttl} 分钟）',
  'monitor.kv.titleWarn': 'Gemini KV 缓存开始出现驱逐风险（预计剩余 {rem}，建议适时续对话）',
  'monitor.kv.titleDanger': 'Gemini KV 缓存临近或可能已失效（空闲 {idle}，参考窗口 {ttl} 分钟）',
  'monitor.kv.titleActive': '对话运行中，KV 缓存持续保活',

  // Monitor session selector
  'monitor.session.autoChip': '自动',
  'monitor.session.pinnedChip': '锁定',
  'monitor.session.aggregateChip': '汇总',
  'monitor.session.autoOption': '跟随活跃对话',
  'monitor.session.aggregateOption': '全部运行中对话 (主+子)',
  'monitor.session.aggregateTitle': '运行汇总 (主+子)',
  'monitor.session.aggregateTitleActive': '运行汇总 ({count} 活跃)',
  'monitor.session.listCaption': '对话与子代理列表',
  'monitor.session.waiting': '等待会话记录',
  'monitor.session.emptyWorkspace': '当前工作区暂无会话记录',
  'monitor.session.recentActive': '运行中',
  'monitor.session.subTag': '子',
  'monitor.session.stepsShort': '{count} 步',

  // Poll options
  'monitor.poll.s3': '3 秒（高频）',
  'monitor.poll.s5': '5 秒（推荐）',
  'monitor.poll.s10': '10 秒',
  'monitor.poll.s30': '30 秒',
  'monitor.poll.s60': '60 秒（省电）',
  'monitor.poll.manual': '手动刷新',
  'monitor.poll.manualShort': '手动',

  // Monitor context panel
  'monitor.ctx.title': '上下文占用',
  'monitor.ctx.generateCapsule': '生成交接胶囊',
  'monitor.ctx.capsuleHelpAria': '什么是交接胶囊？',
  'monitor.ctx.capsuleHelpTitle': '交接胶囊',
  'monitor.ctx.capsuleHelpBody': '将当前分支核心决策与状态压缩为紧凑交接包，新开对话可一键注入上下文。',
  'monitor.ctx.kpiCache': '缓存命中',
  'monitor.ctx.kpiTps': '输出速度',
  'monitor.ctx.kpiFree': '剩余空间',
  'monitor.ctx.kpiCost': '估算费用',
  'monitor.ctx.modelSimLabel': '切模型模拟',
  'monitor.ctx.modelSimAria': '模拟目标模型窗口',
  'monitor.ctx.modelSimNone': '当前模型',
  'monitor.ctx.modelSim200k': '200K（Claude 4.5/4.6）',
  'monitor.ctx.modelSim256k': '256K（GPT-5.x）',
  'monitor.ctx.modelSim1m': '1.00M（Gemini 3/4）',
  'monitor.ctx.modelSimHint': '选择目标窗口预览占比',
  'monitor.ctx.modelSimOverflow': '超出上限 {pct}%（超额 {over}，需压缩）',
  'monitor.ctx.modelSimResult': '模拟占比 {pct}% / 剩余 {free}',
  'monitor.ctx.attributionLabel': '构成与缓存：',
  'monitor.ctx.attributionLoading': '正在加载会话数据...',
  'monitor.ctx.viewCalls': '查看调用明细 →',
  'monitor.ctx.breakdownTitle': '已激活上下文构成',
  'monitor.ctx.deferredTitle': '延迟加载',
  'monitor.ctx.deferredNotLoaded': '未加载',
  'monitor.ctx.freeSpace': '剩余空间',
  'monitor.ctx.mountedAssetsTitle': '已挂载资产',
  'monitor.ctx.emptyItems': '暂无条目',
  'monitor.ctx.hoverHint': '{key} {tokens} ({pct}%)',

  // Context breakdown categories
  'monitor.breakdown.msg': '对话消息',
  'monitor.breakdown.msgNote': '对话历史与工具输出',
  'monitor.breakdown.sys': '系统底座',
  'monitor.breakdown.sysNote': '系统提示与内置工具',
  'monitor.breakdown.mcp': 'MCP 工具',
  'monitor.breakdown.mcpNote': '{count} 个常驻工具',
  'monitor.breakdown.skl': 'Skills 技能',
  'monitor.breakdown.sklNote': '{total} 个摘要 + {loaded} 个已激活',
  'monitor.breakdown.mem': '记忆与规则',
  'monitor.breakdown.memNote': '{count} 份规则与简报',
  'monitor.breakdown.agt': '自定义子代理',
  'monitor.breakdown.agtNote': '{count} 个子代理',

  // Mounted assets & deferred items
  'monitor.assets.mcpTitle': 'MCP 服务与工具',
  'monitor.assets.mcpCount': '{deferred} 按需 / {eager} 常驻',
  'monitor.assets.mcpDeferredMeta': '{count} 个工具（按需加载）',
  'monitor.assets.mcpPluginMeta': '5 个模型工具 + 7 个界面专用',
  'monitor.assets.mcpConfiguredMeta': '已配置 MCP 服务',
  'monitor.assets.rulesTitle': '记忆与规则文件',
  'monitor.assets.rulesCount': '{count} 份文件',
  'monitor.assets.rulePluginSlim': '插件精简规则',
  'monitor.assets.ruleGlobalPlugin': '全局插件规则',
  'monitor.assets.ruleGlobal': '全局规则',
  'monitor.assets.ruleWorkspace': '工作区规则',
  'monitor.assets.ruleVaultBrief': '会话启动精简简报',
  'monitor.assets.ruleVaultMeta': '记忆库（{count} 条）',
  'monitor.assets.skillsTitle': '已激活技能与子代理',
  'monitor.assets.skillsCount': '{skills} 技能 / {agents} 子代理',
  'monitor.assets.skillLoaded': '已加载技能',
  'monitor.assets.customSubagent': '自定义子代理',
  'monitor.assets.deferredMcpKey': 'MCP 工具（按需加载）',
  'monitor.assets.deferredToolsCount': '{count} 个工具',

  // Monitor calls panel
  'monitor.calls.modeStep': '按步查看',
  'monitor.calls.modeSummary': '总汇总',
  'monitor.calls.agentAll': '全部 Agent (主+子)',
  'monitor.calls.agentMain': '仅主 Agent',
  'monitor.calls.agentSub': '仅子 Agent',
  'monitor.calls.modelAll': '全部模型',
  'monitor.calls.onlyDrop': '仅看缓存击穿',
  'monitor.calls.heroSteps': '调用步数',
  'monitor.calls.heroStepsVal': '{count} 步',
  'monitor.calls.heroStepsFiltered': '{count} / {total} 步',
  'monitor.calls.heroAvgTps': '平均速度',
  'monitor.calls.heroCost': '累计费用',
  'monitor.calls.heroModel': '模型：{model}',
  'monitor.calls.waitingSync': '等待同步',
  'monitor.calls.lastSync': '同步 {time}',
  'monitor.calls.colStep': '步序',
  'monitor.calls.colModel': '模型',
  'monitor.calls.colTpsFull': '有效',
  'monitor.calls.colTps': '速度',
  'monitor.calls.colDurFull': '模型',
  'monitor.calls.colDur': '耗时 ⓘ',
  'monitor.calls.colDurTitle': '单步模型耗时（支持 TTFT 时自动切换）',
  'monitor.calls.colTokens': '上下文 / 思考 / 正文',
  'monitor.calls.colCacheFull': '缓存',
  'monitor.calls.colCache': '命中',
  'monitor.calls.colCostFull': '估算',
  'monitor.calls.colCost': '费用',
  'monitor.calls.empty': '当前筛选条件下无调用记录',
  'monitor.calls.footerHint': '点击行展开单步解剖与归因',
  'monitor.calls.footerStats': '共 {count} 步 / 均速 {tps} tok/s / 估算 ${cost}',
  'monitor.calls.cacheDropPill': '击穿',
  'monitor.calls.anatomyTitle': '单步解剖 {tag} #{step}',
  'monitor.calls.anatomyModel': '模型：',
  'monitor.calls.anatomyTiming': '计时：{source}',
  'monitor.calls.anatomyThinkRatio': '思考占比 {ratio}%',
  'monitor.calls.anatomySource': '来源：',
  'monitor.calls.anatomyBreakdown': '缓存命中 {cache} / 新编码 {input} / 输出 {output}',
  'monitor.calls.anatomyDropReason': '缓存击穿归因：',
  'monitor.calls.summaryByAgent': '按主 / 子 Agent 汇总',
  'monitor.calls.summaryByModel': '按模型汇总',
  'monitor.calls.summaryEmpty': '暂无汇总数据',
  'monitor.calls.stepsUnit': '{count} 步',

  // Monitor vault panel
  'monitor.vault.title': '跨会话工作记忆库',
  'monitor.vault.capsuleBtn': '交接胶囊',
  'monitor.vault.addBtn': '+ 新增记忆',
  'monitor.vault.searchPlaceholder': '全文搜索决策、架构、踩坑或标签...',
  'monitor.vault.kindAll': '全部类型',
  'monitor.vault.kindDecision': 'decision（设计决策）',
  'monitor.vault.kindWorkingState': 'working_state（当前状态）',
  'monitor.vault.kindArchitecture': 'architecture（架构地图）',
  'monitor.vault.kindPitfall': 'pitfall（踩坑与禁忌）',
  'monitor.vault.commitsAhead': 'HEAD 前进 +{count} commits',
  'monitor.vault.staleHead': '{count} 条基于旧 HEAD',
  'monitor.vault.empty': '暂无匹配记忆条目，可点击右上角新增记忆',
  'monitor.vault.archive': '归档',

  // Capsule modal
  'monitor.capsule.title': '交接胶囊',
  'monitor.capsule.tabHuman': '易读视图',
  'monitor.capsule.tabAgent': 'Agent 原文',
  'monitor.capsule.budgetCompact': '紧凑 500t',
  'monitor.capsule.budgetStandard': '标准 1200t',
  'monitor.capsule.budgetFull': '完整 2500t',
  'monitor.capsule.goal': '当前目标',
  'monitor.capsule.goalPlaceholder': '输入或编辑当前目标...',
  'monitor.capsule.decisions': '已敲定决策（勾选带入下个对话）',
  'monitor.capsule.files': '涉及文件',
  'monitor.capsule.artifacts': '产物与文档链接',
  'monitor.capsule.nextAction': '下一步行动',
  'monitor.capsule.nextActionPlaceholder': '输入或编辑下一步行动...',
  'monitor.capsule.autoTrack': '自动随会话追踪',
  'monitor.capsule.noDecisions': '暂无已保存决策',
  'monitor.capsule.agentHint': '附着给 Agent 的紧凑格式',
  'monitor.capsule.copyRaw': '复制原文',
  'monitor.capsule.saveOnly': '仅存入记忆库',
  'monitor.capsule.attachNext': '存入并附着到下条消息',

  // Asset Inspector modal
  'monitor.asset.title': '资产检视',
  'monitor.asset.copyPath': '复制路径',
  'monitor.asset.openFile': '打开文件',
  'monitor.asset.pathCopied': '已复制文件路径',
  'monitor.asset.openRequested': '已请求宿主打开文件',
  'monitor.asset.openFallback': '当前视图不支持直开，已复制文件路径',
  'monitor.asset.mcpToolsTitle': '工具明细与 Token 占比',
  'monitor.asset.goGovernance': '前往治理页管理',
  'monitor.asset.mcpEager': '常驻',
  'monitor.asset.mcpDeferred': '按需',
  'monitor.asset.mcpNoTools': '暂无可展示的工具 Schema 明细',
  'monitor.asset.noFileContent': '该资产为动态汇总项，无对应本地文件',
  'monitor.asset.share': '占上下文 {pct}% ({tokens} tokens)',
  'monitor.asset.layerWorkspace': '工作区',
  'monitor.asset.layerGlobal': '全局',
  'monitor.asset.layerPlugin': '插件',
  'monitor.asset.layerBuiltin': '内置',
  'monitor.asset.layerVault': '记忆库',

  // Add memory modal
  'monitor.addMem.title': '新增跨会话记忆',
  'monitor.addMem.kind': '记忆类型',
  'monitor.addMem.titleLabel': '标题',
  'monitor.addMem.titlePlaceholder': '例如：使用自定义 Popover 替代原生 select',
  'monitor.addMem.bodyLabel': '摘要内容（落盘前自动脱敏）',
  'monitor.addMem.bodyPlaceholder': '记录核心结论、权衡与约束...',
  'monitor.addMem.submit': '写入真相源',

  // Restart Antigravity confirmation modal
  'monitor.restart.title': '重启 Antigravity 客户端',
  'monitor.restart.desc': '将安全关闭并重新启动 Antigravity 进程（约 3-5 秒），不会修改 app.asar 或影响已保存数据。',
  'monitor.restart.detail': '未保存的编辑器改动请先保存，重启期间本面板将短暂断开。',
  'monitor.restart.cancel': '取消',
  'monitor.restart.confirm': '确认重启',
  'monitor.restart.restarting': '正在重启...',
  'monitor.restart.success': '已发起安全重启，Antigravity 即将重新启动',
  'monitor.restart.failed': '重启失败：{error}',

  // Settings view
  'settings.back': '← 返回',
  'settings.title': '插件设置',
  'settings.version': 'Antigravity Hub v{version}',
  'settings.section.general': '通用与语言',
  'settings.section.monitor': '监控与预警',
  'settings.section.popout': '窗口与悬浮窗',
  'settings.section.maintenance': '维护与操作',
  'settings.section.doctor': '健康体检（Doctor）',

  'settings.lang.title': '界面语言',
  'settings.lang.desc': '切换插件控制台显示语言，即时生效',
  'settings.lang.zhCN': '简体中文',
  'settings.lang.en': 'English',

  'settings.auxAuto.title': '右侧边栏自动呼出',
  'settings.auxAuto.desc': '触发诊断或交接时自动打开右侧面板',
  'settings.startupPopout.title': '随 Antigravity 启动自动弹出悬浮窗',
  'settings.startupPopout.desc': '打开 Antigravity 并加载完成后自动弹出，单次运行仅弹一次',
  'toast.startupPopoutOn': '已开启随 Antigravity 启动自动弹出悬浮窗',
  'toast.startupPopoutOff': '已关闭启动自动弹出悬浮窗',
  'settings.sidebarPopout.title': '左侧边栏自动弹出悬浮窗',
  'settings.sidebarPopout.desc': '点击左侧入口自动拉起独立悬浮窗',
  'settings.miniBar.title': '迷你悬浮条长度与模块排序',
  'settings.miniBar.desc': '选择快捷长度档位，拖拽或点击模块调整展示顺序（仍支持手动拖宽）',
  'settings.miniBar.presetMinimal': '极简 1',
  'settings.miniBar.presetCompact': '紧凑 2',
  'settings.miniBar.presetStandard': '标准 3',
  'settings.miniBar.presetWide': '加宽 4',
  'settings.miniBar.presetFull': '完整 5',
  'settings.miniBar.customBadge': '自定义 {w}px',
  'settings.miniBar.hint': '拖动模块卡片或点击选中后点目标位置互换顺序；高亮区为当前档位显示项',
  'settings.miniBar.modContext': '上下文占比',
  'settings.miniBar.modCache': '缓存命中',
  'settings.miniBar.modKv': 'KV 倒计时',
  'settings.miniBar.modTps': '输出速度',
  'settings.miniBar.modModel': '模型名',
  'settings.miniBar.resetOrder': '恢复默认顺序',
  'settings.kvCache.title': 'Gemini KV 缓存保鲜倒计时',
  'settings.kvCache.desc': '对话结束后自动倒计时，图标按蓝 / 黄 / 红三态预警',
  'settings.kvCache.windowLabel': '参考窗口（分钟）',
  'settings.topMost.title': '悬浮窗默认置顶',
  'settings.topMost.desc': '始终保持在 Antigravity 窗口最上方',
  'settings.popout.title': '独立悬浮小窗',
  'settings.popout.desc': '按需启动本地无框浮窗，关闭即释放端口',
  'settings.popout.size': '默认尺寸',
  'settings.popout.launch': '弹出悬浮窗',
  'settings.popout.sizeCompact': '420 × 680（紧凑竖窗）',
  'settings.popout.sizeStandard': '460 × 720（标准侧栏）',
  'settings.popout.sizeWide': '880 × 640（宽屏浮窗）',
  'settings.popout.running': '运行中 :{port}',
  'settings.popout.enabled': '已启用',
  'settings.popout.closed': '已关闭',

  'settings.poll.title': '定时检测周期',
  'settings.poll.desc': '自动增量拉取频率（0 模型 Token 消耗）',
  'settings.banner.title': '聊天流单行状态条',
  'settings.banner.desc': '仅向用户展示 TPS 与缓存命中，模型不可见',
  'settings.banner.preview': '⚡ 64.8 tok/s | Cache 96.8% (74.5k/77.0k) | +2.5k in / 268 out | $0.023',
  'settings.budget.label': 'SessionStart 注入上限',
  'settings.warnPct.label': '上下文警戒线 (%)',
  'settings.dropPct.label': '缓存击穿阈值 (%)',

  'settings.doctor.title': '健康体检（Doctor）',
  'settings.doctor.healthy': '健康',
  'settings.doctor.attention': '需关注',
  'settings.doctor.drift': 'Hook 契约漂移',
  'settings.doctor.driftVal': '{count} 项漂移',
  'settings.doctor.circuit': 'Fail-Open 熔断器',
  'settings.doctor.index': 'SQLite FTS5 索引',
  'settings.doctor.indexSynced': '已同步',
  'settings.doctor.indexRebuild': '需重建',
  'settings.doctor.indexVal': '{status} / {count} 条',
  'settings.doctor.deploy': '部署运行包',
  'settings.doctor.deployClean': '0 node_modules',
  'settings.doctor.deployDirty': '含冗余依赖',
  'settings.doctor.deployVal': 'v{version} / {status}',
  'settings.doctor.rebuildBtn': '重建索引',
  'settings.doctor.exportBtn': '导出备份',
  'settings.doctor.runBtn': '立即体检',
  'settings.doctor.resetBtn': '恢复默认设置',
  'settings.doctor.restartBtn': '重启 Antigravity',

  // Governance module
  'gov.title': '生态治理',
  'gov.checking': '检测中',
  'gov.refreshTitle': '重新扫描生态与离线体检',
  'gov.scorePill': '体检 {score} 分',
  'gov.tab.overview': '总览体检',
  'gov.tab.extensions': '插件/MCP',
  'gov.tab.harness': '生效栈',
  'gov.tab.profiles': '场景/快照',
  'gov.overview.scoreLabel': '生态健康评分（纯离线，0 Token）',
  'gov.overview.scanning': '正在扫描插件、MCP、Skills、Rules 与隐私安全...',
  'gov.overview.baseline': '估算常驻底座',
  'gov.overview.lintTitle': '离线体检（MCP / Skill / 隐私）',
  'gov.overview.fixAll': '打包交给 Agent',
  'gov.overview.ignored': '已忽略项',
  'gov.ext.searchPlaceholder': '搜索插件或 MCP Server...',
  'gov.ext.guardrail': '写前自动快照 / 原子校验 / 保护 Hub 自身',
  'gov.ext.pluginsTitle': '已安装插件',
  'gov.ext.mcpTitle': 'MCP 服务',
  'gov.harness.title': '生效优先级栈（P1 工作区 → P4 内置）',
  'gov.harness.all': '全部',
  'gov.profiles.builtinTitle': '内置场景预设',
  'gov.profiles.builtinDesc': '切换前预览 Diff 并自动留存快照，新会话生效',
  'gov.profiles.saveTitle': '保存为自定义预设',
  'gov.profiles.saveDesc': '固化当前插件与 MCP 启停组合',
  'gov.profiles.namePlaceholder': '预设名（如：前端精简）',
  'gov.profiles.descPlaceholder': '可选备注...',
  'gov.profiles.saveBtn': '保存预设',
  'gov.profiles.customTitle': '我的自定义预设',
  'gov.profiles.snapshotsTitle': '配置快照时间机器',

  // Appearance module
  'app.title': '外观壁纸',
  'app.closed': '已关闭',
  'app.masterTitle': '启用或关闭壁纸（免重启热生效）',
  'app.refreshTitle': '刷新壁纸状态',
  'app.tab.gallery': '壁纸库',
  'app.tab.tuning': '质感与护眼',
  'app.tab.rotation': '轮播与急救',
  'app.runtimeNotice': '尚未注入客户端热加载运行时，前往「界面汉化」执行一次安全注入即可启用壁纸。',
  'app.goPatchBtn': '前往注入',
  'app.gallery.libraryTitle': '本地壁纸库',
  'app.gallery.importBtn': '导入图片',
  'app.tuning.title': '实时视觉参数',
  'app.tuning.resetBtn': '恢复默认',
  'app.tuning.opacity': '壁纸不透明度',
  'app.tuning.blur': '背景高斯模糊',
  'app.tuning.scrim': '自适应明暗遮罩',
  'app.tuning.saturation': '色彩饱和度',
  'app.tuning.fit': '画面填充方式',
  'app.tuning.separateTheme': '深浅主题独立绑定',
  'app.rotation.title': '自动轮播',
  'app.rotation.mode': '轮播模式',
  'app.rotation.interval': '切换间隔',
  'app.rotation.minutes': '分钟',
  'app.rotation.pool': '轮播候选池',
  'app.rotation.managePool': '管理轮播池',
  'app.rotation.nextBtn': '换下一张',
  'app.rotation.emergencyOff': '一键关闭壁纸',
  'app.rotation.cliOff': '终端应急关闭',

  // Localization (client i18n) module
  'i18n.title': 'Antigravity 界面汉化',
  'i18n.checking': '检测中',
  'i18n.refreshTitle': '刷新汉化状态',
  'i18n.tab.status': '状态与补丁',
  'i18n.tab.dict': '词典管理',
  'i18n.tab.rules': '防误翻与个性化',
  'i18n.status.versionUnknown': '版本未知',
  'i18n.status.detecting': '正在检测 Antigravity 客户端状态...',
  'i18n.status.desc': '本地零依赖 ASAR 补丁与外置词典，随时可无损还原原版。',
  'i18n.status.applyBtn': '一键应用汉化',
  'i18n.status.restoreBtn': '一键还原原版',
  'i18n.status.refreshBundleBtn': '刷新热加载词典',
  'i18n.status.installPath': '客户端安装路径',
  'i18n.status.autoDetect': '自动探测',
  'i18n.status.redetectBtn': '重新探测',
  'i18n.status.installPlaceholder': '留空自动探测，或手动指定安装目录...',
  'i18n.status.backupsTitle': '已检测原版备份',
  'i18n.status.lastJobTitle': '最近补丁任务',
  'i18n.dict.addBtn': '+ 新增/覆盖词条',
  'i18n.dict.importBtn': '导入 JSON',
  'i18n.dict.exportBtn': '导出 JSON',
  'i18n.dict.syncBtn': '社区词典同步',
  'i18n.dict.searchPlaceholder': '搜索英文原文或中文译文...',
  'i18n.dict.prevPage': '上一页',
  'i18n.dict.nextPage': '下一页',
  'i18n.rules.immunityTitle': '物理防误翻免疫区',
  'i18n.rules.brandTitle': '品牌展示与菜单行为',

  // Toasts
  'toast.synced': '已同步最新数据',
  'toast.syncFailed': '同步失败：{error}',
  'toast.followAuto': '已开启自动跟随活跃对话',
  'toast.followPinned': '已锁定当前对话',
  'toast.aggregateMode': '已切换至全部运行中对话汇总视图',
  'toast.sessionSynced': '已同步切换至所选对话',
  'toast.pollUpdated': '轮询周期已设为每 {interval}',
  'toast.pollManual': '已切换为手动刷新',
  'toast.popoutSize': '悬浮窗默认尺寸已设为 {size}',
  'toast.popoutFocused': '已聚焦悬浮窗（127.0.0.1:{port}）',
  'toast.popoutLaunched': '已打开独立悬浮窗（127.0.0.1:{port}）',
  'toast.popoutFallback': '未检测到 WebView2 或 Edge/Chrome，保持页内运行',
  'toast.popoutFailed': '打开悬浮窗失败：{error}',
  'toast.popoutClosed': '已关闭悬浮窗并释放端口',
  'toast.popoutAlreadyIn': '当前已在独立悬浮窗中',
  'toast.pinnedTop': '已开启窗口置顶',
  'toast.unpinnedTop': '已取消窗口置顶',
  'toast.capsuleCopied': '已复制 Agent 交接原文',
  'toast.capsuleSaved': '已存入记忆库',
  'toast.capsuleAttached': '已保存并附着到下条消息',
  'toast.memSaved': '已写入记忆库并更新索引',
  'toast.memArchived': '已归档该条记忆',
  'toast.langUpdated': '界面语言已切换为简体中文',
  'toast.configReset': '已恢复默认设置',
  'toast.indexRebuilt': '已重建 SQLite 索引（{ms}ms）',
  'toast.backupExported': '已导出备份至 {path}',
  'toast.doctorHealthy': 'Doctor 体检通过',
  'toast.doctorIssues': 'Doctor 发现 {count} 项待关注',
  'toast.auxAutoOn': '已开启右侧边栏自动呼出',
  'toast.auxAutoOff': '已关闭右侧边栏自动呼出',
  'toast.sidebarPopoutOn': '已开启左侧边栏自动弹出悬浮窗',
  'toast.sidebarPopoutOff': '已关闭自动弹出悬浮窗',
  'toast.popoutEnabled': '已启用独立悬浮小窗',
  'toast.bannerOn': '已开启聊天流状态条',
  'toast.bannerOff': '已关闭聊天流状态条',
  'toast.budgetUpdated': 'SessionStart 上限已更新为 {tokens} tokens',
  'toast.warnPctUpdated': '上下文警戒线已更新为 {pct}%',
  'toast.dropPctUpdated': '缓存击穿阈值已更新为 {pct}%',
};

const EN = {
  // Common
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.refresh': 'Refresh',
  'common.loading': 'Loading...',
  'common.empty': 'No data',
  'common.enabled': 'Enabled',
  'common.disabled': 'Off',
  'common.running': 'Running',
  'common.stopped': 'Stopped',
  'common.back': 'Back',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.expand': 'Expand',
  'common.collapse': 'Collapse',
  'common.all': 'All',
  'common.reset': 'Reset',
  'common.settings': 'Settings',
  'common.popout': 'Popout',
  'common.restart': 'Restart',
  'common.restarting': 'Restarting...',
  'common.justNow': 'Just now',
  'common.minutesAgo': '{n}m ago',
  'common.hoursAgo': '{n}h ago',
  'common.daysAgo': '{n}d ago',

  // Navigation rail & topbar
  'nav.ariaModules': 'Antigravity Hub modules',
  'nav.ariaSwitch': 'Switch module',
  'nav.monitor': 'Monitor',
  'nav.monitorTitle': 'Context Monitor',
  'nav.governance': 'Govern',
  'nav.governanceTitle': 'Ecosystem Governance',
  'nav.governanceAlertTitle': 'Pending governance alerts',
  'nav.appearance': 'Theme',
  'nav.appearanceTitle': 'Appearance & Wallpaper',
  'nav.i18n': 'Locale',
  'nav.i18nTitle': 'Client Localization',
  'nav.i18nAlertTitle': 'Client updated, patch needs re-apply',
  'nav.settings': 'Settings',
  'nav.settingsTitle': 'Plugin Settings',
  'nav.popout': 'Popout',
  'nav.popoutTitle': 'Open or focus floating window',

  // Frameless native titlebar
  'titlebar.dragTitle': 'Drag window, double-click to maximize or restore',
  'titlebar.tpsTitle': 'Effective output speed',
  'titlebar.modelTitle': 'Active model',
  'titlebar.pinned': 'Pinned',
  'titlebar.pin': 'Pin',
  'titlebar.pinnedTitle': 'Always on top (click to unpin)',
  'titlebar.unpinnedTitle': 'Not pinned (click to pin on top)',
  'titlebar.collapseTitle': 'Collapse or expand mini bar',
  'titlebar.minimizeTitle': 'Minimize',
  'titlebar.maximizeTitle': 'Maximize or restore',
  'titlebar.closeTitle': 'Close floating window',
  'titlebar.miniSummary': '{pct}% / {cache}% Cache',
  'titlebar.miniSummaryTitle': 'Context {pct}% / Cache hit {cache}% ({mode})',
  'titlebar.modelBadgeTitle': 'Model: {model} ({mode})',
  'titlebar.tpsBadgeTitle': 'Output speed: {tps} tok/s ({mode})',
  'titlebar.tpsWaitingTitle': 'Waiting for output ({mode})',
  'titlebar.modeAggregate': 'Aggregate',
  'titlebar.modeAuto': 'Auto-follow',
  'titlebar.modePinned': 'Pinned',

  // Global launcher card
  'launcher.titleRunning': 'Floating Monitor Running',
  'launcher.titleStopped': 'Floating Monitor Closed',
  'launcher.subRunning': '127.0.0.1:{port} / Following active session',
  'launcher.subStopped': 'Local port released. Reopen anytime below.',
  'launcher.statusRunning': 'Running',
  'launcher.statusStopped': 'Closed',
  'launcher.desc': 'Drag and resize freely with saved geometry. Follows the active conversation and releases its port on close.',
  'launcher.currentSession': 'Tracked Session',
  'launcher.autoFollowLatest': 'Follow latest active session',
  'launcher.btnFocus': 'Focus Popout',
  'launcher.btnEmbedded': 'View Embedded',
  'launcher.btnClose': 'Close Popout',

  // Global i18n update banner
  'banner.i18nOutdated': 'Antigravity updated; localization patch needs re-apply',
  'banner.i18nGo': 'Re-apply',
  'banner.i18nLater': 'Later',

  // Monitor tabs & header
  'monitor.tab.context': 'Context',
  'monitor.tab.calls': 'Calls',
  'monitor.tab.quota': 'Quota',
  'monitor.tab.vault': 'Vault',
  'monitor.header.followAutoTitle': 'Auto-following active session (click to pin)',
  'monitor.header.followPinnedTitle': 'Pinned to session (click to auto-follow)',
  'monitor.header.pollTitle': 'Change polling interval',
  'monitor.header.popoutTitle': 'Open floating window',
  'monitor.header.refreshTitle': 'Refresh now',
  'monitor.header.settingsTitle': 'Plugin Settings',
  'monitor.header.restartBtn': 'Restart',
  'monitor.header.restartTitle': 'Restart Antigravity client',
  'monitor.header.alertsCount': '{count} alerts',
  'monitor.header.alertsTitle': 'Alerts',
  'monitor.header.alertsCollapse': 'Hide',
  'monitor.header.alertsEmpty': 'No active alerts',
  'monitor.header.noGit': 'No Git',
  'monitor.header.gitDirtyTitle': 'Working tree has uncommitted changes',
  'monitor.kv.label': 'KV TTL',
  'monitor.kv.active': 'Live',
  'monitor.kv.expired': 'May expire',
  'monitor.kv.waiting': 'Idle',
  'monitor.kv.helpTitle': 'About Gemini KV Cache Countdown',
  'monitor.kv.helpBody1': 'Antigravity relies on Gemini implicit prefix caching, which upstream compute pools evict dynamically (LRU) based on idle time and load rather than a fixed hard TTL.',
  'monitor.kv.helpBody2': 'Long pauses between turns may trigger cache eviction and full prefill on your next message. This countdown provides a practical three-stage heads-up: Blue (stable) → Amber (eviction risk rises) → Red (high expiry risk).',
  'monitor.kv.titleSafe': 'Gemini KV cache warm (est. {rem} left, {ttl}m window)',
  'monitor.kv.titleWarn': 'Gemini KV cache eviction risk rising (est. {rem} left)',
  'monitor.kv.titleDanger': 'Gemini KV cache near or past window (idle {idle}, {ttl}m window)',
  'monitor.kv.titleActive': 'Conversation active; KV cache stays warm',

  // Monitor session selector
  'monitor.session.autoChip': 'Auto',
  'monitor.session.pinnedChip': 'Pin',
  'monitor.session.aggregateChip': 'All',
  'monitor.session.autoOption': 'Follow active session',
  'monitor.session.aggregateOption': 'All running sessions (Main+Sub)',
  'monitor.session.aggregateTitle': 'Active Aggregate (Main+Sub)',
  'monitor.session.aggregateTitleActive': 'Active Aggregate ({count} live)',
  'monitor.session.listCaption': 'Sessions & Subagents',
  'monitor.session.waiting': 'Waiting for sessions',
  'monitor.session.emptyWorkspace': 'No sessions in this workspace',
  'monitor.session.recentActive': 'Active',
  'monitor.session.subTag': 'Sub',
  'monitor.session.stepsShort': '{count} steps',

  // Poll options
  'monitor.poll.s3': '3s (Fast)',
  'monitor.poll.s5': '5s (Recommended)',
  'monitor.poll.s10': '10s',
  'monitor.poll.s30': '30s',
  'monitor.poll.s60': '60s (Eco)',
  'monitor.poll.manual': 'Manual',
  'monitor.poll.manualShort': 'Manual',

  // Monitor context panel
  'monitor.ctx.title': 'Context Usage',
  'monitor.ctx.generateCapsule': 'Handoff Capsule',
  'monitor.ctx.capsuleHelpAria': 'What is a Handoff Capsule?',
  'monitor.ctx.capsuleHelpTitle': 'Handoff Capsule',
  'monitor.ctx.capsuleHelpBody': 'Packs key decisions and state into a compact payload for instant context handoff in a new session.',
  'monitor.ctx.kpiCache': 'Cache Hit',
  'monitor.ctx.kpiTps': 'Output Speed',
  'monitor.ctx.kpiFree': 'Free Space',
  'monitor.ctx.kpiCost': 'Est. Cost',
  'monitor.ctx.modelSimLabel': 'Window Sim',
  'monitor.ctx.modelSimAria': 'Simulate target model context window',
  'monitor.ctx.modelSimNone': 'Current model',
  'monitor.ctx.modelSim200k': '200K (Claude 4.5/4.6)',
  'monitor.ctx.modelSim256k': '256K (GPT-5.x)',
  'monitor.ctx.modelSim1m': '1.00M (Gemini 3/4)',
  'monitor.ctx.modelSimHint': 'Select target window to preview usage',
  'monitor.ctx.modelSimOverflow': 'Over limit {pct}% (+{over}, compact first)',
  'monitor.ctx.modelSimResult': 'Simulated {pct}% / {free} free',
  'monitor.ctx.attributionLabel': 'Breakdown & Cache: ',
  'monitor.ctx.attributionLoading': 'Loading session telemetry...',
  'monitor.ctx.viewCalls': 'View call details →',
  'monitor.ctx.breakdownTitle': 'Active Context Breakdown',
  'monitor.ctx.deferredTitle': 'Deferred',
  'monitor.ctx.deferredNotLoaded': 'Not loaded',
  'monitor.ctx.freeSpace': 'Free space',
  'monitor.ctx.mountedAssetsTitle': 'Mounted Assets',
  'monitor.ctx.emptyItems': 'No items',
  'monitor.ctx.hoverHint': '{key} {tokens} ({pct}%)',

  // Context breakdown categories
  'monitor.breakdown.msg': 'Messages',
  'monitor.breakdown.msgNote': 'Conversation & tool outputs',
  'monitor.breakdown.sys': 'System baseline',
  'monitor.breakdown.sysNote': 'System prompt & builtin tools',
  'monitor.breakdown.mcp': 'MCP tools',
  'monitor.breakdown.mcpNote': '{count} eager tools',
  'monitor.breakdown.skl': 'Skills',
  'monitor.breakdown.sklNote': '{total} summaries + {loaded} active',
  'monitor.breakdown.mem': 'Memory & Rules',
  'monitor.breakdown.memNote': '{count} rule & brief files',
  'monitor.breakdown.agt': 'Custom agents',
  'monitor.breakdown.agtNote': '{count} custom subagents',

  // Mounted assets & deferred items
  'monitor.assets.mcpTitle': 'MCP servers & tools',
  'monitor.assets.mcpCount': '{deferred} deferred / {eager} eager',
  'monitor.assets.mcpDeferredMeta': '{count} tools (deferred)',
  'monitor.assets.mcpPluginMeta': '5 model + 7 app-only',
  'monitor.assets.mcpConfiguredMeta': 'Configured MCP server',
  'monitor.assets.rulesTitle': 'Memory & Rules files',
  'monitor.assets.rulesCount': '{count} files',
  'monitor.assets.rulePluginSlim': 'Plugin slim rule',
  'monitor.assets.ruleGlobalPlugin': 'Global plugin rule',
  'monitor.assets.ruleGlobal': 'Global rule',
  'monitor.assets.ruleWorkspace': 'Workspace rule',
  'monitor.assets.ruleVaultBrief': 'SessionStart Compact Brief',
  'monitor.assets.ruleVaultMeta': 'Vault ({count} items)',
  'monitor.assets.skillsTitle': 'Active Skills & Custom Agents',
  'monitor.assets.skillsCount': '{skills} active / {agents} agents',
  'monitor.assets.skillLoaded': 'Loaded skill',
  'monitor.assets.customSubagent': 'Custom subagent',
  'monitor.assets.deferredMcpKey': 'MCP tools (deferred)',
  'monitor.assets.deferredToolsCount': '{count} tools',

  // Monitor calls panel
  'monitor.calls.modeStep': 'By Step',
  'monitor.calls.modeSummary': 'Summary',
  'monitor.calls.agentAll': 'All Agents (Main+Sub)',
  'monitor.calls.agentMain': 'Main Agent',
  'monitor.calls.agentSub': 'Subagents',
  'monitor.calls.modelAll': 'All Models',
  'monitor.calls.onlyDrop': 'Cache Drops Only',
  'monitor.calls.heroSteps': 'Steps',
  'monitor.calls.heroStepsVal': '{count} steps',
  'monitor.calls.heroStepsFiltered': '{count} / {total} steps',
  'monitor.calls.heroAvgTps': 'Avg Speed',
  'monitor.calls.heroCost': 'Total Cost',
  'monitor.calls.heroModel': 'Model: {model}',
  'monitor.calls.waitingSync': 'Waiting',
  'monitor.calls.lastSync': 'Synced {time}',
  'monitor.calls.colStep': 'Step',
  'monitor.calls.colModel': 'Model',
  'monitor.calls.colTpsFull': 'Eff. ',
  'monitor.calls.colTps': 'TPS',
  'monitor.calls.colDurFull': 'Step ',
  'monitor.calls.colDur': 'Time ⓘ',
  'monitor.calls.colDurTitle': 'Per-step duration (auto-switches to TTFT if available)',
  'monitor.calls.colTokens': 'Ctx / Think / Text',
  'monitor.calls.colCacheFull': 'Cache ',
  'monitor.calls.colCache': 'Hit',
  'monitor.calls.colCostFull': 'Est. ',
  'monitor.calls.colCost': 'Cost',
  'monitor.calls.empty': 'No matching call records',
  'monitor.calls.footerHint': 'Click a row to inspect anatomy & cache drops',
  'monitor.calls.footerStats': '{count} steps / Avg {tps} tok/s / Est. ${cost}',
  'monitor.calls.cacheDropPill': 'Drop',
  'monitor.calls.anatomyTitle': 'Step Anatomy {tag} #{step}',
  'monitor.calls.anatomyModel': 'Model: ',
  'monitor.calls.anatomyTiming': 'Timing: {source}',
  'monitor.calls.anatomyThinkRatio': 'Thinking {ratio}%',
  'monitor.calls.anatomySource': 'Source: ',
  'monitor.calls.anatomyBreakdown': 'Cache {cache} / Fresh {input} / Output {output}',
  'monitor.calls.anatomyDropReason': 'Cache drop cause: ',
  'monitor.calls.summaryByAgent': 'By Main / Subagent',
  'monitor.calls.summaryByModel': 'By Model',
  'monitor.calls.summaryEmpty': 'No summary data',
  'monitor.calls.stepsUnit': '{count} steps',

  // Monitor vault panel
  'monitor.vault.title': 'Cross-Session Memory Vault',
  'monitor.vault.capsuleBtn': 'Capsule',
  'monitor.vault.addBtn': '+ Add Memory',
  'monitor.vault.searchPlaceholder': 'Search decisions, architecture, pitfalls or tags...',
  'monitor.vault.kindAll': 'All Types',
  'monitor.vault.kindDecision': 'decision',
  'monitor.vault.kindWorkingState': 'working_state',
  'monitor.vault.kindArchitecture': 'architecture',
  'monitor.vault.kindPitfall': 'pitfall',
  'monitor.vault.commitsAhead': 'HEAD +{count} commits',
  'monitor.vault.staleHead': '{count} from older HEAD',
  'monitor.vault.empty': 'No matching memories yet. Click "+ Add Memory" to create one.',
  'monitor.vault.archive': 'Archive',

  // Capsule modal
  'monitor.capsule.title': 'Handoff Capsule',
  'monitor.capsule.tabHuman': 'Readable',
  'monitor.capsule.tabAgent': 'Agent Raw',
  'monitor.capsule.budgetCompact': 'Compact 500t',
  'monitor.capsule.budgetStandard': 'Standard 1200t',
  'monitor.capsule.budgetFull': 'Full 2500t',
  'monitor.capsule.goal': 'Active Goal',
  'monitor.capsule.goalPlaceholder': 'Enter or edit active goal...',
  'monitor.capsule.decisions': 'Decisions (check to include)',
  'monitor.capsule.files': 'Touched Files',
  'monitor.capsule.artifacts': 'Artifacts & Links',
  'monitor.capsule.nextAction': 'Next Action',
  'monitor.capsule.nextActionPlaceholder': 'Enter or edit next action...',
  'monitor.capsule.autoTrack': 'Tracked automatically',
  'monitor.capsule.noDecisions': 'No saved decisions yet',
  'monitor.capsule.agentHint': 'Compact payload attached to Agent',
  'monitor.capsule.copyRaw': 'Copy Raw',
  'monitor.capsule.saveOnly': 'Save to Vault',
  'monitor.capsule.attachNext': 'Save & Attach to Next Message',

  // Asset Inspector modal
  'monitor.asset.title': 'Asset Inspector',
  'monitor.asset.copyPath': 'Copy Path',
  'monitor.asset.openFile': 'Open File',
  'monitor.asset.pathCopied': 'File path copied',
  'monitor.asset.openRequested': 'Requested host to open file',
  'monitor.asset.openFallback': 'Direct open unavailable; path copied',
  'monitor.asset.mcpToolsTitle': 'Tools & Token Share',
  'monitor.asset.goGovernance': 'Manage in Governance',
  'monitor.asset.mcpEager': 'Eager',
  'monitor.asset.mcpDeferred': 'Deferred',
  'monitor.asset.mcpNoTools': 'No tool schema details available',
  'monitor.asset.noFileContent': 'Dynamic summary item with no local file',
  'monitor.asset.share': '{pct}% of context ({tokens} tokens)',
  'monitor.asset.layerWorkspace': 'Workspace',
  'monitor.asset.layerGlobal': 'Global',
  'monitor.asset.layerPlugin': 'Plugin',
  'monitor.asset.layerBuiltin': 'Builtin',
  'monitor.asset.layerVault': 'Vault',

  // Add memory modal
  'monitor.addMem.title': 'Add Cross-Session Memory',
  'monitor.addMem.kind': 'Type',
  'monitor.addMem.titleLabel': 'Title',
  'monitor.addMem.titlePlaceholder': 'e.g. Use custom popover instead of native select',
  'monitor.addMem.bodyLabel': 'Summary (auto-redacted before saving)',
  'monitor.addMem.bodyPlaceholder': 'Key conclusions, trade-offs, and constraints...',
  'monitor.addMem.submit': 'Save to Vault',

  // Restart Antigravity confirmation modal
  'monitor.restart.title': 'Restart Antigravity',
  'monitor.restart.desc': 'Safely restarts the Antigravity client (3-5s) without touching app.asar or saved files.',
  'monitor.restart.detail': 'Save any unsaved editor changes first. This panel will briefly disconnect during restart.',
  'monitor.restart.cancel': 'Cancel',
  'monitor.restart.confirm': 'Restart Now',
  'monitor.restart.restarting': 'Restarting...',
  'monitor.restart.success': 'Safe restart initiated. Antigravity will reopen shortly.',
  'monitor.restart.failed': 'Restart failed: {error}',

  // Settings view
  'settings.back': '← Back',
  'settings.title': 'Settings',
  'settings.version': 'Antigravity Hub v{version}',
  'settings.section.general': 'General & Language',
  'settings.section.monitor': 'Monitor & Alerts',
  'settings.section.popout': 'Floating Window',
  'settings.section.maintenance': 'Maintenance & Actions',
  'settings.section.doctor': 'Diagnostics (Doctor)',

  'settings.lang.title': 'Plugin UI Language',
  'settings.lang.desc': 'Switch console display language immediately',
  'settings.lang.zhCN': '简体中文',
  'settings.lang.en': 'English',

  'settings.auxAuto.title': 'Auto-open Aux Pane',
  'settings.auxAuto.desc': 'Open right pane automatically on diagnostics or handoff',
  'settings.startupPopout.title': 'Auto-launch on Antigravity Startup',
  'settings.startupPopout.desc': 'Pop out once automatically after Antigravity loads this plugin',
  'toast.startupPopoutOn': 'Auto-launch floating window on startup enabled',
  'toast.startupPopoutOff': 'Auto-launch floating window on startup disabled',
  'settings.sidebarPopout.title': 'Auto-popout from Sidebar',
  'settings.sidebarPopout.desc': 'Launch floating window when clicking sidebar entry',
  'settings.miniBar.title': 'Mini Bar Length & Module Order',
  'settings.miniBar.desc': 'Pick a length preset and drag or click modules to reorder (manual resize stays supported)',
  'settings.miniBar.presetMinimal': 'Mini 1',
  'settings.miniBar.presetCompact': 'Compact 2',
  'settings.miniBar.presetStandard': 'Std 3',
  'settings.miniBar.presetWide': 'Wide 4',
  'settings.miniBar.presetFull': 'Full 5',
  'settings.miniBar.customBadge': 'Custom {w}px',
  'settings.miniBar.hint': 'Drag modules or click to select and swap; highlighted slots appear at the chosen length',
  'settings.miniBar.modContext': 'Context %',
  'settings.miniBar.modCache': 'Cache Hit',
  'settings.miniBar.modKv': 'KV Timer',
  'settings.miniBar.modTps': 'TPS',
  'settings.miniBar.modModel': 'Model',
  'settings.miniBar.resetOrder': 'Reset Order',
  'settings.kvCache.title': 'Gemini KV Cache Freshness Timer',
  'settings.kvCache.desc': 'Starts after each turn ends with Blue / Amber / Red icon states',
  'settings.kvCache.windowLabel': 'Reference window (min)',
  'settings.topMost.title': 'Always on Top by Default',
  'settings.topMost.desc': 'Keep floating window above Antigravity',
  'settings.popout.title': 'Floating Monitor Window',
  'settings.popout.desc': 'Frameless local window that frees its port on close',
  'settings.popout.size': 'Default Size',
  'settings.popout.launch': 'Open Popout',
  'settings.popout.sizeCompact': '420 × 680 (Compact)',
  'settings.popout.sizeStandard': '460 × 720 (Standard)',
  'settings.popout.sizeWide': '880 × 640 (Wide)',
  'settings.popout.running': 'Running :{port}',
  'settings.popout.enabled': 'Enabled',
  'settings.popout.closed': 'Off',

  'settings.poll.title': 'Polling Interval',
  'settings.poll.desc': 'Incremental refresh cadence (0 LLM tokens)',
  'settings.banner.title': 'Inline Chat Status Strip',
  'settings.banner.desc': 'Shows TPS & Cache hit only to you (hidden from model)',
  'settings.banner.preview': '⚡ 64.8 tok/s | Cache 96.8% (74.5k/77.0k) | +2.5k in / 268 out | $0.023',
  'settings.budget.label': 'SessionStart Token Cap',
  'settings.warnPct.label': 'Context Warning (%)',
  'settings.dropPct.label': 'Cache Drop Alert (%)',

  'settings.doctor.title': 'Diagnostics (Doctor)',
  'settings.doctor.healthy': 'Healthy',
  'settings.doctor.attention': 'Attention',
  'settings.doctor.drift': 'Hook Schema Drift',
  'settings.doctor.driftVal': '{count} drifts',
  'settings.doctor.circuit': 'Fail-Open Circuit',
  'settings.doctor.index': 'SQLite FTS5 Index',
  'settings.doctor.indexSynced': 'Synced',
  'settings.doctor.indexRebuild': 'Needs rebuild',
  'settings.doctor.indexVal': '{status} / {count} items',
  'settings.doctor.deploy': 'Deployed Bundle',
  'settings.doctor.deployClean': '0 node_modules',
  'settings.doctor.deployDirty': 'Extra deps found',
  'settings.doctor.deployVal': 'v{version} / {status}',
  'settings.doctor.rebuildBtn': 'Rebuild Index',
  'settings.doctor.exportBtn': 'Export Backup',
  'settings.doctor.runBtn': 'Run Doctor',
  'settings.doctor.resetBtn': 'Reset Defaults',
  'settings.doctor.restartBtn': 'Restart Antigravity',

  // Governance module
  'gov.title': 'Governance',
  'gov.checking': 'Checking',
  'gov.refreshTitle': 'Rescan ecosystem & offline audit',
  'gov.scorePill': 'Score {score}',
  'gov.tab.overview': 'Overview',
  'gov.tab.extensions': 'Plugins/MCP',
  'gov.tab.harness': 'Stack',
  'gov.tab.profiles': 'Profiles',
  'gov.overview.scoreLabel': 'Ecosystem Health Score (Offline, 0 Tokens)',
  'gov.overview.scanning': 'Scanning plugins, MCP, Skills, Rules & secrets...',
  'gov.overview.baseline': 'Est. Baseline',
  'gov.overview.lintTitle': 'Offline Audit (MCP / Skill / Secrets)',
  'gov.overview.fixAll': 'Send All to Agent',
  'gov.overview.ignored': 'Ignored items',
  'gov.ext.searchPlaceholder': 'Search plugins or MCP servers...',
  'gov.ext.guardrail': 'Auto snapshot / Atomic write / Hub protected',
  'gov.ext.pluginsTitle': 'Installed Plugins',
  'gov.ext.mcpTitle': 'MCP Servers',
  'gov.harness.title': 'Effective Priority Stack (P1 Workspace → P4 Builtin)',
  'gov.harness.all': 'All',
  'gov.profiles.builtinTitle': 'Built-in Profiles',
  'gov.profiles.builtinDesc': 'Preview Diff & auto-snapshot before switching',
  'gov.profiles.saveTitle': 'Save Custom Profile',
  'gov.profiles.saveDesc': 'Save current plugin & MCP toggle set',
  'gov.profiles.namePlaceholder': 'Profile name (e.g. Frontend Lite)',
  'gov.profiles.descPlaceholder': 'Optional note...',
  'gov.profiles.saveBtn': 'Save Profile',
  'gov.profiles.customTitle': 'My Custom Profiles',
  'gov.profiles.snapshotsTitle': 'Config Snapshot Time Machine',

  // Appearance module
  'app.title': 'Appearance',
  'app.closed': 'Off',
  'app.masterTitle': 'Toggle wallpaper (hot reload, no restart)',
  'app.refreshTitle': 'Refresh wallpaper status',
  'app.tab.gallery': 'Gallery',
  'app.tab.tuning': 'Tuning',
  'app.tab.rotation': 'Rotation',
  'app.runtimeNotice': 'Hot-reload runtime not injected. Apply once in Client Localization to enable wallpapers.',
  'app.goPatchBtn': 'Go to Setup',
  'app.gallery.libraryTitle': 'Local Library',
  'app.gallery.importBtn': 'Import Image',
  'app.tuning.title': 'Live Visual Tuning',
  'app.tuning.resetBtn': 'Reset',
  'app.tuning.opacity': 'Opacity',
  'app.tuning.blur': 'Gaussian Blur',
  'app.tuning.scrim': 'Adaptive Scrim',
  'app.tuning.saturation': 'Saturation',
  'app.tuning.fit': 'Image Fit',
  'app.tuning.separateTheme': 'Separate Light / Dark Wallpapers',
  'app.rotation.title': 'Auto Rotation',
  'app.rotation.mode': 'Mode',
  'app.rotation.interval': 'Interval',
  'app.rotation.minutes': 'min',
  'app.rotation.pool': 'Rotation Pool',
  'app.rotation.managePool': 'Manage Pool',
  'app.rotation.nextBtn': 'Next Wallpaper',
  'app.rotation.emergencyOff': 'Disable Wallpaper',
  'app.rotation.cliOff': 'CLI Emergency Off',

  // Localization (client i18n) module
  'i18n.title': 'Client Localization',
  'i18n.checking': 'Checking',
  'i18n.refreshTitle': 'Refresh localization status',
  'i18n.tab.status': 'Status & Patch',
  'i18n.tab.dict': 'Dictionary',
  'i18n.tab.rules': 'Immunity & Brand',
  'i18n.status.versionUnknown': 'Unknown version',
  'i18n.status.detecting': 'Detecting Antigravity client...',
  'i18n.status.desc': 'Local zero-dependency ASAR patch with external dictionary. Fully reversible.',
  'i18n.status.applyBtn': 'Apply Patch',
  'i18n.status.restoreBtn': 'Restore Original',
  'i18n.status.refreshBundleBtn': 'Reload Dictionary',
  'i18n.status.installPath': 'Client Install Path',
  'i18n.status.autoDetect': 'Auto-detect',
  'i18n.status.redetectBtn': 'Redetect',
  'i18n.status.installPlaceholder': 'Leave blank to auto-detect, or enter install dir...',
  'i18n.status.backupsTitle': 'Original Backups',
  'i18n.status.lastJobTitle': 'Last Patch Job',
  'i18n.dict.addBtn': '+ Add Entry',
  'i18n.dict.importBtn': 'Import JSON',
  'i18n.dict.exportBtn': 'Export JSON',
  'i18n.dict.syncBtn': 'Sync Community',
  'i18n.dict.searchPlaceholder': 'Search English source or Chinese translation...',
  'i18n.dict.prevPage': 'Prev',
  'i18n.dict.nextPage': 'Next',
  'i18n.rules.immunityTitle': 'Translation Immunity Zones',
  'i18n.rules.brandTitle': 'Brand & Native Menu',

  // Toasts
  'toast.synced': 'Data synced',
  'toast.syncFailed': 'Sync failed: {error}',
  'toast.followAuto': 'Auto-following active session',
  'toast.followPinned': 'Pinned to current session',
  'toast.aggregateMode': 'Switched to active sessions aggregate',
  'toast.sessionSynced': 'Switched all views to selected session',
  'toast.pollUpdated': 'Polling interval set to {interval}',
  'toast.pollManual': 'Switched to manual refresh',
  'toast.popoutSize': 'Default popout size set to {size}',
  'toast.popoutFocused': 'Focused popout (127.0.0.1:{port})',
  'toast.popoutLaunched': 'Launched popout (127.0.0.1:{port})',
  'toast.popoutFallback': 'WebView2 / Edge / Chrome not found; staying embedded',
  'toast.popoutFailed': 'Popout failed: {error}',
  'toast.popoutClosed': 'Popout closed and port released',
  'toast.popoutAlreadyIn': 'Already inside floating window',
  'toast.pinnedTop': 'Window pinned on top',
  'toast.unpinnedTop': 'Window unpinned',
  'toast.capsuleCopied': 'Copied Agent handoff payload',
  'toast.capsuleSaved': 'Saved to memory vault',
  'toast.capsuleAttached': 'Saved and attached to next message',
  'toast.memSaved': 'Saved to vault and indexed',
  'toast.memArchived': 'Memory archived',
  'toast.langUpdated': 'UI language switched to English',
  'toast.configReset': 'Settings reset to defaults',
  'toast.indexRebuilt': 'Rebuilt SQLite index ({ms}ms)',
  'toast.backupExported': 'Backup exported to {path}',
  'toast.doctorHealthy': 'Doctor check passed',
  'toast.doctorIssues': 'Doctor found {count} item(s) to review',
  'toast.auxAutoOn': 'Auto-open Aux Pane enabled',
  'toast.auxAutoOff': 'Auto-open Aux Pane disabled',
  'toast.sidebarPopoutOn': 'Sidebar auto-popout enabled',
  'toast.sidebarPopoutOff': 'Sidebar auto-popout disabled',
  'toast.popoutEnabled': 'Floating monitor enabled',
  'toast.bannerOn': 'Inline chat status strip enabled',
  'toast.bannerOff': 'Inline chat status strip disabled',
  'toast.budgetUpdated': 'SessionStart cap set to {tokens} tokens',
  'toast.warnPctUpdated': 'Context warning set to {pct}%',
  'toast.dropPctUpdated': 'Cache drop threshold set to {pct}%',
};

export const UI_DICTIONARIES = Object.freeze({
  'zh-CN': Object.freeze(ZH_CN),
  en: Object.freeze(EN),
});

/**
 * Normalize any language tag into a supported UI language ('zh-CN' | 'en').
 */
export function normalizeUiLang(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  if (raw === 'en' || raw.startsWith('en-') || raw.startsWith('en_')) {
    return 'en';
  }
  return DEFAULT_UI_LANG;
}

/**
 * Translate a key with optional {var} placeholder interpolation.
 */
export function t(lang, key, vars = null) {
  const norm = normalizeUiLang(lang);
  const dict = UI_DICTIONARIES[norm] || UI_DICTIONARIES[DEFAULT_UI_LANG];
  const fallback = UI_DICTIONARIES[DEFAULT_UI_LANG];
  let text = dict[key] ?? fallback[key] ?? String(key ?? '');
  if (vars && typeof vars === 'object') {
    text = text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`));
  }
  return text;
}

/**
 * Apply translations to static DOM elements under rootEl using:
 * - [data-i18n] -> textContent
 * - [data-i18n-placeholder] -> placeholder attribute
 * - [data-i18n-title] -> title attribute
 * - [data-i18n-aria] -> aria-label attribute
 */
export function applyStaticTranslations(rootEl, lang) {
  const norm = normalizeUiLang(lang);
  const root = rootEl || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.querySelectorAll !== 'function') return norm;

  if (typeof document !== 'undefined' && (root === document || root === document.documentElement || root === document.body)) {
    document.documentElement.lang = norm;
  }

  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(norm, key);
  });

  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(norm, key));
  });

  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(norm, key));
  });

  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(norm, key));
  });

  return norm;
}

/**
 * Localize a context breakdown item returned by backend context-inspector.mjs.
 */
export function localizeBreakdownItem(item, lang) {
  const norm = normalizeUiLang(lang);
  if (!item || typeof item !== 'object') return { key: '', note: '' };
  const id = String(item.id || '');
  const rawNote = String(item.note || '');

  if (id === 'msg') {
    return { key: t(norm, 'monitor.breakdown.msg'), note: t(norm, 'monitor.breakdown.msgNote') };
  }
  if (id === 'sys') {
    return { key: t(norm, 'monitor.breakdown.sys'), note: t(norm, 'monitor.breakdown.sysNote') };
  }
  if (id === 'mcp') {
    const m = rawNote.match(/(\d+)/);
    return {
      key: t(norm, 'monitor.breakdown.mcp'),
      note: m ? t(norm, 'monitor.breakdown.mcpNote', { count: m[1] }) : rawNote,
    };
  }
  if (id === 'skl') {
    const nums = rawNote.match(/(\d+)/g);
    return {
      key: t(norm, 'monitor.breakdown.skl'),
      note: nums && nums.length >= 2 ? t(norm, 'monitor.breakdown.sklNote', { total: nums[0], loaded: nums[1] }) : rawNote,
    };
  }
  if (id === 'mem') {
    const m = rawNote.match(/(\d+)/);
    return {
      key: t(norm, 'monitor.breakdown.mem'),
      note: m ? t(norm, 'monitor.breakdown.memNote', { count: m[1] }) : rawNote,
    };
  }
  if (id === 'agt') {
    const m = rawNote.match(/(\d+)/);
    return {
      key: t(norm, 'monitor.breakdown.agt'),
      note: m ? t(norm, 'monitor.breakdown.agtNote', { count: m[1] }) : rawNote,
    };
  }

  return { key: String(item.key || ''), note: rawNote };
}

/**
 * Localize a deferred context item returned by backend context-inspector.mjs.
 */
export function localizeDeferredItem(item, lang) {
  const norm = normalizeUiLang(lang);
  if (!item || typeof item !== 'object') return { key: '', count: '', status: t(norm, 'monitor.ctx.deferredNotLoaded') };
  const rawKey = String(item.key || '');
  const rawCount = String(item.count || '');

  const key = rawKey === 'MCP tools (deferred)' ? t(norm, 'monitor.assets.deferredMcpKey') : rawKey;
  const toolsMatch = rawCount.match(/^(\d+)\s+tools?$/i);
  const count = toolsMatch ? t(norm, 'monitor.assets.deferredToolsCount', { count: toolsMatch[1] }) : rawCount;

  return {
    key,
    count,
    status: t(norm, 'monitor.ctx.deferredNotLoaded'),
  };
}

/**
 * Localize a single Mounted Asset item's name and meta string.
 */
function localizeInventoryItem(it, lang) {
  const norm = normalizeUiLang(lang);
  const rawName = String(it?.name || '');
  const rawMeta = String(it?.meta || '');

  const name = rawName === 'SessionStart Compact Brief' ? t(norm, 'monitor.assets.ruleVaultBrief') : rawName;
  let meta = rawMeta;

  const defTools = rawMeta.match(/^(\d+)\s+tools?\s*\(deferred\)$/i);
  const vaultItems = rawMeta.match(/^vault\s*\((\d+)\s+items?\)$/i);

  if (defTools) {
    meta = t(norm, 'monitor.assets.mcpDeferredMeta', { count: defTools[1] });
  } else if (rawMeta === '5 model + 7 app-only') {
    meta = t(norm, 'monitor.assets.mcpPluginMeta');
  } else if (rawMeta === 'configured MCP server') {
    meta = t(norm, 'monitor.assets.mcpConfiguredMeta');
  } else if (rawMeta === 'plugin slim rule') {
    meta = t(norm, 'monitor.assets.rulePluginSlim');
  } else if (rawMeta === 'global plugin rule') {
    meta = t(norm, 'monitor.assets.ruleGlobalPlugin');
  } else if (rawMeta === 'global rule') {
    meta = t(norm, 'monitor.assets.ruleGlobal');
  } else if (rawMeta === 'workspace rule') {
    meta = t(norm, 'monitor.assets.ruleWorkspace');
  } else if (vaultItems) {
    meta = t(norm, 'monitor.assets.ruleVaultMeta', { count: vaultItems[1] });
  } else if (rawMeta === 'skill (loaded)') {
    meta = t(norm, 'monitor.assets.skillLoaded');
  } else if (rawMeta === 'custom subagent') {
    meta = t(norm, 'monitor.assets.customSubagent');
  }

  return { ...it, name, meta };
}

/**
 * Localize a Mounted Assets accordion group returned by backend context-inspector.mjs.
 * Strips middle-dot separators and translates hardcoded English titles, counts, and item metadata.
 */
export function localizeInventoryGroup(inv, lang) {
  const norm = normalizeUiLang(lang);
  if (!inv || typeof inv !== 'object') return { title: '', count: '', items: [] };
  const rawTitle = String(inv.title || '');
  const rawCount = String(inv.count || '');

  let title = rawTitle;
  let count = rawCount;

  if (rawTitle === 'MCP servers & tools') {
    title = t(norm, 'monitor.assets.mcpTitle');
    const m = rawCount.match(/(\d+)\s+deferred\D+(\d+)\s+eager/i);
    if (m) {
      count = t(norm, 'monitor.assets.mcpCount', { deferred: m[1], eager: m[2] });
    }
  } else if (rawTitle === 'Memory & Rules files') {
    title = t(norm, 'monitor.assets.rulesTitle');
    const m = rawCount.match(/(\d+)\s+files?/i);
    if (m) {
      count = t(norm, 'monitor.assets.rulesCount', { count: m[1] });
    }
  } else if (rawTitle === 'Active Skills & Custom Agents') {
    title = t(norm, 'monitor.assets.skillsTitle');
    const m = rawCount.match(/(\d+)\s+active\D+(\d+)\s+agents?/i);
    if (m) {
      count = t(norm, 'monitor.assets.skillsCount', { skills: m[1], agents: m[2] });
    }
  }

  // Fallback safeguard: ensure no middle-dot separator leaks from backend strings
  count = count.replace(/\s*\u00B7\s*/g, ' / ');

  const items = Array.isArray(inv.items) ? inv.items.map((it) => localizeInventoryItem(it, norm)) : [];
  return { ...inv, title, count, items };
}
