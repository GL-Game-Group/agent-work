/** Labels, colors and formatting shared by the console's pages. */

export const TEAM_LABEL: Record<string, string> = { dev: '开发', product: '产品', qa: '测试' };
export const MODE_LABEL: Record<string, string> = { shared: '共享 Key', dedicated: '独立 Key', account: '订阅账号' };
export const MODE_SHORT: Record<string, string> = { shared: '共享', dedicated: '独立', account: '订阅' };
export const KIND_LABEL: Record<string, string> = { device: '桌面端', browser: '浏览器', key: '内部 Key', phone: '手机' };
export const PROTOCOL_LABEL: Record<string, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic Messages', dashscope: '阿里云百炼', volcengine: '火山引擎' };

/** Audit actions as people read them. */
export const ACTION_LABEL: Record<string, string> = {
	login: '登录', logout: '退出登录', 'login-code': '签发登录码', 'login-denied': '登录被拒',
	'member-add': '新建成员', 'member-disable': '停用成员', 'member-enable': '启用成员', 'member-role': '修改角色', 'member-delete': '删除成员',
	'member-profile': '修改资料', 'member-tunnels': '修改隧道权限', 'member-vendors': '调整厂商', 'member-assign': '调整分配', 'member-unassign': '关闭厂商',
	'key-issue': '生成内部 Key', 'credential-revoke': '吊销设备', 'key-add': '录入 Key', 'key-enable': '启用 Key', 'key-disable': '停用 Key',
	'key-delete': '删除 Key', 'key-import': '导入 Key', 'vendor-add': '新增厂商', 'vendor-update': '修改厂商', 'vendor-delete': '删除厂商',
	'vendor-catalog': '刷新模型列表', 'vendor-models': '修改开放模型', 'voice-settings': '修改语音设置', 'voice-catalog': '更新官方音色', 'voice-voices': '修改开放音色', 'subscription-add': '新增订阅', 'subscription-update': '修改订阅',
	'subscription-delete': '删除订阅', 'account-add': '添加账号', 'account-release': '收回账号', 'account-delete': '删除账号',
	'config-set': '修改系统配置', 'config-delete': '删除系统配置',
	'plugin-add': '登记插件', 'plugin-update': '更新插件', 'plugin-describe': '修改插件说明', 'plugin-publish': '上架插件', 'plugin-hide': '下架插件', 'plugin-delete': '删除插件',
	'tunnel-create': '新建隧道', 'tunnel-delete': '删除隧道', 'tunnel-close': '关闭隧道', 'tunnel-reopen': '重新开放隧道', 'tunnel-settings': '修改隧道设置',
	'tunnel-domain-add': '添加隧道域名', 'tunnel-domain-default': '设置默认隧道域名', 'tunnel-domain-delete': '删除隧道域名',
	'remote-connect': '手机远程连接', 'remote-prompt': '手机发送消息', 'remote-respond': '手机回答提问或审批'
};

const KNOWN_COLORS: Record<string, string> = {
	deepseek: '#4d6bfe', qwen: '#f59e0b', volcengine: '#14b8a6', claude: '#d97757', codex: '#10a37f', qoder: '#7c3aed'
};
const PALETTE = ['#0ea5e9', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#06b6d4', '#a855f7'];

export function vendorColor(id: string): string {
	return KNOWN_COLORS[id] ?? PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length]!;
}

const numberFormat = new Intl.NumberFormat('zh-CN');
export const num = (n: number) => numberFormat.format(n);

export function tokens(n: number): string {
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万`;
	return num(n);
}

export function relative(ms: number | null | undefined, now = Date.now()): string {
	if (ms === null || ms === undefined) return '从未';
	const diff = now - ms;
	const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
	if (diff < 0) return `${Math.ceil(-diff / DAY)} 天后`;
	if (diff < 2 * MIN) return '刚刚';
	if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
	return `${Math.floor(diff / DAY)} 天前`;
}

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const datetime = (ms: number) => dateTimeFormat.format(new Date(ms));
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
export const date = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : dateFormat.format(new Date(ms)));

/** yyyy-mm-dd for date inputs. */
export function dateInput(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '';
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Active within the last ten minutes: as close to "online" as a polling client gets. */
export const recentlyActive = (ms: number | null | undefined, now = Date.now()) => ms !== null && ms !== undefined && now - ms < 10 * 60_000;
