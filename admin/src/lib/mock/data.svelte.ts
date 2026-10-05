/**
 * Prototype data. Everything lives in memory and resets on reload; the real
 * console will read the same shapes from the company service.
 */

export type VendorType = 'api' | 'cli';
export type VendorAuth = 'key' | 'account';
export type Protocol = 'openai' | 'anthropic';

export interface Vendor {
	id: string;
	name: string;
	type: VendorType;
	auth: VendorAuth;
	protocol: Protocol | null;
	baseUrl: string | null;
	models: { id: string; name?: string }[];
	catalog: string[];
	catalogAt: number | null;
	color: string;
	builtin: boolean;
}

/** How a member reaches a vendor. */
export type AssignMode = 'shared' | 'dedicated' | 'subscription';

export interface ApiKey {
	id: string;
	vendor: string;
	label: string;
	last4: string;
	/** Shared keys serve several members; a dedicated key serves exactly one. */
	mode: 'shared' | 'dedicated';
	status: 'active' | 'disabled';
	createdAt: number;
	requests30d: number;
	tokens30d: number;
}

export interface Subscription {
	id: string;
	vendor: string;
	plan: string;
	seats: number;
	price: string;
	cycle: 'monthly' | 'yearly';
	renewsAt: number;
	owner: string;
	note?: string;
}

export interface Account {
	id: string;
	subscription: string;
	account: string;
	note?: string;
}

export interface Assignment {
	vendor: string;
	mode: AssignMode;
	/** Key id for shared/dedicated, account id for subscription; null while waiting. */
	ref: string | null;
}

export interface Member {
	name: string;
	displayName: string;
	githubLogin: string;
	githubId: number;
	role: 'admin' | 'member';
	team: '开发' | '产品' | '测试';
	status: 'active' | 'disabled';
	createdAt: number;
	assignments: Assignment[];
	tokens30d: number;
	/** May open web (HTTP) tunnels from GL Work. */
	tunnels: boolean;
	/** May open SSH (TCP) tunnels; granted one by one. */
	ssh: boolean;
}

export interface InternalKey {
	id: string;
	member: string;
	label: string;
	prefix: string;
	createdAt: number;
	lastUsedAt: number | null;
	status: 'active' | 'revoked';
}

export type DeviceKind = 'desktop' | 'browser' | 'internal-key';

export interface Device {
	id: string;
	/** Desktop devices: company plugins installed in GL Work, by id → version. */
	plugins?: Record<string, string>;
	member: string;
	kind: DeviceKind;
	label: string;
	detail: string;
	ip: string;
	online: boolean;
	lastSeenAt: number;
	createdAt: number;
}

export type TunnelType = 'http' | 'ssh';

export interface CompanyPlugin {
	id: string;
	name: string;
	description: string;
	version: string;
	/** Preinstalled with GL Work and cannot be removed, or installed by members when they need it. */
	mode: 'preinstalled' | 'optional';
	/** What the plugin may do, shown before installing. */
	permissions: string[];
	size: string;
}

export interface Tunnel {
	id: string;
	member: string;
	/** The GL Work desktop device the tunnel runs on. */
	device: string;
	type: TunnelType;
	name: string;
	/** Web tunnels: the domain of their address. */
	domain: string;
	localPort: number;
	/** Web tunnels: anyone with the address, or behind a password. */
	protection: 'public' | 'password';
	/** SSH tunnels: who may connect through GL Work (STCP), or 'all' members. */
	sshAccess?: 'all' | string[];
	/** SSH tunnels: a public port on the server, when an administrator allowed one. */
	publicPort?: number;
	online: boolean;
	traffic24h: number;
	requests24h: number;
	createdAt: number;
	lastSeenAt: number;
}

export interface TunnelDomain {
	name: string;
	isDefault: boolean;
	/** Wildcard DNS record pointing at the company server. */
	dns: 'ok' | 'missing' | 'wrong' | 'checking';
	/** Wildcard certificate issued by Traefik. */
	cert: 'ok' | 'pending' | 'failed' | 'checking';
	addedAt: number;
	note?: string;
}

export interface ConfigEntry {
	key: string;
	value: string;
	secret: boolean;
	group: string;
	note?: string;
	updatedAt: number;
	reads7d: number;
}

export interface AuditEntry {
	at: number;
	actor: string;
	action: string;
	target: string;
	detail?: string;
}

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const ago = (ms: number) => NOW - ms;

export const SERVER_IP = '43.156.x.x';
export const GATEWAY = 'https://agent.glgwork.com';

const SESSION_KEY = 'gl-work-prototype-session';
function restoredSession(): string {
	try { return sessionStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; }
}

export const db = $state({
	/** The signed-in member; empty when signed out. */
	me: restoredSession(),
	vendors: [
		{ id: 'claude', name: 'Claude', type: 'cli', auth: 'account', protocol: null, baseUrl: null, models: [], catalog: [], catalogAt: null, color: '#d97757', builtin: true },
		{ id: 'codex', name: 'Codex', type: 'cli', auth: 'account', protocol: null, baseUrl: null, models: [], catalog: [], catalogAt: null, color: '#10a37f', builtin: true },
		{ id: 'qoder', name: 'Qoder', type: 'cli', auth: 'account', protocol: null, baseUrl: null, models: [], catalog: [], catalogAt: null, color: '#7c3aed', builtin: true },
		{
			id: 'deepseek', name: 'DeepSeek', type: 'api', auth: 'key', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',
			models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
			catalog: ['deepseek-flash', 'deepseek-v4-pro'], catalogAt: ago(2 * DAY), color: '#4d6bfe', builtin: true,
		},
		{
			id: 'qwen', name: '千问', type: 'api', auth: 'key', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
			models: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }, { id: 'qwen-plus' }, { id: 'qwen-max' }],
			catalog: ['qwen-max', 'qwen-max-latest', 'qwen-plus', 'qwen-plus-latest', 'qwen-turbo', 'qwen-turbo-latest', 'qwen-long', 'qwen3-coder-plus', 'qwen3-coder-flash',
				'qwen3-235b-a22b', 'qwen3-32b', 'qwen3-30b-a3b', 'qwen3-14b', 'qwen3-8b', 'qwen-vl-max', 'qwen-vl-plus', 'qwen-math-plus', 'qwq-plus', 'qvq-max', 'qwen-mt-plus',
				'qwen2.5-72b-instruct', 'qwen2.5-32b-instruct', 'qwen2.5-14b-instruct', 'qwen2.5-coder-32b-instruct', 'text-embedding-v4', 'qwen-omni-turbo'],
			catalogAt: ago(5 * HOUR), color: '#f59e0b', builtin: true,
		},
		{
			id: 'volcengine', name: '火山方舟', type: 'api', auth: 'key', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
			models: [{ id: 'doubao-seed-1-6', name: '豆包 Seed 1.6' }],
			catalog: ['doubao-seed-1-6', 'doubao-seed-1-6-thinking', 'doubao-seed-1-6-flash', 'doubao-1-5-pro-32k', 'deepseek-v3-1', 'kimi-k2'],
			catalogAt: ago(1 * DAY), color: '#14b8a6', builtin: true,
		},
	] as Vendor[],
	keys: [
		{ id: 'key_ds1', vendor: 'deepseek', label: '公司主账号', last4: 'c893', mode: 'shared', status: 'active', createdAt: ago(40 * DAY), requests30d: 18_420, tokens30d: 61_200_000 },
		{ id: 'key_ds2', vendor: 'deepseek', label: '研发专用', last4: '7a1e', mode: 'dedicated', status: 'active', createdAt: ago(12 * DAY), requests30d: 6_310, tokens30d: 23_900_000 },
		{ id: 'key_qw1', vendor: 'qwen', label: '百炼主账号', last4: '1111', mode: 'shared', status: 'active', createdAt: ago(20 * DAY), requests30d: 3_204, tokens30d: 9_870_000 },
		{ id: 'key_vc1', vendor: 'volcengine', label: '方舟测试', last4: 'e0f2', mode: 'shared', status: 'disabled', createdAt: ago(8 * DAY), requests30d: 120, tokens30d: 310_000 },
	] as ApiKey[],
	subscriptions: [
		{ id: 'sub_claude', vendor: 'claude', plan: 'Claude Max 5x', seats: 2, price: '$100', cycle: 'monthly', renewsAt: ago(-4 * DAY), owner: 'wuming', note: '公司信用卡' },
		{ id: 'sub_codex', vendor: 'codex', plan: 'ChatGPT Team', seats: 3, price: '$30 / 席', cycle: 'monthly', renewsAt: ago(-18 * DAY), owner: 'wuming' },
		{ id: 'sub_qoder', vendor: 'qoder', plan: 'Qoder Pro', seats: 2, price: '$20', cycle: 'monthly', renewsAt: ago(-26 * DAY), owner: 'lina' },
	] as Subscription[],
	accounts: [
		{ id: 'acct_c1', subscription: 'sub_claude', account: 'ai-claude-1@glgwork.com' },
		{ id: 'acct_c2', subscription: 'sub_claude', account: 'ai-claude-2@glgwork.com' },
		{ id: 'acct_x1', subscription: 'sub_codex', account: 'codex-dev-1@glgwork.com' },
		{ id: 'acct_x2', subscription: 'sub_codex', account: 'codex-dev-2@glgwork.com' },
		{ id: 'acct_x3', subscription: 'sub_codex', account: 'codex-qa@glgwork.com', note: '测试组共用设备' },
		{ id: 'acct_q1', subscription: 'sub_qoder', account: 'qoder-1@glgwork.com' },
	] as Account[],
	members: [
		{
			name: 'wuming', displayName: '吴明', githubLogin: 'eva2show', githubId: 9_919, role: 'admin', team: '开发', status: 'active', createdAt: ago(60 * DAY), tokens30d: 21_400_000, tunnels: true, ssh: true,
			assignments: [{ vendor: 'deepseek', mode: 'dedicated', ref: 'key_ds2' }, { vendor: 'claude', mode: 'subscription', ref: 'acct_c1' }, { vendor: 'qwen', mode: 'shared', ref: 'key_qw1' }],
		},
		{
			name: 'lina', displayName: '李娜', githubLogin: 'lina-pm', githubId: 1_024, role: 'admin', team: '产品', status: 'active', createdAt: ago(55 * DAY), tokens30d: 8_800_000, tunnels: false, ssh: false,
			assignments: [{ vendor: 'deepseek', mode: 'shared', ref: 'key_ds1' }, { vendor: 'qoder', mode: 'subscription', ref: 'acct_q1' }],
		},
		{
			name: 'zhangwei', displayName: '张伟', githubLogin: 'zw-dev', githubId: 4_096, role: 'member', team: '开发', status: 'active', createdAt: ago(50 * DAY), tokens30d: 30_100_000, tunnels: true, ssh: true,
			assignments: [{ vendor: 'deepseek', mode: 'shared', ref: 'key_ds1' }, { vendor: 'codex', mode: 'subscription', ref: 'acct_x1' }, { vendor: 'claude', mode: 'subscription', ref: 'acct_c2' }],
		},
		{
			name: 'chenjie', displayName: '陈杰', githubLogin: 'chenjie', githubId: 2_048, role: 'member', team: '开发', status: 'active', createdAt: ago(30 * DAY), tokens30d: 18_700_000, tunnels: true, ssh: false,
			assignments: [{ vendor: 'deepseek', mode: 'shared', ref: 'key_ds1' }, { vendor: 'codex', mode: 'subscription', ref: 'acct_x2' }, { vendor: 'qwen', mode: 'shared', ref: 'key_qw1' }],
		},
		{
			name: 'sunyu', displayName: '孙雨', githubLogin: 'sunyu-qa', githubId: 8_192, role: 'member', team: '测试', status: 'active', createdAt: ago(21 * DAY), tokens30d: 6_200_000, tunnels: true, ssh: false,
			assignments: [{ vendor: 'deepseek', mode: 'shared', ref: 'key_ds1' }, { vendor: 'codex', mode: 'subscription', ref: 'acct_x3' }, { vendor: 'qoder', mode: 'subscription', ref: null }],
		},
		{
			name: 'zhaolei', displayName: '赵磊', githubLogin: 'zhaolei', githubId: 16_384, role: 'member', team: '产品', status: 'disabled', createdAt: ago(45 * DAY), tokens30d: 0, tunnels: false, ssh: false,
			assignments: [],
		},
	] as Member[],
	internalKeys: [
		{ id: 'ik_1', member: 'wuming', label: 'Claude Code（DeepSeek）', prefix: 'awk_9f2c…a1b2', createdAt: ago(10 * DAY), lastUsedAt: ago(20 * MIN), status: 'active' },
		{ id: 'ik_2', member: 'zhangwei', label: 'CI 脚本', prefix: 'awk_77d0…e4f9', createdAt: ago(6 * DAY), lastUsedAt: ago(3 * HOUR), status: 'active' },
		{ id: 'ik_3', member: 'chenjie', label: '内网穿透', prefix: 'awk_c41a…0b3d', createdAt: ago(4 * DAY), lastUsedAt: ago(2 * MIN), status: 'active' },
		{ id: 'ik_4', member: 'sunyu', label: '自动化测试', prefix: 'awk_120e…88aa', createdAt: ago(15 * DAY), lastUsedAt: ago(9 * DAY), status: 'revoked' },
	] as InternalKey[],
	devices: [
		{ id: 'd1', plugins: { 'team-bundle': '0.2.0', tunnel: '0.1.0' }, member: 'wuming', kind: 'desktop', label: 'MacBook Pro 16"', detail: 'GL Work 0.2.0 · macOS 26 arm64', ip: '58.247.x.x', online: true, lastSeenAt: ago(1 * MIN), createdAt: ago(30 * DAY) },
		{ id: 'd2', member: 'wuming', kind: 'browser', label: 'Chrome · 管理后台', detail: 'macOS', ip: '58.247.x.x', online: true, lastSeenAt: ago(0), createdAt: ago(2 * DAY) },
		{ id: 'd3', member: 'wuming', kind: 'internal-key', label: 'Claude Code（DeepSeek）', detail: 'awk_9f2c…a1b2', ip: '58.247.x.x', online: false, lastSeenAt: ago(20 * MIN), createdAt: ago(10 * DAY) },
		{ id: 'd4', plugins: { 'team-bundle': '0.2.0' }, member: 'lina', kind: 'desktop', label: 'MacBook Air', detail: 'GL Work 0.2.0 · macOS 26 arm64', ip: '116.228.x.x', online: false, lastSeenAt: ago(5 * HOUR), createdAt: ago(25 * DAY) },
		{ id: 'd5', plugins: { 'team-bundle': '0.2.0', tunnel: '0.1.0' }, member: 'zhangwei', kind: 'desktop', label: 'Mac Studio', detail: 'GL Work 0.2.0 · macOS 26 arm64', ip: '101.80.x.x', online: true, lastSeenAt: ago(3 * MIN), createdAt: ago(40 * DAY) },
		{ id: 'd6', member: 'zhangwei', kind: 'internal-key', label: 'CI 脚本', detail: 'awk_77d0…e4f9', ip: '47.236.x.x', online: false, lastSeenAt: ago(3 * HOUR), createdAt: ago(6 * DAY) },
		{ id: 'd7', plugins: { 'team-bundle': '0.2.0', tunnel: '0.1.0' }, member: 'chenjie', kind: 'desktop', label: 'ThinkPad X1', detail: 'GL Work 0.2.0 · Windows 11 x64', ip: '180.169.x.x', online: true, lastSeenAt: ago(2 * MIN), createdAt: ago(20 * DAY) },
		{ id: 'd9', plugins: { 'team-bundle': '0.1.9', tunnel: '0.1.0' }, member: 'sunyu', kind: 'desktop', label: 'MacBook Pro 14"', detail: 'GL Work 0.1.9 · macOS 26 arm64', ip: '222.66.x.x', online: false, lastSeenAt: ago(2 * DAY), createdAt: ago(21 * DAY) },
	] as Device[],
	tunnels: [
		{ id: 't1', member: 'chenjie', device: 'd7', type: 'http', name: 'shop-h5', domain: 't.glgwork.com', localPort: 5173, protection: 'public', online: true, traffic24h: 820_000_000, requests24h: 4_210, createdAt: ago(3 * DAY), lastSeenAt: ago(0) },
		{ id: 't2', member: 'chenjie', device: 'd7', type: 'http', name: 'pay-callback', domain: 'hook.glgwork.com', localPort: 8080, protection: 'password', online: true, traffic24h: 2_400_000, requests24h: 86, createdAt: ago(4 * DAY), lastSeenAt: ago(0) },
		{ id: 't3', member: 'zhangwei', device: 'd5', type: 'http', name: 'api', domain: 't.glgwork.com', localPort: 3000, protection: 'password', online: false, traffic24h: 0, requests24h: 0, createdAt: ago(9 * DAY), lastSeenAt: ago(26 * HOUR) },
		{ id: 't4', member: 'sunyu', device: 'd9', type: 'http', name: 'mock-server', domain: 't.glgwork.com', localPort: 4010, protection: 'public', online: false, traffic24h: 12_000_000, requests24h: 530, createdAt: ago(12 * DAY), lastSeenAt: ago(7 * HOUR) },
		{ id: 't5', member: 'zhangwei', device: 'd5', type: 'ssh', name: 'studio', domain: '', localPort: 22, protection: 'password', sshAccess: ['wuming', 'chenjie'], online: true, traffic24h: 48_000_000, requests24h: 6, createdAt: ago(15 * DAY), lastSeenAt: ago(0) },
		{ id: 't6', member: 'wuming', device: 'd1', type: 'ssh', name: 'mbp', domain: '', localPort: 22, protection: 'password', sshAccess: 'all', online: false, traffic24h: 0, requests24h: 0, createdAt: ago(5 * DAY), lastSeenAt: ago(30 * HOUR) },
	] as Tunnel[],
	plugins: [
		{
			id: 'team-bundle', name: '团队插件', description: '公司账号登录、模型和配置同步。GL Work 自带，不能卸载。', version: '0.2.0', mode: 'preinstalled',
			permissions: ['用公司账号登录', '写入模型配置和凭据'], size: '120 KB',
		},
		{
			id: 'tunnel', name: '内网穿透', description: '把本机的网页服务发布到公网，或让同事经 GL Work 连到你电脑的 SSH。基于 frp。', version: '0.1.0', mode: 'optional',
			permissions: ['运行 frpc 程序（随插件安装，约 15 MB）', '连接公司服务器', '把你选择的本机端口转发出去'], size: '15.2 MB',
		},
	] as CompanyPlugin[],
	tunnelSettings: { enabled: true, allowPublic: true, perMember: 5, idleHours: 24, ssh: true, publicTcp: false, portRange: '20000-20099' },
	frps: { version: '0.65.0', running: true, control: 'wss://agent.glgwork.com/~!frp', since: ago(6 * DAY), clients: 3 },
	/** SSH tunnels this browser's member has opened locally through GL Work (STCP visitors). */
	sshConnections: [{ tunnel: 't5', member: 'chenjie', localPort: 62201, since: ago(40 * MIN) }] as { tunnel: string; member: string; localPort: number; since: number }[],
	tunnelDomains: [
		{ name: 't.glgwork.com', isDefault: true, dns: 'ok', cert: 'ok', addedAt: ago(20 * DAY), note: '日常调试' },
		{ name: 'hook.glgwork.com', isDefault: false, dns: 'ok', cert: 'ok', addedAt: ago(6 * DAY), note: '第三方支付、企业微信回调白名单' },
		{ name: 'preview.glwork.cn', isDefault: false, dns: 'missing', cert: 'pending', addedAt: ago(1 * HOUR), note: '国内客户演示（待配置 DNS）' },
	] as TunnelDomain[],
	config: [
		{ key: 'oss.region', value: 'oss-ap-southeast-1', secret: false, group: '阿里云 OSS', note: '新加坡', updatedAt: ago(9 * DAY), reads7d: 312 },
		{ key: 'oss.bucket', value: 'gl-work-assets', secret: false, group: '阿里云 OSS', updatedAt: ago(9 * DAY), reads7d: 312 },
		{ key: 'oss.accessKeyId', value: 'LTAI5t••••••••••', secret: true, group: '阿里云 OSS', note: '只读 RAM 用户', updatedAt: ago(9 * DAY), reads7d: 298 },
		{ key: 'oss.accessKeySecret', value: '••••••••', secret: true, group: '阿里云 OSS', note: '只读 RAM 用户', updatedAt: ago(9 * DAY), reads7d: 298 },
		{ key: 'feishu.webhook', value: '••••••••', secret: true, group: '通知', note: '发版通知群机器人', updatedAt: ago(3 * DAY), reads7d: 14 },
		{ key: 'sentry.dsn', value: 'https://••••@o1.ingest.sentry.io/42', secret: true, group: '监控', updatedAt: ago(20 * DAY), reads7d: 57 },
		{ key: 'release.channel', value: 'beta', secret: false, group: '发布', note: '客户端更新通道', updatedAt: ago(1 * DAY), reads7d: 640 },
	] as ConfigEntry[],
	audit: [
		{ at: ago(4 * MIN), actor: 'wuming', action: '新建隧道', target: 'pay-callback-chenjie', detail: '本机 8080 · 访问密码' },
		{ at: ago(35 * MIN), actor: 'wuming', action: '分配账号', target: 'sunyu', detail: 'Qoder · 待分配（席位已满）' },
		{ at: ago(2 * HOUR), actor: 'lina', action: '修改系统配置', target: 'release.channel', detail: 'stable → beta' },
		{ at: ago(5 * HOUR), actor: 'wuming', action: '刷新模型列表', target: '千问', detail: '列出 26 个模型' },
		{ at: ago(1 * DAY), actor: 'wuming', action: '停用 Key', target: '方舟测试 …e0f2' },
		{ at: ago(1 * DAY + 2 * HOUR), actor: 'zhangwei', action: '生成内部 Key', target: 'CI 脚本' },
		{ at: ago(2 * DAY), actor: 'wuming', action: '停用成员', target: 'zhaolei', detail: '同时吊销 2 台设备' },
		{ at: ago(3 * DAY), actor: 'system', action: '订阅提醒', target: 'Claude Max 5x', detail: '7 天后续费' },
	] as AuditEntry[],
	usageDaily: Array.from({ length: 14 }, (_, i) => {
		const d = new Date(ago((13 - i) * DAY));
		const weekend = d.getDay() === 0 || d.getDay() === 6;
		const base = weekend ? 1.2 : 4.5;
		return {
			day: `${d.getMonth() + 1}/${d.getDate()}`,
			deepseek: Math.round((base + ((i * 7) % 5) * 0.6) * 1_000_000),
			qwen: Math.round((base * 0.25 + ((i * 3) % 4) * 0.2) * 1_000_000),
			volcengine: i > 9 ? 0 : Math.round(((i * 5) % 3) * 30_000),
		};
	}),
});

// Session (the real console reads it from the company service's cookie)

export function signIn(name: string) {
	db.me = name;
	try { sessionStorage.setItem(SESSION_KEY, name); } catch { /* private mode */ }
	log('登录', name, '浏览器');
}

export function signOut() {
	db.me = '';
	try { sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

export const ORG = 'GL-Game-Group';

// Lookups

export const vendorOf = (id: string) => db.vendors.find((v) => v.id === id);
export const memberOf = (name: string) => db.members.find((m) => m.name === name);
export const keyOf = (id: string | null) => (id === null ? undefined : db.keys.find((k) => k.id === id));
export const accountOf = (id: string | null) => (id === null ? undefined : db.accounts.find((a) => a.id === id));
export const subscriptionOf = (id: string) => db.subscriptions.find((s) => s.id === id);

export function keyUsers(keyId: string): string[] {
	return db.members.filter((m) => m.assignments.some((a) => a.ref === keyId)).map((m) => m.name);
}

export function accountHolder(accountId: string): string | undefined {
	return db.members.find((m) => m.assignments.some((a) => a.mode === 'subscription' && a.ref === accountId))?.name;
}

export function subscriptionAccounts(subId: string): Account[] {
	return db.accounts.filter((a) => a.subscription === subId);
}

/** Pick a key or account for a member the way the service will. */
export function autoAssign(vendorId: string, mode: AssignMode, member: string): string | null {
	if (mode === 'subscription') {
		const subs = db.subscriptions.filter((s) => s.vendor === vendorId).map((s) => s.id);
		return db.accounts.find((a) => subs.includes(a.subscription) && accountHolder(a.id) === undefined)?.id ?? null;
	}
	const candidates = db.keys.filter((k) => k.vendor === vendorId && k.status === 'active' && k.mode === mode)
		.filter((k) => mode === 'shared' || keyUsers(k.id).every((u) => u === member));
	return candidates.sort((a, b) => keyUsers(a.id).length - keyUsers(b.id).length)[0]?.id ?? null;
}

export function tunnelHost(t: Pick<Tunnel, 'name' | 'member' | 'domain'> & { type?: TunnelType; publicPort?: number }): string {
	if (t.type === 'ssh') return t.publicPort ? `agent.glgwork.com:${t.publicPort}` : `ssh://${t.name}-${t.member}`;
	return `${t.name}-${t.member}.${t.domain}`;
}

/** Whether a member may connect to an SSH tunnel. */
export function canConnect(t: Tunnel, member: string): boolean {
	if (t.type !== 'ssh' || t.member === member) return false;
	return t.sshAccess === 'all' || (t.sshAccess ?? []).includes(member);
}

export const defaultDomain = () => db.tunnelDomains.find((d) => d.isDefault)?.name ?? db.tunnelDomains[0]?.name ?? '';
export const usableDomains = () => db.tunnelDomains.filter((d) => d.dns === 'ok' && d.cert === 'ok');
export const deviceOf = (id: string) => db.devices.find((d) => d.id === id);

export function log(action: string, target: string, detail?: string) {
	db.audit.unshift({ at: Date.now(), actor: db.me, action, target, detail });
}

// Formatting

const numberFormat = new Intl.NumberFormat('zh-CN');
export const num = (n: number) => numberFormat.format(n);

export function tokens(n: number): string {
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万`;
	return num(n);
}

export function bytes(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
	return `${n} B`;
}

export function relative(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 0) {
		const days = Math.ceil(-diff / DAY);
		return `${days} 天后`;
	}
	if (diff < 2 * MIN) return '刚刚';
	if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
	return `${Math.floor(diff / DAY)} 天前`;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const datetime = (ms: number) => dateFormat.format(new Date(ms));
const dayFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
export const date = (ms: number) => dayFormat.format(new Date(ms));

export const MODE_LABEL: Record<AssignMode, string> = { shared: '共享 Key', dedicated: '独立 Key', subscription: '订阅账号' };
export const KIND_LABEL: Record<DeviceKind, string> = { desktop: '桌面端', browser: '浏览器', 'internal-key': '内部 Key' };
export const PROTOCOL_LABEL: Record<Protocol, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic Messages' };
