/**
 * Windows 系统媒体桥：用 SMTC（GlobalSystemMediaTransportControlsSessionManager）
 * 读取当前媒体会话并发送播放控制。
 *
 * 读取由一个常驻的 PowerShell 子进程以每秒一行 JSON 的方式推送；
 * 控制是一次性 PowerShell 调用（点击按钮时才会发生）。
 * 该模块只在 win32 上使用，非 Windows 平台不会被导入调用。
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PS = path.join(
	process.env.SystemRoot || "C:\\Windows",
	"System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const READ_SCRIPT = fileURLToPath(new URL("./system-media-win.ps1", import.meta.url));
const CONTROL_SCRIPT = fileURLToPath(new URL("./system-media-control-win.ps1", import.meta.url));
const ACTIONS = new Set(["playpause", "next", "previous"]);
const AUMID_RE = /^[A-Za-z0-9][A-Za-z0-9._!#-]{0,255}$/;
const EMPTY = Object.freeze({ ok: true, supported: true, app: null, playing: false });

const APP_NAMES = [
	[/spotify/i, "Spotify"],
	[/zunemusic|media\.player|music\.ui|mediaplayer/i, "Media Player"],
	[/cloudmusic|netease/i, "网易云音乐"],
	[/qqmusic/i, "QQ音乐"],
	[/kugou/i, "酷狗音乐"],
	[/kuwo/i, "酷我音乐"],
	[/msedge|microsoftedge/i, "Edge"],
	[/chrome/i, "Chrome"],
	[/firefox/i, "Firefox"],
	[/foobar/i, "foobar2000"],
	[/potplayer/i, "PotPlayer"],
	[/vlc/i, "VLC"],
];

/** AUMID/进程名 → 界面上显示的应用名。 */
function displayName(aumid) {
	const id = String(aumid || "");
	for (const [pattern, name] of APP_NAMES) if (pattern.test(id)) return name;
	const base = id.split(/[\\/]/).pop() || id;
	return base.replace(/\.exe$/i, "").slice(0, 80) || "系统媒体";
}

const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** 单个来源行 → 插件路由里的来源形状。 */
function mapRow(data) {
	if (!data || typeof data !== "object") return null;
	const status = String(data.status || "").toLowerCase();
	const title = String(data.title || "").trim();
	if (!title || status === "stopped" || status === "closed") return null;
	const playing = status === "playing";
	return {
		source: data.source === "netease" ? "netease" : "smtc",
		app: displayName(data.aumid),
		bundleId: String(data.aumid || ""),
		playing,
		state: playing ? "playing" : "paused",
		title: title.slice(0, 1000),
		artist: String(data.artist || "").slice(0, 1000),
		album: String(data.album || "").slice(0, 1000),
		duration: num(data.duration),
		position: num(data.position),
	};
}

/** 把 PowerShell 的一行状态映射成插件路由的形状。 */
function mapState(data) {
	if (!data || data.ok !== true) return { ...EMPTY };
	if (Array.isArray(data.sources)) {
		const sources = data.sources.map(mapRow).filter(Boolean).slice(0, 5);
		if (!sources.length) return { ...EMPTY };
		const primary = sources.find((row) => row.playing) || sources[0];
		return { ok: true, supported: true, sources, ...primary, spectrum: String(data.spectrum || "").slice(0, 400) };
	}
	if (data.session !== true) return { ...EMPTY };
	const row = mapRow(data);
	if (!row) return { ...EMPTY };
	return { ok: true, supported: true, ...row, spectrum: String(data.spectrum || "").slice(0, 400) };
}

let child = null;
let buffer = "";
let latest = null;
let latestAt = 0;
let spawnAt = 0;
let disposed = false;

function stopDaemon() {
	if (child) {
		try { child.kill(); } catch { /* already gone */ }
		child = null;
	}
	buffer = "";
	latest = null;
	latestAt = 0;
}

function ensureDaemon() {
	if (disposed || child || Date.now() - spawnAt < 5000) return;
	spawnAt = Date.now();
	try {
		child = spawn(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", READ_SCRIPT], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		child = null;
		return;
	}
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line.startsWith("{")) continue;
			try {
				latest = mapState(JSON.parse(line));
				latestAt = Date.now();
			} catch { /* ignore malformed line */ }
		}
		if (buffer.length > 65536) buffer = "";
	});
	const drop = () => {
		if (child) child = null;
		latest = null;
		latestAt = 0;
	};
	child.on("exit", drop);
	child.on("error", drop);
}

/** 读取当前会话；数据在 5 秒内视为新鲜。 */
export function readWindowsNowPlaying() {
	ensureDaemon();
	if (latest && Date.now() - latestAt < 5000) return latest;
	return { ...EMPTY };
}

/** 发送一个白名单动作。返回 { ok, code, ... }。 */
export function controlWindowsMedia(action, aumid) {
	if (!ACTIONS.has(action)) return Promise.resolve({ ok: false, code: "ACTION" });
	if (aumid && !AUMID_RE.test(aumid)) return Promise.resolve({ ok: false, code: "BODY" });
	const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CONTROL_SCRIPT, "-Action", action];
	if (aumid) args.push("-Aumid", aumid);
	return new Promise((resolve) => {
		execFile(PS, args, { timeout: 6000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
			if (error) { resolve({ ok: false, code: "CONTROL_UNAVAILABLE" }); return; }
			const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
			try {
				const data = JSON.parse(lines[lines.length - 1] || "");
				resolve(data && typeof data === "object" ? data : { ok: false, code: "ERROR" });
			} catch {
				resolve({ ok: false, code: "ERROR" });
			}
		});
	});
}

/** 宿主卸载时停掉常驻读取进程。 */
export function disposeWindowsMedia() {
	disposed = true;
	stopDaemon();
}
