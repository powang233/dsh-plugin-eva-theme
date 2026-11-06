/** DSH 宿主接口。凭据只用于官方余额请求，永远不进入日志或响应。 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assetRoutes } from "./host-assets.mjs";
import {
	NP_CACHE_MS, NOWPLAYING_PATH, CONTROL_PATH, READ_SCRIPT, controlScript, parseNowPlaying,
	parseSystemNowPlaying, systemControlArgs,
} from "./host-nowplaying.mjs";
import {
	ACCOUNT_CREDENTIAL_ID, BALANCE_PATH, BALANCE_URL, BALANCE_TIMEOUT_MS, CACHE_MS, CREDENTIAL_ID,
	PLATFORM_BALANCE_URL, formatBalance, isTrustedRequest, parseAccountServiceBalance, parseBalance,
	parsePlatformBalance, secretOf, tokenOfGrant,
} from "./host-balance.mjs";
import { controlWindowsMedia, disposeWindowsMedia, readWindowsNowPlaying } from "./host-nowplaying-win.mjs";

export const name = "dsh-plugin-eva-theme";

/** 注册统一带本机校验的 JSON 路由；HEAD 不写响应体。 */
function route(scope, path, method, handle) {
	scope.effect(() => scope.webServer.register({
		kind: "exact", path,
		handler: async (req, res) => {
			const send = (status, body) => {
				if (res.destroyed || res.writableEnded) return;
				res.writeHead(status, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				});
				res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
			};
			if (!isTrustedRequest(req.headers)) return send(403, { ok: false, code: "FORBIDDEN" });
			if (req.method !== method && !(method === "GET" && req.method === "HEAD")) {
				return send(405, { ok: false, code: "METHOD" });
			}
			try { await handle(req, send); }
			catch { send(500, { ok: false, code: "ERROR" }); }
		},
	}), "eva-magi: " + path);
}

/** 小型 JSON 请求；在断开、超限或超时后释放监听器。 */
function readJsonBody(req) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		const done = (value) => {
			clearTimeout(timer);
			for (const [event, fn] of listeners) req.removeListener(event, fn);
			resolve(value);
		};
		const onData = (chunk) => {
			size += chunk.length;
			if (size > 4096) { done(null); req.resume(); }
			else chunks.push(chunk);
		};
		const onEnd = () => {
			try {
				const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				done(value && typeof value === "object" && !Array.isArray(value) ? value : null);
			} catch { done(null); }
		};
		const onError = () => done(null);
		const listeners = [["data", onData], ["end", onEnd], ["error", onError], ["aborted", onError]];
		const timer = setTimeout(onError, 5000);
		for (const [event, fn] of listeners) req.on(event, fn);
	});
}

export function apply(ctx) {
	// Static media contains no account data. Exact package paths also work in remote-control views.
	ctx.inject(["webServer"], (scope) => {
		for (const {path, handler} of assetRoutes()) scope.effect(() => scope.webServer.register({kind:"exact", path, handler}), "eva-magi: asset " + path);
	});

	/**
	 * DSH 自己的账号服务（account-controller 底层就是它）。
	 * 这条通道由宿主拿 token 去问平台，**插件全程不接触凭据**，所以排在第一位。
	 * 服务名随版本可能不同，也可能根本不存在 —— 注入不到就静默降级到后面的通道。
	 */
	let accountService = null;
	if (typeof ctx.inject === "function") {
		for (const key of ["deepseekAccount", "accountController"]) {
			try {
				ctx.inject([key], (scope) => {
					let service = null;
					try { service = scope[key] || null; } catch { service = null; }
					if (service && typeof service.getBalance === "function") accountService = service;
					scope.effect(() => () => { if (accountService === service) accountService = null; }, "eva-magi: account service");
				});
			} catch { /* 该宿主没有这个服务 */ }
		}
	}

	// 余额需要凭据；音乐只需要 webServer，两个能力独立降级。
	ctx.inject(["webServer", "credentials"], (scope) => {
		const lifecycle = new AbortController();
		scope.effect(() => () => lifecycle.abort(), "eva-magi: balance requests");
		let cache = null;
		let inflight = null;

		/** 账号服务的元数据参数：只有语言/时区有意义，version 仅供平台统计。 */
		const accountClient = () => {
			let locale = "zh-CN", version = "0.0.0";
			try { locale = Intl.DateTimeFormat().resolvedOptions().locale || locale; } catch { /* 保持默认 */ }
			try { version = String(ctx.app?.version || ctx.version || version); } catch { /* 保持默认 */ }
			return { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
		};

		/** 通道一：DSH 账号服务（不碰凭据）。 */
		const readByAccountService = async () => {
			const service = accountService;
			if (!service) return { ok: false, code: "NO_ACCOUNT_SERVICE" };
			const info = parseAccountServiceBalance(await service.getBalance(accountClient()));
			return info
				? { ok: true, source: "account", via: "service", ...info, text: formatBalance(info) }
				: { ok: false, code: "NO_ACCOUNT_BALANCE" };
		};

		/** 通道二：开放平台 API Key（`/user/balance`，Bearer sk-…）。 */
		const readByApiKey = async (signal) => {
			let key = "";
			try { key = secretOf(await scope.credentials.resolve(CREDENTIAL_ID)); } catch { key = ""; }
			signal.throwIfAborted();
			if (!key) return { ok: false, code: "NO_KEY" };
			const response = await fetch(BALANCE_URL, {
				signal, headers: { authorization: "Bearer " + key, accept: "application/json" },
			});
			if (!response.ok) return { ok: false, code: "HTTP_" + response.status };
			const info = parseBalance(await response.json());
			return info
				? { ok: true, source: "api-key", via: "credentials", ...info, text: formatBalance(info) }
				: { ok: false, code: "NO_BALANCE" };
		};

		/**
		 * 通道三：账号 grant 的 token 直连平台充值钱包。
		 * 只在账号服务不存在/失败时启用；token 取自凭据服务，不落盘、不写日志、不进响应。
		 */
		const readByAccountToken = async (signal) => {
			let token = "";
			try { token = tokenOfGrant(await scope.credentials.resolve(ACCOUNT_CREDENTIAL_ID)); } catch { token = ""; }
			signal.throwIfAborted();
			if (!token) return { ok: false, code: "NO_ACCOUNT" };
			const response = await fetch(PLATFORM_BALANCE_URL, {
				signal, headers: { "x-dsh-auth-token": token, accept: "application/json" },
			});
			if (!response.ok) return { ok: false, code: "ACCOUNT_HTTP_" + response.status };
			const info = parsePlatformBalance(await response.json());
			return info
				? { ok: true, source: "account", via: "token", ...info, text: formatBalance(info) }
				: { ok: false, code: "NO_ACCOUNT_BALANCE" };
		};

		const readBalance = async (force) => {
			if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.body;
			if (inflight) return inflight;
			const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(BALANCE_TIMEOUT_MS)]);
			const task = (async () => {
				try {
					const byService = await readByAccountService();
					if (byService.ok) return byService;
					const byKey = await readByApiKey(signal);
					if (byKey.ok) return byKey;
					const byToken = await readByAccountToken(signal);
					if (byToken.ok) return byToken;
					// 全都没成：优先报"没配 API Key"（最常见），否则报最后一条的具体失败码。
					return byKey.code === "NO_KEY" ? byKey : byToken;
				} catch (error) {
					if (error?.name === "AbortError" || signal.aborted) return { ok: false, code: "TIMEOUT" };
					// 账号服务抛错时仍要给 API Key 通道一次机会。
					try {
						const byKey = await readByApiKey(signal);
						if (byKey.ok) return byKey;
					} catch { /* 落到下面的统一失败 */ }
					return { ok: false, code: "ERROR" };
				}
			})();
			inflight = task;
			try {
				const body = await task;
				if (body.ok && !lifecycle.signal.aborted) cache = { at: Date.now(), body };
				return body;
			} finally { if (inflight === task) inflight = null; }
		};
		route(scope, BALANCE_PATH, "GET", async (req, send) => {
			const refresh = new URL(req.url || BALANCE_PATH, "http://localhost").searchParams.get("refresh") === "1";
			send(200, await readBalance(refresh));
		});
	});

	ctx.inject(["webServer"], (scope) => {
		const lifecycle = new AbortController();
		scope.effect(() => () => lifecycle.abort(), "eva-magi: music processes");
		scope.effect(() => () => disposeWindowsMedia(), "eva-magi: windows media bridge");
		const supported = process.platform === "darwin" || process.platform === "win32";
		const runOsaArgs = (args) => new Promise((resolve) => {
			if (!supported || lifecycle.signal.aborted) return resolve(null);
			execFile("osascript", args, {
				timeout: 5000, maxBuffer: 64 * 1024, signal: lifecycle.signal,
			}, (error, stdout) => resolve(error ? null : String(stdout || "")));
		});
		const runOsa = (script) => runOsaArgs(["-e", script]);
		const mediaScript = fileURLToPath(new URL("./system-nowplaying.jxa", import.meta.url));
		const runMedia = (args) => runOsaArgs(["-l", "JavaScript", mediaScript, ...args]);
		let cache = null;
		let inflight = null;
		let generation = 0;
		const invalidate = () => { generation++; cache = null; inflight = null; };
		const readNowPlaying = async (force) => {
			if (process.platform === "win32") return readWindowsNowPlaying(force);
			if (!supported) return { ok: true, supported: false, app: null, playing: false };
			if (!force && cache && Date.now() - cache.at < NP_CACHE_MS) return cache.body;
			if (inflight) return inflight;
			const started = generation;
			const task = (async () => {
				const system = parseSystemNowPlaying(await runMedia(["read"]));
				if (system?.playing) return { ok: true, supported: true, ...system };
				const raw = await runOsa(READ_SCRIPT);
				const app = raw === null ? null : parseNowPlaying(raw);
				if (app?.playing) return { ok: true, supported: true, source: "app", ...app };
				if (system?.app || system && !app?.app) return { ok: true, supported: true, ...system };
				return app === null
					? { ok: false, code: "PLAYER_UNAVAILABLE", app: null, playing: false }
					: { ok: true, supported: true, source: "app", ...app };
			})();
			inflight = task;
			try {
				const body = await task;
				if (started === generation && !lifecycle.signal.aborted) cache = { at: Date.now(), body };
				return body;
			} finally { if (inflight === task) inflight = null; }
		};
		route(scope, NOWPLAYING_PATH, "GET", async (req, send) => send(200, await readNowPlaying(new URL(req.url, "http://localhost").searchParams.get("refresh") === "1")));
		route(scope, CONTROL_PATH, "POST", async (req, send) => {
			const body = await readJsonBody(req);
			if (!body) return send(400, { ok: false, code: "BODY" });
			if (!controlScript("Music", body.action)) return send(400, { ok: false, code: "ACTION" });
			if (!supported) return send(409, { ok: false, code: "UNSUPPORTED" });
			if (process.platform === "win32") {
				const result = await controlWindowsMedia(body.action, typeof body.bundleId === "string" ? body.bundleId : "");
				if (result?.ok) return send(200, { ok: true, app: result.app ?? null, action: body.action });
				return send(result?.code === "SOURCE_CHANGED" ? 409 : 502, { ok: false, code: result?.code || "CONTROL_UNAVAILABLE" });
			}
			const direct = body.bundleId ? systemControlArgs(body.action, body.bundleId) : null;
			if (body.bundleId && !direct) return send(400, { ok: false, code: "BODY" });
			const controlSystem = async (args) => {
				let result;
				try { result = JSON.parse(await runMedia(args)); } catch { result = null; }
				return result;
			};
			invalidate();
			try {
				// JXA 在同一次调用中核对当前 bundleId 并控制，无需先读取整套曲目元数据。
				if (direct) {
					const result = await controlSystem(direct);
					if (result?.ok) return send(200, { ok: true, bundleId: body.bundleId, action: body.action });
					if (["SOURCE_CHANGED", "NO_APP"].includes(result?.code)) return send(409, { ok: false, code: result.code });
				}
				const current = await readNowPlaying(true);
				if (body.app && body.app !== current.app || body.bundleId && body.bundleId !== current.bundleId) return send(409, { ok: false, code: "SOURCE_CHANGED" });
				if (current.source === "system") {
					const args = systemControlArgs(body.action, current.bundleId);
					if (!args) return send(409, { ok: false, code: "NO_APP" });
					if (!direct) {
						const result = await controlSystem(args);
						if (result?.ok) return send(200, { ok: true, app: current.app, action: body.action });
						if (["SOURCE_CHANGED", "NO_APP"].includes(result?.code)) return send(409, { ok: false, code: result.code });
					}
					// 系统接口不可用时，仅允许 Music / Spotify 的固定脚本，不重复发送系统动作。
					const nativeApp = current.bundleId === "com.apple.Music" ? "Music" : current.bundleId === "com.spotify.client" ? "Spotify" : null;
					const fallback = controlScript(nativeApp, body.action);
					if (!fallback || await runOsa(fallback) === null) return send(502, { ok: false, code: "CONTROL_UNAVAILABLE" });
					return send(200, { ok: true, app: current.app, action: body.action });
				}
				const script = controlScript(current.app, body.action);
				if (!script) return send(409, { ok: false, code: "NO_APP" });
				if (await runOsa(script) === null) return send(502, { ok: false, code: "PLAYER_UNAVAILABLE" });
				return send(200, { ok: true, app: current.app, action: body.action });
			} finally { invalidate(); }
		});
	});
}
