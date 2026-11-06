/**
 * 宿主半边的单测：请求栅栏 + 余额解析。
 *
 * 为什么单独一个文件：宿主侧跑在 DSH 进程里，浏览器测试台（client-harness.html）
 * 够不着它。但这两块恰好是最需要断言的 ——
 *   · isTrustedRequest 写松了 = 任意网页都能把你的余额读走；
 *   · parseBalance 写错了 = 界面显示一个错的金额（比不显示更糟）。
 * 所以它们是纯函数，可以被直接 import 出来断言。
 *
 * 用法：node tests/verify-host.mjs
 */

import {
	NP_APPS,
	NOWPLAYING_PATH,
	CONTROL_PATH,
	READ_SCRIPT,
	controlScript,
	parseNowPlaying,
	parseSystemNowPlaying,
	systemControlArgs,
} from "../lib/host-nowplaying.mjs";

import {
	ACCOUNT_CREDENTIAL_ID,
	BALANCE_PATH,
	BALANCE_URL,
	CREDENTIAL_ID,
	formatBalance,
	isTrustedRequest,
	parseAccountServiceBalance,
	parseBalance,
	parsePlatformBalance,
	PLATFORM_BALANCE_URL,
	secretOf,
	tokenOfGrant,
} from "../lib/host-balance.mjs";

let passed = 0;
const failures = [];

const check = (label, ok, detail) => {
	if (ok) {
		passed += 1;
		return;
	}
	failures.push({ label, detail: detail === undefined ? "" : String(detail) });
};

const eq = (label, actual, expected) => {
	check(label, Object.is(actual, expected), `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
};

// ============================================================
// 1. 请求栅栏 —— 放行与拦截
// ============================================================
const ok = (headers) => isTrustedRequest(headers);
const no = (headers) => isTrustedRequest(headers) === false;

eq("常量：路由路径", BALANCE_PATH, "/dsh-eva-magi/balance.json");
eq("常量：出网地址只有官方余额接口", BALANCE_URL, "https://api.deepseek.com/user/balance");
eq("常量：凭据 id", CREDENTIAL_ID, "DEEPSEEK_API_KEY");

// —— 该放行的 ——
check("放行：回环 IPv4 + 端口", ok({ host: "127.0.0.1:43120" }) === true);
check("放行：localhost + 端口", ok({ host: "localhost:43120" }) === true);
check("放行：IPv6 回环 [::1]", ok({ host: "[::1]:43120" }) === true);
check("放行：带同源 Origin", ok({ host: "127.0.0.1:43120", origin: "http://127.0.0.1:43120" }) === true);
check("放行：同源 https Origin", ok({ host: "127.0.0.1:43120", origin: "https://127.0.0.1:43120" }) === true);
check("放行：same-origin 的 Sec-Fetch-Site", ok({ host: "127.0.0.1:43120", "sec-fetch-site": "same-origin" }) === true);

// —— 该拦截的（每条都对应一种真实攻击面）——
check("拦截：DNS 重绑定（Host 是攻击者域名）", no({ host: "evil.example:43120" }));
check("拦截：伪造同源 Origin 也拦（Host 非回环）", no({ host: "evil.example", origin: "http://evil.example" }));
check("拦截：后缀混淆 127.0.0.1.evil.example", no({ host: "127.0.0.1.evil.example" }));
check("拦截：userinfo 混淆 127.0.0.1:1@evil.example", no({ host: "127.0.0.1:1@evil.example" }));
check("拦截：跨站请求（Sec-Fetch-Site: cross-site）",
	no({ host: "127.0.0.1:43120", "sec-fetch-site": "cross-site" }));
check("拦截：Origin 与本机不同端口", no({ host: "127.0.0.1:43120", origin: "http://127.0.0.1:9999" }));
check("拦截：Origin 指向外部站点", no({ host: "127.0.0.1:43120", origin: "http://evil.example" }));
check("拦截：Origin 畸形", no({ host: "127.0.0.1:43120", origin: "not a url" }));
check("拦截：没有任何 Host", no({}));
check("拦截：headers 缺失", isTrustedRequest(undefined) === false);
check("拦截：headers 不是对象", isTrustedRequest("127.0.0.1") === false);

// —— 密钥取值：resolve 返回 { value }，实机踩过的坑 ——
eq("密钥：从 { value } 里取（这是真实形态）", secretOf({ value: "sk-abc" }), "sk-abc");
eq("密钥：裸字符串也收", secretOf("sk-abc"), "sk-abc");
eq("密钥：null → 空串", secretOf(null), "");
eq("密钥：undefined → 空串", secretOf(undefined), "");
eq("密钥：空对象 → 空串", secretOf({}), "");
eq("密钥：value 不是字符串 → 空串", secretOf({ value: 123 }), "");
check("密钥：绝不要把对象直接拼进请求头",
	secretOf({ value: "sk-x" }) !== String({ value: "sk-x" }));

// ============================================================
// 2. 余额解析 —— 只认能确定的数字
// ============================================================
const cny = parseBalance({
	is_available: true,
	balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
});
check("解析：人民币钱包", Boolean(cny) && cny.currency === "CNY" && cny.balance === 110, JSON.stringify(cny));
eq("解析：赠送额度", cny.granted, 10);
eq("解析：充值额度", cny.toppedUp, 100);
eq("解析：可用标记", cny.available, true);
eq("解析：格式化", formatBalance(cny), "¥110.00");

const mixed = parseBalance({
	balance_infos: [{ currency: "USD", total_balance: "1.00" }, { currency: "CNY", total_balance: "12.34" }],
});
check("解析：多钱包时优先人民币", Boolean(mixed) && mixed.currency === "CNY" && mixed.balance === 12.34, JSON.stringify(mixed));
eq("解析：人民币格式化", formatBalance(mixed), "¥12.34");

const usdOnly = parseBalance({ balance_infos: [{ currency: "USD", total_balance: "5" }] });
check("解析：只有美元时用美元", Boolean(usdOnly) && usdOnly.currency === "USD", JSON.stringify(usdOnly));
eq("解析：美元格式化", formatBalance(usdOnly), "$5.00");

const unavailable = parseBalance({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] });
check("解析：is_available=false 如实带出", Boolean(unavailable) && unavailable.available === false);
eq("解析：零余额照实显示", formatBalance(unavailable), "¥0.00");

// —— 拿不到确定数字时必须返回 null，绝不猜 ——
eq("拒绝：没有 balance_infos", parseBalance({}), null);
eq("拒绝：balance_infos 不是数组", parseBalance({ balance_infos: "110" }), null);
eq("拒绝：空钱包列表", parseBalance({ balance_infos: [] }), null);
eq("拒绝：余额不是数字", parseBalance({ balance_infos: [{ currency: "CNY", total_balance: "N/A" }] }), null);
eq("拒绝：余额字段缺失", parseBalance({ balance_infos: [{ currency: "CNY" }] }), null);
eq("拒绝：payload 是 null", parseBalance(null), null);
eq("拒绝：payload 是字符串", parseBalance("110"), null);
eq("格式化：null 显示破折号", formatBalance(null), "—");

// ============================================================
// 「正在播放」：解析 + 控制脚本白名单
// ============================================================
// 注意：eq 是 === 比较，对象必须逐字段断言（或 stringify），否则永远不等
const empty = parseNowPlaying("");
eq("空输出：没有 app", empty.app, null);
eq("空输出：playing 为假", empty.playing, false);
eq("空输出：state 为空", empty.state, "");
const blank = parseNowPlaying("   \n ");
eq("仅空白同样视为没在放", blank.app === null && blank.playing === false, true);

const music = parseNowPlaying("Music\tplaying\tSong A\tArtist B\tAlbum C\t215.5\t42.25");
eq("Music 播放中：app", music.app, "Music");
eq("Music 播放中：playing 为真", music.playing, true);
eq("Music 播放中：曲名", music.title, "Song A");
eq("Music 播放中：艺人", music.artist, "Artist B");
eq("Music 播放中：时长（秒）", music.duration, 215.5);
eq("Music 播放中：进度", music.position, 42.25);

const spotify = parseNowPlaying("Spotify\tpaused\tTrack\tBand\tAlbum\t300\t10");
eq("Spotify 暂停：playing 为假", spotify.playing, false);
eq("Spotify 暂停：app", spotify.app, "Spotify");

const broken = parseNowPlaying("Music\tplaying");
eq("字段缺失时不产生 NaN", Number.isNaN(broken.duration) || broken.duration === 0, true);
eq("字段缺失时 title 为空串", broken.title, "");
const weird = parseNowPlaying("Music\tplaying\tX\tY\tZ\tabc\t-5");
eq("非数字时长归零", weird.duration, 0);
eq("负数进度归零", weird.position, 0);

eq("控制脚本：Music playpause", /tell application "Music" to playpause/.test(controlScript("Music", "playpause")), true);
eq("控制脚本：Spotify next", /tell application "Spotify" to next track/.test(controlScript("Spotify", "next")), true);
eq("控制脚本：previous", /previous track/.test(controlScript("Music", "previous")), true);

// —— 注入防护：这是这块最要紧的断言 ——
eq("拒绝：不在白名单的 app", controlScript("Music; rm -rf /", "playpause"), null);
eq("拒绝：不在白名单的 app（Spotify 拼串）", controlScript("Spotify\" & (do shell script \"x\")", "next"), null);
eq("拒绝：不在白名单的 action", controlScript("Music", "playpause; do shell script \"rm -rf /\""), null);
eq("拒绝：action 为空", controlScript("Music", ""), null);
eq("拒绝：action 为 undefined", controlScript("Music", undefined), null);
eq("白名单只有两个 app", NP_APPS.length === 2 && NP_APPS.includes("Music") && NP_APPS.includes("Spotify"), true);
eq("只读脚本里不含任何插值占位", READ_SCRIPT.includes("%APP%"), false);
eq("路由路径就位", NOWPLAYING_PATH === "/dsh-eva-magi/nowplaying.json" && CONTROL_PATH === "/dsh-eva-magi/nowplaying", true);

for (const value of [null, "", " ", false, true, [], {}, "0x10", "Infinity"]) {
  eq("拒绝异常金额 " + JSON.stringify(value), parseBalance({ balance_infos: [{ currency: "CNY", total_balance: value }] }), null);
}
eq("可选金额缺失不能伪装成零", parseBalance({ balance_infos: [{ total_balance: "1", granted_balance: null }] }).granted, null);
for (const action of ["__proto__", "constructor", "toString", {}, []]) eq("拒绝继承属性或非字符串动作", controlScript("Music", action), null);
check("优先正在播放的应用，并保留暂停应用作为候选", READ_SCRIPT.includes("if player state is playing then return rowText") && READ_SCRIPT.includes('if out is "" then set out to rowText'));

const system = {ok:true,app:'网易云音乐',bundleId:'com.netease.163music',title:'Song',playing:true,duration:240,position:15};
const parsedSystem = parseSystemNowPlaying(JSON.stringify(system));
eq('系统媒体保留来源 id',parsedSystem.bundleId,system.bundleId);
eq('系统媒体保留曲名',parsedSystem.title,'Song');
eq('系统媒体识别播放',parsedSystem.playing,true);
eq('系统媒体暂停状态',parseSystemNowPlaying(JSON.stringify({...system,playing:false})).state,'paused');
for(const raw of ['invalid','null','{"ok":false}',JSON.stringify({...system,bundleId:'bad; command'})]) eq('无效系统输出不伪造曲目',parseSystemNowPlaying(raw),null);
eq('无系统来源明确返回空状态',parseSystemNowPlaying('{"ok":true,"app":null}').app,null);
eq('无效进度归零',parseSystemNowPlaying(JSON.stringify({...system,position:-5})).position,0);
eq('系统控制只传固定动作和来源',JSON.stringify(systemControlArgs('next',system.bundleId)),JSON.stringify(['next',system.bundleId]));
for(const action of ['__proto__','constructor','launch',{},null]) eq('系统控制拒绝任意动作',systemControlArgs(action,system.bundleId),null);
for(const bundle of ['',null,'a; open x','a\nMusic']) eq('系统控制拒绝无效来源',systemControlArgs('playpause',bundle),null);

// ============================================================
// 3. 账号通道 —— 账号登录用户没有 API Key，余额要从平台钱包取
// ============================================================
eq("常量：账号凭据 id", ACCOUNT_CREDENTIAL_ID, "deepseek-account-platform/default");
eq("常量：平台钱包地址", PLATFORM_BALANCE_URL, "https://platform.deepseek.com/api/v0/users/get_user_summary");

// —— DSH 账号服务（首选通道，插件不接触 token）——
const account = parseAccountServiceBalance({
	status: "ready",
	value: [{ currency: "CNY", balance: "97.47417192" }],
	bonusWallets: [{ currency: "CNY", balance: "0" }],
});
eq("账号服务：金额", account.balance, 97.47417192);
eq("账号服务：币种", account.currency, "CNY");
eq("账号服务：赠送钱包", account.granted, 0);
eq("账号服务：界面文本", formatBalance(account), "¥97.47");
eq("账号服务：美元金额用 $", formatBalance(parseAccountServiceBalance({ status: "ready", value: [{ currency: "USD", balance: "3.5" }] })), "$3.50");
eq("账号服务：无赠送钱包时为 null", account.granted === 0 && parseAccountServiceBalance({ status: "ready", value: [{ currency: "CNY", balance: "1" }] }).granted, null);
for (const value of [null, {}, { status: "failed" }, { status: "ready", value: [] }, { status: "ready", value: [{ currency: "CNY", balance: "abc" }] }, { status: "ready" }]) {
	eq("账号服务：拒绝异常响应 " + JSON.stringify(value), parseAccountServiceBalance(value), null);
}

// —— 账号 token 直连平台钱包（兜底通道）——
const wallet = parsePlatformBalance({
	code: 0,
	data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: "CNY", balance: "98.0009526000000000" }], bonus_wallets: [{ currency: "CNY", balance: "0" }] } },
});
eq("平台钱包：金额", wallet.balance, 98.0009526);
eq("平台钱包：界面文本", formatBalance(wallet), "¥98.00");
eq("平台钱包：拒绝非零 code", parsePlatformBalance({ code: 1, data: { biz_data: { normal_wallets: [{ currency: "CNY", balance: "1" }] } } }), null);
eq("平台钱包：拒绝空钱包", parsePlatformBalance({ code: 0, data: { biz_data: { normal_wallets: [] } } }), null);
eq("平台钱包：拒绝缺失 biz_data", parsePlatformBalance({ code: 0, data: {} }), null);

// —— grant → token（账号 grant 的字段名是 token，不是 value）——
eq("grant 取 token：对象形态", tokenOfGrant({ token: "abc" }), "abc");
eq("grant 取 token：字符串形态", tokenOfGrant("abc"), "abc");
eq("grant 取 token：兼容 value 形态", tokenOfGrant({ value: "abc" }), "abc");
eq("grant 取 token：没有 token 时为空串", tokenOfGrant({ secret: "abc" }), "");

// ============================================================
// 结果
// ============================================================
if (failures.length > 0) {
	console.error(`✗ 宿主半边测试失败（${failures.length}/${passed + failures.length}）`);
	for (const item of failures) console.error(`   ✗ ${item.label}${item.detail ? " —— " + item.detail : ""}`);
	process.exit(1);
}
console.log(`✓ 宿主半边测试通过（${passed} 项断言：请求栅栏 / 余额解析）`);
