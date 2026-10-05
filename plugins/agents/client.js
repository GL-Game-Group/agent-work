// 命令行 Agent, client half: the "命令行 Agent" block at the bottom of Settings → Models
// (settings.models.footer), drawn from the Host half (index.js) at api/agent-work/agents.
//
// Hand-written in the client module format the Host serves: a factory receiving the loader's require.
window.__ModuleLoader__.load({
	id: '@agent-work/dsh-agents',
	factory: (require) => {
		const React = require('react')
		const ui = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const API = 'api/agent-work/agents'
		const url = (path) => new URL(`${API}/${path}`, document.baseURI)

		const muted = { opacity: 0.65, fontSize: '12px' }
		const row = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
		const danger = { color: 'var(--dsw-alias-text-danger, #dc2626)', fontSize: '12px' }
		const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' }

		function call(path, body) {
			return fetch(url(path), body === undefined ? { credentials: 'same-origin' } : {
				method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
			}).then(r => r.json().then((value) => {
				if (!r.ok) throw new Error(value.error ?? '操作失败')
				return value
			}))
		}

		/** What clicking 安装 does, told before it runs. */
		const PLAN = {
			claude: '运行 Anthropic 官方安装脚本（claude.ai/install.sh），安装到 ~/.local/bin，不修改终端配置。',
			codex: '从 OpenAI 官方 GitHub 发布页下载 Codex，核对 sha256 后放到 ~/.local/bin。',
			qoder: '运行 Qoder 官方安装脚本（qoder.com/install），安装到 ~/.local/bin，不修改终端配置。',
		}

		function CliRow({ cli, localBin, reload }) {
			const [confirming, setConfirming] = React.useState(false)
			const [job, setJob] = React.useState(cli.install?.state === 'running' ? cli.install : null)
			const [signIn, setSignIn] = React.useState(null)
			const [error, setError] = React.useState(null)
			React.useEffect(() => {
				if (job?.state !== 'running') return undefined
				const timer = setInterval(() => call(`install/status?id=${job.id}`).then((next) => {
					setJob(next)
					if (next.state !== 'running') reload()
				}, e => setError(e.message)), 1000)
				return () => clearInterval(timer)
			}, [job?.id, job?.state])
			const installed = cli.path !== null
			const startInstall = () => {
				setConfirming(false)
				setError(null)
				call('install', { id: cli.id }).then(setJob, e => setError(e.message))
			}
			const startLogin = () => {
				setError(null)
				call('login', { id: cli.id }).then((value) => {
					setSignIn(value)
					if (value.url) window.open(value.url, '_blank', 'noopener,noreferrer')
				}, e => setError(e.message))
			}
			const dot = !installed ? 'idle' : cli.signedIn === false ? 'warning' : 'done'
			return h('div', { 'data-cli': cli.id, style: { display: 'grid', gap: '6px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.2))' } },
				h('div', { style: row },
					h(ui.StateDot, { state: job?.state === 'running' ? 'ongoing' : dot }),
					h('strong', null, cli.name),
					installed ? h('span', { style: muted }, cli.version ? `v${cli.version}` : '已安装') : h('span', { style: muted }, '未检测到'),
					installed && cli.signedIn === true ? h(ui.Tag, null, '已登录') : null,
					installed && cli.signedIn === false ? h(ui.Tag, null, '未登录') : null,
					h('span', { style: { marginLeft: 'auto', ...row } },
						!installed && cli.installable && job?.state !== 'running' ? h(ui.Button, { size: 'sm', variant: 'primary', 'data-action': 'install', onClick: () => setConfirming(true) }, '安装') : null,
						!installed && !cli.installable ? h('span', { style: muted }, '这个系统暂不支持一键安装') : null,
						installed && cli.signedIn !== true ? h(ui.Button, { size: 'sm', 'data-action': 'login', onClick: startLogin }, '登录') : null)),
				cli.accounts.length > 0 ? h('div', { style: muted }, `公司分配给你的账号：${cli.accounts.join('、')}`) : null,
				confirming ? h('div', { style: { ...row, background: 'var(--muted, rgba(127,127,127,.08))', borderRadius: '8px', padding: '8px 10px' } },
					h('span', { style: { fontSize: '13px' } }, PLAN[cli.id]),
					h(ui.Button, { size: 'sm', variant: 'primary', 'data-action': 'confirm-install', onClick: startInstall }, '确认安装'),
					h(ui.Button, { size: 'sm', onClick: () => setConfirming(false) }, '取消')) : null,
				job?.state === 'running' ? h('div', { style: muted }, '正在安装…') : null,
				job?.state === 'failed' ? h('div', { style: danger }, job.error) : null,
				job?.state === 'done' && installed && !(cli.path ?? '').startsWith(localBin) ? null
					: job?.state === 'done' ? h('div', { style: muted }, `已安装到 ${localBin}。在终端里使用时，确认这个目录在 PATH 中。`) : null,
				signIn ? h('div', { style: muted },
					signIn.url ? ['已在浏览器打开登录页，完成后回到这里。', h('a', { key: 'u', href: signIn.url, target: '_blank', rel: 'noreferrer', style: { marginLeft: '6px' } }, '重新打开')]
						: ['请在终端中运行 ', h('code', { key: 'c', style: mono }, `${cli.command} ${cli.id === 'claude' ? 'auth login' : 'login'}`), ' 完成登录。']) : null,
				error ? h('div', { style: danger }, error) : null)
		}

		function CliBlock() {
			const [state, setState] = React.useState(null)
			const [error, setError] = React.useState(null)
			const load = React.useCallback(() => call('clis').then(setState, e => setError(e.message)), [])
			React.useEffect(() => { load() }, [load])
			return h('section', { 'data-agent-work': 'cli-agents', style: { display: 'grid', gap: '4px', marginTop: '24px' } },
				h('div', { style: row },
					h('strong', { style: { fontSize: '15px' } }, '命令行 Agent'),
					h(ui.Button, { size: 'sm', variant: 'ghost', icon: h(ui.IconRefreshOutlineRegular, { size: 14 }), 'aria-label': '重新检测', title: '重新检测', onClick: load })),
				h('div', { style: muted }, '本机的 Claude Code、Codex、Qoder CLI。安装后在对话的模型里选择“…（本机）”，即进入直连模式：GL Work 不加提示词和工具，直接和命令行对话。登录由各工具的官方流程在浏览器里完成，GL Work 不保存你的账号凭据。'),
				h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-text-warning, #b45309)' } }, '直连模式下命令行拥有这台电脑的全部权限：可以读写任何文件、执行任何命令，不会逐项确认。'),
				state === null ? h('div', { style: muted }, error ?? '正在检测…')
					: state.clis.map(cli => h(CliRow, { key: cli.id, cli, localBin: state.localBin, reload: load })))
		}

		const exports = {}
		exports.inject = ['slots']
		exports.apply = (ctx) => {
			ctx.effect(() => ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
				name: 'settings.models.footer', id: 'agent-work-cli-agents', order: 10,
			}, CliBlock)), 'agent-work: command-line agents')
		}
		return exports
	}
})
