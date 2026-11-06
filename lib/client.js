/*!
 * dsh-plugin-eva-theme v0.51.2 —— 浏览器半边（browser half）
 * MIT License
 *
 * 明日香（暗色）／绫波丽（亮色）双角色主题，覆盖 DSH 全部语义界面。
 *
 * 三条设计原则，按重要性排序：
 *
 *   1) 令牌优先于选择器。
 *      DSH 的配色由 `ctx.theme` 组合成主题快照，再由 ui-layout 以 inline style
 *      写到 <body> 上（`body.style.setProperty(name, value)`）。inline style 压过
 *      任何样式表规则，所以「用 CSS 覆盖 --dsw-alias-*」是不会生效的。本插件因此
 *      走官方通道 `ctx.theme.overrideTokens(source, tokens)`：令牌层叠在用户当前
 *      的 light/dark 主题之上，随主题切换自动解析，卸载时精确移除。
 *
 *   2) 只用语义别名，不碰静态调色板。
 *      `--dsw-alias-*` 是组件真正消费的那一层（107 个）。覆盖 `--dsw-static-*`
 *      会连带改掉语义无关的地方，属于过度侵入。
 *
 *   3) 装饰层与令牌层分离。
 *      扫描线 / 角色背景 / 硬边 / 明朝体这些令牌表达不了的东西，放在插件自有的
 *      样式表与覆盖层里，和插件同生共死；令牌层负责颜色与状态语义。
 *
 * 命名：值一律写成 [light, dark] 两套，这样用户切到浅色主题时皮肤不会崩成
 * 「黑底 + 深色文字」的混合体。暗色为明日香，浅色为绫波丽。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-eva-theme",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const PACKAGE_NAME = "dsh-plugin-eva-theme";
		const STYLE_TAG_ID = PACKAGE_NAME + ":skin";
		const OVERLAY_CLASS = "eva-magi-layer";
		// Keep the original persistence namespace so renamed installs retain preferences.
		const STORAGE_NAMESPACE = "dsh-eva-magi-theme";
		const OPTIONS_STORAGE_KEY = STORAGE_NAMESPACE + ":options";
		const BOOT_FLAG = STORAGE_NAMESPACE + ":booted";
		const BOOT_LANGUAGE_KEY = STORAGE_NAMESPACE + ":boot-language";
		const CLOCK_PANEL_WIDTH = 392;
		const CLOCK_SCALE_UNIT = 0.4;
		/** 宿主半边提供的只读余额路由（见 lib/index.js）。 */
		const BALANCE_ROUTE = "/dsh-eva-magi/balance.json";
		/** 翻到余额面后自动翻回的时长。 */
		const AUTO_FLIP_BACK_MS = 8000;
		// DSH 适配集中在这里：优先语义属性，内部元素只匹配局部作用域内的可读后缀。
		const HOST_HOOKS = Object.freeze({
			header: "[data-conversation-header]",
			turnProcess: "[data-turn-process]",
			composer: "[data-composer-card]",
			region: "[data-conversation-region]",
			rightFullscreen: '[data-sidebar-right-open][data-sidebar-right-panel="fullscreen"]',
			sidebar: '[data-slot="sidebar"] [class*="_root"]:has(> nav[class*="_panelList"])',
			newSession: '[data-slot="sidebar"] button[class*="_newSession"]',
			placeholder: '[data-composer-card] [class*="_placeholder"]',
			add: '[data-composer-card] [class*="_add"]',
			send: '[data-composer-card] [class*="_primary"]',
		});

		/**
		 * 设置面板的重绘钩子，由 mountChrome 装上。
		 * 存在的理由：setOption 定义在 apply 里，而面板构建在 mountChrome 里 ——
		 * 用这个工厂级变量把两边接起来，让 Console 改值也能同步到面板控件上。
		 */
		let refreshPanelRef = null;

		/** 标签块的重绘钩子（峰谷状态/倒计时）。同上：把 mountChrome 与 setOption 接起来。 */
		let refreshTagsRef = null;
		let refreshLayoutRef = null;
		let replayBootRef = null;
		let cancelBootRef = null;
		let previewAttentionRef = null;
		let refreshAttentionRef = null;
		/** 客户端 sessions 服务（子作用域注入）。TPS 波形靠它读 sessionStats 投影。 */
		let sessionsRef = null;


		// ============================================================
		// 1. 调色板：设计令牌表
		// ------------------------------------------------------------
		// 键名 → `--dsw-alias-<键名>`；值 → [浅色, 深色]。
		//
		// 暗色：明日香，参考角色图的战斗服红／黑，领口绿与发色橙金点缀。
		// 浅色：绫波丽，瓷白／冰蓝／少量红色标记。
		// 所有 107 个官方别名均保留；成功、警告、错误与差异仍有独立语义。
		// ============================================================
		const PALETTE = {
			// —— 画布与表面：分三层，越靠前越亮，靠发丝线而不是阴影分隔 ——
			"bg-base": ["#eff6fa", "#0d0f13"],
			"bg-layer-1": ["#f7fbfd", "#14171c"],
			"bg-layer-2": ["#ffffff", "#1c2028"],
			"bg-layer-3": ["#e4eef5", "#272c35"],
			"bg-overlay": ["#ffffff", "#20252d"],
			"bg-module-platform": ["#eaf2f7", "#181c23"],
			"bg-multi-select": ["#23799d1f", "#ff354d1a"],
			"bg-skeleton": ["#0000000a", "#ffffff0f"],
			"bg-document-preview": ["#f7fbfd", "#14171c"],
			"label-document-preview": ["#476173", "#dacbc0"],
			"bg-document-selection": ["#23799d52", "#ff354d59"],

			// 遮罩保持黑/白中性，保持阅读层级
			"bg-mask-1": ["#0000003d", "#0000005c"],
			"bg-mask-2": ["#0000001f", "#00000033"],
			"bg-mask-3": ["#0000007a", "#0000008a"],
			"bg-mask-drop": ["#ffffffb3", "#181c23cc"],
			"bg-mask-photo": ["#000000e0", "#000000e6"],

			// —— 边框：角色主色发丝线，四级递进 ——
			"border-l1": ["#28698a17", "#f33a5124"],
			"border-l2": ["#28698a29", "#f33a513d"],
			"border-l3": ["#28698a40", "#f33a5157"],
			"border-l4": ["#28698a59", "#f33a517a"],
			"border-l2-darkmode-thin": ["#28698a29", "#f33a511f"],
			"border-inverted": ["#0000", "#0000"],
			"border-inverted2": ["#0000", "#0000"],

			// —— 文本：角色文本阶梯。明朝/哥特都靠这四级拉开层级 ——
			"label-primary": ["#203849", "#fff1e7"],
			"label-secondary": ["#476173", "#c6b7ac"],
			"label-tertiary": ["#526c7c", "#b3a294"],
			"label-caption": ["#718998", "#8e8178"],
			"label-primary-dimmed": ["#314d60", "#dacbc0"],
			// 官方定义是 blue-900 / neutral-bluish-50；这里收成暖中性，只为保留
			// 「它和 label-primary 有细微差别」这一层语义，不再往蓝偏。
			"label-primary-bluish": ["#263f52", "#fff5ef"],
			"label-dimmed": ["#b6cad7", "#63646a"],
			"label-primary-inverted": ["#ffffff", "#101116"],
			"label-primary-foreground": ["#ffffff", "#101116"],
			"label-shimmer": ["#2f7190", "#ff9ca8"],
			"label-deep-diving": ["#176b91", "#ff354d"],
			"label-deep-diving-shimmer": ["#2f7190", "#ff9ca8"],

			// —— 品牌色＝主色：亮色蓝底白字／暗色珊瑚底深字 ——
			"brand-primary": ["#176b91", "#ff354d"],
			// 官方这一对是 浅色 #0f1115 / 深色 #f9fafb（浅色侧更暗）——它在官方 bundle 里
			// 找不到消费方，所以这里只做一件事：保持与官方同向的极性，别把任何潜在用途弄反。
			"brand-primary-invert": ["#1a0c10", "#fff1e7"],
			"brand-primary-new-colorprimary-new-color": ["#176b91", "#ff354d"],
			"brand-text": ["#28698a", "#ff5967"],

			// —— 按钮 ——
			"button-primary-fill": ["#176b91", "#ff354d"],
			"button-primary-hover": ["#115777", "#ff5967"],
			"button-primary-dimmed": ["#176b9133", "#ff354d47"],
			"button-contrast-fill": ["#314d60", "#fff1e7"],
			"button-elevated-fill": ["#ffffff", "#30363f"],
			"button-floating-fill": ["#ffffff", "#1b2027"],
			"button-floating-hover": ["#eaf2f7", "#30363f"],
			"button-ghost-active-fill": ["#23799d1f", "#ff354d1f"],
			"button-ghost-active-border": ["#23799d59", "#ff354d59"],
			"button-ghost-active-hover": ["#23799d2e", "#ff354d2e"],
			"button-info-fill": ["#2672631f", "#8dc3581f"],
			"button-info-hover": ["#26726333", "#8dc35833"],
			"button-tool-bar-fill": ["#f7fbfd", "#1b2027"],
			"button-tool-bar-fill-invisible": ["#0000", "#0000"],
			"button-tool-bar-hover": ["#23799d1f", "#ff354d1f"],

			// —— 交互反馈：跟随角色主色 ——
			"interactive-bg-hover": ["#23799d14", "#ff354d14"],
			"interactive-bg-hover-accent": ["#23799d24", "#ff354d24"],
			"interactive-bg-hover-danger": ["#ad3d571f", "#ff849424"],
			"interactive-bg-hover-solid": ["#00000014", "#ffffff1a"],
			"interactive-bg-active": ["#23799d24", "#ff354d24"],

			// —— 状态语义：这套皮肤里业务色跟随角色，焦点环也吃它 ——
			"state-business-primary": ["#176b91", "#ff354d"],
			"state-business-tertiary": ["#176b9159", "#ff354d66"],
			"state-success-primary": ["#267263", "#8dc358"],
			"state-success-secondary": ["#267263cc", "#8dc358cc"],
			"state-success-tertiary": ["#26726359", "#8dc35866"],
			"state-warn-primary": ["#926008", "#e5a24f"],
			"state-warn-secondary": ["#926008cc", "#e5a24fcc"],
			"state-warn-tertiary": ["#92600859", "#e5a24f66"],
			"state-warn-label": ["#805408", "#e5a24f"],
			"state-error-primary": ["#ad3d57", "#ff8494"],
			"state-error-secondary": ["#ad3d57cc", "#ff8494cc"],
			"state-idle-primary": ["#9eb6c5", "#686b73"],
			"link": ["#28698a", "#ff8290"],

			// —— 滚动条：角色色细条，像仪表刻度 ——
			"scrollbar-bg-l1": ["#28698a2e", "#f33a512e"],
			"scrollbar-bg-l2": ["#28698a24", "#f33a5124"],
			"scrollbar-hover-l1": ["#28698a59", "#f33a515c"],
			"scrollbar-hover-l2": ["#28698a47", "#f33a5147"],

			// —— 浮层 ——
			// 注意 tooltip-bg：官方设计里它「两种色板都是深底」，而 DSH 并没有
			// tooltip-label 令牌——气泡里的文字颜色不由皮肤决定。这里的覆盖只保证
			// 不改变它在浅/深两套里的极性（依然是深底），免得把官方组件的文字弄没。
			"menu-icon": ["#314d60", "#dacbc0"],
			"menu-group-header-fill": ["#f7fbfdf0", "#14171cf0"],
			"tooltip-bg": ["#203b4cf2", "#272c35f2"],
			"tooltip-key-bg": ["#3d596a", "#37404b"],
			"toast-bg": ["#203b4cf7", "#272c35f7"],
			"toast-label": ["#eff6fa", "#fff1e7"],

			// —— 开关 / 设置卡片 ——
			"switch-thumb": ["#ffffff", "#ffe1bb"],
			"settings-card-fill": ["#f7fbfd", "#14171c"],
			"settings-card-stroke": ["#28698a29", "#f33a5133"],

			// —— Markdown / 代码 ——
			"markdown-code-block": ["#eaf2f7", "#10141a"],
			"markdown-code-block-banner": ["#e4eef5", "#1c2028"],
			"markdown-inline-code": ["#23799d1a", "#ff354d1f"],
			"markdown-citation": ["#23799d24", "#ff354d24"],
			"markdown-tag": ["#2672631f", "#8dc3581f"],
			"markdown-placeholder": ["#839aa9", "#8e8178"],
			"markdown-code-segment-selected": ["#23799d33", "#ff354d33"],
			"markdown-code-segment-unselected": ["#0000000f", "#ffffff14"],
			"code-diff-added": ["#2672631f", "#8dc3581f"],
			"code-diff-deleted": ["#ad3d571f", "#ff84941f"],

			// —— 文件差异（对齐 code-diff 的语义） ——
			"file-diff-added-bg": ["#26726314", "#8dc35814"],
			"file-diff-added-gutter": ["#26726324", "#8dc35824"],
			"file-diff-added-marker": ["#267263", "#8dc358"],
			"file-diff-deleted-bg": ["#ad3d5714", "#ff849414"],
			"file-diff-deleted-gutter": ["#ad3d5724", "#ff849424"],
			"file-diff-deleted-marker": ["#ad3d57", "#ff8494"],

			// —— 引导页 ——
			"onboarding-accent": ["#176b91", "#ff354d"],
			"onboarding-card-fill": ["#f7fbfd", "#14171c"],
			"onboarding-checkbox-border": ["#28698a59", "#f33a5159"],
			"onboarding-secondary-fill": ["#eaf2f7", "#272c35"],

			// —— 回合触发器 ——
			"turn-trigger-bg": ["#23799d12", "#ff354d12"],
			"turn-trigger-bg-hover": ["#23799d1f", "#ff354d1f"],
		};

		// 启动角色与正文共用色板，避免字体和头像出现另一套红／蓝。
		const BOOT_THEMES = Object.freeze(Object.fromEntries([["asuka", 1], ["rei", 0]].map(([id, mode]) => [id, Object.freeze(Object.fromEntries(Object.entries({
			accent: "brand-primary", ink: "label-primary", dim: "label-secondary", surface: "bg-base", panel: "bg-layer-1", line: "border-l4", signal: "state-warn-primary", ok: "state-success-primary",
		}).map(([role, token]) => [role, PALETTE[token][mode]])))])));
		const bootThemeCSS = (id, prefix) => Object.entries(BOOT_THEMES[id]).map(([role, value]) => "--" + prefix + "-" + role + ":" + value + ";").join("");

		// BEGIN GENERATED ASSET INDEX
		// Generated by tools/build-assets.mjs: small SVG markup and versioned same-origin URLs.
		const BRAND_ASSETS = Object.freeze({
			boot: "/dsh-eva-magi/assets/animations/nerv-boot.gif?v=32d689fa2a8b",
			logo: "/dsh-eva-magi/assets/svg/nerv-logo.svg?v=c517c9bc95b3",
			emergency: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1000 1000\" preserveAspectRatio=\"xMidYMid slice\" fill=\"none\">\n  <title>NERV EMERGENCY</title>\n  <defs>\n    <path id=\"eva-alert-hex\" d=\"M-120 0-60-104H60L120 0 60 104H-60Z\"/>\n    <g id=\"eva-alert-tile\">\n      <use href=\"#eva-alert-hex\" fill=\"#ef060c\" stroke=\"#df0308\" stroke-width=\"5\"/>\n      <path d=\"M0-66-22-30H22ZM-22 29H22L0 65Z\" fill=\"#030101\"/>\n      <text x=\"0\" y=\"9\" fill=\"#030101\" font-family=\"Arial,Helvetica,sans-serif\" font-size=\"26\" font-weight=\"800\" text-anchor=\"middle\" textLength=\"195\" lengthAdjust=\"spacingAndGlyphs\">EMERGENCY</text>\n    </g>\n    <pattern id=\"eva-alert-scan\" width=\"4\" height=\"4\" patternUnits=\"userSpaceOnUse\">\n      <path d=\"M0 .5H4\" stroke=\"#000\" stroke-opacity=\".24\"/>\n      <path d=\"M.5 0V4\" stroke=\"#260000\" stroke-opacity=\".08\"/>\n    </pattern>\n    <filter id=\"eva-alert-grain\" x=\"0\" y=\"0\" width=\"100%\" height=\"100%\">\n      <feTurbulence type=\"fractalNoise\" baseFrequency=\".72\" numOctaves=\"3\" seed=\"19\"/>\n      <feColorMatrix type=\"saturate\" values=\"0\"/>\n    </filter>\n  </defs>\n  <path fill=\"#000\" d=\"M0 0H1000V1000H0Z\"/>\n  <g class=\"eva-alert-honeycomb\" stroke-linejoin=\"miter\">\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.16s\"><use href=\"#eva-alert-tile\" transform=\"translate(363 173)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.74s\" opacity=\".78\"><use href=\"#eva-alert-tile\" transform=\"translate(565 67)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.42s\"><use href=\"#eva-alert-tile\" transform=\"translate(565 280)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.95s\"><use href=\"#eva-alert-tile\" transform=\"translate(767 174)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.32s\" opacity=\".28\"><use href=\"#eva-alert-tile\" transform=\"translate(767 -38)\"/></g>\n    <use href=\"#eva-alert-hex\" transform=\"translate(969 67)\" stroke=\"#df0308\" stroke-width=\"7\"/>\n    <use href=\"#eva-alert-hex\" transform=\"translate(-49 793)\" stroke=\"#df0308\" stroke-width=\"7\"/>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.64s\"><use href=\"#eva-alert-tile\" transform=\"translate(132 899)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.11s\" opacity=\".65\"><use href=\"#eva-alert-tile\" transform=\"translate(334 793)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.83s\"><use href=\"#eva-alert-tile\" transform=\"translate(334 1005)\"/></g>\n    <g class=\"eva-alert-cell\" style=\"--alert-lag:-.36s\" opacity=\".24\"><use href=\"#eva-alert-tile\" transform=\"translate(-70 1005)\"/></g>\n    <use href=\"#eva-alert-hex\" transform=\"translate(536 899)\" stroke=\"#df0308\" stroke-width=\"7\"/>\n    <use href=\"#eva-alert-hex\" transform=\"translate(1128 899)\" stroke=\"#df0308\" stroke-width=\"7\"/>\n  </g>\n  <g class=\"eva-alert-wordmark\" fill=\"#ed050b\">\n    <text x=\"-25\" y=\"558\" font-family=\"Baskerville,'Times New Roman',serif\" font-size=\"218\" textLength=\"578\" lengthAdjust=\"spacingAndGlyphs\">NERV</text>\n    <path d=\"M570 416H939V484H549ZM546 496H1016V565H524Z\"/>\n    <g fill=\"#070000\" font-family=\"'Times New Roman',Baskerville,serif\">\n      <text x=\"572\" y=\"466\" font-size=\"37\" textLength=\"344\" lengthAdjust=\"spacingAndGlyphs\">God's In His Heaven</text>\n      <text x=\"547\" y=\"544\" font-size=\"35\" textLength=\"432\" lengthAdjust=\"spacingAndGlyphs\">All's Right With The World</text>\n    </g>\n    <text data-emergency-clock=\"\" x=\"459\" y=\"653\" text-anchor=\"middle\" font-family=\"'Times New Roman',Baskerville,serif\" font-size=\"96\" textLength=\"420\" lengthAdjust=\"spacingAndGlyphs\">09:58:57</text>\n  </g>\n  <path fill=\"url(#eva-alert-scan)\" d=\"M0 0H1000V1000H0Z\"/>\n  <path fill=\"#fff\" filter=\"url(#eva-alert-grain)\" opacity=\".045\" d=\"M0 0H1000V1000H0Z\"/>\n</svg>\n",
			entryPlug: "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"eva-entry-plug\" viewBox=\"0 0 400 800\" fill=\"none\" aria-hidden=\"true\">\n  <defs>\n    <linearGradient id=\"eva-plug-shell\" x1=\"129\" y1=\"0\" x2=\"271\" y2=\"0\" gradientUnits=\"userSpaceOnUse\">\n      <stop stop-color=\"#9aa8a8\"/><stop offset=\".16\" stop-color=\"#dce3df\"/><stop offset=\".43\" stop-color=\"#fffff3\"/><stop offset=\".7\" stop-color=\"#f5f4e7\"/><stop offset=\"1\" stop-color=\"#aab6b3\"/>\n    </linearGradient>\n    <linearGradient id=\"eva-plug-cap\" x1=\"129\" y1=\"0\" x2=\"271\" y2=\"0\" gradientUnits=\"userSpaceOnUse\">\n      <stop stop-color=\"#82542d\"/><stop offset=\".25\" stop-color=\"#d19b59\"/><stop offset=\".57\" stop-color=\"#f5cd87\"/><stop offset=\"1\" stop-color=\"#a2703e\"/>\n    </linearGradient>\n    <linearGradient id=\"eva-plug-gold\" x1=\"129\" y1=\"0\" x2=\"271\" y2=\"0\" gradientUnits=\"userSpaceOnUse\">\n      <stop stop-color=\"#85621f\"/><stop offset=\".4\" stop-color=\"#e4bd4f\"/><stop offset=\".7\" stop-color=\"#f8d96e\"/><stop offset=\"1\" stop-color=\"#a78630\"/>\n    </linearGradient>\n    <clipPath id=\"eva-plug-outline\"><rect x=\"129\" y=\"54\" width=\"142\" height=\"692\" rx=\"71\"/></clipPath>\n  </defs>\n  <!-- 背部导轨与定位线独立于白色密封筒，装载时仍保留完整轮廓。 -->\n  <g stroke=\"var(--boot-line)\" stroke-width=\"1\">\n    <path d=\"M105 115v578m190-578v578M96 115h18m-18 578h18m172-578h18m-18 578h18\"/>\n    <path d=\"M105 202h22m146 0h22M105 588h22m146 0h22\" stroke-dasharray=\"3 4\"/>\n  </g>\n  <g clip-path=\"url(#eva-plug-outline)\" stroke=\"#677778\" stroke-width=\"1.4\" stroke-linejoin=\"round\">\n    <rect x=\"129\" y=\"54\" width=\"142\" height=\"692\" rx=\"71\" fill=\"url(#eva-plug-shell)\"/>\n    <path d=\"M129 54h142v107c-40 9-102 9-142 0z\" fill=\"url(#eva-plug-cap)\"/>\n    <path d=\"M129 158q71 13 142 0v14q-71 13-142 0z\" fill=\"#333e42\"/>\n    <path class=\"eva-plug-band\" d=\"M129 172q71 13 142 0v29q-71 13-142 0z\" fill=\"var(--boot-accent)\" stroke=\"#36444a\"/>\n    <path d=\"M129 202q71 13 142 0M129 257q71 12 142 0M129 571q71 12 142 0M143 212v349m112-349v349\" opacity=\".6\"/>\n    <g class=\"eva-plug-roll eva-plug-roll-front\">\n    <path d=\"M148 217h20v27h-20zM232 217h20v27h-20zM154 226h8m76 0h8\" stroke=\"#879492\"/>\n    <!-- 橙色鼻锥的检修盖、锁孔与通气槽。 -->\n    <path d=\"M167 76q33-13 66 0l4 33q-37 9-74 0z\" fill=\"#f2c47d\"/>\n    <path d=\"M174 84h52m-48 9h44M151 126v19m98-19v19\" stroke=\"#896a44\"/>\n    <g fill=\"#535d57\" stroke=\"#b98c53\">\n      <circle cx=\"154\" cy=\"111\" r=\"3\"/><circle cx=\"246\" cy=\"111\" r=\"3\"/>\n      <circle cx=\"155\" cy=\"151\" r=\"2.5\"/><circle cx=\"245\" cy=\"151\" r=\"2.5\"/>\n    </g>\n    <path d=\"M180 132q20-10 40 0l-4 9h-32z\" fill=\"#333e42\" stroke=\"#a37b46\"/>\n    <!-- 长筒侧面机体喷字与面板接缝。 -->\n    <g transform=\"rotate(90 200 338)\" fill=\"#344247\" stroke=\"none\" text-anchor=\"middle\">\n      <text x=\"200\" y=\"336\" class=\"eva-plug-stencil\">EVA-<tspan data-boot-unit>02</tspan></text>\n      <text x=\"200\" y=\"353\" class=\"eva-plug-micro\">NERV · DIRECT ENTRY SYSTEM</text>\n    </g>\n    <path d=\"M157 281h-8v110h8m86-110h8v110h-8\" stroke=\"#93a09c\"/>\n    <path d=\"M166 406h68v9h-68z\" fill=\"#e6e8dc\"/>\n    <path d=\"M176 410h48\" stroke=\"var(--boot-accent)\"/>\n    <!-- L.C.L. 观察舱；驾驶员轮廓由同一坐标系的透明蒙版覆盖。 -->\n    <path d=\"M162 433l-10 13v83l10 14h76l10-14v-83l-10-13z\" fill=\"#b3bfba\" stroke=\"#536467\" stroke-width=\"2\"/>\n    <path d=\"M168 443h64l7 9v71l-7 10h-64l-7-10v-71z\" fill=\"#182b30\"/>\n    <path d=\"M166 450h12m44 0h12m-68 73h12m44 0h12\" stroke=\"var(--boot-accent)\" stroke-width=\"2\"/>\n    <path d=\"M173 462h54m-54 13h54m-54 13h54m-54 13h54m-54 13h54\" stroke=\"#709c94\" opacity=\".17\"/>\n    <g fill=\"#657571\" stroke=\"#dce2d5\"><circle cx=\"160\" cy=\"440\" r=\"2\"/><circle cx=\"240\" cy=\"440\" r=\"2\"/><circle cx=\"160\" cy=\"535\" r=\"2\"/><circle cx=\"240\" cy=\"535\" r=\"2\"/></g>\n    <path d=\"M185 552h30m-25 6h20\" stroke=\"#73817b\"/>\n    </g>\n    <g class=\"eva-plug-roll eva-plug-roll-back\" stroke=\"#84918b\">\n      <path d=\"M177 228h46v330h-46zM188 236v310m24-310v310\" fill=\"#e8e9dd\"/>\n      <path d=\"M181 276h38m-38 9h38m-38 9h38m-38 155h38m-38 9h38m-38 9h38\"/>\n      <g transform=\"rotate(90 200 357)\" fill=\"#465450\" stroke=\"none\" text-anchor=\"middle\">\n        <text x=\"200\" y=\"358\" class=\"eva-plug-micro\">NERV / SERVICE ACCESS · L.C.L.</text>\n      </g>\n      <path d=\"M181 506h38v28h-38z\" fill=\"#d5ad4c\"/><path d=\"m188 528 12-17 12 17z\" fill=\"#344247\"/>\n      <path d=\"M188 85h24v55h-24z\" fill=\"#bd894e\"/><path d=\"M193 96h14m-14 8h14m-14 8h14m-14 8h14\"/>\n    </g>\n    <!-- 与参考模型相同的金色宽环、石墨色护套和橙色三角整流片。 -->\n    <g class=\"eva-plug-collar\">\n      <path d=\"M129 583q71 12 142 0v55q-71 12-142 0z\" fill=\"url(#eva-plug-gold)\" stroke=\"#494f41\" stroke-width=\"2\"/>\n      <path d=\"M129 582q71 12 142 0m-142 59q71 12 142 0\" stroke=\"#29383d\" stroke-width=\"6\"/>\n      <path d=\"M129 646q71 12 142 0v53q-71 12-142 0z\" fill=\"#4a595d\" stroke=\"#304247\"/>\n      <path class=\"eva-plug-roll eva-plug-roll-front\" d=\"M145 654l15 37h-17zM178 657l14 39h-22zM211 658l12 38h-22zM245 654l10 36h-22z\" fill=\"#ee9b41\" stroke=\"#263c42\" stroke-width=\"2\"/>\n      <path d=\"M129 702q71 12 142 0\" stroke=\"#7a8780\"/>\n    </g>\n    <path d=\"M168 718q32 9 64 0m-53 10q21 5 42 0\" stroke=\"#97a19a\"/>\n    <path d=\"M145 90v61m0 63v347m0 148v9\" stroke=\"#fffbe5\" stroke-width=\"3\" opacity=\".5\"/>\n  </g>\n  <rect x=\"129\" y=\"54\" width=\"142\" height=\"692\" rx=\"71\" stroke=\"#889694\" stroke-width=\"1.8\"/>\n  <g class=\"eva-plug-callouts\" fill=\"none\" stroke=\"var(--boot-line)\" stroke-width=\"1\">\n    <path d=\"M269 228h35v-15h28M130 486H83v18H65M270 610h36v18h24\"/>\n    <g fill=\"var(--boot-dim)\" stroke=\"none\" class=\"eva-plug-micro\"><text x=\"299\" y=\"205\">A10</text><text x=\"41\" y=\"518\">L.C.L.</text><text x=\"290\" y=\"642\">LOCK</text></g>\n    <circle cx=\"269\" cy=\"228\" r=\"2\" fill=\"var(--boot-accent)\"/><circle cx=\"130\" cy=\"486\" r=\"2\" fill=\"var(--boot-accent)\"/>\n  </g>\n</svg>\n",
			asukaPortrait: "/dsh-eva-magi/assets/images/asuka-portrait-lineart.png?v=5487f9519bc1",
			asukaHead: "/dsh-eva-magi/assets/images/asuka-avatar-closed-eyes.png?v=cda9acf24d32",
			reiMini: "data:image/png;base64,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",
			asukaMini: "data:image/png;base64,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",
			asukaVoice: "/dsh-eva-magi/assets/audio/asuka-voice-boot.mp3?v=8215dd8831b5",
			asukaVoiceDuration: 6.713469,
			asukaPickVoice: "/dsh-eva-magi/assets/audio/asuka-voice-select.mp3?v=39b91f1dd1c4",
			asukaApproval: "/dsh-eva-magi/assets/audio/asuka-voice-approval.mp3?v=d968f4878857",
			asukaComplete: "/dsh-eva-magi/assets/audio/asuka-voice-complete.mp3?v=f88316c1519c",
			reiPortrait: "/dsh-eva-magi/assets/images/rei-portrait-lineart.png?v=1d22c5a34557",
			reiHead: "/dsh-eva-magi/assets/images/rei-avatar-closed-eyes.png?v=cfbf109cf82b",
			reiVoice: "/dsh-eva-magi/assets/audio/rei-voice-boot.mp3?v=4a4aad865e71",
			reiVoiceDuration: 6.556735,
			reiPickVoice: "/dsh-eva-magi/assets/audio/rei-voice-select.mp3?v=ffe2e9857b36",
			reiApproval: "/dsh-eva-magi/assets/audio/rei-voice-approval.mp3?v=6e7870f6bb1d",
			reiComplete: "/dsh-eva-magi/assets/audio/rei-voice-complete.mp3?v=8762550e287c",
			bootBgm: "/dsh-eva-magi/assets/audio/nerv-boot-music.mp3?v=bd145dc69e76",
			contourWorker: "/dsh-eva-magi/assets/workers/boot-contours.js?v=f49bfc8ad0a6",
			asukaWelcome: "/dsh-eva-magi/assets/audio/asuka-voice-welcome.mp3?v=643309fadbc2",
			reiWelcome: "/dsh-eva-magi/assets/audio/rei-voice-welcome.mp3?v=eaa5ce90e76b",
			typing: "/dsh-eva-magi/assets/audio/nerv-ui-typing.mp3?v=2d940e2128c8",
			width: 256, height: 256, frames: 48, durationMs: 3840, cycleDurationMs: 1920, playbackRate: 2,
		});
		// END GENERATED ASSET INDEX

		// ============================================================
		// 2. 皮肤样式表（令牌表达不了的东西）
		// ------------------------------------------------------------
		// 全部规则都挂在 html[data-eva-*] 上：选项关掉即失效，插件卸载即整表移除。
		// 圆角令牌不在主题快照里（快照只含 107 个 --dsw-alias-*），所以它可以用
		// 普通 CSS 覆盖；但默认圆角是 panel 28px，压到 0 是本皮肤最激进的一刀，
		// 因此单独做成可关的开关。
		// ============================================================
		const SKIN_CSS = `
@font-face{font-family:"EVA Backslash";src:local("Segoe UI"),local("Segoe UI Variable Text"),local("Arial"),local("Helvetica Neue"),local("Helvetica"),local("DejaVu Sans"),local("Liberation Sans");unicode-range:U+005C;font-weight:400 700;}

/* ============================================================================
   0. 令牌表达不了的部分：形状、数字、明朝体
   ============================================================================ */

/* 角色色桥：宿主别名覆盖全部 UI；装饰也从同一套颜色取值。
   变量挂在 body，保证 portal 菜单、开机序列和覆盖层均能继承。 */
html[data-eva-magi] body{
  --eva-accent:var(--dsw-alias-brand-primary);
  --eva-ink:var(--dsw-alias-label-primary);
  --eva-dim:var(--dsw-alias-label-tertiary);
  --eva-hair:var(--dsw-alias-border-l2);--eva-line:var(--dsw-alias-border-l3);
  --eva-on-accent:var(--dsw-alias-label-primary-foreground);
  --eva-secondary:#a7425d;--eva-mark:#a7425d;
  --eva-surface:var(--dsw-alias-bg-layer-1);
  --eva-control:color-mix(in srgb,var(--eva-surface) 96%,transparent);
  --eva-control-hover:color-mix(in srgb,var(--eva-accent) 9%,var(--eva-surface));
  --eva-control-active:color-mix(in srgb,var(--eva-accent) 15%,var(--eva-surface));
  --eva-shadow:rgba(29,66,88,.14);
  --eva-ghost:color-mix(in srgb,var(--eva-accent) 9%,var(--eva-surface));
  --eva-panel:color-mix(in srgb,var(--eva-surface) 96%,transparent);
  /* EVA 明朝体：Yu Mincho（游明朝）优先，缺字逐字回退到日文/简体明朝与宋体。 */
  --eva-mincho-font:"EVA Backslash","Yu Mincho","游明朝","YuMincho","BIZ UD Mincho","MS Mincho","MS PMincho","Noto Serif JP","Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;
  --eva-pilot-font:var(--eva-mincho-font);
  background-color:var(--dsw-alias-bg-base);color:var(--eva-ink);
  accent-color:var(--eva-accent);
}
html[data-eva-magi] body[data-ds-dark-theme]{
  --eva-secondary:#e5a24f;--eva-mark:#8dc358;--eva-shadow:rgba(3,5,9,.48);
}


/* 用户提供的 NERV 叶徽：静态矢量装饰，跟随角色配色，不进入辅助技术阅读流。 */
.eva-nerv-logo{display:block;flex:0 0 auto;width:20px;height:23px;background:var(--eva-accent);
  -webkit-mask:url("${BRAND_ASSETS.logo}") center/contain no-repeat;
  mask:url("${BRAND_ASSETS.logo}") center/contain no-repeat}
body:not([data-ds-dark-theme]) .eva-nerv-logo{background:var(--eva-secondary)}
.eva-cp-top .eva-nerv-logo{width:15px;height:17px}
.eva-mp-crest{position:absolute;left:50%;top:50%;width:28px;height:32px;transform:translate(-50%,-50%)}

/* 深度求索与活动过程沿用宿主动画，只将正文、鲸尾及扫光同步到当前角色。 */
html[data-eva-magi] body [data-chat-running],
html[data-eva-magi] body [data-process-activity]:has([data-shimmer]),
html[data-eva-magi] body [data-turn-process]:has([data-shimmer]){
  color:var(--eva-accent);
  --dsw-alias-label-shimmer:var(--dsw-alias-label-deep-diving-shimmer);
}

/* 硬边：EVA 的世界里没有圆角 */
html[data-eva-edges="hard"]{
  --dsw-radius-xs:0px;--dsw-radius-sm:0px;--dsw-radius-md:0px;
  --dsw-radius-lg:0px;--dsw-radius-xl:0px;--dsw-radius-panel:0px;
}
/* HUD 数字：等宽对齐，读数不会随内容跳动 */
html[data-eva-nums="on"] body{font-variant-numeric:tabular-nums}
/* 选区用主色 */
html[data-eva-magi] ::selection{
  background:var(--dsw-alias-bg-document-selection);
  color:var(--dsw-alias-label-primary);
}
/* 标题走明朝体：拉丁仍吃系统无衬线，只有汉字落到明朝。
   靠 font-family 的逐字符回退实现，且只作用于 h1~h3 —— 明朝体横画很细，
   小字号在暗底会糊（这是 nerv-hud 实测到的教训）。 */
html[data-eva-mincho="on"] :is(h1,h2,h3):not(:where(.eva-boot-title)){
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,Arial,
    "Hiragino Mincho ProN","Hiragino Mincho Pro",YuMincho,"Yu Mincho","Songti SC",serif;
  letter-spacing:.01em;
}
html[data-eva-mincho="on"] :is(h1,h2,h3,strong){-webkit-text-stroke:.2px currentColor}

/* ============================================================================
   1. 覆盖层：CRT 质感 + 结构性装饰
   所有装饰都在 .eva-magi-layer 里，pointer-events:none，只影响像素。
   颜色一律用主题令牌，所以浅/深两套自动跟随。
   ============================================================================ */
.${OVERLAY_CLASS}{
  position:fixed;inset:0;pointer-events:none;z-index:2147483000;
}
.${OVERLAY_CLASS}>*{position:absolute;display:block}
.${OVERLAY_CLASS} [hidden]{display:none!important}
/* 宿主模态弹窗拥有完整交互层；皮肤组件及立绘不覆盖其遮罩和按钮。 */
body:has([role="dialog"][aria-modal="true"]:not(.eva-boot):not([hidden]):not([aria-hidden="true"])) .${OVERLAY_CLASS}{visibility:hidden}
.${OVERLAY_CLASS}[data-paused] *, .${OVERLAY_CLASS}[data-paused] *::before, .${OVERLAY_CLASS}[data-paused] *::after{animation-play-state:paused!important}
.eva-corner-stack[data-fit="minimal"] .eva-tps,
.eva-corner-stack[data-fit="minimal"] .eva-tags,
.eva-corner-stack[data-fit="minimal"] .eva-pilot-status,
.eva-corner-stack[data-fit="minimal"] .eva-pilot-en,
.eva-corner-stack[data-fit="minimal"] .eva-hud-vlabel{display:none}
.eva-corner-stack[data-fit="minimal"] .eva-hud-body{padding:7px 10px}
.eva-corner-stack[data-fit="minimal"] .eva-pilot-name{font-size:12px;margin:0}
.eva-corner-stack[data-fit="minimal"] .eva-hud::after{display:none}
html[data-eva-hud="off"] .eva-corner-stack{display:none}

html[data-eva-scan="off"] .eva-magi-scan,
html[data-eva-beam="off"] .eva-magi-beam,
html[data-eva-chrome="off"] .eva-frame,
html[data-eva-chrome="off"] .eva-edge,
html[data-eva-chrome="off"] .eva-hazard,
html[data-eva-chrome="off"] .eva-tags,
html[data-eva-hud="off"] .eva-hud{display:none}

/* 扫描线：3px 周期、1px 暗线。深色下是 CRT 余晖，浅色下减半免得脏 */
.eva-magi-scan{
  inset:0;
  background:repeating-linear-gradient(to bottom,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.30) 2px 3px);
  opacity:var(--eva-scan-strength,.5);mix-blend-mode:multiply;
}
body:not([data-ds-dark-theme]) .eva-magi-scan{opacity:calc(var(--eva-scan-strength,.5) * .45)}

/* 走行的刷新带：老 CRT 的场同步条，9 秒扫一遍 */
.eva-magi-beam{
  inset:0 0 auto 0;height:150px;
  background:linear-gradient(to bottom,rgba(0,0,0,0),rgba(255,255,255,.035),rgba(0,0,0,0));
  animation:eva-beam 9s linear infinite;
}
@keyframes eva-beam{0%{transform:translateY(-160px)}100%{transform:translateY(100vh)}}

/* ---- 框架：内嵌发丝线 + 四角 L 标 ---- */
.eva-frame{position:absolute;inset:5px;border:1px solid var(--eva-hair)}
.eva-corner{position:absolute;width:17px;height:17px;border:2px solid var(--eva-accent);opacity:.7}
.eva-corner.tl{left:5px;top:5px;border-right:0;border-bottom:0}
.eva-corner.tr{right:5px;top:5px;border-left:0;border-bottom:0}
.eva-corner.bl{left:5px;bottom:5px;border-right:0;border-top:0}
.eva-corner.br{right:5px;bottom:5px;border-left:0;border-top:0}

/* ---- 左右刻度尺：每 8px 短刻度、每 40px 长刻度 ---- */
.eva-edge{position:absolute;top:70px;bottom:74px;left:7px;width:8px;opacity:.5;
  background:
    repeating-linear-gradient(to bottom,var(--eva-line) 0 1px,rgba(0,0,0,0) 1px 8px) left/3px 100% no-repeat,
    repeating-linear-gradient(to bottom,var(--eva-accent) 0 1px,rgba(0,0,0,0) 1px 40px) left/8px 100% no-repeat;}
.eva-edge.r{left:auto;right:7px;background-position:right,right}

/* ---- 底部危险条纹 ---- */
.eva-hazard{
  inset:auto 0 0 0;height:5px;opacity:.4;
  background:repeating-linear-gradient(45deg,
    var(--eva-secondary) 0 5px,rgba(0,0,0,0) 5px 10px);
}

/* ---- 右下角：计费标签／当前角色／TPS。保持用户倍率，允许覆盖输入框。 ---- */
.eva-corner-stack{
  position:absolute;right:18px;bottom:20px;z-index:3;
  width:${CLOCK_PANEL_WIDTH * CLOCK_SCALE_UNIT}px;min-width:0;
  display:flex;flex-direction:column;align-items:stretch;gap:6px;
  transform:scale(var(--eva-hud-scale,1));transform-origin:100% 100%;
}
.eva-corner-stack[data-fit="minimal"]{width:auto}
.eva-corner-stack[data-fit="hidden"]{display:none}
.eva-tags{
  /* 用网格把两个面叠在同一个格子里：容器尺寸取较宽的一面，
     所以翻转前后宽度不跳（避让逻辑也就不必跟着重算）。
     3D 翻转 + backface-visibility 让两面不会同时露出来。 */
  display:grid;transform-style:preserve-3d;
  transition:transform .5s cubic-bezier(.2,.75,.2,1);
  pointer-events:auto;cursor:pointer;
}
.eva-tags[data-face="back"]{transform:rotateX(180deg)}
.eva-tags:focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
.eva-tags-face{
  grid-area:1/1;display:flex;flex-direction:column;align-items:stretch;gap:5px;
  backface-visibility:hidden;
}
/* 背面只有一个余额标签：整块高度由正面（两个标签）决定，
   所以把它垂直居中，不然会贴在顶部、下面空一块。 */
.eva-tags-back{transform:rotateX(180deg);justify-content:center}
/* 余额是"钱"，要一眼看到。但**不能动位置和尺寸** ——
   所以只改绘制类属性：底色、字色、字重、内描边（box-shadow 不占布局）、辉光。
   字号、内外边距、行高全部保持原样，两个标签的位置和大小分毫不变。 */
/* 用 .eva-tag.eva-tag--balance 提高权重：这条规则在基础 .eva-tag 之前，
   同权重会被后者（background/color）盖掉 —— 实测底色仍是橙的，就是踩了这个。
   写死权重就不怕以后规则顺序变动。 */
.eva-tag.eva-tag--balance{
  background:var(--eva-surface);color:var(--eva-accent);
  box-shadow:inset 0 0 0 1px var(--eva-accent),
    0 0 14px color-mix(in srgb,var(--eva-accent) 30%,transparent);
}
/* 背面只有一条余额，让它**占满正面两条标签的总高度**（44px 布局），
   并把数字放大 —— 视觉上就是"一条顶两条"。
   数字在上、名称在下，较长的余额也能容纳于组件的固定宽度。 */
.eva-tags-back .eva-tag--balance{
  flex:1 1 auto;flex-direction:column;justify-content:center;gap:3px;
}
.eva-tag.eva-tag--balance b{
  font:700 22px/1 ui-monospace,Menlo,monospace;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
  text-shadow:0 0 12px color-mix(in srgb,var(--eva-accent) 80%,transparent);
}
.eva-tag--balance small{opacity:.9;letter-spacing:.14em}
/* 反白标签块：nerv-hud 里那种橙底黑字 */
.eva-tag{
  /* space-between：宽度被拉齐之后，主文案贴左、副文案贴右，
     和下方仪表的网格对齐方式一致，不至于是"左边挤一堆、右边空一片"。 */
  display:flex;align-items:center;justify-content:space-between;gap:6px;
  font:700 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  letter-spacing:.2em;text-transform:uppercase;
  padding:4px 8px;background:var(--eva-accent);color:var(--eva-on-accent);
  box-shadow:0 0 12px color-mix(in srgb,var(--eva-accent) 45%,transparent);
}
.eva-tag small{font:400 9px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;opacity:.72}
.eva-tag.ghost{background:transparent;color:var(--eva-accent);box-shadow:none;
  border:1px solid var(--eva-line)}

/* ---- 中央教条区：只标识当前已载入的角色，也是显示设置入口。 ---- */
.eva-hud{
  position:relative;display:flex;align-items:stretch;min-width:0;
  border:1px solid var(--eva-line);background:var(--eva-panel);
  box-shadow:0 8px 24px var(--eva-shadow),inset 3px 0 0 var(--eva-accent);
  font:9.5px/1.4 ui-monospace,Menlo,monospace;color:var(--eva-dim);
  pointer-events:auto;cursor:pointer;
}
.eva-hud-vlabel{cursor:pointer;pointer-events:auto}
.eva-hud-vlabel:focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
.eva-hud-vlabel{
  writing-mode:vertical-rl;text-orientation:upright;
  display:flex;align-items:center;justify-content:center;padding:7px 4px;
  border-right:1px solid var(--eva-hair);color:var(--eva-accent);
  font:10px/1.3 "Hiragino Mincho ProN","Songti SC",serif;letter-spacing:.16em;
}
.eva-hud-body{display:flex;flex:1;min-width:0;flex-direction:column;justify-content:center;padding:10px 9px}
.eva-pilot-status{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:7px;letter-spacing:.16em;color:var(--eva-dim)}
.eva-pilot-status i{display:block;width:4px;height:4px;background:var(--eva-mark)}
.eva-pilot-name{display:block;margin:5px 0 3px;color:var(--eva-accent);
  font:700 21px/1.15 "Hiragino Mincho ProN","Songti SC",serif;letter-spacing:.16em;white-space:nowrap}
.eva-pilot-en{font-size:7px;letter-spacing:.14em;color:var(--dsw-alias-label-secondary);white-space:nowrap}
/* 启动标题和角色名共用中文字体，避免简体字与日文汉字回退到不同字库后错位。 */
html[data-eva-magi] :is(.eva-pilot-name,.eva-pilot-info>b,.eva-boot-loading h2,.eva-boot-title){
  font-family:var(--eva-pilot-font);text-align:start;
}
.eva-hud::after{content:"";position:absolute;right:5px;top:5px;width:45px;height:11px;transform:scale(var(--eva-hud-hazard-ratio,1));transform-origin:top right;background:repeating-linear-gradient(130deg,var(--eva-secondary) 0 4px,var(--eva-surface) 4px 8px)}
.eva-hud:hover{border-color:var(--eva-accent)}
.eva-hud-mini{
  display:none;position:fixed;right:12px;bottom:12px;z-index:4;width:var(--eva-mini-size,58px);height:auto;padding:0;
  flex-direction:column;overflow:hidden;border:1px solid var(--eva-accent);background:var(--eva-surface);
  cursor:pointer;pointer-events:auto;
}
.eva-hud-mini img{width:100%;height:var(--eva-mini-size,58px);object-fit:cover;object-position:center center;display:block}
.eva-hud-mini b{
  position:static;width:100%;padding:2px 1px;border-top:1px solid var(--eva-line);
  background:var(--eva-surface);
  color:var(--eva-accent);font:700 clamp(6px,calc(var(--eva-mini-size,58px) * .12),16px)/1.4 var(--eva-mincho-font),serif;text-align:center;letter-spacing:.08em;white-space:nowrap;
}
.eva-hud-mini:hover{border-color:var(--eva-accent);box-shadow:0 0 0 1px var(--eva-accent)}
.eva-hud-mini:focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
.eva-hud:focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
@keyframes eva-blink{0%,58%{opacity:1}59%,100%{opacity:.1}}

/* ---- 设置面板 ---- */
.eva-panel{
  box-sizing:border-box;position:absolute;z-index:10;
  width:360px;max-height:640px;overflow:auto;overscroll-behavior:contain;pointer-events:auto;
  border:1px solid var(--eva-accent);background:var(--eva-surface);
  box-shadow:0 12px 36px var(--eva-shadow),inset 3px 0 0 var(--eva-accent);
  font:12px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.02em;color:var(--eva-dim);
}
.eva-panel[hidden]{display:none}
.eva-panel-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:8px 12px;
  background:var(--eva-accent);color:var(--eva-on-accent);font-weight:700;letter-spacing:.12em}
.eva-panel-head small{margin-left:auto;font:400 8px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;opacity:.75}
.eva-panel-close{flex:0 0 28px;height:28px;padding:0;border:1px solid currentColor;background:transparent;
  color:inherit;cursor:pointer;font:20px/1 sans-serif}
.eva-panel-body{padding:4px 12px 12px}
.eva-panel-section+.eva-panel-section{margin-top:12px;padding-top:8px;border-top:1px solid var(--eva-hair)}
.eva-group{margin:8px 0;color:var(--eva-accent);font-weight:700;font-size:11px;letter-spacing:.12em}
.eva-advanced>summary{display:flex;align-items:center;justify-content:space-between;cursor:pointer;list-style:none}
.eva-advanced>summary::-webkit-details-marker{display:none}
.eva-advanced>summary::after{content:"展开 ＋";font-size:10px;font-weight:400}
.eva-advanced[open]>summary::after{content:"收起 −"}
.eva-row{display:flex;align-items:center;gap:8px;padding:7px 0}
.eva-row-label{flex:1;min-width:0}
.eva-row-label b{display:block;font-weight:400;font-size:12px;color:var(--eva-ink)}
.eva-row-label i{display:block;font-style:normal;font-size:10px;color:var(--eva-dim)}
.eva-row[data-dim="1"]{opacity:.45}
.eva-sw{flex:0 0 auto;min-width:48px;min-height:28px;padding:5px 7px;cursor:pointer;border-radius:0;
  border:1px solid var(--eva-line);background:transparent;color:var(--eva-dim);font:700 10px/1 ui-monospace,Menlo,monospace}
.eva-sw:hover{border-color:var(--eva-accent);color:var(--eva-accent)}
.eva-sw[aria-checked="true"]{background:var(--eva-accent);color:var(--eva-on-accent);border-color:var(--eva-accent)}
.eva-sw[aria-checked="true"]:hover{color:var(--eva-on-accent);border-color:var(--eva-accent)}
.eva-sw[aria-checked="false"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent)}
.eva-sw[aria-checked="false"]:hover{border-color:var(--dsw-alias-state-error-primary)}
.eva-panel :is(button,input,summary):focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
.eva-range-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 8px}
.eva-val{font-size:12px;text-align:right;color:var(--eva-accent);font-variant-numeric:tabular-nums}
.eva-range-controls{grid-column:1/-1;display:grid;grid-template-columns:28px minmax(0,1fr) 28px;align-items:center;gap:8px}
.eva-range-button,.eva-range-reset{min-height:28px;border:1px solid var(--eva-line);background:transparent;
  color:var(--eva-accent);cursor:pointer;font:12px/1 ui-monospace,Menlo,monospace}
.eva-range-reset{padding:0 6px;font-size:10px}
.eva-range-button:disabled,.eva-range-reset:disabled{opacity:.35;cursor:default}
.eva-row input[type=range]{-webkit-appearance:none;appearance:none;box-sizing:border-box;min-width:0;width:100%;height:28px;margin:0;background:transparent;cursor:pointer}
.eva-row input[type=range]::-webkit-slider-runnable-track{height:3px;background:var(--eva-line)}
.eva-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:20px;margin-top:-8px;background:var(--eva-accent);border-radius:0}
.eva-panel-foot{position:sticky;bottom:0;display:flex;gap:8px;padding:9px 12px;background:var(--eva-surface);border-top:1px solid var(--eva-hair);z-index:2}
.eva-btn{flex:1;min-height:30px;padding:5px;cursor:pointer;border-radius:0;border:1px solid var(--eva-line);
  background:transparent;color:var(--eva-accent);font:700 10px/1 ui-monospace,Menlo,monospace}
.eva-btn:disabled{opacity:.4;cursor:default}
.eva-btn:hover:not(:disabled){background:var(--eva-accent);color:var(--eva-on-accent);border-color:var(--eva-accent)}
.eva-sound-previews .eva-btn[aria-pressed="true"]{background:var(--eva-accent);color:var(--eva-on-accent)}
.eva-sound-previews{display:flex;gap:8px;padding:0 0 8px}
.eva-panel-note{margin:8px 0 0;font-size:10px;color:var(--eva-dim)}

/* ---- 两个标签块：峰谷状态 + 倒计时 ----
   高峰为红字，空闲／周末／假日为绿字；中性底色保证两种主题都可读。 */
.eva-tags{--eva-rate-color:var(--dsw-alias-state-success-primary)}
.eva-tags[data-state="peak"]{--eva-rate-color:var(--dsw-alias-state-error-primary)}
.eva-tags .eva-tag--state{background:var(--eva-surface);color:var(--eva-rate-color);
  box-shadow:inset 3px 0 0 var(--eva-rate-color),0 0 12px color-mix(in srgb,var(--eva-rate-color) 16%,transparent)}
.eva-tags .eva-tag--state small,.eva-tags .eva-tag--remain small{opacity:1}
.eva-tags .eva-tag--remain{color:var(--eva-rate-color);border-color:color-mix(in srgb,var(--eva-rate-color) 45%,var(--eva-surface))}
.eva-tag--remain b{font:400 11px/1 ui-monospace,Menlo,monospace;
  letter-spacing:.06em;font-variant-numeric:tabular-nums}
.eva-tag--state b{white-space:nowrap}
/* 推算态：用样式而不是加字来标注（加字会撑宽整栈）。 */
.eva-tag--state[data-inferred="1"] small{
  text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;
  opacity:.55}
.eva-tags[data-imminent="1"] .eva-tag--state{animation:eva-blink 1.15s steps(1) infinite}

/* ============================================================================
   TPS / 解码速度波形（中央教条区正下方）
   ----------------------------------------------------------------------------
   作为仪表栈的最后一个组件，与中央教条区同宽，统一由父级缩放。
   受"仪表"开关控制：html[data-eva-hud="off"] 时一起隐藏。
   ============================================================================ */
.eva-tps{
  position:relative;right:auto;top:auto;flex:0 0 auto;min-width:0;contain:inline-size;
  width:100%;
  /* 高度写死 + overflow:hidden：波形波动时读数位数会变（— / 258 / 1234），
     不能让它把面板撑大或撑出第二行。1+21+37+18+1 = 78 */
  height:78px;overflow:hidden;
  /* border-box：否则 1px 边框会让它比下方仪表盘宽 2px，左边缘差 3px */
  box-sizing:border-box;
  transform:none;

  border:1px solid var(--eva-hair);
  background:var(--eva-panel);
  box-shadow:0 0 22px var(--eva-shadow), inset 0 0 18px color-mix(in srgb,var(--eva-accent) 5%,transparent);
  font:9px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.06em;
  color:var(--dsw-alias-label-tertiary);
  pointer-events:none;
}
html[data-eva-hud="off"] .eva-tps{display:none}
.eva-tps-head{
  display:flex;align-items:center;gap:4px;padding:4px 6px;
  line-height:13px;white-space:nowrap;overflow:hidden;
  border-bottom:1px solid var(--eva-hair);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-weight:700;font-size:9px;letter-spacing:.22em;color:var(--eva-accent);
}
.eva-tps-head i{width:5px;height:5px;background:var(--eva-accent);display:block}
.eva-tps-head small{margin-left:auto;font:400 8px/1 ui-monospace,Menlo,monospace;
  letter-spacing:.1em;color:var(--eva-dim)}
.eva-tps-now{margin-left:4px;
  /* 固定槽位：数字位数变化时布局不动（否则"TPS / DECODE"会被挤来挤去） */
  display:inline-block;min-width:3.4em;text-align:right;
  font:700 13px/1 ui-monospace,Menlo,monospace;letter-spacing:0;
  font-variant-numeric:tabular-nums;
  color:var(--eva-accent);text-shadow:0 0 8px color-mix(in srgb,var(--eva-accent) 70%,transparent)}
.eva-tps-scope{display:block;width:100%;height:34px;margin:3px 0 0;
  background:
    repeating-linear-gradient(90deg,var(--eva-hair) 0 1px,transparent 1px 20px),
    repeating-linear-gradient(0deg,var(--eva-hair) 0 1px,transparent 1px 11px);
}
.eva-tps-base{stroke:var(--eva-hair);stroke-width:1}
.eva-tps-line{fill:none;stroke:var(--eva-accent);stroke-width:1.6;
  stroke-linejoin:round;stroke-linecap:round;
  filter:drop-shadow(0 0 3px color-mix(in srgb,var(--eva-accent) 65%,transparent))}
.eva-tps-foot{display:flex;justify-content:space-between;padding:3px 6px 4px;
  border-top:1px solid var(--eva-hair);font-size:8px;letter-spacing:.1em;
  line-height:11px;white-space:nowrap;overflow:hidden}
.eva-tps-foot b{color:var(--eva-accent);font-weight:700;
  display:inline-block;min-width:2.6em;text-align:right;font-variant-numeric:tabular-nums}

/* 权限与模型选择器共用角色色、警戒条纹与全部交互状态；保持宿主尺寸。 */
html[data-eva-magi] body [data-slot="conversation.input.permission"] button,
html[data-eva-magi] body [data-slot="conversation.input.model"] button{
  background-color:var(--eva-control);
  background-image:repeating-linear-gradient(45deg,var(--eva-secondary) 0 3px,transparent 3px 6px);
  background-size:5px 100%;background-position:left center;background-repeat:no-repeat;
  color:var(--eva-accent);font-weight:700;letter-spacing:.06em;
  box-shadow:inset 0 0 0 1px var(--eva-accent);
  text-shadow:0 0 8px color-mix(in srgb,var(--eva-accent) 45%,transparent);
  transition:background-color .18s ease,box-shadow .18s ease;
}
html[data-eva-magi] body [data-slot="conversation.input.permission"] button:hover:not(:disabled),
html[data-eva-magi] body [data-slot="conversation.input.model"] button:hover:not(:disabled),
html[data-eva-magi] body [data-slot="conversation.input.permission"] button[aria-expanded="true"]:not(:disabled),
html[data-eva-magi] body [data-slot="conversation.input.model"] button[aria-expanded="true"]:not(:disabled){
  background-color:var(--eva-control-hover);
  box-shadow:inset 0 0 0 1px var(--eva-accent),0 0 12px color-mix(in srgb,var(--eva-accent) 32%,transparent);
}
html[data-eva-magi] body [data-slot="conversation.input.permission"] button:active:not(:disabled),
html[data-eva-magi] body [data-slot="conversation.input.model"] button:active:not(:disabled){
  background-color:var(--eva-control-active);
}
html[data-eva-magi] body [data-slot="conversation.input.permission"] button:focus-visible,
html[data-eva-magi] body [data-slot="conversation.input.model"] button:focus-visible{
  outline:1px solid var(--eva-accent);outline-offset:2px;
}
/* 图标和标签继承同一角色前景色。 */
html[data-eva-magi] body [data-slot="conversation.input.permission"] button > span,
html[data-eva-magi] body [data-slot="conversation.input.model"] button > span,
html[data-eva-magi] body [data-slot="conversation.input.permission"] button svg,
html[data-eva-magi] body [data-slot="conversation.input.model"] button svg{
  color:inherit;
}
html[data-eva-magi] body [data-slot="conversation.input.model"] button > span:first-of-type{
  text-transform:uppercase;font-family:ui-monospace,Menlo,monospace;letter-spacing:.07em;
}
/* 推理等级只保留文字，不再绘制独立徽章。 */
html[data-eva-magi] body [data-slot="conversation.input.model"] button > span + span{
  font-family:ui-monospace,Menlo,monospace;font-weight:700;letter-spacing:.06em;
  text-shadow:none;
}

/* ============================================================================
   2. 应用元素的装饰
   只用「不会改变布局、不会与应用自身冲突」的属性：box-shadow / outline /
   border-color / letter-spacing。刻意不用 ::before/:after（可能覆盖应用自己的
   伪元素）与 background-image（可能覆盖应用自己的底纹）。
   挂钩优先用 data-* 语义属性；少数内部节点通过 HOST_HOOKS 匹配可读后缀。
   ============================================================================ */

/* 会话列表：选中项左侧一条橙色标志条 —— 仪表盘式的选中态 */
html[data-eva-magi] [role="treeitem"][aria-selected="true"],
html[data-eva-magi] [role="treeitem"][data-selected="true"]{
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);
}
/* 顶栏：用 inset 阴影画分隔线，不占布局（改 border 宽度会挤动内容） */
html[data-eva-magi] [data-conversation-header]{
  box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l2);
}
/* 主区域：一层极淡的橙色环境光，把中心区从纯黑里拉出来 */
html[data-eva-magi] [data-conversation-region]:not([data-conversation-region="composer"]){
  box-shadow:inset 0 0 140px color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent);
}
/* 输入卡片：外圈发丝线 + 内层橙色浸润 */
/* 侧栏：稳定 slot 与局部可读后缀，同步两套角色配色。 */
/* 侧栏右缘与屏幕底缘共用角色辅助色的警戒带，不增加布局边框。 */
html[data-eva-magi] body ${HOST_HOOKS.sidebar}{
  background-color:var(--eva-control);
  background-image:repeating-linear-gradient(45deg,
    color-mix(in srgb, var(--eva-secondary) 40%, transparent) 0 5px,
    rgba(0,0,0,0) 5px 10px);
  background-size:5px 100%;
  background-position:right center;
  background-repeat:no-repeat;
}
/* 会话列表底部的宿主淡出层使用另一套侧栏底色，会在插件市场上方形成色块。 */
html[data-eva-magi] body [data-slot="sidebar"] [class*="_regionArea"] [class*="_fade"]{
  background:none;
}
/* 品牌标识使用角色主色。 */
html[data-eva-magi] body [data-slot="sidebar.brand.mark"],
html[data-eva-magi] body [data-slot="sidebar.brand.name"]{
  color:var(--eva-accent);
}
html[data-eva-magi] body [data-slot="sidebar.brand.name"]{
  text-transform:uppercase;
  letter-spacing:.1em;
  font-family:ui-monospace,Menlo,monospace;
}
/* 新会话保留按钮最外框；只匹配按钮，内部 Label / Content 容器不描框。 */
html[data-eva-magi] body ${HOST_HOOKS.newSession}{
  background-color:var(--eva-control);
  color:var(--eva-accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--eva-accent) 60%,transparent);
}
html[data-eva-magi] body ${HOST_HOOKS.newSession}:hover{
  background-color:color-mix(in srgb,var(--eva-accent) 14%,transparent);
}
html[data-eva-magi] body ${HOST_HOOKS.newSession}:focus-visible{
  outline:1px solid var(--eva-accent);outline-offset:2px;
}
/* 分组标题：插件（面板标题）/ 工作区（区段标题）
   ----------------------------------------------------------------------------
   这两个标签**没有 data-slot 可用**，原因值得记下来：
   「data-slot="sidebar.panellist"」 这类 slot **只是 portal 锚点、不是容器** ——
   插件标题的真实祖先链是 nav.WYye1W_panelList → div${HOST_HOOKS.sidebar}，
   **根本不在那个 slot 底下**，所以早先 「[data-slot="sidebar.panellist"] > * > button」
   那种写法永远匹配不到（实测确认过）。

   它们的类名是 CSS-module 的 「Hash_name」 形式，所以改用**可读后缀**匹配：
   「[class*="_panelTitle"]」 / 「[class*="_sectionLabel"]」 —— 哈希前缀变了也不受影响，
   比写死 「.tPVXea_sectionLabel」 稳健得多。作用域锚在 「[data-slot="sidebar"]」，
   它确实是侧栏一切的祖先（已实测链路）。

   注：**「未分组」不是分组标题**，它是 workspace 行（「_projectText」，与普通工作区行
   共用同一组件），无法单独选中 —— 保持行标题原色以保证可读。 */
html[data-eva-magi] body [data-slot="sidebar"] [class*="_panelTitle"],
html[data-eva-magi] body [data-slot="sidebar"] [class*="_sectionLabel"]{
  color:var(--eva-accent);
  font-weight:700;
  letter-spacing:.1em;
}
/* 面板行（插件那一行，含左侧图标）：角色主色，图标走 currentColor 一起变 */
html[data-eva-magi] body [data-slot="sidebar"] [class*="_panelRow"],
html[data-eva-magi] body [data-slot="sidebar"] [class*="_sectionHeader"]{
  color:var(--eva-accent);
}

/* 底部「设置」与侧栏图标按钮：角色主色（稳定钩子） */
html[data-eva-magi] body [data-slot="sidebar.settings"],
html[data-eva-magi] body [data-slot="sidebar.footer.action"],
html[data-eva-magi] body [data-slot="sidebar.panellist"] > * > button{
  color:var(--eva-accent);
}
/* 会话前导标记弱化，标题保持正文可读性。 */
html[data-eva-magi] body [data-slot="sidebar.session.row.leading"]{
  color:var(--eva-dim);
}
html[data-eva-magi] body [data-slot="sidebar.session.row.leading"] *{
  color:inherit;
}
/* 侧栏动作保持硬边。 */
html[data-eva-magi] body [data-slot="sidebar.workspaces.session.row.action"] *{
  border-radius:0;
}

/* —— 智能体插件（dockkit 面板）统一：内部侧边栏、标题、输入与滚动条 —— */
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane]{
  --dsw-alias-bg-base:var(--eva-surface);
  --dsw-alias-bg-layer-1:var(--eva-panel);
  --dsw-alias-label-primary:var(--eva-ink);
  --dsw-alias-label-secondary:var(--eva-dim);
  --dsw-alias-border-l1:var(--eva-line);
  --dsw-alias-border-l2:var(--eva-line);
  background:var(--eva-surface)!important;
  color:var(--eva-ink)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] :is(h1,h2,h3){
  color:var(--eva-accent)!important;
  font-family:var(--eva-mincho-font)!important;
  letter-spacing:.06em;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] :is(aside,[class*="sidebar"],[class*="Sidebar"],[data-dockkit-sidebar]){
  background:color-mix(in srgb,var(--eva-surface) 86%,var(--eva-accent) 4%)!important;
  border-right:1px solid var(--eva-line)!important;
  border-left:0!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] :is(input,textarea,select){
  background:var(--eva-panel)!important;
  color:var(--eva-ink)!important;
  border-color:var(--eva-line)!important;
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] button{
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] :is(hr,[class*="divider"],[class*="Divider"]){
  border-color:var(--eva-line)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] ::-webkit-scrollbar{width:8px;height:8px}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] ::-webkit-scrollbar-thumb{background:var(--eva-line);border:0}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-dockkit-pane] ::-webkit-scrollbar-track{background:transparent}
/* 插件页（section._pane_*）内部侧边栏：搜索的“已选目录/盘符”和翻译的设置列。 */
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"]{
  background:var(--eva-surface)!important;
  color:var(--eva-ink)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] :is(aside,[class*="sidebar"],[class*="Sidebar"],[class*="sidePanel"],[class*="side-panel"]){
  background:color-mix(in srgb,var(--eva-surface) 86%,var(--eva-accent) 4%)!important;
  border-right:1px solid var(--eva-line)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] :is(aside,[class*="sidebar"],[class*="Sidebar"]) :is(h1,h2,h3,label,[class*="title"],[class*="Title"],[class*="label"],[class*="Label"]){
  color:var(--eva-dim)!important;
  font-family:var(--eva-mincho-font)!important;
  letter-spacing:.04em;
}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] :is(input,textarea,select){
  background:var(--eva-panel)!important;
  color:var(--eva-ink)!important;
  border-color:var(--eva-line)!important;
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] button{
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] input[type="checkbox"],
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] input[type="radio"]{accent-color:var(--eva-accent)}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] :is(hr,[class*="divider"],[class*="Divider"]){border-color:var(--eva-line)!important}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] ::-webkit-scrollbar{width:8px;height:8px}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] ::-webkit-scrollbar-thumb{background:var(--eva-line);border:0}
html[data-eva-magi][data-eva-plugin-theme="on"] section[class*="_pane_"] ::-webkit-scrollbar-track{background:transparent}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-conversation-region] :is(aside,[class*="sidebar"],[class*="Sidebar"],[class*="sidePanel"],[class*="side-panel"]){
  position:relative!important;
  background:var(--eva-panel)!important;
  border-right:1px solid var(--eva-accent)!important;
  box-shadow:inset 3px 0 0 var(--eva-accent)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-conversation-region] :is(aside,[class*="sidebar"],[class*="Sidebar"],[class*="sidePanel"],[class*="side-panel"])::before{
  content:"";position:absolute;right:8px;bottom:8px;width:45px;height:11px;z-index:2;pointer-events:none;
  background:repeating-linear-gradient(130deg,var(--eva-secondary) 0 4px,var(--eva-surface) 4px 8px);
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-conversation-region] :is(aside,[class*="sidebar"],[class*="Sidebar"]) :is(h1,h2,h3,label,[class*="title"],[class*="Title"],[class*="label"],[class*="Label"]){
  color:var(--eva-dim)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-conversation-region] :is(aside,[class*="sidebar"],[class*="Sidebar"]) :is(input,textarea,select){
  background:var(--eva-panel)!important;
  color:var(--eva-ink)!important;
  border-color:var(--eva-line)!important;
  border-radius:0!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-conversation-region] :is(aside,[class*="sidebar"],[class*="Sidebar"]) input[type="checkbox"]{accent-color:var(--eva-accent)}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-conversation-region] :is(aside,[class*="sidebar"],[class*="Sidebar"]) button{
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
/* 智能体插件页面实际渲染在 DSH 的 main 插槽里；侧栏是插件自绘的 aside，需在 main 插槽作用域补 EVA 样式。 */
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"],[class*="sidePanel"],[class*="side-panel"]){
  position:relative!important;
  background:var(--eva-panel)!important;
  border-right:1px solid var(--eva-accent)!important;
  box-shadow:inset 3px 0 0 var(--eva-accent)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"])::before{
  content:"";position:absolute;right:8px;bottom:8px;width:45px;height:11px;z-index:2;pointer-events:none;
  background:repeating-linear-gradient(130deg,var(--eva-secondary) 0 4px,var(--eva-surface) 4px 8px);
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"]) :is(h1,h2,h3,label,[class*="title"],[class*="Title"],[class*="label"],[class*="Label"]){
  color:var(--eva-dim)!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"]) :is(input,textarea,select){
  background:var(--eva-panel)!important;
  color:var(--eva-ink)!important;
  border-color:var(--eva-line)!important;
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"]) button{
  border-radius:0!important;
  font-family:var(--eva-mincho-font)!important;
}
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"]) input[type="checkbox"],
html[data-eva-magi][data-eva-plugin-theme="on"] [data-slot="main"] :is(aside,[class*="sidebar"],[class*="Sidebar"]) input[type="radio"]{accent-color:var(--eva-accent)}
/* 左侧边栏里的智能体/插件入口：字体跟随主题。 */
html[data-eva-magi] body [data-slot="sidebar.panellist"] :is(button,[role="button"]){
  font-family:var(--eva-mincho-font)!important;
}

/* ============================================================================
   音声管制：NERV 外部音源终端。
   角色面板、警戒条纹、机械双环；动画仅表示播放状态，不模拟真实频谱。
   曲名、来源和进度均由系统媒体接口提供。停播、后台及减少动态效果时冻结。
   ============================================================================ */
.eva-mp{
  --mp-accent:var(--eva-accent);--mp-ink:var(--eva-ink);--mp-dim:var(--eva-dim);--mp-line:var(--eva-line);--mp-active:var(--eva-mark);
  position:absolute;left:0;top:0;width:${CLOCK_PANEL_WIDTH}px;box-sizing:border-box;
  padding:10px 12px 12px;border:1px solid var(--mp-accent);background:var(--eva-surface);
  color:var(--mp-ink);font-family:ui-monospace,Menlo,monospace;
  box-shadow:0 8px 28px var(--eva-shadow),inset 0 0 24px color-mix(in srgb,var(--eva-accent) 3%,transparent);
  pointer-events:auto;transform:scale(var(--eva-clock-scale,1));transform-origin:0 0;z-index:1;
}
.eva-mp::before{
  content:"";position:absolute;left:-1px;top:-1px;width:4px;height:32px;background:var(--mp-accent);
}
.eva-mp::after{
  content:"";position:absolute;right:4px;bottom:4px;width:10px;height:10px;
  border-right:2px solid var(--mp-accent);border-bottom:2px solid var(--mp-accent);pointer-events:none;
}
.eva-mp-loading{position:absolute;inset:42px 12px 58px;z-index:2;display:none;pointer-events:none;
  background:var(--eva-surface);color:var(--mp-accent);place-content:center;gap:7px;text-align:center;
  border-block:1px solid var(--mp-line);font:700 17px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.2em}
.eva-mp-loading small{font-size:8px;font-weight:400;letter-spacing:.25em}
.eva-mp-loading i{display:block;width:168px;height:4px;background:repeating-linear-gradient(90deg,var(--mp-accent) 0 12px,transparent 12px 15px);transform-origin:left;
  animation:mp-connect-bar .6s steps(9,end) both}
.eva-mp[data-entering="1"] .eva-mp-loading{display:grid;animation:mp-connect .65s linear both}
.eva-mp[data-command] .eva-mp-hazard{animation:mp-command .6s linear infinite;background-size:12px 100%}
@keyframes mp-connect{0%,65%{opacity:1}100%{opacity:0}}
@keyframes mp-connect-bar{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes mp-command{to{background-position:12px 0}}
html[data-eva-music="off"] .eva-mp{display:none}
.eva-mp-head{display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--mp-line)}
.eva-mp-head b{font-size:16px;line-height:1.1;letter-spacing:.18em;color:var(--mp-accent)}
.eva-mp-head small{font-size:8px;letter-spacing:.18em;color:var(--mp-dim)}
.eva-mp-hazard{margin-left:auto;width:45px;height:11px;background:repeating-linear-gradient(130deg,var(--eva-secondary) 0 4px,var(--eva-surface) 4px 8px)}
.eva-mp-source{display:flex;align-items:center;gap:8px;margin-top:7px;min-width:0;
  color:var(--mp-dim);font-size:8px;letter-spacing:.1em}
.eva-mp-source>small{flex:0 0 auto;font-size:8px;color:var(--mp-accent)}
.eva-mp-src{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:215px;font-size:10px;letter-spacing:0}
.eva-mp-name{min-width:0;margin-top:7px}
.eva-mp-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:16px;line-height:1.4;font-weight:700;letter-spacing:.015em;color:var(--mp-ink)}
.eva-mp-artist{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  min-height:15px;color:var(--mp-dim);font-size:10px;line-height:1.5}
.eva-mp-deck{display:grid;grid-template-columns:84px minmax(0,1fr);gap:12px;align-items:center;
  margin:8px 0;padding:7px 0;border-top:1px solid var(--mp-line);border-bottom:1px solid var(--mp-line)}
.eva-mp-rings{position:relative;width:84px;height:84px;overflow:hidden;cursor:pointer;outline:none;user-select:none;
  background:linear-gradient(transparent 49%,color-mix(in srgb,var(--eva-accent) 15%,transparent) 49% 50%,transparent 50%),linear-gradient(90deg,transparent 49%,color-mix(in srgb,var(--eva-accent) 15%,transparent) 49% 50%,transparent 50%)}
.eva-mp-ring{position:absolute;inset:0;display:block;width:84px;height:84px;color:var(--mp-accent);
  animation:mp-spin 18s steps(120) infinite;animation-play-state:paused;transform-origin:50% 50%}
.eva-mp-ring--solid{color:var(--mp-active);animation-duration:11s;animation-direction:reverse}
.eva-mp[data-playing="1"] .eva-mp-ring{animation-play-state:running}
.eva-mp-core{position:absolute;inset:0;width:84px;height:84px;color:var(--mp-accent)}
.eva-mp-core text{fill:var(--mp-ink);font:7px ui-monospace,Menlo,monospace;letter-spacing:1px}
.eva-mp-rings:hover .eva-mp-ring{opacity:1}
.eva-mp-rings[data-on="1"] .eva-mp-core text{fill:var(--mp-active)}
.eva-mp-rings:focus-visible{outline:2px solid var(--mp-active);outline-offset:3px}
.eva-mp-rings[data-on="0"] .eva-mp-ring--open{color:var(--mp-active)}
.eva-mp-rings[data-on="0"] .eva-mp-ring--solid{color:var(--mp-accent)}
@keyframes mp-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.eva-mp-signal{min-width:0;position:relative;overflow:hidden}
.eva-mp-status{display:flex;align-items:center;justify-content:space-between;gap:6px;
  color:var(--mp-accent);font-size:12px;font-weight:700;letter-spacing:.08em}
.eva-mp-status small{font-size:8px;letter-spacing:.14em}
.eva-mp[data-playing="1"] .eva-mp-status{color:var(--mp-active)}
.eva-mp-eq{display:flex;gap:4px;align-items:flex-end;height:31px;margin:8px 0 5px;
  background:repeating-linear-gradient(0deg,color-mix(in srgb,var(--eva-accent) 8%,transparent) 0 1px,transparent 1px 8px)}
.eva-mp-eq i{display:block;flex:1;height:100%;transform:scaleY(.18);transform-origin:50% 100%;
  background:repeating-linear-gradient(0deg,var(--mp-accent) 0 3px,transparent 3px 5px);
  animation:mp-eq 1.4s steps(5,end) infinite alternate;animation-play-state:paused}
.eva-mp-eq i:nth-child(3n){animation-duration:1.1s;animation-delay:-.6s}
.eva-mp-eq i:nth-child(3n+1){animation-duration:1.7s;animation-delay:-1.1s}
.eva-mp-eq i:nth-child(even){animation-direction:alternate-reverse}
.eva-mp[data-playing="1"] .eva-mp-eq i{animation-play-state:running}
.eva-mp-signal>small{display:block;color:var(--mp-dim);font-size:7px;letter-spacing:.1em}
@keyframes mp-eq{0%{transform:scaleY(.18)}35%{transform:scaleY(.65)}70%{transform:scaleY(.4)}100%{transform:scaleY(1)}}
.eva-mp-times{display:flex;align-items:baseline;justify-content:space-between;font-variant-numeric:tabular-nums}
.eva-mp-times>span{display:flex;align-items:baseline;gap:6px}
.eva-mp-times small{font-size:7px;letter-spacing:.08em;color:var(--mp-dim)}
.eva-mp-times b{font-size:15px;font-weight:500;line-height:1.2}
.eva-mp-cur{color:var(--mp-accent)}
.eva-mp-tot{color:var(--mp-dim)}
.eva-mp-bar{position:relative;height:6px;margin:5px 0 10px;background:color-mix(in srgb,var(--eva-accent) 11%,transparent);overflow:hidden}
.eva-mp-bar::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 11px,var(--eva-surface) 11px 13px);pointer-events:none}
.eva-mp-bar i{display:block;height:100%;width:0;background:var(--mp-accent);transition:width .35s linear}
.eva-mp-btns{display:grid;grid-template-columns:1fr 1.45fr 1fr;gap:5px}
.eva-mp-btn{min-width:0;height:36px;padding:0 4px;cursor:pointer;background:color-mix(in srgb,var(--eva-accent) 3%,transparent);
  border:1px solid var(--mp-line);color:var(--mp-accent);font:700 9px ui-monospace,Menlo,monospace;letter-spacing:.05em;
  display:flex;align-items:center;justify-content:center;gap:6px;transition:background-color .15s,color .15s}
.eva-mp-btn svg{width:15px;height:15px;flex:0 0 auto;fill:currentColor}
.eva-mp-btn[data-act="play"]{border-color:var(--mp-accent);background:var(--mp-accent);color:var(--eva-on-accent)}
.eva-mp-btn:disabled{opacity:.45;cursor:default}
.eva-mp-btn:not(:disabled):hover{background:color-mix(in srgb,var(--eva-accent) 15%,transparent);border-color:var(--mp-accent);color:var(--mp-ink)}
.eva-mp-btn[data-act="play"]:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover);color:var(--eva-on-accent)}
.eva-mp-btn:not(:disabled):active{transform:translateY(1px)}
.eva-mp-btn:focus-visible{outline:2px solid var(--mp-active);outline-offset:2px}
.eva-mp-ico-pause{display:none}
.eva-mp[data-playing="1"] .eva-mp-ico-pause{display:block}
.eva-mp[data-playing="1"] .eva-mp-ico-play{display:none}
/* 只读来源（网易云桌面版）：没有系统媒体会话，隐藏进度与控制按钮。 */
.eva-mp[data-readonly="1"] :is(.eva-mp-btns,.eva-mp-bar,.eva-mp-times){display:none}
/* 无时长的来源（网易云兜底）：隐藏进度与时间，保留控制按钮。 */
.eva-mp[data-untimed="1"] :is(.eva-mp-bar,.eva-mp-times){display:none}
.eva-mp-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:7px 0 0;padding:0 0 3px;border-bottom:1px solid var(--mp-line)}
.eva-mp-tabs[hidden],.eva-mp-extras[hidden]{display:none!important}
.eva-mp-tab{max-width:100%;padding:2px 6px;cursor:pointer;background:transparent;border:1px solid var(--mp-line);color:var(--mp-dim);font:8px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.eva-mp-tab[data-on="1"]{border-color:var(--mp-accent);background:var(--mp-accent);color:var(--eva-on-accent)}
.eva-mp-tab:not([data-on="1"]):hover{border-color:var(--mp-accent);color:var(--mp-ink)}
.eva-mp-extras{--mp-accent:var(--eva-accent);--mp-ink:var(--eva-ink);--mp-dim:var(--eva-dim);--mp-line:var(--eva-line);--mp-active:var(--eva-mark);position:absolute;left:0;top:0;display:flex;flex-direction:column;gap:6px;width:${CLOCK_PANEL_WIDTH}px;transform:scale(var(--eva-clock-scale,1));transform-origin:0 0;pointer-events:none;z-index:1;font-family:ui-monospace,Menlo,monospace}
.eva-mp-extra{display:flex;align-items:center;gap:7px;min-width:0;padding:5px 7px;border:1px solid var(--mp-line);background:color-mix(in srgb,var(--eva-surface) 92%,transparent);pointer-events:auto}
.eva-mp-extra small{flex:0 0 auto;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mp-accent);font-size:8px;letter-spacing:.06em}
.eva-mp-extra b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mp-ink);font-size:10px;font-weight:500}
.eva-mp-extra button{flex:0 0 auto;height:24px;padding:0 8px;cursor:pointer;border:1px solid var(--mp-accent);background:var(--mp-accent);color:var(--eva-on-accent);font:8px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em}
.eva-mp-extra button:hover{background:color-mix(in srgb,var(--mp-accent) 80%,#fff)}
.eva-mp[data-spectrum="1"] .eva-mp-eq i{animation:none!important}

/* ============================================================================
   時刻管制：与音声管制共用当前角色的面板与硬边规格。
   七段显示直接读取系统时间，秒刻度每秒推进，不表示网络校时状态。
   日期、本地 UTC 偏移、UTC 时刻独立排版；底部仅显示实际解码状态。
   ============================================================================ */
.eva-clockpanel{
  --cp-accent:var(--eva-accent);--cp-ink:var(--eva-accent);--cp-dim:var(--eva-dim);--cp-line:var(--eva-line);--cp-active:var(--eva-mark);
  position:absolute;left:0;top:0;width:${CLOCK_PANEL_WIDTH}px;box-sizing:border-box;padding:10px 12px 12px;
  background:var(--eva-surface);border:1px solid var(--cp-accent);color:var(--cp-ink);
  box-shadow:0 8px 28px var(--eva-shadow),inset 0 0 24px color-mix(in srgb,var(--eva-accent) 3%,transparent);
  font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;z-index:0;
  transform:scale(var(--eva-clock-scale,1));transform-origin:0 0;
}
.eva-clockpanel::before{content:"";position:absolute;left:-1px;top:-1px;width:4px;height:32px;background:var(--cp-accent)}
.eva-clockpanel::after{content:"";position:absolute;right:4px;bottom:4px;width:10px;height:10px;
  border-right:2px solid var(--cp-accent);border-bottom:2px solid var(--cp-accent)}
html[data-eva-clock="off"] .eva-clockpanel{display:none}
.eva-cp-top{display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--cp-line)}
.eva-cp-top b{font-size:16px;line-height:1.1;letter-spacing:.18em;color:var(--cp-accent)}
.eva-cp-top small{font-size:8px;letter-spacing:.16em;color:var(--cp-dim)}
.eva-cp-top i{margin-left:auto;width:45px;height:11px;background:repeating-linear-gradient(130deg,var(--eva-secondary) 0 4px,var(--eva-surface) 4px 8px)}
.eva-cp-mode{display:flex;align-items:center;justify-content:space-between;margin-top:8px;
  color:var(--cp-dim);font-size:8px;line-height:1;letter-spacing:.12em}
.eva-cp-mode>span:last-child{color:var(--cp-active)}
.eva-cp-main{padding:10px 0 9px;border-bottom:1px solid var(--cp-line)}
.eva-cp-digits{display:flex;align-items:flex-end;justify-content:center;gap:8px}
.eva-cp-pair>small{display:block;margin-bottom:5px;text-align:center;color:var(--cp-dim);font-size:7px;letter-spacing:.16em;line-height:1}
.eva-cp-number{display:flex;align-items:flex-end;gap:5px}
.eva-cp-dg{display:block;height:58px;width:34px}
.eva-cp-dg use{stroke:var(--eva-surface);stroke-width:.35;stroke-linejoin:round}
.eva-cp-ghost{fill:var(--eva-ghost)}
.eva-cp-lit{fill:var(--cp-ink)}
.eva-cp-pair--seconds .eva-cp-dg{height:44px;width:26px}
.eva-cp-pair--seconds .eva-cp-lit{fill:var(--cp-accent)}
.eva-cp-cl{display:block;width:8px;height:58px;fill:var(--cp-accent)}
.eva-cp-cl--seconds{height:44px;opacity:.75}
.eva-cp-side{display:grid;grid-template-columns:1.22fr 1fr 1fr;gap:7px;margin-top:9px}
.eva-cp-block{min-width:0;padding:1px 0 2px 7px;border-left:1px solid var(--cp-line);overflow:hidden}
.eva-cp-block small{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:5px;
  color:var(--cp-dim);font-size:7px;line-height:1;letter-spacing:.05em;white-space:nowrap}
.eva-cp-weekday{font:inherit;color:var(--cp-accent)}
.eva-cp-block>b{display:block;font-size:12px;font-weight:500;line-height:1.2;color:var(--cp-ink);white-space:nowrap}
.eva-cp-block .eva-cp-tz{font-size:11px}
.eva-cp-block .eva-cp-utc{color:var(--cp-active)}
.eva-cp-second-head{display:flex;justify-content:space-between;align-items:center;margin-top:10px;
  color:var(--cp-dim);font-size:7px;line-height:1;letter-spacing:.08em}
.eva-cp-second-head b{color:var(--cp-accent);font-weight:400}
.eva-cp-second-track{position:relative;height:4px;margin-top:5px;overflow:hidden;background:color-mix(in srgb,var(--eva-accent) 11%,transparent)}
.eva-cp-second-track i{display:block;width:0;height:100%;background:var(--cp-accent)}
.eva-cp-second-track::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(100% / 60 - 2px),var(--eva-surface) calc(100% / 60 - 2px) calc(100% / 60))}
.eva-cp-decode{display:flex;align-items:center;gap:9px;margin-top:9px;padding-top:7px;border-top:1px solid var(--cp-line)}
.eva-cp-decode>small{font-size:7px;line-height:1.5;letter-spacing:.08em;color:var(--cp-dim);flex:0 0 auto}
.eva-cp-lamps{display:flex;gap:3px;flex:1;min-width:0}
.eva-cp-lamps span{flex:1;text-align:center;font-size:7px;line-height:1;font-weight:500;letter-spacing:.05em;
  padding:4px 0;border:1px solid var(--eva-hair);color:var(--eva-dim)}
.eva-cp-lamps span[data-on="1"]{background:color-mix(in srgb,var(--eva-accent) 10%,transparent);border-color:var(--cp-accent);color:var(--cp-accent)}
.eva-cp-lamps span:nth-child(1)[data-on="1"]{border-color:var(--eva-dim);background:color-mix(in srgb,var(--eva-dim) 8%,transparent);color:var(--cp-dim)}
.eva-cp-lamps span:nth-child(4)[data-on="1"]{border-color:var(--cp-active);background:color-mix(in srgb,var(--eva-mark) 8%,transparent);color:var(--cp-active)}

/* 时钟小字独立字号：日期 / 时区 / 秒刻 / 解码状态等，只放大这些说明文字，
   不改变七段数字的尺寸。倍率由 --eva-clock-text-scale 控制（设置面板「时钟小字」）。 */
.eva-cp-top small{font-size:calc(8px * var(--eva-clock-text-scale,1))}
.eva-cp-mode{font-size:calc(8px * var(--eva-clock-text-scale,1))}
.eva-cp-pair>small{font-size:calc(7px * var(--eva-clock-text-scale,1))}
.eva-cp-block small{font-size:calc(7px * var(--eva-clock-text-scale,1))}
.eva-cp-block>b{font-size:calc(12px * var(--eva-clock-text-scale,1))}
.eva-cp-block .eva-cp-tz{font-size:calc(11px * var(--eva-clock-text-scale,1))}
.eva-cp-second-head{font-size:calc(7px * var(--eva-clock-text-scale,1))}
.eva-cp-decode>small{font-size:calc(7px * var(--eva-clock-text-scale,1))}
.eva-cp-lamps span{font-size:calc(7px * var(--eva-clock-text-scale,1))}

/* 输入框与 portal 菜单：全模式角色配色，只修改绘制属性，保持宿主尺寸。 */
/* 输入区外层横跨整个会话宽度；清除宿主铺底渐变与区域阴影，避免卡片两侧出现色块。 */
html[data-eva-magi] body [data-composer-seat],
html[data-eva-magi] body [data-conversation-region="composer"]{
  background:none;box-shadow:none;
}
html[data-eva-magi] body [data-composer-card]{
  background-color:var(--eva-control);
  /* 右缘红黑危险条纹：卡片右端到发送按钮之间还有约 17px 空档，画条带进去。
     带宽 5px —— 与权限块、侧栏两条统一（原来这里是 6px，是唯一不一致的一条）。 */
  background-image:repeating-linear-gradient(45deg,var(--eva-secondary) 0 3px,rgba(0,0,0,0) 3px 6px);
  background-size:5px 100%;
  background-position:right center;
  background-repeat:no-repeat;
  box-shadow:inset 0 0 0 1px var(--eva-accent),
    inset 0 0 34px color-mix(in srgb,var(--eva-accent) 5%,transparent);
  transition:box-shadow .18s ease;
}
html[data-eva-magi] body [data-composer-card]:focus-within{
  box-shadow:inset 0 0 0 1px var(--eva-accent),
    inset 0 0 34px color-mix(in srgb,var(--eva-accent) 9%,transparent),
    0 0 22px color-mix(in srgb,var(--eva-accent) 20%,transparent);
}
/* 正文使用阅读色，光标使用角色主色。 */
html[data-eva-magi] body [data-composer-input]{
  color:var(--eva-ink);
  caret-color:var(--eva-accent);
  text-shadow:none;
}
/* 占位符使用可读的次级色。 */
html[data-eva-magi] body ${HOST_HOOKS.placeholder},
html[data-eva-magi] body ${HOST_HOOKS.placeholder} *{
  color:var(--eva-dim);
}
/* 附件按钮共用角色面板。 */
html[data-eva-magi] body ${HOST_HOOKS.add}{
  background-color:var(--eva-control);
  color:var(--eva-accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--eva-accent) 70%,transparent);
}
/* 发送按钮的反白文字随主题极性切换。 */
html[data-eva-magi] body ${HOST_HOOKS.send}{
  background-color:var(--eva-accent);
  color:var(--eva-on-accent);
  box-shadow:inset 0 0 0 1px var(--eva-accent), 0 0 14px color-mix(in srgb,var(--eva-accent) 30%,transparent);
}
html[data-eva-magi] body ${HOST_HOOKS.send}:hover{background-color:var(--dsw-alias-button-primary-hover)}

/* ---- 弹出菜单（模型 / 推理等级 / 权限 …）----
   钩子是 role="menu" + data-menu-material（语义 + 官方属性；正文里的菜单共用，
   对一套皮肤来说正好统一）。菜单里的「标签 / 值」读数行照参考图 CODE : 258 的排法：
   标签使用角色主色、数值使用次级阅读色。 */
/* ⚠️ 选择器里带上 [data-menu-material] 是**必须的**：
   本项目更靠后还有一条 :is([role=dialog],[role=menu],[role=listbox]) 的弹层描边规则，
   它与 [role=menu] 那条**特异性完全相同**（都是 0,2,1），靠源码顺序它会赢 ——
   实测菜单描边被染成橙色 rgb(255,106,0)。加上这个官方属性后特异性升到 0,3,1，
   与源码顺序无关地稳定生效。
   （注意：本段 CSS 是 JS 模板字符串，注释里不能出现反引号，否则会提前截断字符串。） */
html[data-eva-magi] body [role="menu"][data-menu-material]{
  background-color:var(--eva-control);
  box-shadow:inset 0 0 0 1px var(--eva-accent),
    0 10px 30px var(--eva-shadow),
    0 0 18px color-mix(in srgb,var(--eva-accent) 16%,transparent);
  color:var(--eva-accent);
}
html[data-eva-magi] body [role="menu"][data-menu-material] [class*="_cellLabel"]{
  color:var(--eva-accent);font-weight:700;letter-spacing:.08em;
}
html[data-eva-magi] body [role="menu"][data-menu-material] [class*="_cellValue"]{
  color:var(--eva-dim);
  font-family:ui-monospace,Menlo,monospace;letter-spacing:.04em;
}
html[data-eva-magi] body [role="menu"][data-menu-material] [role="menuitem"]:hover,
html[data-eva-magi] body [role="menu"][data-menu-material] [role="option"]:hover,
html[data-eva-magi] body [role="menu"][data-menu-material] button:hover{
  background-color:color-mix(in srgb,var(--eva-accent) 14%,transparent);color:var(--eva-accent);
}
/* 右侧栏 / 停靠面板：刻意不加描边。
   踩过的坑：早先这里给 [data-sidebar-right-panel] 加了 inset 1px 环，那个面板却是
   全高透明层（x 从屏幕正中到右缘、y 全高），于是它的左边在屏幕正中画出一条竖线、
   上边在顶端画出一条横线，拼成一个毫无意义的 L 形——用户的评价就是「多余的」。
   教训：装饰只能画在真的会绘制出来的表面上。 */
/* 按钮：加字距，悬停时内描一圈橙 —— 不设背景，避免盖掉应用的状态色 */
html[data-eva-magi] button{letter-spacing:.08em}
html[data-eva-magi] button:hover{
  box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l4);
}
/* 键帽：老终端的实体键 */
html[data-eva-magi] kbd{
  padding:1px 5px;border:1px solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-layer-3);
  box-shadow:0 1px 0 var(--dsw-alias-border-l2);
}
/* 滚动条：细橙条，像仪表刻度 */
html[data-eva-magi] ::-webkit-scrollbar{width:10px;height:10px}
html[data-eva-magi] ::-webkit-scrollbar-track{background:transparent}
html[data-eva-magi] ::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-scrollbar-bg-l1);border:0;
  border-left:1px solid var(--dsw-alias-border-l2);
}
html[data-eva-magi] ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1)}
html[data-eva-magi] ::-webkit-scrollbar-corner{background:transparent}
/* 分隔线变危险条纹 */
html[data-eva-magi] hr{
  border:0;height:5px;opacity:.4;
  background:repeating-linear-gradient(45deg,
    var(--eva-secondary) 0 5px,rgba(0,0,0,0) 5px 10px);
}
/* DSH 的「已完成，用时」是任务过程按钮，底部是 border，不是 hr。
   使用稳定属性挂钩；警戒带画在现有底部留白内，不改高度或折叠行为。 */
html[data-eva-magi] ${HOST_HOOKS.turnProcess}{
  border-bottom-color:transparent;
  background-image:repeating-linear-gradient(45deg,
    color-mix(in srgb,var(--eva-secondary) 40%,transparent) 0 5px,transparent 5px 10px);
  background-position:left bottom;background-size:100% 5px;background-repeat:no-repeat;
}
/* 代码块左侧主色竖线 */
html[data-eva-magi] pre{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
/* 浮层：橙色外环 + 冷光 */
html[data-eva-magi] :is([role="dialog"],[role="menu"],[role="listbox"]){
  box-shadow:0 0 0 1px var(--dsw-alias-brand-primary),
    0 0 30px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);
}
/* 焦点环统一走主色（focus.css 的兜底色是 state-business-primary，这里显式固定） */
html[data-eva-magi] :focus-visible{--dsw-focus-ring-color:var(--dsw-alias-brand-primary)}

/* ============================================================================
   2b. 追加的结构元素：雷达环 / 角编号 / 色散 / 扫描高光
   ============================================================================ */

/* 角色底纹：明日香的双斜切／绫波丽的细环，中心留给会话内容。 */
.eva-emg{position:absolute;inset:0;z-index:0;opacity:var(--eva-wallpaper-strength,.5);pointer-events:none;overflow:hidden;contain:paint}
html[data-eva-wallpaper="off"] .eva-emg{display:none}
html[data-eva-low-power="on"] .eva-edge::after,
html[data-eva-low-power="on"] .eva-tag--state,
html[data-eva-low-power="on"] .eva-mp-hazard{animation:none!important}
html[data-eva-low-power="on"] .eva-cp-number,
html[data-eva-low-power="on"] .eva-cp-cl{filter:none!important}
.eva-character-art{position:absolute;right:-100px;top:18%;width:min(52vw,680px);aspect-ratio:1;color:var(--eva-accent);opacity:.17}
.eva-character-art svg{display:block;width:100%;height:100%;overflow:visible}
.eva-character-art text{font:700 210px/1 ui-monospace,Menlo,monospace;letter-spacing:-18px;fill:currentColor;stroke:none}
.eva-character-art .eva-art-label{font:500 10px/1 ui-monospace,Menlo,monospace;letter-spacing:2.2px}
.eva-character-art .eva-art-micro{font:400 7px/1 ui-monospace,Menlo,monospace;letter-spacing:1.3px;opacity:.8}
.eva-character-art .eva-art-fine{stroke-width:1;opacity:.7}
.eva-character-art .eva-art-panel{fill:currentColor;fill-opacity:.06;stroke:none}
.eva-character-art .eva-art-detail{color:var(--eva-mark)}
.eva-character-art--asuka .eva-art-detail{color:var(--eva-secondary)}
.eva-character-art--rei{display:none}
body:not([data-ds-dark-theme]) .eva-character-art--asuka{display:none}
body:not([data-ds-dark-theme]) .eva-character-art--rei{display:block;opacity:.19}
/* 左侧半身线稿：外层轻羽化，内层使用透明 PNG 轮廓作为角色色蒙版。
   与现有背景共用开关和强度；不产生点击区域，不修改宿主正文排版。 */
.eva-character-portrait{position:absolute;left:var(--eva-portrait-left,24px);top:var(--eva-portrait-top,100px);
  width:var(--eva-portrait-width,280px);height:var(--eva-portrait-height,420px);
  color:var(--eva-accent);opacity:.52;pointer-events:none;overflow:hidden;
  mask-image:linear-gradient(90deg,transparent,#000 8%,#000 74%,transparent)}
.eva-character-portrait::before{content:"";position:absolute;inset:0;background:currentColor;
  -webkit-mask:url("${BRAND_ASSETS.asukaPortrait}") center top/contain no-repeat;
  mask:url("${BRAND_ASSETS.asukaPortrait}") center top/contain no-repeat;
  /* 对齐腰部轮廓，消除原图下方透明留白：明日香 50/1536，绫波丽 14/1536。 */
  transform:translateY(3.2552083333%)}
body:not([data-ds-dark-theme]) .eva-character-portrait{opacity:.48}
body:not([data-ds-dark-theme]) .eva-character-portrait::before{
  -webkit-mask-image:url("${BRAND_ASSETS.reiPortrait}");mask-image:url("${BRAND_ASSETS.reiPortrait}");
  transform:translateY(.9114583333%)}
@media(max-width:640px){.eva-character-portrait{opacity:.3}
  body:not([data-ds-dark-theme]) .eva-character-portrait{opacity:.26}}
.eva-character-caption{position:absolute;left:24px;top:43%;writing-mode:vertical-rl;
  color:var(--eva-accent);opacity:.22;font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:.38em}
body[data-ds-dark-theme] .eva-character-caption{color:var(--eva-secondary)}
@media (prefers-reduced-motion:reduce){
  .${OVERLAY_CLASS} *, .${OVERLAY_CLASS} *::before, .${OVERLAY_CLASS} *::after, .eva-boot, .eva-boot *{animation:none!important;transition:none!important}
}
/* 四角编号：EVA 屏幕上到处是这种规格码（设施编号 / 机体番号 / 模式码）。
   刻意压在 top:52px 而不是顶角 —— 顶栏两端分别是应用自己的徽标与侧栏折叠按钮，
   第一版把编号放顶角时正好压在徽标上。 */
.eva-id{
  position:absolute;font:9px/1 ui-monospace,Menlo,monospace;
  letter-spacing:.2em;color:var(--eva-accent);opacity:.55;padding:4px 6px;
}
.eva-id.tl{left:6px;top:52px}
.eva-id.tr{right:6px;top:52px}

/* CRT 色散：红/青两条线相对偏移 1px，模仿显像管的三枪不重合。
   只作用在内嵌框架上，所以不会让正文发虚。 */
.eva-frame::before,.eva-frame::after{
  content:"";position:absolute;inset:-3px;border:1px solid;opacity:.3;
}
.eva-frame::before{border-color:var(--eva-secondary);transform:translate(-1px,-1px)}
.eva-frame::after{border-color:var(--eva-mark);transform:translate(1px,1px)}

/* 刻度尺上的扫描高光：像游标量规在滑 */
.eva-edge{overflow:hidden}
.eva-edge::after{
  content:"";position:absolute;left:0;right:0;height:70px;opacity:.28;
  top:0;background:linear-gradient(to bottom,rgba(0,0,0,0),var(--eva-accent),rgba(0,0,0,0));
  will-change:transform;animation:eva-ruler 6.5s linear infinite;
}
.eva-edge.r::after{animation-duration:7.8s;animation-delay:-2.5s}
@keyframes eva-ruler{0%{transform:translateY(-70px)}100%{transform:translateY(100vh)}}

/* GIF → NERV 警报 → 黑底打字引导 → 全屏驾驶员认证舱 → 音声同步 → 聊天交接。 */
.eva-boot{${bootThemeCSS("asuka", "boot")}--sync-progress:0;
  position:fixed;inset:0;z-index:2147483100;pointer-events:auto;
  display:grid;place-items:center;overflow:hidden;background:#000101;color:var(--boot-ink);
  font-family:ui-monospace,Menlo,monospace;isolation:isolate}
.eva-boot[data-pilot="rei"]{${bootThemeCSS("rei", "boot")}}
/* The macOS host subtracts body-level overlays from window drag regions.
   Keep the boot background draggable, with the whole card-to-plug path interactive. */
html[data-platform="darwin"] .eva-boot{-webkit-app-region:drag}
html[data-platform="darwin"] .eva-boot :where(.eva-boot-grid,.eva-entry-bay,a,button,input,select,textarea,summary,
  [contenteditable="true"],[tabindex],[role="button"],[role="link"],[role="tab"],[role="option"],
  [role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="combobox"],[role="textbox"],
  [role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="listbox"],
  [role="dialog"],[role="alertdialog"],[role="tooltip"]){-webkit-app-region:no-drag}
.eva-boot *, .eva-boot *::before, .eva-boot *::after{box-sizing:border-box}
.eva-boot:is([data-phase="select"],[data-phase="loading"]){transition:background-color .65s cubic-bezier(.2,.7,.2,1),color .65s ease}
.eva-boot:is([data-phase="select"],[data-phase="loading"]) :is(.eva-boot-console,.eva-boot-title,.eva-boot-kicker,.eva-boot-kicker small,.eva-boot-hint,.eva-boot-header,.eva-boot-security,.eva-boot-security b,.eva-boot-exit,.eva-boot-resume,.eva-boot-sound,.eva-nerv-logo,.eva-entry-bay,.eva-entry-label,.eva-entry-label b,.eva-entry-spec,.eva-entry-spec b,.eva-entry-lock,.eva-entry-target,.eva-entry-machine,.eva-entry-window,.eva-entry-plug *,.eva-boot-footer,.eva-boot-status,.eva-boot-loading,.eva-boot-loading h2,.eva-boot-loading p,.eva-boot-code,.eva-sync-portrait,.eva-sync-orbit,.eva-sync-systems,.eva-sync-systems b,.eva-boot-meter,.eva-boot-meter i,.eva-boot-progress-label,.eva-boot-progress-label time,.eva-sync-caption,.eva-boot-magi,.eva-boot-magi span,.eva-boot-magi i){transition:color .65s ease,background-color .65s ease,border-color .65s ease,fill .65s ease,stroke .65s ease,box-shadow .65s ease}
.eva-boot-theme-sweep{position:absolute;inset:0;z-index:2;pointer-events:none;background:linear-gradient(105deg,transparent 35%,color-mix(in srgb,var(--boot-accent) 7%,transparent) 49%,color-mix(in srgb,var(--boot-accent) 22%,transparent) 50%,transparent 51%);animation:eva-theme-sweep .7s cubic-bezier(.2,.6,.2,1) both}
@keyframes eva-theme-sweep{from{transform:translateX(-100%);opacity:0}15%,65%{opacity:1}to{transform:translateX(100%);opacity:0}}
.eva-boot[data-phase="loading"] .eva-boot-loading{animation:eva-sync-reveal .5s ease-out both}
@keyframes eva-sync-reveal{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.eva-boot [hidden]{display:none!important}
.eva-boot-gif{display:block;width:min(512px,calc(100vw - 24px),calc(100dvh - 24px));
  height:auto;aspect-ratio:1;object-fit:contain;image-rendering:auto}
.eva-boot:not([data-phase="gif"]){display:block;background:var(--boot-surface)}
.eva-boot[data-phase="emergency"]{background:#000}
.eva-emergency{position:absolute;inset:0;overflow:hidden;background:#000;pointer-events:none}
.eva-emergency>svg{display:block;width:100%;height:100%;animation:eva-alert-sequence 3s ease-in-out both}
.eva-emergency .eva-alert-cell{animation:eva-alert-cell 1.25s ease-in-out infinite;animation-delay:var(--alert-lag,0s)}
@keyframes eva-alert-sequence{0%{opacity:0}10%{opacity:.96}28%{opacity:.42}45%{opacity:.98}62%{opacity:.3}78%{opacity:.96}91%{opacity:.68}100%{opacity:0}}
@keyframes eva-alert-cell{0%,100%{opacity:1}50%{opacity:.24}}
.eva-emergency-next{position:absolute;right:24px;top:24px;border:1px solid #86191c;border-radius:0;padding:9px 12px;background:#080101;color:#ec6a6d;cursor:pointer;font:10px/1.5 ui-monospace,Menlo,monospace}
.eva-boot-backdrop{position:absolute;inset:0;overflow:hidden;pointer-events:none;
  background:radial-gradient(ellipse at 20% 35%,#d56c1810,transparent 65%),radial-gradient(ellipse at 90% 100%,#ef7d2112,transparent 55%)}
.eva-boot-contours{position:absolute;inset:0;width:100%;height:100%;color:#f49344;opacity:.65}
.eva-boot-watermark{position:absolute;right:-.035em;bottom:-.13em;color:#f49344;opacity:.035;font:800 clamp(260px,48vw,900px)/1 ui-monospace,Menlo,monospace;letter-spacing:-.1em}
.eva-boot-rail{position:absolute;top:30%;bottom:12%;width:10px;opacity:.5;background:repeating-linear-gradient(0deg,#f49344 0 1px,transparent 1px 24px)}
.eva-boot-rail.left{left:10px}.eva-boot-rail.right{right:10px}
.eva-boot-console{position:relative;z-index:1;width:100%;height:100%;height:100dvh;margin:0;
  padding:clamp(16px,3dvh,38px) clamp(24px,3.5vw,72px) clamp(12px,2dvh,24px);
  display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:clamp(14px,2.5dvh,30px);min-height:0}
.eva-boot-header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-top:2px solid var(--boot-accent);padding-top:16px}
.eva-boot-heading{min-width:0}.eva-boot-brand{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.eva-boot-brand .eva-nerv-logo{width:24px;height:28px}
html[data-eva-magi] .eva-boot .eva-nerv-logo{background:var(--boot-accent)}
.eva-boot-kicker{margin:0;color:var(--boot-accent);font:10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.22em}
.eva-boot-kicker small{display:block;color:var(--boot-dim);font-size:8px;letter-spacing:.16em}
.eva-boot-title{margin:0;font:500 clamp(26px,3.2vw,54px)/1.3 var(--eva-pilot-font);letter-spacing:.13em;color:var(--boot-ink);font-synthesis:none;-webkit-text-stroke:0}
html[data-eva-magi] .eva-boot-title{-webkit-text-stroke:0}
.eva-boot-hint{margin:10px 0 0;color:var(--boot-dim);font:11px/1.6 ui-monospace,Menlo,monospace}
.eva-boot-header-side{display:flex;flex-direction:column;gap:10px;align-items:flex-end;text-align:right;flex-shrink:0}
.eva-boot-actions{display:flex;align-items:center;gap:10px}
.eva-boot-languages{display:flex;gap:2px;padding:3px;border:1px solid #774820;background:#100d09cc}
.eva-boot-languages button{border:1px solid transparent;border-radius:0;padding:5px 7px;background:transparent;color:#b8a692;cursor:pointer;font:10px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap}
.eva-boot-languages button[aria-pressed="true"]{color:#ffbe82;background:#f493441a;border-color:#a45d2b}
.eva-boot-languages button:hover{color:#ffe2c6}
.eva-boot-security{color:var(--boot-dim);font:9px/1.7 ui-monospace,Menlo,monospace;letter-spacing:.13em}
.eva-boot-security b{display:block;color:var(--boot-accent);font-weight:400}
.eva-boot-exit,.eva-boot-resume{flex:0 0 auto;border:1px solid var(--boot-line);border-radius:0;padding:10px 13px;background:var(--boot-surface);color:var(--boot-ink);cursor:pointer;font:11px/1.4 ui-monospace,Menlo,monospace}
.eva-boot button:focus-visible{outline:2px solid var(--boot-accent);outline-offset:4px}
.eva-boot-exit:hover,.eva-boot-resume:hover{border-color:var(--boot-accent);color:var(--boot-accent)}
.eva-boot-sound{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;padding:7px;border:1px solid var(--boot-line);border-radius:0;background:var(--boot-surface);color:var(--boot-accent);cursor:pointer}
.eva-boot-sound svg{width:18px;height:18px}.eva-boot-sound[aria-pressed="true"] .eva-sound-slash{display:none}
.eva-boot:is([data-phase="gif"],[data-phase="emergency"]) .eva-boot-sound{position:absolute;right:24px;bottom:24px;color:#d1d9dc;border-color:#37464b;background:#000101}
.eva-boot[data-phase="emergency"] .eva-boot-sound{color:#ec6a6d;border-color:#86191c;background:#080101}
.eva-boot[data-phase="intro"]{background:#000101}
.eva-boot[data-phase="intro"] .eva-boot-sound{position:absolute;right:24px;bottom:24px;color:#d1d9dc;border-color:#37464b;background:#000101;z-index:6}
.eva-boot-intro{position:absolute;inset:0;z-index:5;display:grid;place-items:center;overflow:hidden;background:#000101;color:#e5e9e7;clip-path:inset(0);isolation:isolate}
.eva-intro-copy{position:relative;z-index:1;max-width:calc(100% - 40px);text-align:center;animation:eva-intro-copy-in .45s ease-out both}
.eva-intro-kicker{margin:0 0 24px;color:#81908f;font:10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.28em}
.eva-intro-title{position:relative;width:max-content;max-width:100%;margin:0 auto;color:#e5e9e7;font:500 clamp(26px,4vw,62px)/1.5 var(--eva-pilot-font);letter-spacing:.12em;white-space:pre;font-synthesis:none;-webkit-text-stroke:0}
html[data-eva-magi] .eva-intro-title{font-family:var(--eva-pilot-font);letter-spacing:.12em;-webkit-text-stroke:0}
.eva-boot[lang="en"] .eva-intro-title{letter-spacing:.025em;font-size:clamp(24px,3.8vw,58px)}
.eva-intro-measure{visibility:hidden}.eva-intro-typed{position:absolute;left:0;top:0}
.eva-intro-typed::after{content:"";display:inline-block;width:2px;height:.85em;margin-left:.12em;background:#cbd9d8;vertical-align:-.03em;animation:eva-intro-caret .72s steps(1,end) infinite}
.eva-intro-rule{display:block;width:90px;height:1px;margin:30px auto 0;background:linear-gradient(90deg,${BOOT_THEMES.asuka.accent} 0 48%,transparent 48% 52%,${BOOT_THEMES.rei.accent} 52%);transform-origin:center;animation:eva-intro-rule-in .7s ease-out both}
.eva-intro-pilot{position:absolute;top:50%;width:clamp(80px,12vw,160px);transform:translateY(-50%);text-align:center;color:var(--intro-pilot);pointer-events:none;animation:eva-intro-pilot-in 1s ease-out both}
.eva-intro-pilot[data-pilot="asuka"]{--intro-pilot:${BOOT_THEMES.asuka.accent};--intro-head:url("${BRAND_ASSETS.asukaHead}");left:7vw}
.eva-intro-pilot[data-pilot="rei"]{--intro-pilot:${BOOT_THEMES.rei.accent};--intro-head:url("${BRAND_ASSETS.reiHead}");right:7vw}
.eva-intro-face{display:block;width:100%;aspect-ratio:1/1.2;background:currentColor;mask:var(--intro-head) center/contain no-repeat;opacity:.3}
.eva-intro-pilot b{display:block;margin-top:12px;font:400 23px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.1em;opacity:.8}
.eva-intro-pilot small{display:block;margin-top:8px;color:#81908f;font:8px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.13em}
.eva-intro-next{position:absolute;right:24px;top:24px;padding:9px 12px;border:1px solid #37464b;border-radius:0;background:#000101;color:#aabbbd;cursor:pointer;font:10px/1.5 ui-monospace,Menlo,monospace}
.eva-intro-next:hover{color:#e5e9e7;border-color:#81908f}
.eva-boot-intro[data-leaving]{animation:eva-intro-dissolve .82s ease-out both;pointer-events:none}
.eva-boot-intro[data-leaving] .eva-intro-copy{visibility:hidden;animation:none}
.eva-intro-flight{position:fixed;z-index:7;margin:0;pointer-events:none;white-space:pre;transform-origin:0 0;font-synthesis:none;-webkit-text-stroke:0}
.eva-boot[data-arriving] .eva-boot-title{visibility:hidden}
@keyframes eva-intro-copy-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes eva-intro-pilot-in{from{opacity:0}to{opacity:1}}
@keyframes eva-intro-rule-in{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes eva-intro-caret{0%,100%{opacity:1}50%{opacity:0}}
@keyframes eva-intro-dissolve{from{opacity:1}to{opacity:0}}
@media(max-width:600px){.eva-intro-pilot{top:calc(50% - 140px);width:72px}.eva-intro-pilot[data-pilot="asuka"]{left:calc(50% - 108px)}.eva-intro-pilot[data-pilot="rei"]{right:calc(50% - 108px)}.eva-intro-pilot b{font-size:18px;margin-top:6px}.eva-intro-pilot small{font-size:7px}.eva-intro-kicker{font-size:8px;letter-spacing:.15em;margin-bottom:18px}.eva-intro-rule{margin-top:22px}}
@media(max-height:440px){.eva-intro-pilot{top:50%;width:70px}.eva-intro-pilot[data-pilot="asuka"]{left:5vw}.eva-intro-pilot[data-pilot="rei"]{right:5vw}.eva-intro-pilot small{display:none}.eva-intro-title{font-size:28px}.eva-intro-kicker{margin-bottom:12px}.eva-intro-rule{margin-top:16px}}
.eva-boot-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:clamp(18px,3vw,56px);align-items:stretch;min-height:0}
.eva-entry-bay{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;min-width:0;container-type:size;border:1px solid var(--boot-line);background:var(--boot-panel);overflow:hidden}
.eva-entry-bay::before{content:"";position:absolute;left:50%;top:50%;width:80%;aspect-ratio:1;border:1px solid var(--boot-line);border-radius:50%;outline:1px solid color-mix(in srgb,var(--boot-line) 70%,transparent);outline-offset:24px;transform:translate(-50%,-50%)}
.eva-entry-bay::after{content:"";position:absolute;inset:72px 16px 46px;pointer-events:none;border-inline:1px solid var(--boot-line);background:repeating-linear-gradient(0deg,var(--boot-line) 0 1px,transparent 1px 28px) left/8px 100% no-repeat,repeating-linear-gradient(0deg,var(--boot-line) 0 1px,transparent 1px 28px) right/8px 100% no-repeat}
.eva-entry-bay[data-over="1"]{border-color:var(--boot-accent);box-shadow:inset 0 0 90px color-mix(in srgb,var(--boot-accent) 13%,transparent)}
.eva-entry-label{position:absolute;z-index:1;top:18px;left:18px;color:var(--boot-dim);font:9px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.2em}
.eva-entry-label b{display:block;color:var(--boot-accent);font-size:12px;letter-spacing:.12em}
.eva-entry-spec{position:absolute;right:18px;top:20px;text-align:right;color:var(--boot-dim);font:8px/1.7 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.eva-entry-spec b{display:block;color:var(--boot-accent);font-weight:400}
.eva-entry-machine{--plug-clearance:105px;--plug-width:144cqw;position:relative;flex:none;height:min(calc(100cqh - var(--plug-clearance)),var(--plug-width));aspect-ratio:1/2;color:var(--boot-dim)}
.eva-entry-assembly{position:absolute;inset:0;transform:rotate(14deg)}
.eva-entry-plug{display:block;width:100%;height:100%;color:inherit;overflow:visible}
.eva-entry-plug .eva-plug-micro{font:7px ui-monospace,Menlo,monospace;letter-spacing:1px;stroke:none}
.eva-entry-plug .eva-plug-stencil{font:500 33px ui-monospace,Menlo,monospace;letter-spacing:-1px;stroke:none}
/* Surface markings roll around the long axis; shell, lighting and 14° assembly tilt stay fixed. */
.eva-plug-roll{transform-box:view-box;transform-origin:200px 400px}
.eva-plug-roll-back{opacity:0}
.eva-boot[data-paused] .eva-plug-roll{animation-play-state:paused!important}
.eva-boot[data-phase="select"] .eva-plug-roll{animation:eva-plug-roll 10s linear infinite}
.eva-boot[data-phase="select"] .eva-plug-roll-back{animation-delay:-5s}
@keyframes eva-plug-roll{
 0%,100%{transform:translateX(0) scaleX(1);opacity:1}
 12.5%{transform:translateX(45px) scaleX(.707);opacity:1}
 24.9%{transform:translateX(64px) scaleX(.006);opacity:0}
 25%,74.9%{transform:translateX(64px) scaleX(0);opacity:0}
 75%{transform:translateX(-64px) scaleX(0);opacity:0}
 87.5%{transform:translateX(-45px) scaleX(.707);opacity:1}
}
@media(prefers-reduced-motion:reduce){.eva-boot[data-phase="select"] .eva-plug-roll{animation:none}}
.eva-entry-window{position:absolute;left:41.5%;right:41.5%;top:55.5%;height:11%;opacity:0;
  background:var(--boot-accent);mask:var(--boot-head) center/contain no-repeat;pointer-events:none;filter:drop-shadow(0 0 3px var(--boot-accent))}
.eva-entry-target{position:absolute;left:12px;right:12px;bottom:16px;margin:0;text-align:center;color:var(--boot-accent);font:10px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.12em}
.eva-entry-target::before{content:"";display:block;width:58px;height:3px;margin:0 auto 8px;background:repeating-linear-gradient(135deg,var(--boot-signal) 0 4px,transparent 4px 8px)}
.eva-entry-lock{position:absolute;right:22px;top:42%;writing-mode:vertical-rl;color:var(--boot-dim);font:8px/1 ui-monospace,Menlo,monospace;letter-spacing:.18em}
.eva-pilot-list{display:grid;grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:clamp(12px,2.3dvh,26px);min-width:0;min-height:0}
.eva-pilot-card{${bootThemeCSS("asuka", "card")}position:relative;display:grid;grid-template-columns:54% 1fr;align-items:center;text-align:left;min-width:0;min-height:0;
  padding:24px 24px 18px 8px;background:var(--card-surface);border:1px solid var(--card-line);border-left:3px solid var(--card-accent);border-radius:0;color:var(--card-ink);cursor:grab;touch-action:none;user-select:none;overflow:hidden}
.eva-pilot-card[data-pilot="rei"]{${bootThemeCSS("rei", "card")}}
.eva-pilot-card:hover,.eva-pilot-card:focus-visible{background:var(--card-panel);border-color:var(--card-accent)}
.eva-pilot-card:focus-visible{outline-color:var(--card-accent)}
.eva-pilot-card:active{cursor:grabbing}
.eva-pilot-card::before{content:attr(data-unit);position:absolute;right:-.04em;bottom:-.2em;color:var(--card-accent);font:800 clamp(100px,15vw,260px)/1 ui-monospace,Menlo,monospace;letter-spacing:-.1em;opacity:.055;pointer-events:none}
.eva-pilot-card-top{position:absolute;top:10px;left:16px;right:16px;display:flex;justify-content:space-between;color:var(--card-accent);font:8px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.13em}
.eva-pilot-card-top i{font-style:normal;color:var(--card-dim)}
.eva-pilot-face{display:block;width:100%;height:100%;min-height:0;background:var(--card-accent);mask:var(--pilot-head) center/contain no-repeat;pointer-events:none}
.eva-pilot-card[data-pilot="asuka"]{--pilot-head:url("${BRAND_ASSETS.asukaHead}")}
.eva-pilot-card[data-pilot="rei"]{--pilot-head:url("${BRAND_ASSETS.reiHead}")}
.eva-pilot-info{display:block;position:relative;min-width:0}
.eva-pilot-number{display:block;color:var(--card-accent);font:700 clamp(34px,5vw,84px)/1 ui-monospace,Menlo,monospace;letter-spacing:-.06em}
.eva-pilot-info b{display:block;margin-top:12px;color:var(--card-accent);font:500 clamp(18px,2.4vw,36px)/1.3 serif;letter-spacing:.1em}
.eva-pilot-info small{display:block;margin-top:6px;color:var(--card-accent);font:9px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.eva-pilot-info em{display:block;margin-top:14px;color:var(--card-accent);font:normal 9px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.1em}
.eva-pilot-card::after{content:"";position:absolute;right:8px;bottom:8px;width:14px;height:14px;border-right:1px solid var(--card-accent);border-bottom:1px solid var(--card-accent)}
.eva-pilot-ghost{position:fixed;left:0;top:0;z-index:4;pointer-events:none;opacity:.85;transform-origin:center;box-shadow:0 12px 60px #0009;will-change:transform}
.eva-boot-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--boot-line);padding-top:12px;min-width:0}
.eva-boot-status{margin:0;display:flex;gap:12px;align-items:center;color:var(--boot-dim);min-height:20px;font:10px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.1em}
.eva-boot-status::before{content:"";width:6px;height:6px;flex:none;background:var(--boot-accent)}
.eva-boot-magi{display:flex;align-items:center;gap:8px;color:var(--boot-dim);font:8px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.eva-boot-magi span{border:1px solid var(--boot-line);padding:6px 10px}.eva-boot-magi i{display:inline-block;width:4px;height:4px;margin-right:6px;background:var(--boot-ok)}
.eva-boot-loading{position:relative;display:flex;flex-direction:column;justify-content:center;min-height:0;min-width:0;overflow:hidden;border:1px solid var(--boot-line);padding:clamp(20px,3vw,56px);gap:clamp(14px,3dvh,34px);background:var(--boot-panel)}
.eva-sync-portrait{position:absolute;inset:0 0 0 20%;background:var(--boot-accent);mask:var(--boot-head) right center/contain no-repeat;opacity:.1;pointer-events:none}
.eva-boot-loading>*:not(.eva-sync-portrait){position:relative}
.eva-boot-loading h2{margin:6px 0 0;color:var(--boot-accent);font:500 clamp(28px,4.5vw,72px)/1.3 serif;letter-spacing:.13em}
.eva-boot-loading .eva-boot-code{color:var(--boot-dim);font:10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.15em}
.eva-boot-loading p{margin:12px 0 0;color:var(--boot-dim);font:11px/1.9 ui-monospace,Menlo,monospace}
.eva-sync-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,32%);align-items:center;gap:14px}
.eva-sync-orbit{position:relative;aspect-ratio:1;color:var(--boot-accent)}
.eva-sync-orbit svg{display:block;width:100%;height:100%}
.eva-sync-ring-meter{stroke-dasharray:440;stroke-dashoffset:calc(440 * (1 - var(--sync-progress)));transform:rotate(-90deg);transform-origin:90px 90px}
.eva-sync-readout{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.eva-sync-value{font:400 clamp(22px,3vw,48px)/1 ui-monospace,Menlo,monospace;letter-spacing:-.06em}
.eva-sync-readout small{margin-top:9px;font:8px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em}
.eva-sync-systems{display:flex;justify-content:space-between;gap:8px;padding-block:12px;border-block:1px solid var(--boot-line);color:var(--boot-dim);font:8px/1.8 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.eva-sync-systems b{display:block;color:var(--boot-accent);font-weight:400}
.eva-boot-meter{height:16px;overflow:hidden;border:1px solid var(--boot-line);padding:3px}
.eva-boot-meter i{display:block;width:100%;height:100%;background:repeating-linear-gradient(90deg,var(--boot-accent) 0 7px,transparent 7px 10px);transform:scaleX(0);transform-origin:left}
.eva-boot-progress-label{margin-top:10px;display:flex;justify-content:space-between;gap:10px;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--boot-accent)}
.eva-boot-progress-label time{color:var(--boot-dim)}
.eva-sync-caption{margin-top:10px;color:var(--boot-dim);font:8px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.1em}
.eva-boot[data-phase="loading"] .eva-entry-window{opacity:.9;animation:eva-pilot-insert .7s cubic-bezier(.2,.8,.2,1) both}
.eva-boot[data-phase="loading"] .eva-entry-machine{color:var(--boot-accent)}
.eva-boot[data-phase="loading"] .eva-plug-collar{animation:eva-collar-lock .7s ease-out both;transform-origin:200px 640px}
@keyframes eva-pilot-insert{from{transform:translateY(-60px);opacity:0}to{transform:translateY(0);opacity:.9}}
@keyframes eva-collar-lock{from{transform:scaleX(1.12)}to{transform:scaleX(1)}}
/* 双侧舱门打开，真实聊天界面留在原位；最后以细边框交接输入焦点。 */
.eva-boot[data-phase="handoff"]{background:transparent}
.eva-boot[data-phase="handoff"] .eva-boot-backdrop{visibility:hidden}
.eva-boot[data-phase="handoff"] .eva-boot-console{z-index:3;pointer-events:none;animation:eva-console-release .28s ease-out both}
@keyframes eva-console-release{to{opacity:0;transform:translateY(-8px);visibility:hidden}}
.eva-boot-gate{position:absolute;top:0;bottom:0;width:50.2%;z-index:2;pointer-events:none;overflow:hidden;background:var(--boot-surface);color:var(--boot-accent)}
.eva-boot-gate::before{content:"";position:absolute;inset:20px;border:1px solid var(--boot-line);background:repeating-linear-gradient(135deg,transparent 0 18px,color-mix(in srgb,var(--boot-accent) 3%,transparent) 18px 19px)}
.eva-boot-gate::after{content:"";position:absolute;top:0;bottom:0;width:3px;background:repeating-linear-gradient(0deg,var(--boot-accent) 0 12px,transparent 12px 20px);opacity:.7}
.eva-boot-gate.left{left:0;border-right:1px solid var(--boot-accent);animation:eva-gate-left 1.6s cubic-bezier(.65,0,.2,1) both}
.eva-boot-gate.right{right:0;border-left:1px solid var(--boot-accent);animation:eva-gate-right 1.6s cubic-bezier(.65,0,.2,1) both}
.eva-boot-gate.left::after{right:10px}.eva-boot-gate.right::after{left:10px}
.eva-boot-gate span{position:absolute;top:50%;font:9px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;writing-mode:vertical-rl}
.eva-boot-gate.left span{right:32px}.eva-boot-gate.right span{left:32px}
@keyframes eva-gate-left{0%,18%{transform:translateX(0)}90%,100%{transform:translateX(-102%)}}
@keyframes eva-gate-right{0%,18%{transform:translateX(0)}90%,100%{transform:translateX(102%)}}
.eva-boot-clearance{position:absolute;z-index:4;left:50%;top:50%;transform:translate(-50%,-50%);padding:14px 24px;background:var(--boot-surface);border-block:1px solid var(--boot-accent);color:var(--boot-accent);text-align:center;white-space:nowrap;pointer-events:none;animation:eva-clearance 1.6s ease-out both}
.eva-boot-clearance b{display:block;font:400 clamp(16px,2vw,30px)/1.4 var(--eva-pilot-font);letter-spacing:.22em}
.eva-boot-clearance small{font:8px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.16em}
@keyframes eva-clearance{0%{opacity:0}16%,32%{opacity:1}55%,100%{opacity:0}}
.eva-boot-composer-frame{position:fixed;z-index:1;border:1px solid var(--boot-accent);box-shadow:0 0 16px color-mix(in srgb,var(--boot-accent) 22%,transparent);pointer-events:none;animation:eva-composer-arrival 1.6s ease-out both}
@keyframes eva-composer-arrival{0%,58%{opacity:0}78%{opacity:.8}100%{opacity:0}}
@media(max-width:900px){.eva-boot-security{display:none}.eva-boot-console{padding-inline:24px}.eva-entry-spec{display:none}.eva-boot-magi span{padding:5px}.eva-sync-main{grid-template-columns:minmax(0,1fr) 90px}.eva-boot-loading{padding:20px}.eva-boot-loading h2{font-size:34px}}
@media(max-width:640px){
 .eva-boot-console{padding:14px 14px 10px;gap:12px}.eva-boot-header{gap:8px;padding-top:10px}.eva-boot-title{font-size:24px;letter-spacing:.08em}
 .eva-boot-brand{gap:8px;margin-bottom:8px}.eva-boot-brand .eva-nerv-logo{width:18px;height:21px}.eva-boot-kicker{font-size:7px;letter-spacing:.08em}.eva-boot-kicker small{font-size:6px}
 .eva-boot-hint{font-size:9px;max-width:230px;margin-top:8px}.eva-boot-exit{padding:7px;font-size:9px}.eva-boot-header-side{gap:8px}.eva-boot-languages button{font-size:9px;padding:4px 5px}.eva-boot-actions{gap:6px}.eva-boot[lang="en"] .eva-boot-title{font-size:22px;letter-spacing:0}
 .eva-boot-grid{grid-template-columns:minmax(0,.83fr) minmax(0,1.17fr);gap:10px}.eva-entry-machine{--plug-clearance:85px;--plug-width:240cqw}
 .eva-entry-label{top:10px;left:8px;font-size:6px;letter-spacing:.08em}.eva-entry-label b{font-size:8px}.eva-entry-target{font-size:7px;letter-spacing:0;bottom:12px;left:6px;right:6px}.eva-entry-lock{display:none}.eva-entry-bay::after{inset:55px 5px 40px}
 .eva-pilot-list{gap:10px}.eva-pilot-card{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto;padding:22px 10px 10px}.eva-pilot-face{min-height:0}.eva-pilot-info{padding-left:3px}
 .eva-pilot-card-top{left:9px;right:9px;font-size:6px}.eva-pilot-card-top i{display:none}.eva-pilot-number{position:absolute;right:0;top:-28px;font-size:30px;opacity:.7}.eva-pilot-info b{font-size:17px;margin-top:3px}.eva-pilot-info small{font-size:7px}.eva-pilot-info em{font-size:7px;margin-top:5px}
 .eva-boot-loading{gap:18px;padding:16px 12px}.eva-sync-main{grid-template-columns:1fr;gap:18px}.eva-sync-orbit{width:94px;justify-self:center;grid-row:1}.eva-boot-loading h2{font-size:25px}.eva-boot-loading p{font-size:9px}.eva-boot-code{font-size:8px!important;letter-spacing:.06em!important}.eva-sync-systems{gap:5px;font-size:6px}.eva-sync-value{font-size:24px}.eva-sync-readout small{font-size:6px}.eva-boot-progress-label{font-size:9px;gap:4px}.eva-sync-caption{font-size:6px;letter-spacing:0}
 .eva-boot-footer{padding-top:8px;gap:8px}.eva-boot-status{font-size:8px;gap:7px;letter-spacing:0}.eva-boot-magi{gap:3px;font-size:5px}.eva-boot-magi span{padding:4px 3px}.eva-boot-magi i{display:none}
}
@media(max-height:560px){
 .eva-boot-console{padding-top:12px;padding-bottom:8px;gap:10px}.eva-boot-header{padding-top:9px}.eva-boot-brand{margin-bottom:5px}.eva-boot-brand .eva-nerv-logo{width:16px;height:18px}.eva-boot-kicker small{display:none}.eva-boot-title{font-size:26px}.eva-boot-hint{margin-top:5px;font-size:9px}.eva-boot-footer{padding-top:7px}.eva-boot-status{font-size:8px}.eva-boot-magi span{padding:4px 7px}
 .eva-entry-machine{--plug-clearance:55px}.eva-entry-label{top:8px;font-size:7px}.eva-entry-label b{font-size:9px}.eva-entry-target{font-size:8px;bottom:7px}.eva-entry-spec,.eva-entry-lock{display:none}.eva-entry-bay::after{inset:44px 8px 30px}
 .eva-entry-target::before{display:none}
 .eva-pilot-card{grid-template-columns:48% 1fr;grid-template-rows:1fr;padding:18px 12px 8px 4px}.eva-pilot-info b{font-size:18px;margin-top:4px}.eva-pilot-info small{font-size:7px}.eva-pilot-info em{font-size:7px;margin-top:6px}.eva-pilot-number{font-size:28px;position:static;opacity:1}.eva-pilot-card-top{font-size:6px;top:5px}
 .eva-boot-loading{padding:14px 20px;gap:12px}.eva-sync-main{grid-template-columns:minmax(0,1fr) 80px;gap:12px}.eva-sync-orbit{width:auto;grid-row:auto}.eva-boot-loading h2{font-size:28px}.eva-boot-loading p{margin-top:5px;font-size:9px}.eva-sync-systems{display:none}.eva-boot-loading .eva-boot-code{font-size:8px}.eva-boot-meter{height:12px}.eva-boot-progress-label{font-size:10px;margin-top:5px}.eva-sync-caption{margin-top:5px;font-size:7px}.eva-sync-value{font-size:22px}
}
@media(max-height:380px){
 .eva-boot-console{gap:8px}.eva-boot-title{font-size:22px}.eva-boot-brand{margin-bottom:4px}.eva-boot-hint{font-size:8px}.eva-boot-magi{font-size:6px}
 .eva-pilot-number{display:none}.eva-pilot-card{padding:17px 10px 6px 4px}.eva-pilot-info b{font-size:17px;margin-top:0}.eva-pilot-info small{margin-top:3px}.eva-pilot-info em{margin-top:4px}
 .eva-boot-loading{padding:8px 14px;gap:6px}.eva-sync-main{grid-template-columns:minmax(0,1fr) 60px}.eva-sync-orbit{width:60px}.eva-boot-loading h2{font-size:26px}.eva-boot-loading p{display:none}.eva-boot-resume{padding:6px;font-size:9px}.eva-sync-caption{font-size:6px}
}

/* ============================================================================
   右侧仪表边栏（局部补丁）
   ----------------------------------------------------------------------------
   原先时钟 / 播放器 / 仪表浮在正文右上与右下，窄窗时必然压住文字。
   现在它们停进一条真正的右侧栏：JS 给会话头与会话体加右边距，正文不会流进栏里；
   栏宽按组件实际尺寸计算，窗口太窄时收成一条可点的拉手（抽屉按需展开）。
   ============================================================================ */
.${OVERLAY_CLASS} .eva-rail{
  right:0;top:0;bottom:0;width:var(--eva-rail-width,0px);
  display:none;pointer-events:none;
  background:
    linear-gradient(180deg,color-mix(in srgb,var(--eva-accent) 6%,transparent) 0,transparent 220px),
    color-mix(in srgb,var(--eva-surface) 62%,transparent);
  border-left:1px solid var(--eva-line);
}
.eva-rail::before{content:"";position:absolute;left:0;top:0;width:2px;height:72px;background:var(--eva-accent);opacity:.8}
.eva-rail::after{content:"";position:absolute;left:9px;right:9px;bottom:10px;height:6px;opacity:.32;
  background:repeating-linear-gradient(135deg,var(--eva-secondary) 0 4px,transparent 4px 8px)}
.${OVERLAY_CLASS}[data-rail="on"] .eva-rail,
.${OVERLAY_CLASS}[data-rail="tab"] .eva-rail,
.${OVERLAY_CLASS}[data-rail="drawer"] .eva-rail{display:block}
.${OVERLAY_CLASS}[data-rail="drawer"] .eva-rail{box-shadow:-24px 0 60px var(--eva-shadow)}
.eva-rail-scrim{position:absolute;inset:0;display:none;pointer-events:auto;background:rgba(0,0,0,.38)}
.${OVERLAY_CLASS}[data-rail="drawer"] .eva-rail-scrim{display:block}
.${OVERLAY_CLASS} .eva-rail-tab{
  position:absolute;right:0;top:50%;transform:translateY(-50%);z-index:2;
  display:none;align-items:center;justify-content:center;
  width:12px;height:68px;padding:0;margin:0;border:0;background:var(--eva-accent);
  border-radius:7px 0 0 7px;color:var(--eva-accent);cursor:pointer;pointer-events:auto;
}
.eva-rail-tab::before{content:"";position:absolute;inset:1px;background:var(--eva-surface);border-radius:6px 0 0 6px}
.eva-rail-tab svg{position:relative;z-index:1;width:9px;height:14px;display:block}
.eva-rail-tab path{fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round}
.eva-rail-tab:hover::before{background:color-mix(in srgb,var(--eva-surface) 88%,var(--eva-accent) 12%)}
.eva-rail-tab:focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
/* 收起侧边栏：贴在边栏左缘的梯形按钮，右向双箭头。 */
.eva-rail-hide-tab{
  position:absolute;top:50%;right:var(--eva-rail-width,380px);transform:translateY(-50%);
  z-index:3;display:none;align-items:center;justify-content:center;
  width:12px;height:68px;padding:0;margin:0;border:0;background:var(--eva-accent);
  border-radius:7px 0 0 7px;
  color:var(--eva-accent);cursor:pointer;pointer-events:auto;
}
.eva-rail-hide-tab::before{
  content:"";position:absolute;inset:1px;background:var(--eva-surface);
  border-radius:6px 0 0 6px;
}
.eva-rail-hide-tab svg{position:relative;z-index:1;width:9px;height:14px;display:block}.eva-rail-hide-tab path{fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round}
.${OVERLAY_CLASS}[data-rail="on"] .eva-rail-hide-tab{display:flex}
.eva-rail-hide-tab:hover{background:var(--eva-accent)}
.eva-rail-hide-tab:hover span{color:var(--eva-accent)}
.eva-rail-hide-tab:focus-visible{outline:2px solid var(--eva-accent);outline-offset:2px}
.${OVERLAY_CLASS}[data-rail="tab"] .eva-rail-tab,
.${OVERLAY_CLASS}[data-rail="drawer"] .eva-rail-tab,
.${OVERLAY_CLASS}[data-rail="collapsed"] .eva-rail-tab{display:flex}
.${OVERLAY_CLASS}[data-rail="drawer"] .eva-rail-tab{right:var(--eva-rail-width,340px)}

/* ============================================================================
   全局明朝体：正文、英文、菜单与按钮统一到 EVA 的明朝字面。
   代码 / 公式 / 终端保留各自字体，避免等宽失效与公式缺字。
   ============================================================================ */
html[data-eva-mincho-body="on"] body,
html[data-eva-mincho-body="on"] body :not(:where(code,code *,pre,pre *,kbd,samp,.katex,.katex *,.eva-boot,.eva-boot *,[data-dockkit-pane],[data-dockkit-pane] *)){
  font-family:var(--eva-mincho-font)!important;
}
/* 仪表里的纯数字仍用等宽：日期、倒计时、波形读数不会因字体比例而跳动。 */
html[data-eva-mincho-body="on"] .eva-clockpanel :is(.eva-cp-date,.eva-cp-tz,.eva-cp-utc,.eva-cp-second-value,.eva-cp-second-head b),
html[data-eva-mincho-body="on"] .eva-tps :is(.eva-tps-now,.eva-tps-peak,.eva-tps-avg),
html[data-eva-mincho-body="on"] .eva-mp :is(.eva-mp-cur,.eva-mp-tot,.eva-mp-src),
html[data-eva-mincho-body="on"] .eva-tags :is(.eva-tag--remain b,.eva-tag--balance b),
html[data-eva-mincho-body="on"] .eva-panel :is(.eva-val,.eva-range-button,.eva-range-reset){
  font-family:ui-monospace,Menlo,Consolas,monospace!important;
}

/* ============================================================================
   七段斜体：参考 EVA 内部倒计时屏的字形姿态 —— 斜体、加粗、微辉光。
   颜色仍走角色主色，不额外改时钟面板的配色。
   ============================================================================ */
html[data-eva-nixie="on"] .eva-cp-digits{transform:skewX(-8.5deg);transform-origin:50% 100%}
html[data-eva-nixie="on"] .eva-cp-dg use.eva-cp-lit{stroke:var(--cp-ink);stroke-width:.45;stroke-linejoin:round}
html[data-eva-nixie="on"] .eva-cp-number{filter:drop-shadow(0 0 5px color-mix(in srgb,var(--cp-ink) 40%,transparent))}
html[data-eva-nixie="on"] .eva-cp-cl{filter:drop-shadow(0 0 4px color-mix(in srgb,var(--cp-accent) 45%,transparent))}

/* 倒计时标签：与时钟相同的七段斜体；颜色仍取当前料金状态色。 */
.eva-tag--remain b[data-seg="on"]{
  display:inline-flex;align-items:center;gap:1px;height:14px;
  transform:skewX(-8.5deg);transform-origin:50% 100%;
}
.eva-tag--remain b[data-seg="on"] .eva-tag-seg{display:block;height:14px;width:auto;fill:currentColor}
.eva-tag--remain b[data-seg="on"] .eva-tag-seg use{fill:currentColor}
.eva-tag--remain b[data-seg="on"] .eva-tag-seg-colon{width:5px}
.eva-tag--remain b[data-seg="on"] .eva-tag-seg-cjk{font:inherit;line-height:1;margin:0 3px 0 2px}

`;

		const PILOTS = Object.freeze({
			asuka: Object.freeze({ name: "明日香", en: "ASUKA LANGLEY", code: "02", mode: "DARK" }),
			rei: Object.freeze({ name: "绫波丽", en: "REI AYANAMI", code: "00", mode: "LIGHT" }),
		});
		// 启动界面语言独立于宿主 UI；语音继续使用用户提供的两段原始 MP3。
		const BOOT_COPY = Object.freeze({
			"zh-CN": {
				select: "选择你的驾驶员", skipIntro: "进入选择", hint: "将头像拖入左侧插入栓，或点击头像装载", exit: "跳过并进入", language: "启动界面语言",
				asuka: "明日香", rei: "绫波丽", dark: "暗色", light: "亮色", card: "选择{pilot}，载入{mode}主题",
				bay: "插入栓，驾驶员头像放置区", drop: "拖入驾驶员 · DROP PILOT HERE", inserted: "驾驶员已装载 · 接続開始", pilots: "驾驶员选择",
				syncTitle: "驾驶员同步中", syncHint: "启动语音播放结束后进入会话", syncArea: "驾驶员同步", voiceHint: "启动语音与同步进度", progress: "驾驶员启动语音进度",
				waiting: "等待驾驶员 · AWAITING PILOT", responding: "驾驶员应答 · {pilot}", sync: "音声同步 · {pilot}", buffering: "语音缓冲中…", paused: "启动语音已暂停，返回后点击继续。",
				error: "语音暂时无法播放，可重试或跳过进入。", themeError: "主题切换暂时不可用，请重试或跳过。", resume: "继续启动语音", retry: "重试启动语音",
				complete: "同步完成", handoff: "同步完成，正在进入聊天", alert: "NERV 警报启动画面", skipAlert: "跳过警报",
				bgm: "启动背景音乐", bgmOn: "背景音乐播放中 · 点击静音", bgmOff: "点击播放启动背景音乐",
			},
			ja: {
				select: "パイロットを選択", skipIntro: "選択画面へ", hint: "ポートレートを左のエントリープラグへドラッグ、またはクリック", exit: "スキップして入る", language: "起動画面の言語",
				asuka: "アスカ", rei: "綾波レイ", dark: "ダーク", light: "ライト", card: "{pilot}を選択、{mode}テーマを読み込む",
				bay: "エントリープラグ、パイロットのドロップ先", drop: "パイロットを挿入 · DROP PILOT HERE", inserted: "パイロット搭乗 · 接続開始", pilots: "パイロット選択",
				syncTitle: "パイロット同期中", syncHint: "起動ボイス終了後にチャットへ移行します", syncArea: "パイロット同期", voiceHint: "起動ボイスと同期状況", progress: "起動ボイスの再生状況",
				waiting: "パイロット待機中 · AWAITING PILOT", responding: "パイロット応答 · {pilot}", sync: "音声同期 · {pilot}", buffering: "音声を読み込み中…", paused: "起動ボイスを一時停止しました。再開ボタンを押してください。",
				error: "音声を再生できません。再試行するかスキップしてください。", themeError: "テーマを切り替えられません。再試行してください。", resume: "起動ボイスを再開", retry: "起動ボイスを再試行",
				complete: "同期完了", handoff: "同期完了、チャットへ移行中", alert: "NERV 警報起動画面", skipAlert: "警報をスキップ",
				bgm: "起動 BGM", bgmOn: "BGM 再生中 · クリックでミュート", bgmOff: "クリックして BGM を再生",
			},
			en: {
				select: "Select your pilot", skipIntro: "Continue", hint: "Drag a portrait into the entry plug, or click to select", exit: "Skip and enter", language: "Startup language",
				asuka: "Asuka", rei: "Rei", dark: "Dark", light: "Light", card: "Select {pilot}, load the {mode} theme",
				bay: "Entry plug, pilot drop zone", drop: "DROP PILOT HERE", inserted: "PILOT LOADED · CONNECTING", pilots: "Pilot selection",
				syncTitle: "Synchronizing pilot", syncHint: "Enter chat when the startup voice finishes", syncArea: "Pilot synchronization", voiceHint: "Startup voice and synchronization", progress: "Startup voice progress",
				waiting: "AWAITING PILOT", responding: "PILOT RESPONSE · {pilot}", sync: "VOICE SYNC · {pilot}", buffering: "Buffering voice…", paused: "Startup voice paused. Select resume to continue.",
				error: "Voice playback unavailable. Retry or skip to enter.", themeError: "Theme change unavailable. Please retry or skip.", resume: "Resume voice", retry: "Retry voice",
				complete: "Sync complete", handoff: "Sync complete, entering chat", alert: "NERV emergency startup", skipAlert: "Skip alert",
				bgm: "Startup music", bgmOn: "Music playing · Click to mute", bgmOff: "Click to play startup music",
			},
		});
		/** Shared deterministic geometry: the worker and fallback draw identical contours. */
		function createContourRenderer() {
			const columns = 81, rows = 51, heights = new Float32Array(columns * rows);
			const pairs = [[], [0, 3], [0, 1], [1, 3], [1, 2], null, [0, 2], [2, 3], [2, 3], [0, 2], null, [1, 2], [1, 3], [0, 1], [0, 3], []];
			return (time) => {
				const result = [];
				// 同一连续高度场取不同高度截线；移动山峰、谷地及细部波纹，轮廓不会互相穿越。
				const phase = time * .18, peaks = [[.18 + .035 * Math.sin(phase), .17 + .04 * Math.cos(phase * .7), .03, .055, 1.2], [.89 + .03 * Math.cos(phase * .8), .84 + .06 * Math.sin(phase * .65), .045, .09, 1.3], [-.1, .9, .06, .07, .65], [.54, .53, .06, .05, -.45]];
				for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
					const u = x / (columns - 1), v = y / (rows - 1);
					let h = .11 * Math.sin(9 * u + 3 * v + phase) + .075 * Math.cos(12 * v - 4 * u - phase * .8) + .035 * Math.sin(18 * u - 11 * v + phase * .6);
					for (const [px, py, sx, sy, gain] of peaks) h += gain * Math.exp(-((u - px) ** 2 / sx + (v - py) ** 2 / sy));
					heights[y * columns + x] = h;
				}
				for (let levelIndex = 0; levelIndex < 24; levelIndex++) {
					const level = -.26 + levelIndex * .065, nodes = new Map();
					for (let y = 0; y < rows - 1; y++) for (let x = 0; x < columns - 1; x++) {
						const i = y * columns + x, a = heights[i], b = heights[i + 1], c = heights[i + columns + 1], d = heights[i + columns];
						const mask = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
						let edges = pairs[mask];
						if (edges === null) { const centerHigh = (a + b + c + d) / 4 > level; edges = (mask === 5) === centerHigh ? [0, 1, 2, 3] : [0, 3, 1, 2]; }
						if (!edges.length) continue;
						const edge = (id) => {
							const horizontal = id % 2 === 0, xx = x + (id === 1 ? 1 : 0), yy = y + (id === 2 ? 1 : 0);
							const key = horizontal ? yy * (columns - 1) + xx : rows * (columns - 1) + yy * columns + xx;
							if (!nodes.has(key)) {
								const from = id === 0 || id === 3 ? a : id === 1 ? b : d, to = id === 0 ? b : id === 3 ? d : c, t = (level - from) / (to - from);
								nodes.set(key, { x: (xx + (horizontal ? t : 0)) * 20, y: (yy + (horizontal ? 0 : t)) * 20, links: [] });
							}
							return nodes.get(key);
						};
						for (let e = 0; e < edges.length; e += 2) { const from = edge(edges[e]), to = edge(edges[e + 1]); from.links.push(to); to.links.push(from); }
					}
					const visited = new Set(), curves = [], point = p => p.x.toFixed(1) + " " + p.y.toFixed(1), middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
					const trace = (start) => {
						if (visited.has(start)) return;
						const chain = []; let node = start;
						while (node && !visited.has(node)) { visited.add(node); chain.push(node); node = node.links.find(next => !visited.has(next)); }
						if (chain.length < 2) return;
						const last = chain.at(-1), closed = chain.length > 2 && last.links.includes(start);
						let path = "M" + point(closed ? middle(last, start) : start);
						for (let n = closed ? 0 : 1; n < chain.length - (closed ? 0 : 1); n++) path += "Q" + point(chain[n]) + " " + point(middle(chain[n], chain[(n + 1) % chain.length]));
						curves.push(path + (closed ? "Z" : "L" + point(last)));
					};
					for (const node of nodes.values()) if (node.links.length === 1) trace(node);
					for (const node of nodes.values()) trace(node);
					result.push(curves.join(""));
				}
				return result;
			};
		}

		/** Same 20fps curves, computed off the UI thread with one in-flight frame. */
		function mountBootContours(root, media) {
			const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
			svg.classList.add("eva-boot-contours"); svg.setAttribute("viewBox", "0 0 1600 1000"); svg.setAttribute("preserveAspectRatio", "xMidYMid slice"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
			const paths = Array.from({ length: 24 }, (_, index) => {
				const path = document.createElementNS(ns, "path"); path.setAttribute("stroke-width", index % 4 === 0 ? "1.25" : ".7"); path.setAttribute("opacity", index % 4 === 0 ? ".72" : ".38"); svg.appendChild(path); return path;
			});
			const render = createContourRenderer(), paint = curves => curves.forEach((curve, index) => paths[index].setAttribute("d", curve));
			let frame = null, last = null, painted = 0, time = 0, disposed = false, worker = null, busy = false;
			paint(render(0)); root.prepend(svg); svg.dataset.renderer = "main";
			if (!media.matches && typeof Worker === "function") {
				try {

					worker = new Worker(BRAND_ASSETS.contourWorker); svg.dataset.renderer = "worker";
					worker.onmessage = ({data}) => { busy = false; if (!disposed && !document.hidden && !media.matches) paint(data); };
					worker.onerror = event => { event.preventDefault(); worker?.terminate(); worker = null; busy = false; svg.dataset.renderer = "main"; };
				} catch {worker?.terminate(); worker = null; svg.dataset.renderer = "main";}
			}
			const tick = (now) => {
				frame = null; if (disposed || document.hidden || media.matches) return;
				if (last !== null) time += Math.min(100, now - last) / 1000; last = now;
				if (now - painted >= 50 && !busy) {
					painted = now;
					if (worker) {busy = true; worker.postMessage(time);} else paint(render(time));
				}
				frame = requestAnimationFrame(tick);
			};
			const refresh = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; last = null; if (!disposed && !document.hidden && !media.matches) frame = requestAnimationFrame(tick); };
			refresh(); document.addEventListener("visibilitychange", refresh); media.addEventListener("change", refresh);
			return () => { disposed = true; if (frame !== null) cancelAnimationFrame(frame); worker?.terminate(); document.removeEventListener("visibilitychange", refresh); media.removeEventListener("change", refresh); };
		}

		const currentPilot = () => document.body.hasAttribute("data-ds-dark-theme") ? PILOTS.asuka : PILOTS.rei;
		function paintPilot(root) {
			const pilot = currentPilot();
			for (const node of root.querySelectorAll("[data-eva-pilot-name]")) node.textContent = pilot.name;
			for (const node of root.querySelectorAll("[data-eva-pilot-en]")) node.textContent = pilot.en;
			for (const node of root.querySelectorAll("[data-eva-pilot-id]")) node.textContent = "EVA / " + pilot.code;
		}

		// ============================================================
		// 3. 选项
		// ------------------------------------------------------------
		// 自绘显示设定面板与 Console 钩子共用选项，通过 localStorage 持久化：
		//   __EVA_MAGI_THEME__.set("scanlines", false)
		// ============================================================
		// 新标尺的 1.5 对应旧标尺的 0.6；保留当前视觉尺寸并腾出向下调节空间。
		const SIZE_MIN = 0.6, SIZE_MAX = 5, SIZE_STEP = 0.05;
		const clockRenderScale = (value) => Number((value * CLOCK_SCALE_UNIT).toFixed(9));
		const DEFAULT_OPTIONS = Object.freeze({
			// 仪表自身的缩放倍率（面板滑杆 / Cmd+滚轮可调）
			hudScale: 1.5,
			// 结构性装饰（v0.2 新增）——「EVA 元素太少」的直接回应
			chrome: true, // 内嵌框架 + 四角 L 标 + 危险条纹 + 左右刻度尺 + 反白标签块
			hud: true, // 右下角角色载入标识与 TPS
			beam: false, // 走行的场同步带（白线扫屏；实测后被要求关掉，改为默认关）
			boot: true, // 开机序列（每个会话只放一次）
			attentionSound: true, // 人工审核与任务正常完成时播放当前角色的语音
			// 质感层
			// 扫描线默认关闭（用户实测后要求先去掉）。想开回来：
			//   __EVA_MAGI_THEME__.set("scanlines", true)
			scanlines: false,
			scanlineStrength: 0.5,
			// 背景：随明暗模式切换的角色几何底纹。兼容旧 wallpaper 强度设置。
			// 更早的 rings 已不再使用；旧枚举值会被校验器忽略，回落到布尔默认值。
			wallpaper: true,
			wallpaperStrength: 0.5,
			lowPower: false, // 停止刻度游标/机械环/闪烁与时钟辉光，降低持续合成开销
			clock: true, // 正文区右上角那块「内部/外部」七段大时钟
			// 大时钟自身的缩放倍率（面板滑杆可调；独立于 hudScale）
			clockScale: 1.5,
			// 时钟面板内小字的独立倍率（日期 / 时区 / 秒刻 / 解码），不动七段数字
			clockTextScale: 1.25,
			// 七段斜体：斜体、加粗的时钟数字（颜色仍用主题主色）
			clockNixie: true,
			floatScale: 1, // 时钟 / 播放器 / 仪表整列等比缩放
			miniSize: 58, // 收起后角色头像小框的边长（px）
			pluginTheming: true, // 是否给智能体插件面板套用 EVA 样式
			// 右侧边栏：把时钟 / 播放器 / 仪表停进正文右侧的栏里（关掉则回到旧的悬浮层）
			rail: true,
			fitShrink: true, // 空间不足时整列等比缩小
			fitHideStack: true, // 缩到极限仍放不下时允许收起 TPS / 标签
			fitHideMusic: false, // 是否允许收起播放器
			music: true, // 检测到系统正在播放后才显示；暂停时保留控制
			multiTabs: false, // 多音源：开=单面板切换来源，关=主面板 + 紧凑控制器
			// 形状与排版
			hardEdges: true,
			tabularNumbers: true,
			minchoHeadings: true,
			// 全局明朝体：正文、英文标签、菜单与控件都落到 EVA 的 Mincho 字面
			minchoBody: true,
		});

		// ============================================================
		// 设置面板的规格
		// ------------------------------------------------------------
		// 仪表可点开面板，面板里是同一批开关。刻意**不把 hud 自己**列进来：
		// 面板是仪表的一部分，关掉仪表等于把自己关在门外（只能回 Console 开）。
		// ============================================================
		const PANEL_SPEC = [
			{ group: "布局", items: [
				{ key: "rail", label: "右侧仪表边栏", hint: "停靠在正文右侧，正文为其让位" },
				{ key: "fitShrink", label: "空间不足等比缩小", hint: "时钟 / 播放器 / 仪表整列一起缩小" },
				{ key: "fitHideStack", label: "允许隐藏 TPS / 标签", hint: "缩到极限仍放不下时" },
				{ key: "fitHideMusic", label: "允许隐藏播放器", hint: "空间极小时" },
			] },
			{ group: "智能体插件", items: [
				{ key: "pluginTheming", label: "面板样式适配", hint: "为 dockkit 面板与插件页侧栏套用 EVA 样式" },
			] },
			{ group: "字体", items: [
				{ key: "minchoBody", label: "全局明朝体", hint: "正文 / 英文 / 控件 · Yu Mincho" },
				{ key: "minchoHeadings", label: "标题明朝体", hint: "h1–h3" },
			] },
			{ group: "组件尺寸", items: [
				{ key: "hudScale", label: "仪表尺寸", hint: "中央教条区与 TPS · 每步 0.05 倍", type: "range", min: SIZE_MIN, max: SIZE_MAX, step: SIZE_STEP },
				{ key: "clockScale", label: "时钟尺寸", hint: "时钟与播放器 · 每步 0.05 倍", type: "range", min: SIZE_MIN, max: SIZE_MAX, step: SIZE_STEP },
				{ key: "clockTextScale", label: "时钟小字", hint: "日期 / 时区 / 等级等 · 100% 为原尺寸", type: "range", min: 1, max: 1.7, step: SIZE_STEP },
				{ key: "floatScale", label: "悬浮窗总缩放", hint: "时钟 / 播放器 / 仪表整列等比", type: "range", min: 0.5, max: 1.5, step: SIZE_STEP },
				{ key: "miniSize", label: "小框头像尺寸", hint: "收起整列后右下角角色头像 · 36–200 px", type: "range", min: 36, max: 200, step: 2 },
				{ key: "clockNixie", label: "七段斜体", hint: "斜体加粗七段数字 · 同主题色" },
				{ key: "clock", label: "显示时钟" },
				{ key: "music", label: "音乐播放器", hint: "播放时显示，支持暂停与切歌" },
				{ key: "multiTabs", label: "多音源标签页", hint: "开：单面板切换来源；关：主面板 + 紧凑控制器" },
			] },
			{ group: "角色背景", items: [
				{ key: "wallpaper", label: "显示角色背景", hint: "随明暗主题自动切换" },
				{ key: "lowPower", label: "低功耗动画", hint: "停止刻度游标 / 机械环 / 闪烁与时钟辉光" },
				{ key: "wallpaperStrength", label: "背景强度", type: "range", min: 0, max: 1, step: 0.05 },
			] },
			{ group: "声音提醒", items: [
				{ key: "attentionSound", label: "角色提示音", hint: "操作待审核／任务完成时播放" },
			] },
			{ group: "装饰与排版", collapsible: true, items: [
				{ key: "chrome", label: "框架与刻度" },
				{ key: "boot", label: "开机动画", hint: "每次浏览器会话首次加载" },
				{ key: "beam", label: "场同步带", hint: "滚动白线" },
				{ key: "scanlines", label: "CRT 扫描线" },
				{ key: "scanlineStrength", label: "扫描线浓度", type: "range" },
				{ key: "hardEdges", label: "硬边", hint: "圆角归零" },
				{ key: "tabularNumbers", label: "等宽数字" },
			] },
		];

		// 选项 → <html> 上的标记。boot 不在表里：它是一次性 DOM，不走 CSS 开关。
		const OPTION_ATTRS = {
			chrome: "data-eva-chrome",
			hud: "data-eva-hud",
			beam: "data-eva-beam",
			scanlines: "data-eva-scan",
			clock: "data-eva-clock",
			clockNixie: "data-eva-nixie",
			music: "data-eva-music",
			wallpaper: "data-eva-wallpaper",
			lowPower: "data-eva-low-power",
			hardEdges: "data-eva-edges",
			tabularNumbers: "data-eva-nums",
			minchoHeadings: "data-eva-mincho",
			minchoBody: "data-eva-mincho-body",
			pluginTheming: "data-eva-plugin-theme",
		};

		const NUMBER_OPTIONS = Object.freeze({
			hudScale: [SIZE_MIN, SIZE_MAX], clockScale: [SIZE_MIN, SIZE_MAX], clockTextScale: [1, 1.7], floatScale: [0.5, 1.5], miniSize: [36, 200], scanlineStrength: [0, 1], wallpaperStrength: [0, 1],
		});
		function normalizeOption(key, value) {
			if (!Object.hasOwn(DEFAULT_OPTIONS, key)) throw new Error("[dsh-plugin-eva-theme] 未知选项 " + key);
			if (Object.hasOwn(NUMBER_OPTIONS, key)) {
				if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("选项必须是有限数字：" + key);
				const [min, max] = NUMBER_OPTIONS[key];
				return Math.min(max, Math.max(min, value));
			}
			if (typeof value !== "boolean") throw new TypeError("选项必须是布尔值：" + key);
			return value;
		}

		/** 读回用户上次的选择；localStorage 不可用时静默退回默认值。 */
		function loadOptions() {
			const merged = Object.assign({}, DEFAULT_OPTIONS);
			try {
				const raw = globalThis.localStorage?.getItem(OPTIONS_STORAGE_KEY);
				if (raw) {
					const saved = JSON.parse(raw);
					for (const key of Object.keys(DEFAULT_OPTIONS)) {
						if (!saved || !Object.hasOwn(saved, key)) continue;
						try {
							let value = saved[key];
							if (key === "clockScale") {
								const unit = Object.hasOwn(saved, "clockScaleUnit") ? saved.clockScaleUnit : 1;
								if (typeof unit !== "number" || !Number.isFinite(unit) || unit <= 0) continue;
								if (typeof value === "number") value = Number((value * unit / CLOCK_SCALE_UNIT).toFixed(9));
							}
							merged[key] = normalizeOption(key, value);
						} catch { /* 旧类型或损坏的值回到默认 */ }
					}
					if (saved && (saved.clockScaleUnit !== CLOCK_SCALE_UNIT || Object.keys(saved).some(key => key !== "clockScaleUnit" && !Object.hasOwn(DEFAULT_OPTIONS, key)))) saveOptions(merged);
				}
			} catch (error) {
				/* 无痕模式 / 存储被禁用：皮肤照常工作，只是不记忆 */
			}
			return merged;
		}

		function saveOptions(options) {
			try {
				globalThis.localStorage?.setItem(OPTIONS_STORAGE_KEY, JSON.stringify({ ...options, clockScaleUnit: CLOCK_SCALE_UNIT }));
			} catch (error) {
				/* 同上 */
			}
		}

		/** 把选项写进 <html> 的 data-* / 自定义属性，CSS 只认这些标记。 */
		function paintOptions(options) {
			const root = document.documentElement;
			root.setAttribute("data-eva-magi", "");
			// 清理已移除功能的旧标记，旧设置不会重新启用它们。
			for (const attr of ["data-eva-grid", "data-eva-top", "data-eva-vig", "data-eva-motion"]) root.removeAttribute(attr);
			for (const [key, attr] of Object.entries(OPTION_ATTRS)) {
				const on = Boolean(options[key]);
				// edges 是三态（hard/soft），其余都是 on/off
				root.setAttribute(attr, attr === "data-eva-edges" ? (on ? "hard" : "soft") : on ? "on" : "off");
			}
			root.style.setProperty("--eva-scan-strength", String(options.scanlineStrength));
			// 仪表缩放走自定义属性（不是开关，所以不在 OPTION_ATTRS 里）
			root.style.setProperty("--eva-hud-scale", String(options.hudScale));
			// 大时钟尺寸同理走自定义属性（不是开关）
			root.style.setProperty("--eva-clock-scale", String(clockRenderScale(options.clockScale)));
			root.style.setProperty("--eva-clock-text-scale", String(options.clockTextScale));
			root.style.setProperty("--eva-wallpaper-strength", String(options.wallpaperStrength));
			root.style.setProperty("--eva-mini-size", String(options.miniSize) + "px");
		}

		/**
		 * 在 <body> 存在时立刻执行，否则等 DOMContentLoaded。
		 * 客户端插件正常应在 body 脚本之后物化，但这条保护让「过早物化」这一种
		 * 失败模式变成不可能——皮肤宁可不挂，也不能把宿主页面搞崩。
		 */
		function whenBodyReady(run) {
			if (document.body) return run();
			let dispose = null;
			let cancelled = false;
			const onReady = () => {
				if (!cancelled) dispose = run();
			};
			document.addEventListener("DOMContentLoaded", onReady, { once: true });
			return () => {
				cancelled = true;
				document.removeEventListener("DOMContentLoaded", onReady);
				if (typeof dispose === "function") dispose();
			};
		}

		/** Fullscreen body children become no-drag in the macOS desktop host. */
		function themeOverlayHost() {
			return document.getElementById("root") || document.body;
		}

		// ============================================================
		// 峰谷计价：把当前处于高峰还是空闲算出来，并给出下一切换时刻
		// ------------------------------------------------------------
		// 规则与 DSH 生态里已有的实现（dsh-whale-widget）同源，其依据是
		// DeepSeek 官方计费文档 + 国务院节假日安排：
		//
		//   高峰 = 北京时间 周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00
		//   空闲 = 其余全部，含 周末（2026-08-23 起）、调休上班的周末、
		//          以及中国法定节假日全天（2026-09-19 起）
		//
		// 全部在本地按时钟推算：不联网、不读账号、不碰任何用户数据。
		// 唯一的风险是规则会变 —— 所以节假日清单只覆盖到 HOLIDAY_COVERED_YEAR，
		// 超出范围时状态照旧推算，但会标注 certainty=inferred，界面上显示「推定」。
		// ============================================================
		const PEAK_HOURS = [
			[9, 12],
			[14, 18],
		];
		// 北京时间 2026-08-23 00:00 起：周末全天按空闲计
		const WEEKEND_VALLEY_FROM = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000);
		// 北京时间 2026-09-19 00:00 起：法定节假日全天按空闲计
		const HOLIDAY_VALLEY_FROM = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000);
		// 只列「放假」的日期：调休上班日全部落在周末，按周末规则本就是空闲。
		// 来源：《国务院办公厅关于 2026 年部分节假日安排的通知》。
		// ⚠️ 每年 11 月国务院发布次年安排后需要补下一年；未覆盖的年份会被标为「推定」。
		const HOLIDAY_COVERED_YEAR = 2026;
		const HOLIDAY_VALLEY = new Set([
			"2026-01-01", "2026-01-02", "2026-01-03",
			"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
			"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
			"2026-04-04", "2026-04-05", "2026-04-06",
			"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
			"2026-06-19", "2026-06-20", "2026-06-21",
			"2026-09-25", "2026-09-26", "2026-09-27",
			"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
			"2026-10-05", "2026-10-06", "2026-10-07",
		]);

		/**
		 * 某个时刻的计费状态。
		 * @param sec - epoch 秒。
		 * @returns {peak, reason, inferred}。reason ∈ peak|offhours|weekend|holiday。
		 */
		function pricingStateAt(sec) {
			// 平移 +8h 后用 UTC 读，得到的就是北京时间的日历日与小时
			const bj = new Date(sec * 1000 + 8 * 3600 * 1000);
			const dow = bj.getUTCDay();
			const inferred = bj.getUTCFullYear() > HOLIDAY_COVERED_YEAR;
			const day = bj.toISOString().slice(0, 10);
			// 先判法定节假日再判周末：两者可能同时成立（如国庆里的周六）。
			// 此时报「休日」才和信息一致 —— 否则标签写着「週末」，
			// 倒计时却是整个假期的长度（4 天），自相矛盾。
			if (sec >= HOLIDAY_VALLEY_FROM && HOLIDAY_VALLEY.has(day)) {
				return { peak: false, reason: "holiday", inferred: false };
			}
			if (sec >= WEEKEND_VALLEY_FROM && (dow === 0 || dow === 6)) {
				return { peak: false, reason: "weekend", inferred: false };
			}
			const hour = bj.getUTCHours();
			for (const [start, end] of PEAK_HOURS) {
				if (hour >= start && hour < end) return { peak: true, reason: "peak", inferred };
			}
			return { peak: false, reason: "offhours", inferred: bj.getUTCFullYear() > HOLIDAY_COVERED_YEAR };
		}

		/**
		 * 下一个峰谷切换时刻（epoch 秒），与 pricingStateAt 完全同源。
		 * 只需扫北京时间的 0/9/12/14/18 点边界；最长假期 9 天，扫 12 天留足余量。
		 */
		function nextPricingChangeAt(sec) {
			if (!Number.isFinite(sec)) return null;
			const current = pricingStateAt(sec).peak;
			const day0 = Math.floor((sec + 8 * 3600) / 86400) * 86400;
			for (let d = 0; d <= 12; d += 1) {
				for (const edge of [0, 9, 12, 14, 18]) {
					const candidate = day0 + d * 86400 + edge * 3600 - 8 * 3600;
					if (candidate <= sec) continue;
					if (pricingStateAt(candidate).peak !== current) return candidate;
				}
			}
			return null;
		}

		/** 剩余时长 → 显示文本。跨天时用「N日 HH:MM:SS」，否则 HH:MM:SS。 */
		function formatRemaining(seconds) {
			const total = Math.max(0, Math.floor(seconds));
			const days = Math.floor(total / 86400);
			const rest = total % 86400;
			const hh = String(Math.floor(rest / 3600)).padStart(2, "0");
			const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, "0");
			const ss = String(rest % 60).padStart(2, "0");
			return days > 0 ? days + "日" + hh + ":" + mm + ":" + ss : hh + ":" + mm + ":" + ss;
		}

		/**
		 * 造设置面板。
		 *
		 * 与 Console 钩子共用同一个 setOption —— 两条路改的是同一份状态，
		 * 所以面板开着时从 Console 改值，面板也会跟着刷新。
		 *
		 * @param options - 当前选项（会被就地修改）。
		 * @param setOption - 单项写入 + 持久化 + 重绘。
		 * @param resetAll - 恢复全部默认值。
		 */
		function buildPanel(options, setOption, resetAll) {
			const panel = document.createElement("div");
			panel.className = "eva-panel"; panel.hidden = true;
			// 非模态设置区不加入宿主 dialog 栈；远程控制按 dialog 数量保护嵌套关闭。
			panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "EVA 角色主题显示设定");
			const head = document.createElement("div"); head.className = "eva-panel-head";
			head.innerHTML = '<span>表示設定</span><small>DISPLAY CONFIG</small><button type="button" class="eva-panel-close" aria-label="关闭显示设定" title="关闭（Esc）">×</button>';
			panel.appendChild(head);
			const body = document.createElement("div"); body.className = "eva-panel-body";
			const controls = [];
			for (const section of PANEL_SPEC) {
				const groupBody = document.createElement(section.collapsible ? "details" : "section");
				groupBody.className = "eva-panel-section" + (section.collapsible ? " eva-advanced" : "");
				const group = document.createElement(section.collapsible ? "summary" : "div");
				group.className = "eva-group"; group.textContent = section.group;
				groupBody.appendChild(group); body.appendChild(groupBody);
				for (const item of section.items) {
					const row = document.createElement("div"); row.className = "eva-row"; row.dataset.key = item.key;
					const label = document.createElement("span"); label.className = "eva-row-label";
					const name = document.createElement("b"); name.textContent = item.label; label.appendChild(name);
					if (item.hint) { const hint = document.createElement("i"); hint.textContent = item.hint; label.appendChild(hint); }
					row.appendChild(label);
					if (item.type === "range") {
						row.classList.add("eva-range-row");
						const min = item.min ?? 0, max = item.max ?? 1, step = item.step ?? 0.05;
						const input = document.createElement("input"); input.type = "range";
						input.min = String(min); input.max = String(max); input.step = String(step);
						input.setAttribute("aria-label", item.label);
						input.addEventListener("input", () => setOption(item.key, Number(input.value)));
						const val = document.createElement("output"); val.className = "eva-val";
						const reset = document.createElement("button"); reset.type = "button"; reset.className = "eva-range-reset";
						reset.textContent = "默认"; reset.setAttribute("aria-label", item.label + "恢复默认");
						reset.addEventListener("click", () => setOption(item.key, DEFAULT_OPTIONS[item.key]));
						const strip = document.createElement("div"); strip.className = "eva-range-controls";
						const minus = document.createElement("button"), plus = document.createElement("button");
						for (const [button, direction, text] of [[minus, -1, "−"], [plus, 1, "＋"]]) {
							button.type = "button"; button.className = "eva-range-button"; button.textContent = text;
							button.setAttribute("aria-label", (direction < 0 ? "减小" : "增大") + item.label);
							button.addEventListener("click", () => setOption(item.key, Number((options[item.key] + direction * step).toFixed(3))));
						}
						input.addEventListener("keydown", (event) => {
							const direction = {ArrowLeft:-1, ArrowDown:-1, ArrowRight:1, ArrowUp:1}[event.key];
							if (!direction) return;
							event.preventDefault(); setOption(item.key, Number((options[item.key] + direction * step).toFixed(3)));
						});
						row.append(val, reset); strip.append(minus, input, plus); row.appendChild(strip);
						controls.push({key:item.key,kind:"range",input,val,row,minus,plus,reset,min,max});
					} else {
						const sw = document.createElement("button"); sw.type = "button"; sw.className = "eva-sw";
						sw.dataset.key = item.key; sw.setAttribute("role", "switch"); sw.setAttribute("aria-label", item.label);
						sw.addEventListener("click", () => setOption(item.key, !options[item.key])); row.appendChild(sw);
						controls.push({key:item.key,kind:"switch",sw});
					}
					groupBody.appendChild(row);
					if (item.key === "attentionSound") {
						const previews = document.createElement("div"); previews.className = "eva-sound-previews";
						for (const [kind, label] of [["approval", "试听审核提醒"], ["complete", "试听完成提醒"]]) {
							const button = document.createElement("button"); button.type = "button"; button.className = "eva-btn";
							button.textContent = label; button.dataset.attentionPreview = kind;
							button.setAttribute("aria-pressed", "false"); button.title = "播放当前主题的" + (kind === "approval" ? "审核" : "完成") + "语音";
							button.addEventListener("click", () => previewAttentionRef?.(kind)); previews.appendChild(button);
						}
						groupBody.appendChild(previews);
					}
				}
			}
			const note = document.createElement("p"); note.className = "eva-panel-note";
			note.textContent = "调整立即生效并自动保存 · Esc 关闭"; body.appendChild(note); panel.appendChild(body);
			const foot = document.createElement("div"); foot.className = "eva-panel-foot";
			const resetBtn = document.createElement("button"); resetBtn.type = "button"; resetBtn.className = "eva-btn";
			resetBtn.textContent = "重置全部"; resetBtn.addEventListener("click", resetAll); foot.appendChild(resetBtn);
			const replayBtn = document.createElement("button"); replayBtn.type = "button"; replayBtn.className = "eva-btn eva-replay-boot";
				replayBtn.textContent = "重新选择驾驶员"; replayBtn.addEventListener("click", () => replayBootRef?.()); foot.appendChild(replayBtn); panel.appendChild(foot);
			const refresh = () => {
				for (const button of panel.querySelectorAll("[data-attention-preview]")) button.disabled = !options.attentionSound;
				replayBtn.title = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "直接选择驾驶员（减少动态效果）" : "重播 NERV 并选择驾驶员";
				for (const c of controls) {
					if (c.kind === "switch") {
						const on = Boolean(options[c.key]); c.sw.setAttribute("aria-checked", String(on)); c.sw.textContent = on ? "承認" : "否定";
					} else {
						const value = options[c.key], size = c.key === "clockScale" || c.key === "hudScale";
						c.input.value = String(value);
						const text = size ? Number(value).toFixed(3).replace(/\.?0+$/, "") + "×" : Math.round(value * 100) + "%";
						c.val.textContent = text; c.input.setAttribute("aria-valuetext", text);
						const disabled = c.key === "scanlineStrength" && !options.scanlines || c.key === "wallpaperStrength" && !options.wallpaper;
						c.input.disabled = disabled; c.row.dataset.dim = disabled ? "1" : "0";
						c.minus.disabled = disabled || value <= c.min; c.plus.disabled = disabled || value >= c.max;
						c.reset.disabled = disabled || value === DEFAULT_OPTIONS[c.key];
					}
				}
			};
			refresh(); return {panel,refresh};
		}

		/**
		 * 造装饰层：CRT 质感 + 结构框架 + 仪表簇 + 反白标签。
		 *
		 * 全部挂在同一个 pointer-events:none 的固定层里，所以永远不挡操作、也不进
		 * 应用的布局流。角色标识来自实际明暗模式，时钟与解码读数来自真实状态，
		 * 不做假遥测 —— 装饰就要有装饰的自觉。
		 *
		 * 返回移除函数（连同定时器、监听器一起回收）。
		 */
		function mountChrome(ctx, options, setOption, resetAll) {
			const layer = document.createElement("div");
			layer.className = OVERLAY_CLASS;
			layer.setAttribute("aria-label", "EVA 双角色主题组件");
			layer.innerHTML = [
				'<div class="eva-rail" aria-hidden="true"></div>',
				'<div class="eva-emg" aria-hidden="true">',
				'<div class="eva-character-portrait"></div>',
				'<div class="eva-character-art eva-character-art--asuka"><svg viewBox="0 0 600 600" fill="none" stroke="currentColor">',
				'<path class="eva-art-panel" d="M80 60h235l200 200v235H280L80 295Z"/><path d="M80 60h235l200 200v235H280L80 295Z" stroke-width="2"/>',
				'<path d="M90 20h250l215 215M45 115v200l225 225h260" stroke-width="12"/><path class="eva-art-fine" d="M102 82h204l187 187v204H289L102 286ZM68 155v149l215 215h155M132 100h150l190 190v154"/>',
				'<path class="eva-art-detail" d="M354 110l70 70m-36-88 70 70" stroke-width="18"/><path class="eva-art-detail" d="M90 323l24 24m-24-6 24 24m-24-6 24 24" stroke-width="5"/>',
				'<text class="eva-art-label" x="112" y="126">EVANGELION / UNIT-02</text><text class="eva-art-micro" x="112" y="146">PRODUCTION MODEL // NERV</text>',
				'<path class="eva-art-fine" d="M112 164h92m10 0h35m39 13v-22h22M130 236v-28h28M435 390v28h-28"/><circle cx="116" cy="186" r="3"/><circle cx="130" cy="186" r="3"/><circle cx="144" cy="186" r="3"/>',
				'<text x="150" y="390">02</text><path d="M140 454h310" stroke-width="2"/><path class="eva-art-fine" d="M140 444h310M140 461v12m10-12v7m10-7v7m10-7v12m10-12v7m10-7v7m10-7v12M350 461h100"/>',
				'<text class="eva-art-label" x="278" y="492">SECOND CHILD</text><text class="eva-art-micro" x="294" y="508">ASUKA LANGLEY // 02</text><path class="eva-art-detail" d="M459 420h12v12h-12zM480 441h12v12h-12z" fill="currentColor" stroke="none"/>',
				'</svg></div>',
				'<div class="eva-character-art eva-character-art--rei"><svg viewBox="0 0 600 600" fill="none" stroke="currentColor">',
				'<circle cx="300" cy="300" r="242" stroke-width="1"/><circle cx="300" cy="300" r="255" stroke-width="5" stroke-dasharray="1 25.7"/><circle cx="300" cy="300" r="230" stroke-dasharray="90 18 2 18"/>',
				'<circle cx="300" cy="300" r="215" stroke-width="3" stroke-dasharray="200 22 2 22"/><circle class="eva-art-fine" cx="300" cy="300" r="198" stroke-dasharray="2 7"/>',
				'<path d="M300 26v68m0 412v68M26 300h68m412 0h68" stroke-width="2"/><path d="M300 112l188 188-188 188-188-188Z"/><path class="eva-art-fine" d="M300 128l172 172-172 172-172-172ZM146 146h28v-18m280 18h-28v-18M146 454h28v18m280-18h-28v18"/>',
				'<g class="eva-art-detail"><circle cx="300" cy="72" r="9" fill="currentColor" stroke="none"/><circle cx="300" cy="72" r="15"/><circle cx="300" cy="528" r="5" fill="currentColor"/><path d="M63 294h12v12H63zM525 294h12v12h-12z" stroke-width="2"/></g>',
				'<text class="eva-art-label" x="175" y="180">EVANGELION / UNIT-00</text><text class="eva-art-micro" x="190" y="196">PROTOTYPE // NERV</text><text x="156" y="368">00</text>',
				'<path class="eva-art-fine" d="M196 398h208m-208 8h52m104 0h52"/><text class="eva-art-label" x="218" y="430">FIRST CHILD</text><text class="eva-art-micro" x="199" y="446">REI AYANAMI // 00</text>',
				'</svg></div>',
				'<span class="eva-character-caption" data-eva-pilot-en></span></div>',
				'<i class="eva-magi-beam"></i>',
				'<i class="eva-magi-scan"></i>',
				'<div class="eva-frame">',
				'<span class="eva-corner tl"></span><span class="eva-corner tr"></span>',
				'<span class="eva-corner bl"></span><span class="eva-corner br"></span>',
				'<span class="eva-id tl" data-eva-pilot-id></span>',
				'<span class="eva-id tr" data-eva-pilot-en></span>',
				// TPS / 解码速度波形：挂载后移动到中央教条区下方，与仪表一起适配。
				'<div class="eva-tps" data-eva-tps>',
				'<div class="eva-tps-head"><i></i><b>波形</b><small>TPS</small><span class="eva-tps-now">—</span></div>',
				'<svg class="eva-tps-scope" viewBox="0 0 200 56" preserveAspectRatio="none" aria-hidden="true">',
				'<line class="eva-tps-base" x1="0" y1="55" x2="200" y2="55"></line>',
				'<polyline class="eva-tps-line" points=""></polyline>',
				"</svg>",
				'<div class="eva-tps-foot"><span>PEAK <b class="eva-tps-peak">—</b></span><span>AVG <b class="eva-tps-avg">—</b></span></div>',
				"</div>",
				"</div>",
				'<i class="eva-edge"></i><i class="eva-edge r"></i>',
				'<i class="eva-hazard"></i>',
				'<svg width="0" height="0" aria-hidden="true"><defs>',
				'<g id="eva-d0"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/><path d="M0.00 19.10 L2.10 17.00 L4.20 19.10 L4.20 27.70 L2.10 29.80 L0.00 27.70 Z"/><path d="M0.00 6.30 L2.10 4.20 L4.20 6.30 L4.20 14.90 L2.10 17.00 L0.00 14.90 Z"/></g><g id="eva-d1"><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/></g><g id="eva-d2"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/><path d="M0.00 19.10 L2.10 17.00 L4.20 19.10 L4.20 27.70 L2.10 29.80 L0.00 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/></g><g id="eva-d3"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/></g><g id="eva-d4"><path d="M0.00 6.30 L2.10 4.20 L4.20 6.30 L4.20 14.90 L2.10 17.00 L0.00 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/></g><g id="eva-d5"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M0.00 6.30 L2.10 4.20 L4.20 6.30 L4.20 14.90 L2.10 17.00 L0.00 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/></g><g id="eva-d6"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M0.00 6.30 L2.10 4.20 L4.20 6.30 L4.20 14.90 L2.10 17.00 L0.00 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/><path d="M0.00 19.10 L2.10 17.00 L4.20 19.10 L4.20 27.70 L2.10 29.80 L0.00 27.70 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/></g><g id="eva-d7"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/></g><g id="eva-d8"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/><path d="M0.00 19.10 L2.10 17.00 L4.20 19.10 L4.20 27.70 L2.10 29.80 L0.00 27.70 Z"/><path d="M0.00 6.30 L2.10 4.20 L4.20 6.30 L4.20 14.90 L2.10 17.00 L0.00 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/></g><g id="eva-d9"><path d="M2.10 0.00 L17.90 0.00 L20.00 2.10 L17.90 4.20 L2.10 4.20 L0.00 2.10 Z"/><path d="M15.80 6.30 L17.90 4.20 L20.00 6.30 L20.00 14.90 L17.90 17.00 L15.80 14.90 Z"/><path d="M15.80 19.10 L17.90 17.00 L20.00 19.10 L20.00 27.70 L17.90 29.80 L15.80 27.70 Z"/><path d="M2.10 29.80 L17.90 29.80 L20.00 31.90 L17.90 34.00 L2.10 34.00 L0.00 31.90 Z"/><path d="M0.00 6.30 L2.10 4.20 L4.20 6.30 L4.20 14.90 L2.10 17.00 L0.00 14.90 Z"/><path d="M2.10 14.90 L17.90 14.90 L20.00 17.00 L17.90 19.10 L2.10 19.10 L0.00 17.00 Z"/></g>',
				'</defs></svg>',
				'<div class="eva-rail-scrim" aria-hidden="true"></div>',
				'<div class="eva-clockpanel" aria-hidden="true">',
				'<div class="eva-cp-top"><b>時刻管制</b><small>SYSTEM CLOCK</small><span class="eva-nerv-logo" aria-hidden="true"></span><i></i></div>',
				'<div class="eva-cp-mode"><span>現在時刻 / LOCAL TIME</span><span>24H FORMAT</span></div>',
				'<div class="eva-cp-main"><div class="eva-cp-digits">',
				'<div class="eva-cp-pair"><small>HOUR</small><div class="eva-cp-number"><svg class="eva-cp-dg" data-i="0" viewBox="0 0 20 34"><use class="eva-cp-ghost" href="#eva-d8"/><use class="eva-cp-lit" href="#eva-d0"/></svg><svg class="eva-cp-dg" data-i="1" viewBox="0 0 20 34"><use class="eva-cp-ghost" href="#eva-d8"/><use class="eva-cp-lit" href="#eva-d0"/></svg></div></div>',
				'<svg class="eva-cp-cl" viewBox="0 0 8 34"><rect x="2" y="10" width="3" height="3"/><rect x="2" y="22" width="3" height="3"/></svg>',
				'<div class="eva-cp-pair"><small>MINUTE</small><div class="eva-cp-number"><svg class="eva-cp-dg" data-i="2" viewBox="0 0 20 34"><use class="eva-cp-ghost" href="#eva-d8"/><use class="eva-cp-lit" href="#eva-d0"/></svg><svg class="eva-cp-dg" data-i="3" viewBox="0 0 20 34"><use class="eva-cp-ghost" href="#eva-d8"/><use class="eva-cp-lit" href="#eva-d0"/></svg></div></div>',
				'<svg class="eva-cp-cl eva-cp-cl--seconds" viewBox="0 0 8 34"><rect x="2" y="10" width="3" height="3"/><rect x="2" y="22" width="3" height="3"/></svg>',
				'<div class="eva-cp-pair eva-cp-pair--seconds"><small>SECOND</small><div class="eva-cp-number"><svg class="eva-cp-dg" data-i="4" viewBox="0 0 20 34"><use class="eva-cp-ghost" href="#eva-d8"/><use class="eva-cp-lit" href="#eva-d0"/></svg><svg class="eva-cp-dg" data-i="5" viewBox="0 0 20 34"><use class="eva-cp-ghost" href="#eva-d8"/><use class="eva-cp-lit" href="#eva-d0"/></svg></div></div>',
				'</div></div>',
				'<div class="eva-cp-side">',
				'<div class="eva-cp-block"><small>日付 / DATE <em class="eva-cp-weekday">---</em></small><b class="eva-cp-date">----</b></div>',
				'<div class="eva-cp-block"><small>地方時 / ZONE</small><b class="eva-cp-tz">UTC+00:00</b></div>',
				'<div class="eva-cp-block"><small>協定時 / UTC</small><b class="eva-cp-utc">--:--:--</b></div>',
				'</div>',
				'<div class="eva-cp-second-head"><span>秒刻 / SECOND INDEX</span><b class="eva-cp-second-value">00 / 59</b></div>',
				'<div class="eva-cp-second-track"><i></i></div>',
				'<div class="eva-cp-decode"><small>推理等级<br>EFFORT</small><div class="eva-cp-lamps"><span>OFF</span><span>LOW</span><span>HIGH</span><span>MAX</span></div></div>',
				'</div>',
				// —— 音声管制：曲目信息、播放状态、真实进度和三个系统控制按钮。——
				'<div class="eva-mp" role="region" aria-label="系统音乐控制" hidden>',
				'<div class="eva-mp-head"><b>音声管制</b><small>AUDIO CONTROL</small><i class="eva-mp-hazard" aria-hidden="true"></i></div>',
				'<div class="eva-mp-tabs" hidden></div>',
				'<div class="eva-mp-source"><small>外部音源 / SOURCE</small><span class="eva-mp-src"></span></div>',
				'<div class="eva-mp-name"><span class="eva-mp-title" aria-live="polite">等待系统播放</span><span class="eva-mp-artist"></span></div>',
				'<div class="eva-mp-deck"><div class="eva-mp-rings" role="button" tabindex="0" aria-label="切换真实频谱" aria-pressed="false" title="点击切换真实频谱">',
				'<svg class="eva-mp-ring eva-mp-ring--open" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="53 8 7 8"/><path d="M50 2v7M98 50h-7M50 98v-7M2 50h7" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
				'<svg class="eva-mp-ring eva-mp-ring--solid" viewBox="0 0 100 100"><circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="19 6 3 6"/><path d="M20 33l5 3M80 33l-5 3M50 84v-6" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
				'<svg class="eva-mp-core" viewBox="0 0 100 100"><path d="M50 25 72 37v26L50 75 28 63V37Z" fill="var(--eva-ghost)" stroke="currentColor"/><text x="50" y="76" text-anchor="middle">AUDIO</text></svg><span class="eva-nerv-logo eva-mp-crest"></span>',
				'</div><div class="eva-mp-signal"><div class="eva-mp-status"><span class="eva-mp-state">一時停止</span><small class="eva-mp-state-en">HOLD</small></div>',
				'<div class="eva-mp-eq"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>',
				'<small>PLAYBACK STATE / 再生状態</small></div></div>',
				'<div class="eva-mp-times"><span><small>経過</small><b class="eva-mp-cur">00:00</b></span><span><small>全長</small><b class="eva-mp-tot">00:00</b></span></div>',
				'<div class="eva-mp-bar" role="progressbar" aria-label="曲目进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>',
				'<div class="eva-mp-btns">',
				'<button type="button" class="eva-mp-btn" data-act="prev" aria-label="上一首"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 5h2v14H5zM19 5v14L8 12z"/></svg><span>PREV</span></button>',
				'<button type="button" class="eva-mp-btn" data-act="play" aria-label="播放 / 暂停"><svg aria-hidden="true" viewBox="0 0 24 24" class="eva-mp-ico-pause"><rect x="7" y="6" width="3.5" height="12"/><rect x="13.5" y="6" width="3.5" height="12"/></svg><svg aria-hidden="true" viewBox="0 0 24 24" class="eva-mp-ico-play"><path d="M8 5v14l11-7z"/></svg><span class="eva-mp-playlabel">PLAY</span></button>',
				'<button type="button" class="eva-mp-btn" data-act="next" aria-label="下一首"><span>NEXT</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 5h2v14h-2zM5 5v14l11-7z"/></svg></button>',
				'</div><div class="eva-mp-loading" aria-hidden="true"><b>音源接続</b><small>SOURCE LINK</small><i></i></div></div>',
				'<div class="eva-mp-extras" hidden></div>',
				'<div class="eva-corner-stack">',
				'<div class="eva-tags" data-face="front" role="button" tabindex="0" title="点击查看余额">',
				'<div class="eva-tags-face eva-tags-front">',
				'<span class="eva-tag eva-tag--state" data-state="valley"><b>空闲料金</b><small>VALLEY</small></span>',
				'<span class="eva-tag ghost eva-tag--remain"><b>--:--:--</b><small>残余</small></span>',
				"</div>",
				'<div class="eva-tags-face eva-tags-back">',
				'<span class="eva-tag eva-tag--balance"><b>—</b><small>残高</small></span>',
				"</div>",
				"</div>",
				'<div class="eva-hud">',
				'<div class="eva-hud-vlabel" role="button" tabindex="0" aria-label="收起全部仪表" title="点击收起全部仪表">中央教条区</div>',
				'<div class="eva-hud-body">',
				'<span class="eva-pilot-status"><i></i>当前载入 / LOADED</span>',
				'<strong class="eva-pilot-name" data-eva-pilot-name></strong>',
				'<small class="eva-pilot-en" data-eva-pilot-en></small>',
				"</div></div>",
				"</div>",
'<button type="button" class="eva-hud-mini" aria-label="展开全部仪表" title="展开全部仪表"><img alt=""><b></b></button>',
				'<button type="button" class="eva-rail-tab" aria-label="展开仪表边栏" aria-expanded="false" title="展开仪表边栏"><svg viewBox="0 0 12 16" aria-hidden="true"><path d="M10 2 Q5 8 10 14"></path><path d="M6 2 Q1 8 6 14"></path></svg></button>',
'<button type="button" class="eva-rail-hide-tab" aria-label="收起仪表边栏" title="收起仪表边栏"><svg viewBox="0 0 12 16" aria-hidden="true"><path d="M2 2 Q7 8 2 14"></path><path d="M6 2 Q11 8 6 14"></path></svg></button>',
			].join("");

			for (const node of layer.children) {
				if (!node.matches(".eva-corner-stack,.eva-mp,.eva-rail-tab,.eva-rail-hide-tab,.eva-hud-mini")) node.setAttribute("aria-hidden", "true");
			}
			let disposed = false;
			const requests = new Set();
			const fetchLocal = async (url, init = {}, controller = new AbortController()) => {
				requests.add(controller);
				const timer = setTimeout(() => controller.abort(), 12000);
				try {
					const response = await fetch(url, { ...init, signal: controller.signal });
					const data = await response.json().catch(() => null);
					return { response, data };
				} finally { clearTimeout(timer); requests.delete(controller); }
			};

			// —— 七段大时钟 ——
			const clockEl = layer.querySelector(".eva-clockpanel");
			const clockDigits = clockEl ? [...clockEl.querySelectorAll(".eva-cp-dg")] : [];
			const clockDate = clockEl ? clockEl.querySelector(".eva-cp-date") : null;
			const clockTz = clockEl ? clockEl.querySelector(".eva-cp-tz") : null;
			const clockUtc = clockEl ? clockEl.querySelector(".eva-cp-utc") : null;
			const clockWeekday = clockEl?.querySelector(".eva-cp-weekday");
			const clockSecondValue = clockEl?.querySelector(".eva-cp-second-value");
			const clockSecondFill = clockEl?.querySelector(".eva-cp-second-track i");
			const clockLamps = clockEl ? [...clockEl.querySelectorAll(".eva-cp-lamps span")] : [];


			const pad2 = (value) => (value < 10 ? "0" + value : String(value));

			/** 每秒刷一次：六位数字靠切换 <use href> 指向 defs 里预定义的字形。 */
			const updateClock = () => {
				if (!clockEl) return;
				const now = new Date();
				const text = pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
				for (let i = 0; i < clockDigits.length && i < text.length; i += 1) {
					const use = clockDigits[i].querySelector(".eva-cp-lit");
					if (use && use.getAttribute("href") !== "#eva-d" + text[i]) use.setAttribute("href", "#eva-d" + text[i]);
				}
				if (clockDate) {
					clockDate.textContent =
						now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
				}
				if (clockTz) {
					const offset = -now.getTimezoneOffset(), absolute = Math.abs(offset);
					clockTz.textContent = "UTC" + (offset >= 0 ? "+" : "-") + pad2(Math.floor(absolute / 60)) + ":" + pad2(absolute % 60);
				}
				if (clockUtc) {
					clockUtc.textContent = pad2(now.getUTCHours()) + ":" + pad2(now.getUTCMinutes()) + ":" + pad2(now.getUTCSeconds());
				}
				if (clockWeekday) clockWeekday.textContent = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()];
				if (clockSecondValue) clockSecondValue.textContent = pad2(now.getSeconds()) + " / 59";
				if (clockSecondFill) clockSecondFill.style.width = (now.getSeconds() + 1) / 60 * 100 + "%";
			};

			/**
			 * 推理等级灯排：与模型选择里的 Off / Low / High / Max 对齐。
			 * 数据优先读当前会话的 modelSelection 投影；投影未就绪时退回模型菜单触发器上的文字。
			 * 不再跟着解码速度走 —— TPS 仍由上方波形单独显示。
			 */
			const EFFORT_LEVELS = Object.freeze(["off", "low", "high", "max"]);
			const effortIndex = (value) => {
				if (value === null || value === undefined) return -1;
				const text = String(value).trim().toLowerCase();
				if (!text) return -1;
				const index = EFFORT_LEVELS.indexOf(text);
				if (index >= 0) return index;
				if (/^(none|关闭|關閉|なし|无|無)/.test(text)) return 0;
				if (/^(low|低)/.test(text)) return 1;
				if (/^(high|高)/.test(text)) return 2;
				if (/^(max|maximum|最高|最大)/.test(text)) return 3;
				return -1;
			};
			const currentBinding = () => {
				try {
					if (!sessionsRef || typeof sessionsRef.binding !== "function") return null;
					const raw = domSessionId();
					if (!raw) return null;
					const bare = raw.replace(/^session-/, "");
					return sessionsRef.binding(raw) || sessionsRef.binding(bare) || sessionsRef.binding("session-" + bare) || null;
				} catch (error) { return null; }
			};
			const readEffort = () => {
				try {
					const binding = currentBinding();
					const face = binding && binding.session && binding.session.projections
						? binding.session.projections.faceOf("modelSelection") : null;
					const snapshot = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : null;
					const effort = snapshot && (snapshot.next?.reasoningEffort ?? snapshot.lastUsed?.reasoningEffort);
					if (effort) return effort;
				} catch (error) { /* 投影未就绪，走 DOM 兜底 */ }
				try {
					const slot = document.querySelector('[data-slot="conversation.input.model"]');
					const label = slot ? slot.querySelector('[class*="_triggerEffort"]') : null;
					return label && label.textContent ? label.textContent.trim() : null;
				} catch (error) { return null; }
			};
			const setLamps = () => {
				if (!clockLamps.length) return;
				const level = effortIndex(readEffort());
				for (let i = 0; i < clockLamps.length; i += 1) {
					if (i === level) clockLamps[i].setAttribute("data-on", "1");
					else clockLamps[i].removeAttribute("data-on");
				}
				const row = clockEl ? clockEl.querySelector(".eva-cp-decode") : null;
				if (row) row.title = "推理等级：" + (level >= 0 ? EFFORT_LEVELS[level].toUpperCase() : "未知");
			};

			// —— 音乐播放器 ——
			const mpEl = layer.querySelector(".eva-mp");

			const mpTitle = layer.querySelector(".eva-mp-title");
			const mpArtist = layer.querySelector(".eva-mp-artist");
			const mpState = layer.querySelector(".eva-mp-state");
			const mpStateEn = layer.querySelector(".eva-mp-state-en");
			const mpPlayLabel = layer.querySelector(".eva-mp-playlabel");
			const mpCur = layer.querySelector(".eva-mp-cur");
			const mpTot = layer.querySelector(".eva-mp-tot");
			const mpBar = layer.querySelector(".eva-mp-bar");
			const mpFill = mpBar ? mpBar.querySelector("i") : null;
			const mpButtons = [...layer.querySelectorAll(".eva-mp-btn")];

			const mpFmt = (sec) => {
				const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
				return pad2(Math.floor(total / 60)) + ":" + pad2(total % 60);
			};

			// 系统媒体控制：没有活动来源时不提供文件选择或独立音频播放。
			for (const btn of mpButtons) {
				btn.addEventListener("click", () => {
					if (npInfo) npSend(btn.dataset.act === "play" ? "playpause" : btn.dataset.act === "prev" ? "previous" : "next");
				});
			}
			const NP_URL = "/dsh-eva-magi/nowplaying.json";
			const NP_CTL = "/dsh-eva-magi/nowplaying";
			const mpSrc = layer.querySelector(".eva-mp-src");
			const mpTabs = layer.querySelector(".eva-mp-tabs");
			const mpExtras = layer.querySelector(".eva-mp-extras");
			const mpEq = layer.querySelector(".eva-mp-eq");
			const mpSpec = layer.querySelector(".eva-mp-rings");
			const mpSpecLabel = layer.querySelector(".eva-mp-core text");
			if (mpEq && mpEq.querySelectorAll("i").length === 12) {
				mpEq.replaceChildren(...Array.from({ length: 24 }, () => document.createElement("i")));
				mpEq.style.gap = "2px";
			}

			// —— 真实频谱：WASAPI 回环 → 守护进程 FFT → 面板 12 根柱（无需共享屏幕）。——
			let specOn = true, specTimer = null, specSeen = false;
			const specTargets = [];
			const specValues = [];
			const ensureSpecSize = (count) => {
				while (specTargets.length < count) { specTargets.push(0.05); specValues.push(0.05); }
			};
			let specRaf = 0;
			const specAnim = () => {
				if (!specOn || !mpEl.hasAttribute("data-spectrum")) { specRaf = 0; return; }
				if (!mpEq) { specRaf = 0; return; }
				const bars = [...mpEq.querySelectorAll("i")];
				if (document.hidden || mpEl.hidden || !mpEl.hasAttribute("data-playing")) {
					ensureSpecSize(bars.length);
					for (let i = 0; i < bars.length; i++) { specValues[i] = 0.05; bars[i].style.transform = "scaleY(0.050)"; }
					specRaf = 0;
					return;
				}
				specRaf = requestAnimationFrame(specAnim);
				ensureSpecSize(bars.length);
				for (let i = 0; i < bars.length; i++) {
					const target = specTargets[i] ?? 0.05;
					specValues[i] = (specValues[i] ?? 0.05) + (target - (specValues[i] ?? 0.05)) * 0.3;
					bars[i].style.transform = "scaleY(" + Math.max(0.05, Math.min(1, specValues[i])).toFixed(3) + ")";
				}
			};
			const startSpecAnim = () => { if (!specRaf) specRaf = requestAnimationFrame(specAnim); };
			const setSpecTargets = (values) => {
				const count = mpEq ? mpEq.querySelectorAll("i").length : 12;
				ensureSpecSize(count);
				for (let i = 0; i < count; i++) {
					const value = values ? Number(values[i]) : 0.05;
					specTargets[i] = Number.isFinite(value) ? Math.max(0.05, Math.min(1, value)) : 0.05;
				}
				startSpecAnim();
			};
			const applySpectrum = (csv) => {
				if (!specOn) return false;
				let values = String(csv).split(",").map((value) => Number(value)).filter((value) => Number.isFinite(value));
				if (values.length < 4) return false;
				const bars = mpEq ? mpEq.querySelectorAll("i").length : 12;
				if (values.length > 1 && values.length !== bars) {
					const scaled = [];
					for (let i = 0; i < bars; i++) {
						const t = i * (values.length - 1) / (bars - 1);
						const a = Math.floor(t);
						const b = Math.min(values.length - 1, a + 1);
						scaled.push(values[a] * (1 - (t - a)) + values[b] * (t - a));
					}
					values = scaled;
				}
				setSpecTargets(values);
				mpEl.setAttribute("data-spectrum", "1");
				if (mpSpec) { mpSpec.dataset.on = "1"; mpSpec.setAttribute("aria-pressed", "true"); }
				if (mpSpecLabel) mpSpecLabel.textContent = "REAL";
				specSeen = true;
				return true;
			};
			const specTick = async () => {
				if (disposed || !specOn) return;
				specTimer = setTimeout(specTick, 70);
				if (document.hidden || mpEl.hidden) return;
				if (!mpEl.hasAttribute("data-playing")) { if (specSeen) setSpecTargets(null); return; }
				try {
					const { data } = await fetchLocal(NP_URL, { credentials: "same-origin" });
					if (!specOn || disposed) return;
					const csv = data?.spectrum || (/^SP:/.test(String(data?.album || "")) ? String(data.album).slice(3) : "");
					if (csv) applySpectrum(csv);
				} catch { }
			};
			const stopSpectrum = () => {
				specOn = false;
				if (specTimer) { clearTimeout(specTimer); specTimer = null; }
				if (specRaf) { cancelAnimationFrame(specRaf); specRaf = 0; }
				mpEl.removeAttribute("data-spectrum");
				if (mpEq) for (const bar of mpEq.querySelectorAll("i")) bar.style.removeProperty("transform");
				if (mpSpec) { mpSpec.dataset.on = "0"; mpSpec.setAttribute("aria-pressed", "false"); }
				if (mpSpecLabel) mpSpecLabel.textContent = "AUDIO";
			};
			if (mpSpec) mpSpec.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") { event.preventDefault(); mpSpec.click(); }
			});
			if (mpSpec) mpSpec.addEventListener("click", (event) => {
				event.stopPropagation();
				if (specOn) stopSpectrum();
				else {
					specOn = true;
					mpSpec.dataset.on = "1";
					mpSpec.setAttribute("aria-pressed", "true");
					if (specSeen) { mpEl.setAttribute("data-spectrum", "1"); startSpecAnim(); }
					specTick();
				}
			});
			specTick();
			let npInfo = null;
			let npSources = [];
			let npTabKey = null;
			let npExtrasKey = "";
			let npBusy = false;
			let npSeenSource = null;
			let npControlling = false;
			let npConfirmed = null, npExpected = null, npEpoch = 0, npRefresh = false, npEnterTimer = null, npReadController = null;
			const npCommands = [];
			let mediaSuspended = false;
			const mediaSource = (info) => info?.bundleId || info?.app || null;
			const renderExternal = (info) => {
				const entering = !npInfo || mediaSource(npInfo) !== mediaSource(info);
				npInfo = info;
				if (entering && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
					clearTimeout(npEnterTimer);
					mpEl.dataset.entering = "1";
					npEnterTimer = setTimeout(() => { mpEl.removeAttribute("data-entering"); npEnterTimer = null; }, 650);
				}
				if (info.playing) npSeenSource = mediaSource(info);
				const readOnly = info.controls === false;
				mpEl.dataset.readonly = readOnly ? "1" : "";
				mpEl.dataset.untimed = info.duration > 0 ? "" : "1";
				if (mpSrc) {
					mpSrc.textContent = info.app || "";
					mpSrc.title = info.app || "";
				}
				const title = info.title || "(未知曲目)";
				if (mpTitle && mpTitle.textContent !== title) { mpTitle.textContent = title; mpTitle.title = title; }
				if (mpArtist) { mpArtist.textContent = info.artist || info.album || "未知演出者"; mpArtist.title = [info.artist, info.album].filter(Boolean).join(" / "); }
				if (mpState) mpState.textContent = info.playing ? "再生中" : "一時停止";
				if (mpStateEn) mpStateEn.textContent = info.playing ? "PLAYING" : "HOLD";
				if (mpPlayLabel) mpPlayLabel.textContent = info.playing ? "PAUSE" : "PLAY";
				if (mpCur) mpCur.textContent = mpFmt(info.position);
				if (mpTot) mpTot.textContent = mpFmt(info.duration);
				const progress = info.duration > 0 ? Math.max(0, Math.min(100, (Number(info.position) || 0) / info.duration * 100)) : 0;
				if (mpFill) mpFill.style.width = progress + "%";
				if (mpBar) {
					mpBar.setAttribute("aria-valuenow", String(Math.round(progress)));
					mpBar.setAttribute("aria-valuetext", mpFmt(info.position) + " / " + mpFmt(info.duration));
				}
				mpEl.toggleAttribute("data-playing", info.playing === true);
				if (info.playing) mpEl.setAttribute("data-playing", "1");
				const play = mpEl.querySelector('[data-act="play"]');
				play.setAttribute("aria-label", info.playing ? "暂停" : "继续播放");
				scheduleLayout();
			};
			const npSourceKey = (source) => source?.bundleId || source?.app || "";
			const renderTabs = (sources, display) => {
				mpTabs.replaceChildren();
				for (const source of sources) {
					const tab = document.createElement("button");
					tab.type = "button"; tab.className = "eva-mp-tab";
					tab.dataset.on = npSourceKey(source) === npSourceKey(display) ? "1" : "0";
					tab.textContent = (source.app || "来源") + (source.playing ? "" : " · 暂停");
					tab.title = source.title || "";
					tab.addEventListener("click", () => { npTabKey = npSourceKey(source); renderSources(npSources); });
					mpTabs.appendChild(tab);
				}
				mpTabs.hidden = sources.length < 2;
			};
			const renderExtras = (extras) => {
				const list = extras.slice(0, 3);
				if (!list.length) { mpExtras.hidden = true; mpExtras.replaceChildren(); npExtrasKey = ""; scheduleLayout(); return; }
				const signature = list.map((source) => npSourceKey(source) + "|" + source.title + "|" + (source.playing ? 1 : 0)).join("~");
				if (signature === npExtrasKey) { mpExtras.hidden = false; return; }
				npExtrasKey = signature;
				mpExtras.replaceChildren();
				for (const source of list) {
					const row = document.createElement("div"); row.className = "eva-mp-extra";
					const app = document.createElement("small"); app.textContent = source.app || "来源"; app.title = source.app || "";
					const title = document.createElement("b"); title.textContent = source.title || "(未知曲目)"; title.title = source.title || "";
					const button = document.createElement("button"); button.type = "button";
					button.textContent = source.playing ? "PAUSE" : "PLAY";
					button.setAttribute("aria-label", (source.playing ? "暂停 " : "继续播放 ") + (source.app || ""));
					button.addEventListener("click", () => npSendFor(source, "playpause"));
					row.append(app, title, button);
					mpExtras.appendChild(row);
				}
				mpExtras.hidden = false;
				scheduleLayout();
			};
			const renderSources = (sources) => {
				npSources = sources;
				if (!sources.length) { mpTabs.hidden = true; mpExtras.hidden = true; return; }
				if (options.multiTabs === true) {
					mpExtras.hidden = true; mpExtras.replaceChildren(); npExtrasKey = "";
					if (!npTabKey || !sources.some((source) => npSourceKey(source) === npTabKey)) {
						npTabKey = npSourceKey(sources.find((source) => source.playing) || sources[0]);
					}
					const display = sources.find((source) => npSourceKey(source) === npTabKey) || sources[0];
					renderTabs(sources, display);
					renderExternal(display);
				} else {
					mpTabs.hidden = true; mpTabs.replaceChildren();
					const display = sources.find((source) => source.playing) || sources[0];
					renderExternal(display);
					renderExtras(sources.filter((source) => npSourceKey(source) !== npSourceKey(display)));
				}
			};
			const clearNowPlaying = () => {
				const changed = npInfo !== null;
				npInfo = null; npConfirmed = null; npSeenSource = null; /* 乐观窗口由 npPoll 到期清理，不在此清空 */
				clearTimeout(npEnterTimer); npEnterTimer = null; mpEl.removeAttribute("data-entering");
				mpEl.hidden = true; mpEl.removeAttribute("data-playing");
				mpTabs.hidden = true; mpExtras.hidden = true; npSources = []; npTabKey = null; npExtrasKey = "";
				if (changed) scheduleLayout();
			};

			let npTimer = null;
			let npSupported = true;
			const scheduleNp = () => {
				clearTimeout(npTimer); npTimer = null;
				if (!disposed && !document.hidden && options.music && !mediaSuspended && npSupported && !npControlling) {
					npTimer = setTimeout(npPoll, npExpected && npExpected.until > Date.now() ? 250 : npInfo?.app ? 2000 : 3000);
				}
			};
			const npPoll = async (force = false) => {
				clearTimeout(npTimer); npTimer = null;
				// 过期窗口不再参与刷新与渲染，避免停止播放后长期携带 refresh=1，也避免被后续命令复活。
				if (npExpected && npExpected.until <= Date.now()) npExpected = null;
				npRefresh ||= force || Boolean(npExpected);
				if (disposed || document.hidden || npBusy || npControlling || !mpEl || mediaSuspended || !options.music || !npSupported) return;
				npBusy = true;
				const reader = new AbortController(); npReadController = reader;
				const epoch = npEpoch, refresh = npRefresh; npRefresh = false;
				try {
					const { response, data: info } = await fetchLocal(NP_URL + (refresh ? "?refresh=1" : ""), { credentials: "same-origin" }, reader);
					if (disposed || !options.music || epoch !== npEpoch) return;
					if (!response.ok) throw new Error("http");
					npSupported = info?.supported !== false;
					/* 乐观窗口优先：控制指令刚发出、系统状态尚未完成迁移时，旧快照不得清空面板。
					   系统一旦报出与预期一致的状态就收窗，避免压住确认后的真实变化。 */
					const expected = npExpected && npExpected.until > Date.now() && npExpected.source
						&& npExpected.source === mediaSource(info) && info?.ok !== false && info.app ? npExpected : null;
					if (expected) {
						if (info.playing === expected.playing) { npExpected = null; npConfirmed = info; renderExternal(info); }
						else renderExternal({ ...info, playing: expected.playing, state: expected.playing ? "playing" : "paused" });
					} else if (info?.ok && Array.isArray(info.sources) && info.sources.length) {
						const sources = info.sources.filter((source) => source && source.app && source.title);
						if (sources.length) { npExpected = null; npConfirmed = info; renderSources(sources); }
						else { clearNowPlaying(); mpTabs.hidden = true; mpExtras.hidden = true; }
					} else if (info?.ok && info.app && (info.playing === true || info.state === "paused" && npSeenSource === mediaSource(info))) {
						// 系统可能在接受动作后短暂返回旧状态；最多等 1.5s，避免图标先切换又闪回。
						if (npExpected && npExpected.source === mediaSource(info) && npExpected.until > Date.now() && info.playing !== npExpected.playing) {
							renderExternal({ ...info, playing: npExpected.playing, state: npExpected.playing ? "playing" : "paused" });
						} else { npExpected = null; npConfirmed = info; renderExternal(info); }
					}
					else {
						// 另一个应用（例如浏览器里暂停的旧会话）不应把我们的面板顶掉。
						// 当前来源暂停时，忽略“别的来源也处于暂停”这种切换；等真正有别的来源在播放再切。
						const panelSource = npInfo ? mediaSource(npInfo) : null;
						const incomingSource = mediaSource(info);
						const otherPaused = info?.ok === true && Boolean(info.app) && info.playing !== true
							&& info.state === "paused" && panelSource && incomingSource && incomingSource !== panelSource;
						if (otherPaused) {
							if (!(npExpected && npExpected.source === panelSource && npExpected.until > Date.now()) && npInfo && npInfo.playing) {
								renderExternal({ ...npInfo, playing: false, state: "paused" });
							}
						} else {
							clearNowPlaying();
						}
					}
				} catch {
					if (!disposed && epoch === npEpoch) clearNowPlaying();
				} finally {
					npBusy = false;
					if (npReadController === reader) npReadController = null;
					if (npRefresh && !npControlling && !disposed && !document.hidden && options.music && !mediaSuspended && npSupported) npPoll(true);
					else scheduleNp();
				}
			};

			/** 连续点击按顺序发送；先响应界面，再以系统结果校准，不锁住按钮等待查询。 */
			const drainNpCommands = async () => {
				npControlling = true;
				try {
					while (npCommands.length && !disposed) {
						const command = npCommands[0];
						const { response, data } = await fetchLocal(NP_CTL, {
							method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
							body: JSON.stringify({ action: command.action, app: command.app, bundleId: command.bundleId }),
						});
						if (disposed) return;
						if (!response.ok || !data?.ok) throw new Error(data?.code === "SOURCE_CHANGED" ? "播放来源已切换" : "控制失败");
						if (command.action === "playpause" && npConfirmed) npConfirmed = { ...npConfirmed, playing: command.playing, state: command.playing ? "playing" : "paused" };
						npCommands.shift();
					}
				} catch (error) {
					npCommands.length = 0;
					npExpected = null;
					if (!disposed) {
						if (npConfirmed) { if (npSources.length) renderSources(npSources); else renderExternal(npConfirmed); }
						if (mpSrc) mpSrc.textContent = error.message === "播放来源已切换" ? error.message : "控制失败";
					}
				} finally {
					npControlling = false;
					// 只续期仍然有效的窗口；已过期的窗口直接丢弃，避免 next/previous 把旧状态套到新曲目上。
					if (npExpected && npExpected.until > Date.now()) npExpected.until = Date.now() + 1500;
					else npExpected = null;
					if (!disposed) { mpEl.removeAttribute("data-command"); npPoll(true); }
				}
			};
			const npSendFor = (source, action) => {
				if (!source || disposed || npCommands.length >= 8) return;
				npEpoch++; npReadController?.abort(); clearTimeout(npTimer); npTimer = null;
				const playing = action === "playpause" ? !source.playing : source.playing;
				npCommands.push({ action, app: source.app, bundleId: source.bundleId, playing });
				mpEl.dataset.command = action;
				// 点击时不再被载入遮罩覆盖；暂停立即冻结机械环并切换图标。
				clearTimeout(npEnterTimer); npEnterTimer = null; mpEl.removeAttribute("data-entering");
				if (action === "playpause") {
					npExpected = { source: mediaSource(source), playing, until: Infinity };
					source.playing = playing; source.state = playing ? "playing" : "paused";
					if (npSources.includes(source)) renderSources(npSources);
					else if (npInfo && mediaSource(npInfo) === mediaSource(source)) renderExternal({ ...npInfo, playing, state: source.state });
				}
				else if (mediaSource(npInfo) === mediaSource(source)) { mpState.textContent = "切替中"; mpStateEn.textContent = action === "next" ? "NEXT" : "PREV"; }
				if (!npControlling) drainNpCommands();
			};
			const npSend = (action) => npSendFor(npInfo, action);

			const tpsPanelEl = layer.querySelector(".eva-tps");
			if (tpsPanelEl) { tpsPanelEl.setAttribute("aria-hidden", "true"); layer.querySelector(".eva-corner-stack").appendChild(tpsPanelEl); }
			themeOverlayHost().appendChild(layer);
			// 插件面板若使用 Shadow DOM，全局样式无法穿透；向打开的影子根注入同一套 EVA 面板样式。
			const EVA_SHADOW_CSS = `
@font-face{font-family:"EVA Backslash";src:local("Segoe UI"),local("Segoe UI Variable Text"),local("Arial"),local("Helvetica Neue"),local("Helvetica"),local("DejaVu Sans"),local("Liberation Sans");unicode-range:U+005C;font-weight:400 700;}

:host{background:var(--eva-surface)!important;color:var(--eva-ink)!important;font-family:var(--eva-mincho-font)!important}
aside,:is([class*="sidebar"],[class*="Sidebar"],[class*="sidePanel"],[class*="side-panel"]){position:relative!important;background:var(--eva-panel)!important;border-right:1px solid var(--eva-accent)!important;box-shadow:inset 3px 0 0 var(--eva-accent)!important;font-family:var(--eva-mincho-font)!important}
aside::before,:is([class*="sidebar"],[class*="Sidebar"])::before{content:"";position:absolute;right:8px;bottom:8px;width:45px;height:11px;z-index:2;pointer-events:none;background:repeating-linear-gradient(130deg,var(--eva-secondary) 0 4px,var(--eva-surface) 4px 8px)}
aside :is(h1,h2,h3,label,[class*="title"],[class*="Title"],[class*="label"],[class*="Label"]),:is([class*="sidebar"],[class*="Sidebar"]) :is(h1,h2,h3,label,[class*="title"],[class*="label"]){color:var(--eva-dim)!important;font-family:var(--eva-mincho-font)!important}
:is(input,textarea,select){background:var(--eva-panel)!important;color:var(--eva-ink)!important;border-color:var(--eva-line)!important;border-radius:0!important;font-family:var(--eva-mincho-font)!important}
button{border-radius:0!important;font-family:var(--eva-mincho-font)!important}
input[type="checkbox"],input[type="radio"]{accent-color:var(--eva-accent)}
:is(hr,[class*="divider"],[class*="Divider"]){border-color:var(--eva-line)!important}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:var(--eva-line);border:0}
::-webkit-scrollbar-track{background:transparent}
`;
			const injectDockShadow = () => {
				const enabled = options.pluginTheming !== false;
				for (const pane of document.querySelectorAll("[data-dockkit-pane],section[class*='_pane_'],[data-slot='main']")) {
					const hosts = [pane, ...pane.querySelectorAll("*")];
					for (const host of hosts) {
						const root = host.shadowRoot;
						if (!root) continue;
						if (!enabled) {
							for (const node of root.querySelectorAll("style[data-eva-dock]")) node.remove();
							continue;
						}
						if (root.querySelector("style[data-eva-dock]")) continue;
						const style = document.createElement("style");
						style.setAttribute("data-eva-dock", "1");
						style.textContent = EVA_SHADOW_CSS;
						root.appendChild(style);
					}
				}
			};
			const injectDockFrame = () => {
				const vars = ["--eva-accent", "--eva-ink", "--eva-dim", "--eva-line", "--eva-surface", "--eva-panel", "--eva-secondary", "--eva-mark", "--eva-mincho-font"];
				const rootStyle = getComputedStyle(document.documentElement);
				const varCSS = ":root{" + vars.map((v) => v + ":" + rootStyle.getPropertyValue(v).trim() + ";").join("") + "}";
				const enabled = options.pluginTheming !== false;
				for (const frame of document.querySelectorAll("iframe")) {
					try {
						const doc = frame.contentDocument;
						if (!doc) continue;
						if (!enabled) {
							for (const node of doc.querySelectorAll("style[data-eva-dock]")) node.remove();
							continue;
						}
						if (doc.querySelector("style[data-eva-dock]")) continue;
						const style = doc.createElement("style");
						style.setAttribute("data-eva-dock", "1");
						style.textContent = varCSS + EVA_SHADOW_CSS;
						(doc.head || doc.documentElement).appendChild(style);
					} catch { }
				}
			};
			injectDockShadow();
			injectDockFrame();
			const dockShadowTimer = setInterval(() => { injectDockShadow(); injectDockFrame(); }, 2000);

			// 角色标识只显示当前载入者；模式切换时原位更新，不重建组件或重置用户设置。
			const readState = () => {
				paintPilot(layer);
				const hud = layer.querySelector(".eva-hud");
				hud.setAttribute("aria-label", "当前载入：" + currentPilot().name + "；打开显示设定");
			};

			// —— 两个标签块：峰谷状态 + 下一切换倒计时 ——
			const tagsWrap = layer.querySelector(".eva-tags");
			const stateTag = layer.querySelector(".eva-tag--state");
			const remainTag = layer.querySelector(".eva-tag--remain");
			const stateText = stateTag.querySelector("b");
			const stateSub = stateTag.querySelector("small");
			const remainText = remainTag.querySelector("b");
			const remainSub = remainTag.querySelector("small");

			/** 状态 → [主文案, 副文案] */
			const STATE_LABELS = {
				peak: ["高峰料金", "PEAK RATE"],
				weekend: ["週末料金", "WEEKEND"],
				holiday: ["休日料金", "HOLIDAY"],
				offhours: ["空闲料金", "VALLEY"],
			};

			/** 倒计时文字 → 七段数字；七段斜体关闭时退回普通文本。 */
			const SEG_COLON = '<svg class="eva-tag-seg eva-tag-seg-colon" viewBox="0 0 8 34" aria-hidden="true"><rect x="2" y="10" width="4" height="4"></rect><rect x="2" y="22" width="4" height="4"></rect></svg>';
			const paintRemaining = (el, text) => {
				const nixie = document.documentElement.getAttribute("data-eva-nixie") === "on";
				if (!nixie || !/[0-9]/.test(text)) {
					el.textContent = text;
					el.removeAttribute("data-seg");
					el.removeAttribute("aria-label");
					return;
				}
				let html = "";
				for (const ch of text) {
					if (ch >= "0" && ch <= "9") {
						html += '<svg class="eva-tag-seg" viewBox="0 0 20 34" aria-hidden="true"><use href="#eva-d' + ch + '"></use></svg>';
					} else if (ch === ":") {
						html += SEG_COLON;
					} else if (ch === "日") {
						html += '<span class="eva-tag-seg-cjk">日</span>';
					} else if (ch === " ") {
						html += " ";
					}
				}
				el.innerHTML = html;
				el.dataset.seg = "on";
				el.setAttribute("aria-label", text);
			};

			/** 把当前峰谷状态与倒计时画进两个标签块。 */
			const renderTags = () => {
				const nowSec = Math.floor(Date.now() / 1000);
				const state = pricingStateAt(nowSec);
				const key = state.peak ? "peak" : state.reason;
				const label = STATE_LABELS[key] || STATE_LABELS.offhours;
				tagsWrap.dataset.state = key;
				stateText.textContent = label[0];
				// 节假日清单未覆盖时，以虚线下划线和提示标注推算状态。
				stateSub.textContent = label[1];
				stateTag.dataset.inferred = state.inferred ? "1" : "0";
				stateTag.title = state.inferred ? "节假日清单未覆盖该年份，此状态为推算" : "";

				const next = nextPricingChangeAt(nowSec);
				if (next === null) {
					paintRemaining(remainText, "—");
					remainSub.textContent = "残余";
					tagsWrap.dataset.imminent = "0";
					return;
				}
				const remain = next - nowSec;
				paintRemaining(remainText, formatRemaining(remain));
				// 「切换」比「至切换」再短一档：默认放大到 1.5 之后，
			// 这几个像素就是标签块保得住还是被自动收掉的差别。
			remainSub.textContent = "切换";
				// 30 分钟内就要切换 → 闪一下（EVA 的「まもなく」）
				tagsWrap.dataset.imminent = remain <= 1800 ? "1" : "0";
			};

			// —— 点击标签块翻面看余额 ——
			// 余额由**宿主半边**去取：客户端按设计读不到 API Key。
			// 流程是 标签翻面 → fetch 本机只读路由 → 宿主用凭据问 DeepSeek 官方接口。
			// 所以这里不碰密钥、不直连外网，只请求自己的宿主。
			const balanceTag = layer.querySelector(".eva-tag--balance");
			let balanceState = "idle"; // idle | loading | ready | failed | unsupported

			/** 只做展示：把状态画到背面的两个标签上。 */
			const paintBalance = (main, sub) => {
				balanceTag.querySelector("b").textContent = main;
				balanceTag.querySelector("small").textContent = sub;
			};

			/** 失败原因 → 副文案。让人看得出是"没配密钥"还是"网络不通"。 */
			const FAILURE_LABEL = {
				NO_KEY: "未配置密钥",
				NO_BALANCE: "响应异常",
				FORBIDDEN: "本机校验未过",
				METHOD: "方法不允许",
				ERROR: "网络失败",
				TIMEOUT: "请求超时",
			};

			const formatAmount = (data) => {
				const symbol = data.currency === "USD" ? "$" : "¥";
				const amount = Number(data.balance);
				return symbol + (Number.isFinite(amount) ? amount.toFixed(2) : String(data.balance ?? "—"));
			};

			/**
			 * 翻到背面时取一次余额，两行都画上。
			 *
			 * 只有余额一个数据源：宿主拿 DSH 凭据去问 DeepSeek 官方接口。
			 * （原来的「今日已用」本地记账已按用户要求整体删除。）
			 */
			let balanceRequest = 0;
			const loadBackFace = async () => {
				const request = ++balanceRequest;
				balanceState = "loading";
				paintBalance("取得中", "RESOLVING");
				try {
					const { response, data } = await fetchLocal(BALANCE_ROUTE, { credentials: "same-origin" });
					if (disposed || request !== balanceRequest) return;
					if (response.status === 404) {
						balanceState = "unsupported"; paintBalance("未対応", "NO HOST ROUTE"); return;
					}
					if (!response.ok || data?.ok !== true || typeof data.balance !== "number" || !Number.isFinite(data.balance)) {
						balanceState = "failed";
						const code = data?.code || "ERROR";
						paintBalance("取得不可", FAILURE_LABEL[code] || (/^HTTP_/.test(code) ? "HTTP " + code.slice(5) : "BALANCE N/A"));
					} else { balanceState = "ready"; paintBalance(formatAmount(data), "残高"); }
				} catch (error) {
					if (disposed || request !== balanceRequest) return;
					balanceState = "failed";
					paintBalance("取得不可", error?.name === "AbortError" ? "请求超时" : "网络失败");
				}
			};

			// 仪表与时钟共用基准宽度；标签翻面或倒计时变化不再影响组件宽度。
			const stack = layer.querySelector(".eva-corner-stack");

			// ============================================================
			// TPS / 解码速度波形（中央教条区下方）
			// ------------------------------------------------------------
			// 数据源是 DSH 自己的 sessionStats 投影 —— 界面上那个「257 tok/s」就是它算的：
			//   tps = decodeTokens / (decodeMs / 1000)
			// 但那是**会话累计均值**，画出来几乎是条直线。所以这里取投影的原始分量，
			// 按采样间隔求增量，得到该区间内的**瞬时**解码速度 —— 那才是有波动的曲线。
			// ============================================================
			const tpsLine = layer.querySelector(".eva-tps-line");
			const tpsNow = layer.querySelector(".eva-tps-now");
			const tpsPeak = layer.querySelector(".eva-tps-peak");
			const tpsAvg = layer.querySelector(".eva-tps-avg");
			const TPS_SAMPLES = 44;
			const tpsBuffer = new Array(TPS_SAMPLES).fill(0);
			let tpsPrev = null;
			let tpsSessionId = null;

			/** 当前会话 id：会话区域上的 data-conversation-session（形如 session-<uuid>）。 */
			const domSessionId = () => {
				try {
					const host = document.querySelector("[data-conversation-session]");
					return host ? host.getAttribute("data-conversation-session") : null;
				} catch (error) {
					return null;
				}
			};

			/** 读当前会话的 sessionStats 投影；拿不到就返回 null（波形照画，只是没数据）。 */
			const readStats = () => {
				try {
					if (!sessionsRef || typeof sessionsRef.binding !== "function") return null;
					const raw = domSessionId();
					if (!raw) return null;
					const bare = raw.replace(/^session-/, "");
					const binding =
						sessionsRef.binding(raw) || sessionsRef.binding(bare) || sessionsRef.binding("session-" + bare);
					const projections = binding && binding.session && binding.session.projections;
					const face = projections && typeof projections.faceOf === "function"
						? projections.faceOf("sessionStats")
						: null;
					return face && typeof face.getSnapshot === "function" ? face.getSnapshot() : null;
				} catch (error) {
					return null;
				}
			};

			const drawTps = (instant) => {
				if (!tpsLine) return;
				const peak = Math.max(...tpsBuffer);
				const avg = tpsBuffer.reduce((sum, value) => sum + value, 0) / tpsBuffer.length;
				// 纵轴自适应，但保底 60：空闲时不把噪声放大成满屏波形
				const top = Math.max(60, peak * 1.15);
				let points = "";
				for (let i = 0; i < TPS_SAMPLES; i += 1) {
					const x = (i / (TPS_SAMPLES - 1)) * 200;
					const y = 55 - Math.min(1, tpsBuffer[i] / top) * 52;
					points += (i > 0 ? " " : "") + x.toFixed(1) + "," + y.toFixed(1);
				}
				tpsLine.setAttribute("points", points);
				tpsNow.textContent = instant > 0 ? String(Math.round(instant)) : "—";
				tpsPeak.textContent = peak > 0 ? String(Math.round(peak)) : "—";
				tpsAvg.textContent = avg > 0 ? String(Math.round(avg)) : "—";
			};

			const sampleTps = () => {
				if (disposed || document.hidden || (!options.hud && !options.clock)) return;
				const sessionId = domSessionId();
				if (sessionId !== tpsSessionId) { tpsPrev = null; tpsBuffer.fill(0); tpsSessionId = sessionId; }
				let instant = 0;
				const stats = readStats();
				const tokens = stats ? Number(stats.decodeTokens) : NaN;
				const ms = stats ? Number(stats.decodeMs) : NaN;
				if (Number.isFinite(tokens) && Number.isFinite(ms)) {
					if (tpsPrev) {
						const deltaTokens = tokens - tpsPrev.tokens;
						const deltaMs = ms - tpsPrev.ms;
						// 增量 / 增量：这一段区间内的真实解码速度
						if (deltaTokens > 0 && deltaMs > 0) instant = deltaTokens / (deltaMs / 1000);
					}
					tpsPrev = { tokens, ms };
				}
				tpsBuffer.push(instant);
				tpsBuffer.shift();
				drawTps(instant);
				// 把原始分量写进 title：出问题时能一眼看出是"读不到投影"还是"确实没在生成"
				const panel = layer.querySelector(".eva-tps");
				if (panel) {
					panel.title = Number.isFinite(tokens) && Number.isFinite(ms)
						? "decodeTokens=" + tokens + " decodeMs=" + Math.round(ms) + " 瞬时=" + instant.toFixed(1) + " tok/s"
						: "读不到 sessionStats 投影（sessions 服务未就绪或没有当前会话）";
				}
			};
			let tpsTimer = null;
			drawTps(0);

			const tagsEl = layer.querySelector(".eva-tags");
			/** 自动翻回的定时器。 */
			let flipBackTimer = null;
			/**
			 * 翻面。
			 *
			 * 翻到背面展示余额，**8 秒后自动翻回** —— 用的是同一个 CSS transition，
			 * 所以来回动画完全一致。中途再点一下也会即时翻回（并取消待执行的定时器）。
			 */
			const flipTags = (force) => {
				const toBack = typeof force === "boolean" ? force : tagsEl.dataset.face !== "back";
				tagsEl.dataset.face = toBack ? "back" : "front";
				tagsEl.setAttribute("aria-label", toBack ? "返回计费状态" : "查看账户余额");
				layer.querySelector(".eva-tags-front").setAttribute("aria-hidden", String(toBack));
				layer.querySelector(".eva-tags-back").setAttribute("aria-hidden", String(!toBack));
				if (flipBackTimer !== null) {
					clearTimeout(flipBackTimer);
					flipBackTimer = null;
				}
				if (!toBack) return;
				loadBackFace();
				flipBackTimer = setTimeout(() => {
					flipBackTimer = null;
					flipTags(false);
				}, AUTO_FLIP_BACK_MS);
			};
			tagsEl.addEventListener("click", flipTags);
			tagsEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					flipTags();
				}
			});

			// 设置入口保留在仪表上；布局按实测盒子与可见视口计算，不使用固定基宽。
			paintOptions(options);
			const hudEl = layer.querySelector(".eva-hud");
			const hudMini = layer.querySelector(".eva-hud-mini");
			const hudMiniImg = hudMini.querySelector("img");
			const hudMiniName = hudMini.querySelector("b");
			const { panel, refresh: refreshPanel } = buildPanel(options, setOption, resetAll);
			layer.appendChild(panel);
			panel.id = PACKAGE_NAME + ":panel";
			refreshPanelRef = refreshPanel;
			refreshTagsRef = renderTags;
			hudEl.setAttribute("role", "button");
			hudEl.setAttribute("tabindex", "0");
			hudEl.setAttribute("aria-label", "EVA 角色主题显示设定");
			hudEl.setAttribute("aria-controls", panel.id);
			hudEl.setAttribute("aria-expanded", "false");
			hudEl.title = "点击打开显示设定";
			layer.querySelector(".eva-tags-back").setAttribute("aria-hidden", "true");
			tagsEl.setAttribute("aria-label", "查看账户余额");

			// 布局使用 CSS 视口坐标；组件保留用户设定倍率，跟随页面原生缩放。
			const viewport = () => {
				const vv = window.visualViewport;
				const left = vv?.offsetLeft || 0, top = vv?.offsetTop || 0;
				const width = vv?.width || window.innerWidth, height = vv?.height || window.innerHeight;
				return { left, top, width, height, right: left + width, bottom: top + height };
			};
			const css = (el, key, value) => { if (el.style[key] !== value) el.style[key] = value; };
			const variable = (key, value) => {
				if (layer.style.getPropertyValue(key) !== value) layer.style.setProperty(key, value);
			};
			let layoutFrame = null;
			/** 整个仪表栈收起：只留右下角角色小框。 */
			let stackHidden = false;
			let resizeObserver = null;
			let observed = [];
			const bindSizeObservers = (elements) => {
				if (!resizeObserver || elements.length === observed.length && elements.every((el, i) => el === observed[i])) return;
				resizeObserver.disconnect();
				observed = elements;
				for (const element of observed) resizeObserver.observe(element);
			};

			const placePanel = (bounds, gap, head, anchorRight = null) => {
				if (panel.hidden) return;
				const top = Math.min(bounds.bottom - gap - 1, Math.max(bounds.top + gap, (head?.bottom || bounds.top) + 12));
				const room = Math.max(1, bounds.bottom - top - gap);
				const narrow = window.innerWidth < 760;
				const available = (anchorRight === null ? bounds.width : Math.max(200, anchorRight - bounds.left)) - gap * 2;
				const width = Math.max(1, Math.min(360, available));
				panel.dataset.dock = narrow ? "bottom" : "left";
				css(panel, "width", width + "px");
				css(panel, "left", (anchorRight === null ? bounds.left + gap : Math.max(bounds.left + gap, anchorRight - width - gap)) + "px");
				css(panel, "top", narrow ? "auto" : top + "px");
				css(panel, "bottom", narrow ? window.innerHeight - bounds.bottom + gap + "px" : "auto");
				css(panel, "maxHeight", Math.min(640, room, narrow ? bounds.height * .7 : room) + "px");
			};

			const portrait = layer.querySelector(".eva-character-portrait");
			const railTab = layer.querySelector(".eva-rail-tab");
			const railScrim = layer.querySelector(".eva-rail-scrim");
			/**
			 * 会话列让位：只给会话头与会话体加右边距，不碰应用自己的网格列。
			 * React 换掉节点时由布局观察器重新挂上，所以每次布局都写一次（值相同时不触发样式变更）。
			 */
			const applyHostInset = (width) => {
				const panes = [...document.querySelectorAll("[data-dockkit-pane]")];
				const pane = panes.find((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
				for (const node of [document.querySelector(HOST_HOOKS.header), document.querySelector(HOST_HOOKS.region), pane]) {
					if (node) css(node, "marginRight", width > 0 ? width + "px" : "");
				}
			};
			/** 记录对话页最后一次的仪表栏尺寸，插件页沿用同一尺寸，避免因缺少输入框/头部而“恢复原样”。 */
			let chatRailMetrics = null;
			/** 窄窗抽屉的开关；只有 railMode 为 tab / drawer 时才有意义。 */
			let railOpen = false;
			/** 手动收起右侧仪表边栏。 */
			let railCollapsed = false;
			const setRailOpen = (open) => {
				railOpen = Boolean(open);
				if (railTab) {
					railTab.setAttribute("aria-expanded", String(railOpen));
					railTab.setAttribute("aria-label", railOpen ? "收起仪表边栏" : "展开仪表边栏");
					const label = railTab.querySelector("span");
					if (label) label.textContent = railOpen ? "关闭" : "仪表";
				}
				layout();
			};
			layer.querySelector(".eva-rail-hide-tab")?.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				railCollapsed = true;
				layout();
			});
			railTab?.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (railCollapsed) { railCollapsed = false; layout(); return; }
				if (layer.dataset.rail === "on") { railCollapsed = true; layout(); return; }
				setRailOpen(!railOpen);
			});
			railScrim?.addEventListener("pointerdown", (event) => {
				event.preventDefault();
				event.stopPropagation();
				setRailOpen(false);
			});

			const layout = () => {
				if (disposed || document.hidden) return;
				const screenBounds = viewport();
				const bounds = { ...screenBounds };
				const header = document.querySelector(HOST_HOOKS.header);
				const composer = document.querySelector(HOST_HOOKS.composer);
				const region = document.querySelector(HOST_HOOKS.region);
				if (stackHidden) {
					layer.dataset.rail = "off";
					applyHostInset(0);
					clockEl.hidden = true; mpEl.hidden = true; mpExtras.hidden = true; stack.hidden = true; mediaSuspended = true;
					if (tpsPanelEl) tpsPanelEl.hidden = true;
					hudMini.style.display = "flex";
					return;
				}
				const rightPanel = document.querySelector("[data-sidebar-right-panel][data-sidebar-right-open]");
				const dockPane = [...document.querySelectorAll("[data-dockkit-pane]")].find((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
				const regionBox = region?.getBoundingClientRect();
				const contentBox = regionBox?.width > 0 ? regionBox : null;
				if (contentBox && contentBox.width > 0 && contentBox.right > bounds.left && contentBox.left < bounds.right) {
					bounds.left = Math.max(bounds.left, contentBox.left);
					bounds.right = Math.min(bounds.right, contentBox.right);
					bounds.width = bounds.right - bounds.left;
				}
				const gap = bounds.width < 640 ? 8 : 18;
				bindSizeObservers([document.documentElement, document.body, header, composer, region, dockPane].filter(Boolean));
				const head = header?.getBoundingClientRect();
				const rawCard = composer?.getBoundingClientRect();
				const card = rawCard?.width > 0 && rawCard.height > 0 ? rawCard : null;

				// 宿主右栏（文件/终端/浏览器）展开时整体退场，避免盖住宿主面板。
				if (rightPanel) {
					layer.dataset.rail = "off";
					applyHostInset(0);
					stack.hidden = false;
					stack.dataset.fit = "minimal";
					portrait.hidden = true; clockEl.hidden = true; mpEl.hidden = true; mpExtras.hidden = true; mediaSuspended = true;
					if (tpsPanelEl) tpsPanelEl.hidden = true;
					stack.style.setProperty("--eva-hud-scale", String(options.hudScale));
					css(stack, "right", window.innerWidth - screenBounds.right + gap + "px");
					css(stack, "bottom", window.innerHeight - screenBounds.bottom + gap + "px");
					// 全屏右栏保留一个最小设置入口；push 模式则完全让位。
					stack.hidden = rightPanel.getAttribute("data-sidebar-right-panel") !== "fullscreen";
					placePanel(screenBounds, gap, null);
					return;
				}

				// 对话页的判据：会话头或输入框可见。插件页缺少这些元素，但仪表栏仍沿用对话页的尺寸。
				const chatVisible = [header, composer].some((node) => {
					if (!node) return false;
					const rect = node.getBoundingClientRect();
					if (!(rect.width > 0 && rect.height > 0)) return false;
					const style = getComputedStyle(node);
					if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
					if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
					return true;
				});

				mediaSuspended = false;
				stack.hidden = false;
				if (tpsPanelEl) tpsPanelEl.hidden = !chatVisible;
				// 左侧立绘以会话半宽为目标；腰部贴输入框，空间不足时等比收小以保留头部。
				const portraitMinTop = Math.max(bounds.top + gap, (head?.bottom || bounds.top + 64) + 10);
				const portraitBottom = Math.min(bounds.bottom, card ? card.top : bounds.bottom - gap);
				const portraitRoom = Math.max(0, portraitBottom - portraitMinTop);
				portrait.hidden = portraitRoom === 0 || !chatVisible;
				const portraitWidth = Math.min(bounds.width * .5, portraitRoom * 2 / 3);
				const portraitHeight = portraitWidth * 1.5;
				const portraitTop = portraitBottom - portraitHeight;
				variable("--eva-portrait-left", bounds.left + gap + (bounds.width > 900 ? 12 : 0) + portraitWidth / 6 + "px");
				variable("--eva-portrait-top", portraitTop + "px");
				variable("--eva-portrait-width", portraitWidth + "px");
				variable("--eva-portrait-height", portraitHeight + "px");

				// —— 侧边栏：按组件真实宽度求栏宽；窗口不够宽时收成一条拉手 ——
				const clockBase = clockRenderScale(options.clockScale);
				const hudBase = options.hudScale;
				const widgetWidth = Math.max(CLOCK_PANEL_WIDTH * clockBase, CLOCK_PANEL_WIDTH * CLOCK_SCALE_UNIT * hudBase);
				let railMode = "off";
				let rail = 0;
				if (options.rail && region) {
					const want = Math.max(210, Math.round(widgetWidth + 24));
					const cap = Math.min(380, Math.round(screenBounds.width * .44));
					rail = Math.max(200, Math.min(want, cap));
					if (screenBounds.width - rail < 320) rail = screenBounds.width - 320;
					railMode = screenBounds.width < 560 || rail < 190 ? (railOpen ? "drawer" : "tab") : "on";
				}
				if (railMode === "tab" || railMode === "drawer") {
					rail = railMode === "drawer" ? Math.min(340, Math.max(200, Math.round(screenBounds.width - 40))) : 28;
				}
				layer.dataset.rail = railMode;
				if (railMode === "on" && railTab) {
					railTab.setAttribute("aria-expanded", String(!railCollapsed));
					railTab.setAttribute("aria-label", railCollapsed ? "展开仪表边栏" : "收起仪表边栏");
					const railTabLabel = railTab.querySelector("span");
					if (railTabLabel) railTabLabel.textContent = railCollapsed ? "仪表" : "收起";
				}
				if (railMode !== "off") variable("--eva-rail-width", rail + "px");
				applyHostInset(railMode === "on" ? rail : railMode === "off" ? 0 : 28);

				if (railCollapsed && railMode === "on") {
					layer.dataset.rail = "collapsed";
					applyHostInset(0);
					clockEl.hidden = true; mpEl.hidden = true; stack.hidden = true; mpExtras.hidden = true; mediaSuspended = true;
					if (tpsPanelEl) tpsPanelEl.hidden = true;
					if (railTab) { railTab.setAttribute("aria-expanded", "false"); const label = railTab.querySelector("span"); if (label) label.textContent = "仪表"; }
					placePanel(bounds, gap, head);
					return;
				}

				if (railMode === "tab") {
					clockEl.hidden = true; mpEl.hidden = true; stack.hidden = true; mpExtras.hidden = true; mpTabs.hidden = true;
					placePanel(bounds, gap, head);
					return;
				}

				if (railMode === "on" || railMode === "drawer") {
					let railLeft = screenBounds.right - rail;
					const fit = Math.min(1, Math.max(1, rail - 24) / Math.max(widgetWidth, 1));
					let clockScale = clockBase * fit * options.floatScale;
					let hudScale = hudBase * fit * options.floatScale;
					clockEl.hidden = !options.clock;
					mpEl.hidden = !options.music || !npInfo;
					mpEl.dataset.compact = "false";
					stack.dataset.fit = "full";
					if (tpsPanelEl) tpsPanelEl.hidden = false;
					let top = Math.max(screenBounds.top + gap, (head?.bottom || screenBounds.top + 64) + 10);
					const railBottom = screenBounds.bottom - gap;
					// 高度不足时先整列等比缩小，保留所有组件；缩到极限再把允许的部分收起。
					if (options.fitShrink) {
						const clockPart = clockEl.hidden ? 0 : clockEl.offsetHeight + 10;
						const mpPart = mpEl.hidden ? 0 : mpEl.offsetHeight + (!mpExtras.hidden ? 8 + mpExtras.offsetHeight : 0);
						const totalHeight = (clockPart + mpPart) * clockScale + stack.offsetHeight * hudScale + 10;
						const available = railBottom - top - 10;
						if (totalHeight > available && totalHeight > 0) {
							const ratio = Math.max(0.45, available / totalHeight);
							clockScale *= ratio;
							hudScale *= ratio;
						}
					}
					if (railMode === "on") {
						const visualWidgetWidth = Math.max(CLOCK_PANEL_WIDTH * clockScale, CLOCK_PANEL_WIDTH * CLOCK_SCALE_UNIT * hudScale);
						const huggedRail = Math.max(200, Math.round(visualWidgetWidth + 24));
						if (huggedRail < rail) {
							rail = huggedRail;
							variable("--eva-rail-width", rail + "px");
							applyHostInset(rail);
							railLeft = screenBounds.right - rail;
						}
					}
					if (railMode === "on") {
						if (chatVisible) {
							chatRailMetrics = { rail, clockScale, hudScale, top };
						} else if (chatRailMetrics) {
							rail = chatRailMetrics.rail;
							clockScale = chatRailMetrics.clockScale;
							hudScale = chatRailMetrics.hudScale;
							top = chatRailMetrics.top;
							railLeft = screenBounds.right - rail;
							variable("--eva-rail-width", rail + "px");
							applyHostInset(rail);
						}
					}
					clockEl.style.setProperty("--eva-clock-scale", String(clockScale));
					mpEl.style.setProperty("--eva-clock-scale", String(clockScale));
					stack.style.setProperty("--eva-hud-scale", String(hudScale));
					stack.style.setProperty("--eva-hud-hazard-ratio", (clockScale / hudScale).toFixed(4));
					const clockWidth = CLOCK_PANEL_WIDTH * clockScale;
					const clockLeft = Math.round(railLeft + (rail - clockWidth) / 2);
					css(clockEl, "left", clockLeft + "px");
					css(clockEl, "top", top + "px");
					const clockHeight = clockEl.hidden ? 0 : clockEl.offsetHeight * clockScale;
					css(mpEl, "left", clockLeft + "px");
					css(mpEl, "top", top + clockHeight + (clockHeight ? 10 : 0) + "px");
					mpExtras.style.setProperty("--eva-clock-scale", String(clockScale));
					const mpHeight = mpEl.hidden ? 0 : mpEl.offsetHeight * clockScale;
					if (!mpExtras.hidden && !mpEl.hidden) {
						css(mpExtras, "left", clockLeft + "px");
						css(mpExtras, "top", top + clockHeight + (clockHeight ? 10 : 0) + mpHeight + 8 + "px");
					} else if (mpEl.hidden) mpExtras.hidden = true;
					const stackWidth = CLOCK_PANEL_WIDTH * CLOCK_SCALE_UNIT * hudScale;
					css(stack, "right", Math.round(window.innerWidth - screenBounds.right + (rail - stackWidth) / 2) + "px");
					css(stack, "bottom", Math.round(window.innerHeight - screenBounds.bottom + gap) + "px");
					// 缩到极限仍放不下时，按设置依次收起 TPS / 标签、播放器。
					let stackHeight = stack.offsetHeight * hudScale;
					const extrasHeight = (!mpExtras.hidden && !mpEl.hidden) ? mpExtras.offsetHeight * clockScale + 8 : 0;
					const mpBottom = mpEl.hidden ? top + clockHeight : top + clockHeight + (clockHeight ? 10 : 0) + mpHeight + extrasHeight;
					if (options.fitHideStack !== false && !mpEl.hidden && mpBottom > railBottom - stackHeight - 10) {
						if (tpsPanelEl) tpsPanelEl.hidden = true;
						stackHeight = stack.offsetHeight * hudScale;
					}
					if (options.fitHideStack !== false && !mpEl.hidden && mpBottom > railBottom - stackHeight - 10) {
						stack.dataset.fit = "minimal";
						stackHeight = stack.offsetHeight * hudScale;
					}
					if (options.fitHideMusic && !mpEl.hidden && mpBottom > railBottom - stackHeight - 10) { mpEl.hidden = true; mpExtras.hidden = true; }
					placePanel(bounds, gap, head, railLeft);
					return;
				}

				// —— 关掉侧边栏时保留旧的悬浮布局 ——
				clockEl.style.removeProperty("--eva-clock-scale");
				mpEl.style.removeProperty("--eva-clock-scale");
				stack.style.removeProperty("--eva-hud-scale");
				stack.dataset.fit = "full";
				variable("--eva-hud-scale", String(options.hudScale * options.floatScale));
				css(stack, "right", window.innerWidth - bounds.right + gap + "px");
				css(stack, "bottom", window.innerHeight - bounds.bottom + gap + "px");

				const top = Math.max(bounds.top + gap, (head?.bottom || bounds.top + 64) + 10);
				clockEl.hidden = !options.clock;
				mpEl.hidden = !options.music || !npInfo;
				mpEl.dataset.compact = "false";
				const clockHeight = clockEl.hidden ? 0 : clockEl.offsetHeight;
				const clockScale = clockRenderScale(options.clockScale) * options.floatScale;
				variable("--eva-clock-scale", String(clockScale));
				variable("--eva-hud-hazard-ratio", (clockScale / (options.hudScale * options.floatScale)).toFixed(4));
				const left = bounds.right - gap - CLOCK_PANEL_WIDTH * clockScale;
				css(clockEl, "left", left + "px"); css(clockEl, "top", top + "px");
				css(mpEl, "left", left + "px"); css(mpEl, "top", top + clockHeight * clockScale + (clockHeight ? 10 : 0) + "px");
				mpExtras.style.setProperty("--eva-clock-scale", String(clockScale));
				const mpHeight = mpEl.hidden ? 0 : mpEl.offsetHeight * clockScale;
				if (!mpExtras.hidden && !mpEl.hidden) {
					css(mpExtras, "left", left + "px");
					css(mpExtras, "top", top + clockHeight * clockScale + (clockHeight ? 10 : 0) + mpHeight + 8 + "px");
				} else if (mpEl.hidden) mpExtras.hidden = true;
				placePanel(bounds, gap, head);
			};
			const scheduleLayout = () => {
				if (disposed || document.hidden || layoutFrame !== null) return;
				layoutFrame = requestAnimationFrame(() => { layoutFrame = null; layout(); syncWork(); });
			};
			if (typeof ResizeObserver === "function") resizeObserver = new ResizeObserver(scheduleLayout);
			const layoutObserver = new MutationObserver((records) => {
				const hooks = HOST_HOOKS.header + "," + HOST_HOOKS.composer + "," + HOST_HOOKS.region + ",[data-sidebar-right-panel],[data-dockkit-pane]";
				if (records.some((record) => {
					if (layer.contains(record.target)) return false;
					if (record.type === "attributes") return record.target.matches("[data-sidebar-right-panel]") || observed.some((el) => record.target === el || record.target.contains(el));
					return [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1 && (node.matches(hooks) || node.querySelector(hooks)));
				})) scheduleLayout();
			});
			layoutObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-sidebar-right-open", "data-sidebar-right-panel"] });
			layoutObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
			const themeObserver = new MutationObserver(readState);
			themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });

			const togglePanel = (open, restoreFocus = true) => {
				const willOpen = typeof open === "boolean" ? open : panel.hidden;
				const hadFocus = panel.contains(document.activeElement);
				panel.hidden = !willOpen;
				hudEl.setAttribute("aria-expanded", String(willOpen));
				if (willOpen) {
					refreshPanel(); layout();
					panel.querySelector("input[type=range],.eva-sw")?.focus({ preventScroll: true });
				} else if (restoreFocus && hadFocus) hudEl.focus({ preventScroll: true });
			};
			panel.querySelector(".eva-panel-close").addEventListener("click", () => togglePanel(false));
			panel.querySelector(".eva-replay-boot").addEventListener("click", () => togglePanel(false, false));
			const syncMiniAvatar = () => {
				// 主题的明/暗模式就是绫波丽/明日香两套视觉：亮色为丽（蓝），暗色为明日香（红）。
				const rei = !document.body.hasAttribute("data-ds-dark-theme");
				const name = rei ? "綾波レイ" : "明日香";
				const src = rei ? BRAND_ASSETS.reiMini : BRAND_ASSETS.asukaMini;
				if (hudMiniImg.getAttribute("src") !== src) hudMiniImg.src = src;
				if (hudMiniName.textContent !== name) hudMiniName.textContent = name;
			};
			syncMiniAvatar();
			new MutationObserver(syncMiniAvatar).observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
			const setStackHidden = (value) => {
				if (value === stackHidden) return;
				stackHidden = value;
				if (value) {
					syncMiniAvatar();
					hudMini.style.display = "flex";
					if (!panel.hidden) togglePanel(false, false);
					hudMini.focus({ preventScroll: true });
				} else {
					hudMini.style.display = "none";
					hudEl.focus({ preventScroll: true });
				}
				layout();
			};
			hudEl.addEventListener("click", () => togglePanel());
			hudEl.addEventListener("keydown", (event) => {
				if (event.target !== hudEl) return;
				if (event.key === "Enter" || event.key === " ") { event.preventDefault(); togglePanel(); }
			});
			const hudVlabel = hudEl.querySelector(".eva-hud-vlabel");
			hudVlabel.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); setStackHidden(true); });
			hudVlabel.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setStackHidden(true); }
			});
			hudMini.addEventListener("click", () => setStackHidden(false));
			const onHudWheel = (event) => {
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				const next = Math.round((options.hudScale + (event.deltaY < 0 ? SIZE_STEP : -SIZE_STEP)) * 100) / 100;
				setOption("hudScale", next);
			};
			hudEl.addEventListener("wheel", onHudWheel, { passive: false });
			const onDocPointerDown = (event) => {
				if (!panel.hidden && !panel.contains(event.target) && !hudEl.contains(event.target)) togglePanel(false, false);
				if (railOpen && !panel.contains(event.target) && !railTab?.contains(event.target) && !clockEl.contains(event.target) && !mpEl.contains(event.target) && !mpExtras.contains(event.target) && !stack.contains(event.target)) setRailOpen(false);
			};
			const onDocKeyDown = (event) => {
				if (event.key !== "Escape") return;
				if (!panel.hidden) togglePanel(false);
				else if (railOpen) setRailOpen(false);
			};
			document.addEventListener("pointerdown", onDocPointerDown, true);
			document.addEventListener("keydown", onDocKeyDown);

			let secondsTimer = null;
			const updateReadings = () => {
				if (disposed || document.hidden) return;
				if (options.hud) renderTags();
				if (options.clock) { updateClock(); setLamps(); }
			};
			const syncWork = () => {
				const active = !document.hidden;
				layer.toggleAttribute("data-paused", !active);
				if (active && (options.hud && stack.dataset.fit !== "minimal" || options.clock && !clockEl.hidden)) {
					if (secondsTimer === null) secondsTimer = setInterval(updateReadings, 1000);
					if (tpsTimer === null) tpsTimer = setInterval(sampleTps, 400);
				} else {
					clearInterval(secondsTimer); secondsTimer = null;
					clearInterval(tpsTimer); tpsTimer = null; tpsPrev = null;
				}
				if (active && options.music && !mediaSuspended && npSupported) {
					if (npTimer === null && !npBusy && !npControlling) npPoll();
				} else { clearTimeout(npTimer); npTimer = null; }
			};
			const onVisibility = () => { syncWork(); if (!document.hidden) { updateReadings(); scheduleLayout(); } };
			refreshLayoutRef = () => { layout(); updateReadings(); syncWork(); };
			window.addEventListener("resize", scheduleLayout);
			window.visualViewport?.addEventListener("resize", scheduleLayout);
			window.visualViewport?.addEventListener("scroll", scheduleLayout);
			document.addEventListener("transitionend", scheduleLayout, true);
			document.addEventListener("visibilitychange", onVisibility);
			updateClock(); readState(); renderTags(); setLamps();
			layout(); syncWork();
			// 老内核没有 ResizeObserver 时保留低频布局兜底。
			const fallbackTimer = resizeObserver ? null : setInterval(scheduleLayout, 2000);

			return () => {
				disposed = true; stopSpectrum();
				for (const request of requests) request.abort();
				requests.clear();
				clearInterval(secondsTimer); clearInterval(tpsTimer); clearInterval(fallbackTimer);
				clearTimeout(npTimer); clearTimeout(npEnterTimer); clearTimeout(flipBackTimer); npCommands.length = 0;
				if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
				window.removeEventListener("resize", scheduleLayout);
				window.visualViewport?.removeEventListener("resize", scheduleLayout);
				window.visualViewport?.removeEventListener("scroll", scheduleLayout);
				document.removeEventListener("transitionend", scheduleLayout, true);
				document.removeEventListener("visibilitychange", onVisibility);
				document.removeEventListener("pointerdown", onDocPointerDown, true);
				document.removeEventListener("keydown", onDocKeyDown);
				resizeObserver?.disconnect(); layoutObserver.disconnect(); themeObserver.disconnect();
				refreshTagsRef = null; refreshPanelRef = null; refreshLayoutRef = null;
				applyHostInset(0);
				layer.remove();
				const root = document.documentElement;
				root.removeAttribute("data-eva-magi");
				for (const attr of Object.values(OPTION_ATTRS)) root.removeAttribute(attr);
				for (const key of ["--eva-tps-width", "--eva-scan-strength", "--eva-hud-scale", "--eva-hud-scale-inv", "--eva-clock-scale", "--eva-clock-text-scale", "--eva-wallpaper-strength"]) root.style.removeProperty(key);
			};
		}

		/** 只订阅宿主状态，不回答审核、不创建会话，也不把历史回放当作任务完成。 */
		function mountAttentionSounds(ctx, options) {
			const sessions = ctx.sessions, status = ctx.uiSession?.sessionStatus;
			if (typeof sessions?.list?.subscribe !== "function" || typeof status?.subscribe !== "function") return () => {};
			let disposed = false, audio = null, active = null, generation = 0, deadline = null, blocked = false, previewId = 0;
			let queue = [];
			const bindings = new Map(), seenApprovals = new Set();
			const fresh = (item) => options.attentionSound && Date.now() - item.at < 60000 && item.valid();
			const paintPlayback = () => {
				for (const button of document.querySelectorAll("[data-attention-preview]")) {
					const label = button.dataset.attentionPreview === "approval" ? "审核" : "完成";
					const playing = Boolean(active?.preview && active.started && active.kind === button.dataset.attentionPreview && !blocked);
					button.setAttribute("aria-pressed", String(playing)); button.textContent = playing ? "停止" + label + "试听" : "试听" + label + "提醒";
					button.title = playing ? PILOTS[audio.dataset.pilot].name + " · " + label + "提醒播放中" : "播放当前主题的" + label + "语音";
				}
			};
			const release = () => {
				generation++; clearTimeout(deadline); deadline = null; active = null; blocked = false;
				if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
				paintPlayback();
			};
			const finish = () => { release(); pump(); };
			const attempt = () => {
				const current = active, serial = ++generation;
				blocked = false;
				const failed = (error) => {
					if (disposed || serial !== generation || active !== current) return;
					if (error?.name === "NotAllowedError") { blocked = true; paintPlayback(); }
					else finish();
				};
				try { Promise.resolve(audio.play()).then(() => {
					if (!disposed && serial === generation && active === current) { active.started = true; paintPlayback(); }
				}, failed); } catch (error) { failed(error); }
			};
			const pump = () => {
				if (disposed || active || !options.attentionSound || document.querySelector(".eva-boot,.eva-welcome-voice")) return;
				queue = queue.filter(fresh);
				const item = queue.shift(); if (!item) return;
				if (!audio) {
					audio = document.createElement("audio"); audio.className = "eva-attention-audio"; audio.hidden = true;
					audio.setAttribute("aria-hidden", "true"); audio.preload = "auto"; audio.volume = .85;
					audio.addEventListener("ended", finish); audio.addEventListener("error", finish); document.body.appendChild(audio);
				}
				const pilot = document.body.hasAttribute("data-ds-dark-theme") ? "asuka" : "rei";
				active = item; audio.dataset.kind = item.kind; audio.dataset.pilot = pilot;
				audio.src = BRAND_ASSETS[pilot + (item.kind === "approval" ? "Approval" : "Complete")]; audio.load();
				deadline = setTimeout(finish, 15000); attempt();
			};
			const enqueue = (kind, valid, preview = false) => {
				if (disposed || !options.attentionSound) return false;
				if (preview) {
					queue = queue.filter(item => !item.preview);
					if (active?.preview) release();
				}
				const item = { kind, valid, preview, at: Date.now() };
				// 人工审核优先于排队的完成提醒；一个音源串行播放，避免多会话叠音。
				if (kind === "approval") queue.unshift(item); else queue.push(item);
				if (queue.length > 8) queue.pop(); pump(); return true;
			};
			const isPending = (id, key) => {
				const pending = status.getSnapshot().get(id)?.pendingInteraction;
				return pending?.kind === "approval" && pending.key === key && pending.answerable;
			};
			const scanApprovals = () => {
				for (const [id, value] of status.getSnapshot()) {
					const pending = value.pendingInteraction;
					if (pending?.kind !== "approval" || !pending.answerable) continue;
					const key = id + ":" + pending.key;
					if (seenApprovals.has(key)) continue;
					seenApprovals.add(key);
					if (seenApprovals.size > 1024) seenApprovals.delete(seenApprovals.values().next().value);
					enqueue("approval", () => isPending(id, pending.key));
				}
				queue = queue.filter(fresh);
				if (active && !fresh(active)) release(); pump();
			};
			const scanSessions = () => {
				const list = sessions.list.getSnapshot(), present = new Set();
				for (const id of Object.keys(list.byId)) {
					if (list.byId[id].origin === "subagent") continue;
					const binding = sessions.binding(id), source = binding?.eventSource;
					if (typeof source?.subscribe !== "function" || binding.session?.getSnapshot().subagent) continue;
					present.add(id);
					if (bindings.get(id)?.binding === binding) continue;
					bindings.get(id)?.stop();
					const record = { binding, watermark: -1, version: 0, stop: null };
					const seed = (snapshot) => {
						record.version++; record.watermark = -1;
						for (const { event } of snapshot.entries) if (Number.isInteger(event.seq)) record.watermark = Math.max(record.watermark, event.seq);
					};
					seed(source.getSnapshot());
					record.stop = source.subscribe(() => {
						const snapshot = source.getSnapshot(), change = snapshot.change;
						if (change.kind === "replace") { seed(snapshot); return; }
						if (change.kind !== "append") return;
						for (const { event } of change.entries) {
							if (!Number.isInteger(event.seq) || event.seq <= record.watermark) continue;
							const { seq, type, data } = event; record.watermark = seq;
							if (type !== "turn/end" || data.reason.kind !== "completed") continue;
							const version = record.version;
							enqueue("complete", () => bindings.get(id) === record && record.version === version);
						}
					});
					bindings.set(id, record);
				}
				for (const [id, record] of bindings) if (!present.has(id)) { record.stop(); bindings.delete(id); }
			};
			const preview = (kind) => {
				if (!["approval", "complete"].includes(kind)) return false;
				if (active?.preview && active.kind === kind && !blocked) { previewId++; release(); pump(); return true; }
				const id = ++previewId; return enqueue(kind, () => id === previewId, true);
			};
			const refresh = () => {
				if (!options.attentionSound) { queue = []; release(); } else pump();
			};
			const onGesture = () => {
				if (!blocked || !active) return;
				if (!fresh(active)) finish(); else attempt();
			};
			let observedBootHost = null;
			const observeBootHost = () => {
				const host = themeOverlayHost();
				if (host === observedBootHost) return;
				bootObserver.disconnect();
				bootObserver.observe(document.body, { childList: true });
				if (host !== document.body) bootObserver.observe(host, { childList: true });
				observedBootHost = host;
			};
			const bootObserver = new MutationObserver(() => {
				observeBootHost();
				if (document.querySelector(".eva-boot,.eva-welcome-voice")) {
					if (active) { const item = active; release(); queue.unshift(item); }
				} else pump();
			});
			observeBootHost();
			document.addEventListener("pointerdown", onGesture, true); document.addEventListener("keydown", onGesture, true);
			const stopStatus = status.subscribe(scanApprovals), stopList = sessions.list.subscribe(scanSessions);
			previewAttentionRef = preview; refreshAttentionRef = refresh;
			scanSessions(); scanApprovals();
			return () => {
				disposed = true; queue = []; release(); bootObserver.disconnect(); stopStatus(); stopList();
				for (const record of bindings.values()) record.stop(); bindings.clear(); seenApprovals.clear();
				document.removeEventListener("pointerdown", onGesture, true); document.removeEventListener("keydown", onGesture, true);
				if (audio) { audio.removeEventListener("ended", finish); audio.removeEventListener("error", finish); audio.remove(); }
				if (previewAttentionRef === preview) previewAttentionRef = null;
				if (refreshAttentionRef === refresh) refreshAttentionRef = null;
			};
		}

		/** 启动状态机：主题只走宿主 setTheme；进度只跟随真实音频时钟。 */
		function mountBoot(ctx) {
			const el = document.createElement("div");
			el.className = "eva-boot"; el.dataset.phase = "gif"; el.setAttribute("aria-hidden", "true");
			el.innerHTML = '<img class="eva-boot-gif" alt="" width="256" height="256" decoding="async">';
			const img = el.firstElementChild, media = window.matchMedia("(prefers-reduced-motion: reduce)");
			const bgm = document.createElement("audio"), soundButton = document.createElement("button");
			bgm.className = "eva-boot-bgm"; bgm.preload = "auto"; bgm.loop = true; bgm.volume = 0;
			bgm.src = BRAND_ASSETS.bootBgm;
			soundButton.type = "button"; soundButton.className = "eva-boot-sound"; soundButton.setAttribute("aria-label", "启动背景音乐");
			soundButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="eva-sound-slash" d="m3 3 18 18"/></svg>';
			const previousFocus = document.activeElement, listeners = [], inertNodes = new Map();
			// Warm both themes while the GIF/alarm is playing; drop never starts a large portrait decode.
			const warmImages = ["asukaHead", "reiHead", "asukaPortrait", "reiPortrait"].map(key => {
				const image = new Image(); image.src = BRAND_ASSETS[key]; image.decode?.().catch(() => {}); return image;
			});
			let disposed = false, gifTimer = null, deadline = null, enterTimer = null, progressFrame = null, focusFrame = null, bgmFrame = null, emergencyTimer = null, emergencyClockTimer = null;
			let emergency = null, emergencyNext = null, stopContours = null;
			let intro = null, introTimer = null, typeTimer = null, revealTimer = null, introFlight = null, flightAnimation = null, selectionAnimation = null;
			let bgmWanted = true, bgmStarting = false;
			let typingAudio = null, welcomeAudio = null, welcomeTimer = null, welcomeCleanup = null;
			let audio = null, consoleEl = null, status = null, bay = null, resume = null, progress = null, fill = null, percent = null, time = null;
			let selected = null, drag = null, suppressClick = false, syncValue = null, syncOrbit = null;
			let pickAudio = null, pickPilot = null, pointerPilot = null, pickActive = false, waitingForPick = false, pickTimer = null, pickCleanup = null, pickGeneration = 0;
			let themeSweep = null, themeTimer = null;
			let language = "zh-CN", statusKey = "waiting", resumeKey = "resume";
			try { const saved = localStorage.getItem(BOOT_LANGUAGE_KEY); if (Object.hasOwn(BOOT_COPY, saved)) language = saved; } catch { /* 存储受限时仍可即时切换。 */ }
			const text = (key) => BOOT_COPY[language][key].replace("{pilot}", BOOT_COPY[language][selected || pickPilot || "asuka"]);
			const listen = (target, type, handler, options) => {
				target.addEventListener(type, handler, options); listeners.push(() => target.removeEventListener(type, handler, options));
			};
			const paintSound = () => {
				const playing = bgmWanted && !bgm.paused;
				soundButton.setAttribute("aria-pressed", String(playing));
				soundButton.setAttribute("aria-label", text("bgm")); soundButton.title = text(playing ? "bgmOn" : "bgmOff");
			};
			const fadeBgm = (target, duration = 260) => {
				if (bgmFrame !== null) cancelAnimationFrame(bgmFrame); bgmFrame = null;
				if (disposed) return;
				if (bgm.paused) { bgm.volume = target; return; }
				const from = bgm.volume, start = performance.now();
				const step = (now) => {
					bgmFrame = null; if (disposed || document.hidden) return;
					const ratio = Math.max(0, Math.min(1, (now - start) / duration)); bgm.volume = Math.max(0, Math.min(1, from + (target - from) * ratio));
					if (ratio < 1) bgmFrame = requestAnimationFrame(step);
				};
				bgmFrame = requestAnimationFrame(step);
			};
			const playBgm = () => {
				if (disposed || !bgmWanted || bgmStarting || !bgm.paused || document.hidden || el.dataset.phase === "handoff") return;
				bgmStarting = true;
				try { Promise.resolve(bgm.play()).then(() => { bgmStarting = false; if (!disposed) paintSound(); }, () => { bgmStarting = false; if (!disposed) paintSound(); }); }
				catch { bgmStarting = false; paintSound(); }
			};
			listen(bgm, "playing", () => { if (!disposed) { paintSound(); fadeBgm(el.dataset.phase === "loading" || pickActive ? .075 : .28, 450); } });
			listen(bgm, "pause", paintSound);
			listen(bgm, "error", () => { if (!disposed) { bgm.pause(); paintSound(); } });
			listen(soundButton, "click", () => {
				if (!bgm.paused) { bgmWanted = false; bgm.pause(); if (bgmFrame !== null) cancelAnimationFrame(bgmFrame); bgmFrame = null; }
				else { bgmWanted = true; playBgm(); }
				paintSound();
			});
			listen(el, "pointerdown", (event) => { if (!soundButton.contains(event.target)) playBgm(); }, true);
			listen(el, "keydown", (event) => { if (event.key !== "Escape" && !soundButton.contains(event.target)) playBgm(); });
			paintSound();
			const releaseBackground = () => { for (const [node, inert] of inertNodes) node.inert = inert; inertNodes.clear(); };
			const holdBackground = () => {
				// Isolate siblings along the ancestor chain, never an ancestor of this dialog.
				for (let node = el; node && node !== document.body; node = node.parentElement) {
					for (const sibling of node.parentElement?.children || []) {
						if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
						inertNodes.set(sibling, sibling.inert); sibling.inert = true;
					}
				}
			};
			const clearEmergency = () => {
				clearTimeout(emergencyTimer); clearInterval(emergencyClockTimer); emergencyTimer = emergencyClockTimer = null;
				emergency?.remove(); emergencyNext?.remove(); emergency = emergencyNext = null;
			};
			const stopTyping = () => {
				if (!typingAudio) return;
				typingAudio.pause(); typingAudio.removeAttribute("src"); typingAudio.load(); typingAudio.remove(); typingAudio = null;
			};
			const stopWelcome = () => {
				clearTimeout(welcomeTimer); welcomeTimer = null; welcomeCleanup?.(); welcomeCleanup = null;
				if (!welcomeAudio) return;
				welcomeAudio.pause(); welcomeAudio.removeAttribute("src"); welcomeAudio.load(); welcomeAudio.remove(); welcomeAudio = null;
			};
			const playWelcome = () => {
				if (!selected || document.hidden) return;
				welcomeAudio = document.createElement("audio"); welcomeAudio.className = "eva-welcome-voice"; welcomeAudio.hidden = true;
				welcomeAudio.preload = "auto"; welcomeAudio.src = BRAND_ASSETS[selected + "Welcome"];
				const onHidden = () => { if (document.hidden) stopWelcome(); };
				welcomeAudio.addEventListener("ended", stopWelcome); welcomeAudio.addEventListener("error", stopWelcome);
				document.addEventListener("visibilitychange", onHidden);
				welcomeCleanup = () => { document.removeEventListener("visibilitychange", onHidden); welcomeAudio?.removeEventListener("ended", stopWelcome); welcomeAudio?.removeEventListener("error", stopWelcome); };
				document.body.appendChild(welcomeAudio); welcomeTimer = setTimeout(stopWelcome, 10000);
				try { Promise.resolve(welcomeAudio.play()).catch(stopWelcome); } catch { stopWelcome(); }
			};
			const clearIntro = () => {
				stopTyping();
				clearTimeout(introTimer); clearTimeout(typeTimer); clearTimeout(revealTimer);
				introTimer = typeTimer = revealTimer = null; intro?.remove(); intro = null;
				flightAnimation?.cancel(); flightAnimation = null; introFlight?.remove(); introFlight = null;
				selectionAnimation?.cancel(); selectionAnimation = null;
				el.removeAttribute("data-arriving"); if (consoleEl) consoleEl.inert = false;
			};
			const clearThemeShift = () => { clearTimeout(themeTimer); themeTimer = null; themeSweep?.remove(); themeSweep = null; };
			const previewPilot = (id) => {
				for (const node of el.querySelectorAll("[data-boot-unit]")) if (node.textContent !== PILOTS[id].code) node.textContent = PILOTS[id].code;
				if (el.dataset.pilot === id) return;
				el.dataset.pilot = id; clearThemeShift();
				if (disposed || media.matches || document.hidden) return;
				themeSweep = document.createElement("div"); themeSweep.className = "eva-boot-theme-sweep"; themeSweep.setAttribute("aria-hidden", "true"); el.appendChild(themeSweep);
				themeTimer = setTimeout(clearThemeShift, 700);
			};
			const endDrag = () => {
				if (!drag) return;
				const active = drag; drag = null; active.ghost?.remove();
				try { if (active.card.hasPointerCapture(active.pointerId)) active.card.releasePointerCapture(active.pointerId); } catch {}
				if (bay) bay.removeAttribute("data-over");
			};
			const stopPick = () => {
				pickGeneration++; pickActive = false; clearTimeout(pickTimer); pickTimer = null; pickCleanup?.(); pickCleanup = null;
				if (pickAudio) { pickAudio.pause(); pickAudio.removeAttribute("src"); pickAudio.load(); }
			};
			const finishPick = () => {
				if (disposed) return;
				stopPick();
				if (waitingForPick) { waitingForPick = false; if (el.dataset.phase === "loading" && !document.hidden) playVoice(); }
				else if (el.dataset.phase === "select") { if (statusKey === "responding") setStatus("waiting"); fadeBgm(.28); }
			};
			const playPick = (id) => {
				if (disposed || el.dataset.phase !== "select" || document.hidden || !pickAudio) return;
				stopPick(); pickPilot = id; pickActive = true; pickAudio.dataset.pilot = id; setStatus("responding");
				const generation = pickGeneration, done = () => { if (generation === pickGeneration) finishPick(); };
				pickAudio.addEventListener("ended", done); pickAudio.addEventListener("error", done);
				pickCleanup = () => { pickAudio.removeEventListener("ended", done); pickAudio.removeEventListener("error", done); };
				pickTimer = setTimeout(done, 8000); pickAudio.src = BRAND_ASSETS[id + "PickVoice"]; pickAudio.load();
				playBgm(); fadeBgm(.075);
				try { Promise.resolve(pickAudio.play()).catch(done); } catch { done(); }
			};
			const prepareVoice = (id) => {
				if (audio.dataset.pilot === id) return;
				audio.dataset.pilot = id; audio.src = BRAND_ASSETS[id + "Voice"]; audio.load();
			};
			const cancelDrag = () => {
				endDrag(); pointerPilot = null;
				if (el.dataset.phase === "select") { stopPick(); setStatus("waiting"); fadeBgm(.28); previewPilot(document.body.hasAttribute("data-ds-dark-theme") ? "asuka" : "rei"); }
			};
			const dispose = (focus = false, welcome = false) => {
				stopWelcome();
				if (focusFrame !== null) { cancelAnimationFrame(focusFrame); focusFrame = null; }
				if (disposed) return;
				disposed = true; clearTimeout(gifTimer); clearTimeout(deadline); clearTimeout(enterTimer); clearEmergency(); clearIntro(); clearThemeShift(); stopContours?.();
				if (progressFrame !== null) cancelAnimationFrame(progressFrame);
				if (bgmFrame !== null) cancelAnimationFrame(bgmFrame); bgmFrame = null;
				endDrag(); waitingForPick = false; stopPick(); for (const remove of listeners) remove();
				img.removeAttribute("src");
				for (const image of warmImages) image.removeAttribute("src"); warmImages.length = 0;
				if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
				bgm.pause(); bgm.removeAttribute("src"); bgm.load();
				releaseBackground(); el.remove();
				if (welcome) playWelcome();
				if (focus && !document.hidden) {
					const restoreFocus = () => {
						if (document.hidden || document.querySelector(".eva-boot")) return;
						const input = document.querySelector('[data-composer-input]:not([contenteditable="false"]):not([aria-disabled="true"])');
						if (input && !input.closest("[inert]")) input.focus({ preventScroll: true });
						else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
					};
					restoreFocus();
					// 宿主编辑器需要一帧反映 inert 解除；下一帧补齐交接且可被重播／卸载取消。
					const active = document.activeElement;
					if (!active?.matches("[data-composer-input]")) focusFrame = requestAnimationFrame(() => {
						focusFrame = null; if (document.activeElement === active) restoreFocus();
					});
				}
			};
			const setStatus = (key) => { statusKey = key; if (status) status.textContent = text(key); };
			const paintLanguage = () => {
				el.lang = language;
				if (el.dataset.phase !== "gif") el.setAttribute("aria-label", text({ emergency: "alert", intro: "select", select: "select", loading: "syncArea", handoff: "handoff" }[el.dataset.phase]));
				for (const node of el.querySelectorAll("[data-boot-text]")) node.textContent = text(node.dataset.bootText);
				for (const node of el.querySelectorAll("[data-boot-aria]")) node.setAttribute("aria-label", text(node.dataset.bootAria));
				for (const button of el.querySelectorAll("[data-boot-language]")) button.setAttribute("aria-pressed", String(button.dataset.bootLanguage === language));
				if (emergencyNext) emergencyNext.textContent = text("skipAlert");
				if (consoleEl) {
					el.querySelector(".eva-boot-title").textContent = text(selected ? "syncTitle" : "select");
					el.querySelector(".eva-boot-hint").textContent = text(selected ? "syncHint" : "hint");
					for (const card of el.querySelectorAll(".eva-pilot-card")) {
						const id = card.dataset.pilot, mode = text(id === "asuka" ? "dark" : "light");
						card.setAttribute("aria-label", BOOT_COPY[language].card.replace("{pilot}", text(id)).replace("{mode}", mode));
						card.querySelector(".eva-pilot-info b").textContent = text(id); card.querySelector(".eva-pilot-info em").textContent = mode + " / UNIT " + PILOTS[id].code;
					}
					el.querySelector(".eva-entry-target").textContent = text(selected ? "inserted" : "drop");
					if (selected) el.querySelector(".eva-boot-loading h2").textContent = text(selected);
					resume.textContent = text(resumeKey); setStatus(statusKey);
				}
				paintSound();
			};
			const fmt = (seconds) => { const n = Math.floor(Math.max(0, seconds || 0)); return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0"); };
			const drawProgress = (ended = false) => {
				if (!audio || disposed) return;
				// Desktop's dsh-app proxy strips Content-Length: duration may stay
				// Infinity until late in playback. Fall back to the same file's sample count.
				const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : BRAND_ASSETS[(selected || audio.dataset.pilot) + "VoiceDuration"] || 0;
				const value = ended ? 100 : duration ? Math.min(100, Math.max(0, audio.currentTime / duration * 100)) : 0;
				fill.style.transform = "scaleX(" + value / 100 + ")";
				if (syncOrbit) syncOrbit.style.setProperty("--sync-progress", String(value / 100));
				const rounded = String(Math.floor(value));
				if (progress.getAttribute("aria-valuenow") !== rounded) { progress.setAttribute("aria-valuenow", rounded); percent.textContent = rounded.padStart(2, "0") + "%"; if (syncValue) syncValue.textContent = percent.textContent; }
				const clockText = fmt(audio.currentTime) + " / " + (duration ? fmt(duration) : "--:--");
				if (time.textContent !== clockText) time.textContent = clockText;
				if (progress.getAttribute("aria-valuetext") !== clockText) progress.setAttribute("aria-valuetext", clockText);
			};
			const tick = () => {
				progressFrame = null; if (disposed || !audio || audio.paused || document.hidden) return;
				drawProgress(); progressFrame = requestAnimationFrame(tick);
			};
			const showAudioError = () => {
				if (disposed || el.dataset.phase !== "loading") return;
				clearTimeout(deadline); audio.pause(); resume.hidden = false; resumeKey = "retry"; resume.textContent = text(resumeKey);
				setStatus("error");
			};
			const playVoice = () => {
				if (disposed || !audio) return;
				waitingForPick = false; stopPick();
				playBgm(); fadeBgm(.075);
				resume.hidden = true; clearTimeout(deadline); deadline = setTimeout(showAudioError, 12000);
				try { const playing = audio.play(); playing?.catch(() => { if (!disposed) showAudioError(); }); } catch { showAudioError(); }
			};
			const handoff = () => {
				if (disposed || el.dataset.phase !== "loading") return;
				drawProgress(true); clearTimeout(deadline); if (progressFrame !== null) cancelAnimationFrame(progressFrame); progressFrame = null;
				if (media.matches) { dispose(true, true); return; }
				// 全程保留模态隔离，等舱门完全开启后再把输入焦点交回宿主。
				el.dataset.phase = "handoff"; el.setAttribute("aria-label", text("handoff")); stopContours?.();
				fadeBgm(0, 1500);
				el.tabIndex = -1; el.focus({ preventScroll: true });
				const gates = document.createElement("div"); gates.setAttribute("aria-hidden", "true");
				gates.innerHTML = '<div class="eva-boot-gate left"><span>NERV / ENTRY SYSTEM · INTERLOCK RELEASED</span></div><div class="eva-boot-gate right"><span>A.T. FIELD · COMMUNICATION CHANNEL OPEN</span></div><div class="eva-boot-clearance"><b>' + text("complete") + '</b><small>SYNCHRONIZATION COMPLETE / EVA ' + PILOTS[selected].code + '</small></div>';
				el.appendChild(gates);
				const frame = document.createElement("div"); frame.className = "eva-boot-composer-frame"; frame.setAttribute("aria-hidden", "true");
				const locateComposer = () => {
					const target = document.querySelector("[data-composer-card]");
					if (!target) { frame.hidden = true; return; }
					const rect = target.getBoundingClientRect(); frame.hidden = rect.width === 0 || rect.height === 0;
					Object.assign(frame.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
				};
				el.appendChild(frame); locateComposer(); listen(window, "resize", locateComposer);
				enterTimer = setTimeout(() => dispose(true, true), 1600);
			};
			const choose = (id, picked = false) => {
				if (disposed || el.dataset.phase !== "select" || !Object.hasOwn(PILOTS, id)) return;
				try {
					if (typeof ctx.theme.setTheme !== "function") throw new Error("theme unavailable");
					ctx.theme.setTheme(id === "asuka" ? "dark" : "light");
				} catch { setStatus("themeError"); return; }
				if (!picked) playPick(id);
				const rollFrames = [...el.querySelectorAll(".eva-plug-roll")].map(node => ({node, transform:getComputedStyle(node).transform, opacity:getComputedStyle(node).opacity}));
				selected = id; previewPilot(id); el.style.setProperty("--boot-head", 'url("' + BRAND_ASSETS[id + "Head"] + '")');
				el.dataset.phase = "loading"; endDrag();
				if (!media.matches && !document.hidden) for (const {node, transform, opacity} of rollFrames) node.animate([{transform, opacity}, {transform:"translateX(0px) scaleX(1)", opacity:node.classList.contains("eva-plug-roll-back") ? 0 : 1}], {duration:400,easing:"ease-out"});
				el.querySelector(".eva-pilot-list").hidden = true; el.querySelector(".eva-boot-loading").hidden = false;
				el.querySelector(".eva-boot-code").textContent = "EVA / " + PILOTS[id].code + " · " + PILOTS[id].en;
				el.querySelector(".eva-entry-label b").textContent = "ENTRY PLUG / " + PILOTS[id].code;
				el.querySelector(".eva-entry-lock").textContent = "INTERLOCK / ENGAGED";
				setStatus(pickActive ? "responding" : "sync"); paintLanguage();
				prepareVoice(id);
				if (pickActive) { waitingForPick = true; resume.hidden = true; } else playVoice();
				el.querySelector(".eva-boot-exit").focus({ preventScroll: true });
			};
			const emergencyScreen = () => {
				if (disposed || el.dataset.phase !== "gif") return;
				if (media.matches || document.hidden) { selectScreen(); return; }
				clearTimeout(gifTimer); clearTimeout(deadline); img.removeAttribute("src"); img.hidden = true;
				el.dataset.phase = "emergency"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "NERV 警报启动画面"); holdBackground();
				emergency = document.createElement("section"); emergency.className = "eva-emergency"; emergency.setAttribute("aria-hidden", "true"); emergency.innerHTML = BRAND_ASSETS.emergency;
				emergencyNext = document.createElement("button"); emergencyNext.type = "button"; emergencyNext.className = "eva-emergency-next"; emergencyNext.textContent = "跳过警报";
				el.insertBefore(emergency, soundButton); el.appendChild(emergencyNext); bgm.hidden = true; el.appendChild(bgm);
				const updateClock = () => { if (emergency) emergency.querySelector("[data-emergency-clock]").textContent = new Date().toTimeString().slice(0, 8); };
				const fitEmergency = () => { emergency?.querySelector("svg").setAttribute("preserveAspectRatio", window.innerWidth < window.innerHeight ? "xMidYMid meet" : "xMidYMid slice"); };
				updateClock(); fitEmergency(); emergencyClockTimer = setInterval(updateClock, 1000);
				listen(window, "resize", fitEmergency); listen(emergencyNext, "click", introScreen);
				paintLanguage();
				emergencyNext.focus({ preventScroll: true }); emergencyTimer = setTimeout(introScreen, 3000);
			};
			const introScreen = () => {
				if (disposed || !["gif", "emergency"].includes(el.dataset.phase)) return;
				if (media.matches || document.hidden) { selectScreen(); return; }
				clearTimeout(gifTimer); clearTimeout(deadline); clearEmergency(); img.removeAttribute("src"); img.hidden = true;
				el.dataset.phase = "intro"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); holdBackground();
				intro = document.createElement("section"); intro.className = "eva-boot-intro";
				intro.innerHTML = '<div class="eva-intro-pilot" data-pilot="asuka" aria-hidden="true"><span class="eva-intro-face"></span><b>02</b><small>ASUKA LANGLEY</small></div><div class="eva-intro-copy"><p class="eva-intro-kicker" aria-hidden="true">NERV / PILOT AUTHENTICATION</p><h1 class="eva-intro-title"><span class="eva-intro-measure" aria-hidden="true"></span><span class="eva-intro-typed" aria-hidden="true"></span></h1><i class="eva-intro-rule" aria-hidden="true"></i></div><div class="eva-intro-pilot" data-pilot="rei" aria-hidden="true"><span class="eva-intro-face"></span><b>00</b><small>REI AYANAMI</small></div><button type="button" class="eva-intro-next"></button>';
				const title = intro.querySelector("h1"), typed = intro.querySelector(".eva-intro-typed"), next = intro.querySelector("button");
				const fullTitle = text("select"), characters = Array.from(fullTitle); let count = 0;
				title.setAttribute("aria-label", fullTitle); intro.querySelector(".eva-intro-measure").textContent = fullTitle; next.textContent = text("skipIntro");
				const typeNext = () => {
					typeTimer = null; if (disposed || el.dataset.phase !== "intro") return;
					typed.textContent = characters.slice(0, ++count).join("");
					if (count === 1) { try { Promise.resolve(typingAudio?.play()).catch(() => {}); } catch { /* A blocked effect never holds up the title. */ } }
					if (count < characters.length) typeTimer = setTimeout(typeNext, 1050 / characters.length);
				};
				typingAudio = document.createElement("audio"); typingAudio.className = "eva-intro-typing"; typingAudio.hidden = true; typingAudio.preload = "auto"; typingAudio.volume = .8; typingAudio.src = BRAND_ASSETS.typing;
				listen(typingAudio, "ended", stopTyping); listen(typingAudio, "error", stopTyping); el.appendChild(typingAudio);
				el.insertBefore(intro, soundButton); paintLanguage(); listen(next, "click", () => selectScreen()); next.focus({ preventScroll: true });
				typeTimer = setTimeout(typeNext, 220); introTimer = setTimeout(() => selectScreen(true), 2250);
			};
			const selectScreen = (animate = false) => {
				if (disposed || !["gif", "emergency", "intro"].includes(el.dataset.phase)) return;
				const introLayer = animate === true && !media.matches && !document.hidden ? intro : null;
				if (!introLayer) clearIntro();
				else { stopTyping(); clearTimeout(typeTimer); clearTimeout(introTimer); typeTimer = introTimer = null; }
				clearTimeout(gifTimer); clearTimeout(deadline); clearEmergency(); img.removeAttribute("src"); img.hidden = true;
				el.dataset.phase = "select"; el.removeAttribute("aria-hidden"); el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "选择你的驾驶员");
				holdBackground();
				el.dataset.pilot = document.body.hasAttribute("data-ds-dark-theme") ? "asuka" : "rei";
				const backdrop = document.createElement("div"); backdrop.className = "eva-boot-backdrop"; backdrop.setAttribute("aria-hidden", "true");
				backdrop.innerHTML = '<span class="eva-boot-watermark" data-boot-unit>EV</span><i class="eva-boot-rail left"></i><i class="eva-boot-rail right"></i>';
				stopContours = mountBootContours(backdrop, media);
				el.appendChild(backdrop);
				consoleEl = document.createElement("section"); consoleEl.className = "eva-boot-console";
				consoleEl.innerHTML = [
					'<header class="eva-boot-header"><div class="eva-boot-heading"><div class="eva-boot-brand"><span class="eva-nerv-logo" aria-hidden="true"></span><p class="eva-boot-kicker">NERV / PILOT AUTHENTICATION<small>SPECIAL AGENCY · CENTRAL DOGMA</small></p></div><h1 class="eva-boot-title">选择你的驾驶员</h1><p class="eva-boot-hint">将头像拖入左侧插入栓，或点击头像装载</p></div><div class="eva-boot-header-side"><div class="eva-boot-security" aria-hidden="true">TOKYO-III<b>NEURAL INTERFACE · LEVEL 07</b></div><div class="eva-boot-languages" role="group" data-boot-aria="language"><button type="button" data-boot-language="zh-CN" lang="zh-CN">中文</button><button type="button" data-boot-language="ja" lang="ja">日本語</button><button type="button" data-boot-language="en" lang="en">English</button></div><div class="eva-boot-actions"><button type="button" class="eva-boot-exit" data-boot-text="exit">跳过并进入</button></div></div></header>',
					'<div class="eva-boot-grid"><div class="eva-entry-bay" role="group" data-boot-aria="bay"><div class="eva-entry-label">NERV / ENTRY SYSTEM<b>ENTRY PLUG / STANDBY</b></div><div class="eva-entry-spec" aria-hidden="true">EVANGELION<b>DIRECT ENTRY SYSTEM</b>L.C.L. / SEALED</div><span class="eva-entry-lock" aria-hidden="true">INTERLOCK / STANDBY</span><div class="eva-entry-machine"><div class="eva-entry-assembly">',
					BRAND_ASSETS.entryPlug,
					'<div class="eva-entry-window" aria-hidden="true"></div></div></div><p class="eva-entry-target">拖入驾驶员 · DROP PILOT HERE</p></div><div class="eva-pilot-list" role="group" data-boot-aria="pilots">',
					...Object.entries(PILOTS).map(([id, pilot]) => '<button type="button" class="eva-pilot-card" data-pilot="' + id + '" data-unit="' + pilot.code + '" aria-label="选择' + pilot.name + '，载入' + (id === "asuka" ? "暗色" : "亮色") + '主题"><span class="eva-pilot-card-top" aria-hidden="true">PILOT / ' + (id === "asuka" ? "SECOND CHILD" : "FIRST CHILD") + '<i>NEURAL ID · ' + pilot.code + '</i></span><span class="eva-pilot-face" aria-hidden="true"></span><span class="eva-pilot-info"><span class="eva-pilot-number">' + pilot.code + '</span><b>' + pilot.name + '</b><small>' + pilot.en + '</small><em>' + (id === "asuka" ? "暗色 / UNIT 02" : "亮色 / UNIT 00") + '</em></span></button>'),
					'</div><section class="eva-boot-loading" hidden data-boot-aria="syncArea"><div class="eva-sync-portrait" aria-hidden="true"></div><div class="eva-sync-main"><div><span class="eva-boot-code"></span><h2></h2><p>VOICE LINK<br><span data-boot-text="voiceHint">启动语音与同步进度</span></p></div><div class="eva-sync-orbit" aria-hidden="true"><svg viewBox="0 0 180 180" fill="none" stroke="currentColor"><circle cx="90" cy="90" r="86" opacity=".35" stroke-dasharray="1 7"/><circle cx="90" cy="90" r="70" opacity=".14" stroke-width="3"/><circle class="eva-sync-ring-meter" cx="90" cy="90" r="70" stroke-width="3"/><path d="M90 0v9m90 81h-9M90 180v-9M0 90h9"/></svg><div class="eva-sync-readout"><span class="eva-sync-value">00%</span><small>VOICE SYNC</small></div></div></div><div class="eva-sync-systems" aria-hidden="true"><span>A10 INTERFACE<b>CONNECTED</b></span><span>L.C.L. CHAMBER<b>SEALED</b></span><span>MAGI SYSTEM<b>STANDBY</b></span></div><div><div class="eva-boot-meter" role="progressbar" data-boot-aria="progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div><div class="eva-boot-progress-label"><span>00%</span><time>00:00 / --:--</time></div><div class="eva-sync-caption">AUDIO SYNCHRONIZATION</div></div><button type="button" class="eva-boot-resume" hidden>继续启动语音</button></section></div><footer class="eva-boot-footer"><p class="eva-boot-status" role="status">等待驾驶员 · AWAITING PILOT</p><div class="eva-boot-magi" aria-hidden="true"><span><i></i>MELCHIOR·1</span><span><i></i>BALTHASAR·2</span><span><i></i>CASPER·3</span></div></footer>',
				].join("");
				el.appendChild(consoleEl);
				previewPilot(el.dataset.pilot);
				el.querySelector(".eva-boot-actions").insertBefore(soundButton, el.querySelector(".eva-boot-exit"));
				status = el.querySelector(".eva-boot-status"); bay = el.querySelector(".eva-entry-bay"); resume = el.querySelector(".eva-boot-resume");
				progress = el.querySelector(".eva-boot-meter"); fill = progress.firstElementChild; percent = el.querySelector(".eva-boot-progress-label span"); time = el.querySelector(".eva-boot-progress-label time");
				syncValue = el.querySelector(".eva-sync-value"); syncOrbit = el.querySelector(".eva-sync-orbit");
				audio = document.createElement("audio"); audio.preload = "auto"; audio.hidden = true; el.appendChild(audio);
				audio.className = "eva-boot-voice"; bgm.hidden = true; el.appendChild(bgm);
				pickAudio = document.createElement("audio"); pickAudio.className = "eva-boot-pick-voice"; pickAudio.preload = "auto"; pickAudio.hidden = true; el.appendChild(pickAudio);
				for (const event of ["loadedmetadata", "durationchange", "timeupdate"]) listen(audio, event, () => drawProgress());
				listen(audio, "ended", handoff); listen(audio, "error", showAudioError);
				listen(audio, "playing", () => { if (disposed) return; clearTimeout(deadline); resume.hidden = true; setStatus("sync"); if (progressFrame === null) tick(); });
				listen(audio, "pause", () => { if (disposed || audio.ended || el.dataset.phase !== "loading") return; resume.hidden = false; resumeKey = "resume"; resume.textContent = text(resumeKey); fadeBgm(.28); });
				listen(audio, "waiting", () => { if (!disposed) { clearTimeout(deadline); deadline = setTimeout(showAudioError, 12000); setStatus("buffering"); } });
				listen(resume, "click", playVoice); listen(el.querySelector(".eva-boot-exit"), "click", () => dispose(true));
				// 拖动中 Chromium 可能把 capture 交回页面；在 document 接续移动与放手。
				listen(document, "pointermove", (event) => {
					if (!drag || drag.pointerId !== event.pointerId) return;
					if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
					const rect = bay.getBoundingClientRect();
					if (!drag.ghost) { const cardRect = drag.card.getBoundingClientRect(); drag.width = cardRect.width; drag.height = cardRect.height; drag.ghost = drag.card.cloneNode(true); drag.ghost.classList.add("eva-pilot-ghost"); drag.ghost.inert = true; drag.ghost.setAttribute("aria-hidden", "true"); drag.ghost.style.width = drag.width + "px"; drag.ghost.style.height = drag.height + "px"; el.appendChild(drag.ghost); }
					drag.ghost.style.transform = "translate(" + (event.clientX - drag.width / 2) + "px," + (event.clientY - drag.height / 2) + "px) scale(.6)";
					const over = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
					bay.dataset.over = over ? "1" : "0"; previewPilot(drag.card.dataset.pilot);
				}, true);
				listen(document, "pointerup", (event) => {
					if (!drag || drag.pointerId !== event.pointerId) return;
					const moved = Boolean(drag.ghost), id = drag.card.dataset.pilot, rect = bay.getBoundingClientRect();
					const over = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
					endDrag(); suppressClick = moved; if (moved) pointerPilot = null; if (moved && over) choose(id, true);
				}, true);
				listen(document, "pointercancel", (event) => { if (drag?.pointerId === event.pointerId) cancelDrag(); }, true);
				listen(window, "blur", cancelDrag);
				for (const card of el.querySelectorAll(".eva-pilot-card")) {
					listen(card, "click", (event) => { if (suppressClick) { suppressClick = false; pointerPilot = null; event.preventDefault(); return; } const picked = event.detail > 0 && pointerPilot === card.dataset.pilot; pointerPilot = null; choose(card.dataset.pilot, picked); });
					listen(card, "pointerdown", (event) => {
						if (event.button !== 0 || el.dataset.phase !== "select") return;
						event.preventDefault(); card.focus({ preventScroll: true });
						suppressClick = false; endDrag(); drag = { card, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ghost: null };
					pointerPilot = card.dataset.pilot; previewPilot(pointerPilot); prepareVoice(pointerPilot); playPick(pointerPilot);
						try { card.setPointerCapture(event.pointerId); } catch { /* 不支持 capture 时由 document 接续。 */ }
					});
					listen(card, "lostpointercapture", (event) => { if (drag?.pointerId === event.pointerId && event.buttons === 0) cancelDrag(); });
				}
				for (const button of el.querySelectorAll("[data-boot-language]")) listen(button, "click", () => {
					language = button.dataset.bootLanguage; paintLanguage();
					try { localStorage.setItem(BOOT_LANGUAGE_KEY, language); } catch { /* 当前界面仍然生效。 */ }
				});
				paintLanguage();
				if (introLayer) {
					const fromTitle = introLayer.querySelector(".eva-intro-title"), toTitle = el.querySelector(".eva-boot-title");
					const from = fromTitle.getBoundingClientRect(), to = toTitle.getBoundingClientRect(), style = getComputedStyle(fromTitle);
					introFlight = document.createElement("div"); introFlight.className = "eva-intro-flight"; introFlight.textContent = text("select"); introFlight.setAttribute("aria-hidden", "true");
					Object.assign(introFlight.style, {left: from.left + "px", top: from.top + "px", fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color});
					el.appendChild(introFlight);
					flightAnimation = introFlight.animate([{transform:"translate(0,0) scale(1,1)", color:style.color}, {transform:"translate(" + (to.left - from.left) + "px," + (to.top - from.top) + "px) scale(" + to.width / from.width + "," + to.height / from.height + ")", color:getComputedStyle(toTitle).color}], {duration:820,easing:"cubic-bezier(.22,.7,.2,1)",fill:"both"});
					// A one-shot fade cannot restart when data-arriving is removed.
					selectionAnimation = consoleEl.animate([{opacity:0}, {opacity:1}], {duration:820,easing:"ease-out"});
					el.setAttribute("data-arriving", ""); introLayer.setAttribute("data-leaving", ""); introLayer.inert = consoleEl.inert = true;
					el.tabIndex = -1; el.focus({ preventScroll: true });
					revealTimer = setTimeout(() => {
						clearIntro(); if (!disposed && !document.hidden && el.dataset.phase === "select") el.querySelector(".eva-pilot-card")?.focus({ preventScroll: true });
					}, 820);
				} else if (!document.hidden) {
					if (!media.matches) selectionAnimation = consoleEl.animate([{opacity:0}, {opacity:1}], {duration:380,easing:"ease-out"});
					el.querySelector(".eva-pilot-card").focus({ preventScroll: true });
				}
			};
			listen(document, "keydown", (event) => {
				if (disposed) return;
				if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (drag) cancelDrag(); else dispose(true); return; }
				if (event.key === "Tab" && el.dataset.phase !== "gif") {
					if (el.dataset.phase === "handoff" || el.hasAttribute("data-arriving")) { event.preventDefault(); return; }
					const buttons = [...el.querySelectorAll("button:not(:disabled)")].filter(node => !node.closest("[hidden]"));
					const index = buttons.indexOf(document.activeElement), next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
					event.preventDefault(); buttons[next]?.focus({ preventScroll: true });
				}
			}, true);
			listen(window, "resize", () => {
				if (!el.hasAttribute("data-arriving")) return;
				clearIntro(); if (!document.hidden) el.querySelector(".eva-pilot-card")?.focus({ preventScroll: true });
			});
			listen(document, "visibilitychange", () => {
				if (disposed) return;
				el.toggleAttribute("data-paused", document.hidden);
				if (document.hidden) { bgm.pause(); if (bgmFrame !== null) cancelAnimationFrame(bgmFrame); bgmFrame = null; cancelDrag(); clearThemeShift(); clearIntro(); waitingForPick = false; stopPick(); if (["gif", "emergency", "intro"].includes(el.dataset.phase)) selectScreen(); else if (el.dataset.phase === "loading") { audio.pause(); resume.hidden = false; resumeKey = "resume"; resume.textContent = text(resumeKey); setStatus("paused"); } else if (el.dataset.phase === "handoff") dispose(); }
				else if (el.dataset.phase === "select") el.querySelector(".eva-pilot-card")?.focus({ preventScroll: true });
			});
			listen(media, "change", () => { if (media.matches) { clearThemeShift(); clearIntro(); if (["gif", "emergency", "intro"].includes(el.dataset.phase)) selectScreen(); else if (el.dataset.phase === "handoff") dispose(true, true); } });
			listen(img, "load", () => { if (disposed || el.dataset.phase !== "gif") return; clearTimeout(deadline); el.setAttribute("data-ready", ""); gifTimer = setTimeout(emergencyScreen, BRAND_ASSETS.durationMs); }, { once: true });
			listen(img, "error", emergencyScreen, { once: true });
			themeOverlayHost().appendChild(el);
			el.appendChild(soundButton); el.removeAttribute("aria-hidden"); paintLanguage(); playBgm();
			if (media.matches) selectScreen();
			else { deadline = setTimeout(emergencyScreen, 5000); img.src = BRAND_ASSETS.boot; }
			return dispose;
		}

		/** 开机序列每个浏览器会话只放一次，别让每次刷新都等一遍。 */
		function shouldRunBoot() {
			try {
				if (sessionStorage.getItem(BOOT_FLAG)) return false;
				sessionStorage.setItem(BOOT_FLAG, "1");
				return true;
			} catch (error) {
				return true; // 无痕模式下每次都放，总比不放好
			}
		}

		/** 注入插件自有样式表。返回移除函数。 */
		function mountStyles() {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = SKIN_CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/** 令牌表 → `overrideTokens` 要的 { light, dark } 形状。 */
		function tokenLayer() {
			const layer = {};
			for (const [alias, [light, dark]] of Object.entries(PALETTE)) {
				layer["--dsw-alias-" + alias] = { light, dark };
			}
			return layer;
		}

		// ============================================================
		// 4. 插件体
		// ============================================================
		/** 服务依赖：theme 由 @deepseek-ai/dsh-client-ui-theme 提供。 */
		const inject = ["theme"];

		/**
		 * @param ctx - 浏览器侧 Cordis 上下文。
		 */
		// ============================================================
		// 启动自检
		// ------------------------------------------------------------
		// HOST_HOOKS 集中记录语义属性与可读类名后缀。只有相应宿主区域存在时，
		// 缺失的控件才算必需；空白页、非会话页面和折叠侧栏不会产生误报。
		const DIAGNOSE_DELAY_MS = 4000;

		const HOOK_CHECKS = [
			{ sel: HOST_HOOKS.turnProcess, what: "任务完成与用时栏", required: false },
			{ sel: HOST_HOOKS.composer, what: "输入框卡片", required: true, context: HOST_HOOKS.header },
			{ sel: "[data-composer-input]", what: "输入区", required: true, context: HOST_HOOKS.composer },
			{ sel: '[data-slot="conversation.input.model"]', what: "模型选择器", required: true, context: HOST_HOOKS.composer },
			{ sel: '[data-slot="conversation.input.permission"]', what: "权限选择器", required: true, context: HOST_HOOKS.composer },
			{ sel: '[data-slot="sidebar"]', what: "侧边栏插槽", required: false },
			{ sel: HOST_HOOKS.sidebar, what: "左侧边栏面板", required: true, context: '[data-slot="sidebar"]' },
			{ sel: HOST_HOOKS.newSession, what: "新会话按钮", required: true, context: '[data-slot="sidebar"]' },
			{ sel: HOST_HOOKS.add, what: "加号按钮", required: true, context: HOST_HOOKS.composer },
			{ sel: HOST_HOOKS.send, what: "发送按钮", required: true, context: HOST_HOOKS.composer },
			{ sel: HOST_HOOKS.placeholder, what: "输入框占位符", required: false },
			{ sel: '[data-slot="sidebar"] [class*="_panelTitle"]', what: "侧栏标题", required: false },
			{ sel: '[role="menu"][data-menu-material]', what: "弹出菜单", required: false },
		];

		/**
		 * 体检：返回未命中的钩子。全中时 missing 为空数组。
		 * 只读、不写入，可随时在 Console 调用。
		 */
		function diagnose(doc) {
			const root = doc || globalThis.document;
			if (!root || typeof root.querySelector !== "function") {
				return { checked: 0, missing: [], unverifiable: true };
			}
			const missing = [];
			for (const check of HOOK_CHECKS) {
				let hit = false;
				try {
					hit = Boolean(root.querySelector(check.sel));
				} catch (error) {
					hit = false; // 选择器不被支持（极老的内核）
				}
				if (!hit) missing.push({ what: check.what, sel: check.sel, required: check.required && (!check.context || Boolean(root.querySelector(check.context))) });
			}
			return { checked: HOOK_CHECKS.length, missing };
		}

		/**
		 * 延迟一拍再体检：这些节点多半是应用异步渲染出来的，挂载瞬间查必然全是缺的。
		 *
		 * 只在「**确实认出了一个钩子**、但 required 的钩子缺了」时才输出 ——
		 * 一个都没认出来说明当前根本不在应用页面里（例如测试台），此时保持安静。
		 */
		function scheduleDiagnose() {
			const timer = setTimeout(() => {
				const report = diagnose();
				const found = report.checked - report.missing.length;
				if (found === 0) return;
				const bad = report.missing.filter((m) => m.required);
				if (bad.length === 0) return;
				console.info(
					"[dsh-plugin-eva-theme] 启动自检：" +
						bad.length +
						" 处钩子未命中，对应样式会**静默失效**（多半是 DSH 升级改过结构）。" +
						"明细：__EVA_MAGI_THEME__.diagnose()",
				);
				for (const m of bad) console.info("  · " + m.what + "  →  " + m.sel);
			}, DIAGNOSE_DELAY_MS);
			return () => clearTimeout(timer);
		}

		function apply(ctx) {
			const options = loadOptions();
			let mounted = null;

			/**
			 * 唯一的写入通道：界面面板与 Console 钩子都走它。
			 * 写入 → 持久化 → 重绘 CSS 标记 → 刷新面板控件。
			 */
			const setOption = (key, value) => {
				if (!mounted) throw new Error("主题已卸载");
				options[key] = normalizeOption(key, value);
				if (key === "boot" && !options.boot) cancelBootRef?.();
				saveOptions(options);
				paintOptions(options);
				refreshAttentionRef?.();
				if (typeof refreshPanelRef === "function") refreshPanelRef();
				if (typeof refreshTagsRef === "function") refreshTagsRef();
				if (typeof refreshLayoutRef === "function") refreshLayoutRef();
				return options[key];
			};

			/** 恢复全部默认值（面板底部的「重置全部」）。 */
			const resetAll = () => {
				if (!mounted) throw new Error("主题已卸载");
				Object.assign(options, DEFAULT_OPTIONS);
				saveOptions(options);
				paintOptions(options);
				refreshAttentionRef?.();
				if (typeof refreshPanelRef === "function") refreshPanelRef();
				if (typeof refreshTagsRef === "function") refreshTagsRef();
				if (typeof refreshLayoutRef === "function") refreshLayoutRef();
				return options;
			};

			// 皮肤样式表 + 装饰层 + 令牌层，生命周期都挂在 ctx.effect 上，
			// 因此 HMR 重载和插件卸载都不会留下残留。

			// 可选依赖：客户端 sessions 服务（TPS 波形要读它的 sessionStats 投影）。
			// 同样用子作用域注入：服务缺失时皮肤照常工作，只是波形没有数据。
			if (typeof ctx.inject === "function") {
				ctx.inject(["sessions", "uiSession"], (scope) => {
					scope.effect(() => whenBodyReady(() => mountAttentionSounds(scope, options)), "eva-magi: role attention sounds");
				});
				ctx.inject(["sessions"], (scope) => {
					try {
						sessionsRef = scope.sessions || null;
					} catch (error) {
						sessionsRef = null;
					}
					scope.effect(() => () => {
						sessionsRef = null;
					}, "eva-magi: sessions ref");
				});
			}

			ctx.effect(() => scheduleDiagnose(), "eva-magi: hook self-check");
			ctx.effect(() => mountStyles(), "eva-magi: skin stylesheet");
			ctx.effect(
				() => whenBodyReady(() => mountChrome(ctx, options, setOption, resetAll)),
				"eva-magi: chrome + crt layers",
			);
			ctx.effect(() => {
				let stopped = false, stop = null;
				const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
				const cancel = () => { stop?.(); stop = null; };
				const play = () => {
					if (stopped || document.hidden) return false;
					cancel(); stop = whenBodyReady(() => mountBoot(ctx)); return true;
				};
				const refresh = () => { refreshPanelRef?.(); };
				replayBootRef = play; cancelBootRef = cancel;
				reducedMotion.addEventListener("change", refresh);
				if (options.boot && !document.hidden && shouldRunBoot()) play();
				return () => {
					stopped = true; cancel(); reducedMotion.removeEventListener("change", refresh);
					if (replayBootRef === play) replayBootRef = null;
					if (cancelBootRef === cancel) cancelBootRef = null;
				};
			}, "eva-magi: boot sequence");
			ctx.effect(
				() => {
					const dispose = ctx.theme.overrideTokens(PACKAGE_NAME, tokenLayer());
					return () => {
						dispose();
						if (globalThis.__EVA_MAGI_THEME__ === mounted) delete globalThis.__EVA_MAGI_THEME__;
						mounted = null;
					};
				},
				"eva-magi: alias token layer",
			);

			// 面板与 Console 共用当前有效选项。
			mounted = {
				version: "0.51.2",
				source: PACKAGE_NAME,
				options,
				palette: PALETTE,
				tokens: tokenLayer(),
				// Console 钩子与界面面板走同一条写入通道，不会有两套状态
				set: setOption,
				reset: resetAll,
				// 体检当前页面里的钩子命中情况（只读）
				diagnose,
			};
			globalThis.__EVA_MAGI_THEME__ = mounted;
		}

		exports.name = PACKAGE_NAME;
		exports.inject = inject;
		exports.apply = apply;
		exports.PALETTE = PALETTE;
		exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
		// 峰谷规则是纯函数，导出以便单测（测试台用已知时刻断言高峰/空闲）
		exports.pricingStateAt = pricingStateAt;
		exports.nextPricingChangeAt = nextPricingChangeAt;
		exports.createContourRenderer = createContourRenderer;
		return module.exports;
	},
});
