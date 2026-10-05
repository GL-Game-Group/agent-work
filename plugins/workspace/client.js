// 工作区管理, client half, drawn from the Host half (index.js) at api/agent-work/workspace:
// - "GitHub CLI" on the Plugins page: install gh, sign in to GitHub, let git use that sign-in;
// - the new-workspace flow (the sidebar + button and the empty-state picker): a local folder
//   or a repository of the company organization, cloned or added as a worktree;
// - 复制为工作区 and 删除工作树 in a workspace's "..." menu (patches/0011), with their dialogs.
//
// Hand-written in the client module format the Host serves: a factory receiving the loader's require.
window.__ModuleLoader__.load({
	id: '@agent-work/dsh-workspace',
	factory: (require) => {
		const React = require('react')
		const ui = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const API = 'api/agent-work/workspace'
		const url = (path) => new URL(`${API}/${path}`, document.baseURI)

		const muted = { opacity: 0.65, fontSize: '12px' }
		const row = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
		const stack = { display: 'grid', gap: '10px' }
		const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12.5px', wordBreak: 'break-all' }
		const danger = { color: 'var(--dsw-alias-text-danger, #dc2626)', fontSize: '13px' }
		const card = { border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))', borderRadius: '12px', padding: '12px 14px', display: 'grid', gap: '8px' }

		/** GET or POST one Host route; a refusal becomes an Error with the Host's message. */
		function call(path, body) {
			return fetch(url(path), body === undefined ? { credentials: 'same-origin' } : {
				method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
			}).then(r => r.json().then((value) => {
				if (!r.ok) throw new Error(value.error ?? '操作失败')
				return value
			}))
		}

		/** A labelled input. */
		const field = (label, input) => h('label', { style: { display: 'grid', gap: '4px', fontSize: '12px' } }, h('span', { style: { opacity: 0.7 } }, label), input)

		/** The branch a new worktree starts (the same rule as git.js branchFor). */
		function branchFor(login, name) {
			const slug = name.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-')
			return login ? `${login.toLowerCase()}/${slug}` : slug
		}

		// --- Tools: git and gh ---------------------------------------------------------------

		function useTools() {
			const [tools, setTools] = React.useState(null)
			const [error, setError] = React.useState(null)
			const load = React.useCallback(() => call('tools').then(setTools, e => setError(e.message)), [])
			React.useEffect(() => { load() }, [load])
			// While GitHub sign-in waits for the browser, follow it.
			React.useEffect(() => {
				if (tools?.signIn.state !== 'waiting') return undefined
				const timer = setInterval(load, 2000)
				return () => clearInterval(timer)
			}, [tools?.signIn.state, load])
			return { tools, error, setError, setTools, load }
		}

		function ToolsPanel({ state, compact }) {
			const { tools, error, setError, setTools } = state
			const [busy, setBusy] = React.useState(null)
			const act = (path, label) => {
				setBusy(label)
				setError(null)
				call(path, {}).then(setTools, e => setError(e.message)).finally(() => setBusy(null))
			}
			if (tools === null) return h('div', { style: muted }, error ?? '正在检查…')
			const gh = tools.gh
			return h('div', { style: stack, 'data-agent-work': 'tools' },
				h('div', { style: row },
					h(ui.StateDot, { state: tools.git.available ? 'done' : 'error' }),
					tools.git.available ? h('span', null, tools.git.version) : h('span', { style: danger }, '没有找到 Git。macOS 请在终端运行 xcode-select --install；Windows 请安装 Git for Windows')),
				h('div', { style: row },
					h(ui.StateDot, { state: gh.available ? 'done' : 'idle' }),
					gh.available
						? h('span', null, `${gh.version ?? 'GitHub CLI'}${gh.source === 'installed' ? '（GL Work 安装）' : gh.source === 'system' ? '（系统已安装）' : ''}`)
						: h('span', null, '还没有安装 GitHub CLI（gh）'),
					!gh.available && tools.installable ? h(ui.Button, { size: 'sm', variant: 'primary', disabled: busy !== null, 'data-action': 'install-gh', onClick: () => act('tools/install-gh', 'install') },
						busy === 'install' ? '正在安装…' : '一键安装') : null),
				!gh.available && !compact ? h('div', { style: muted }, '从 GitHub 官方下载 gh，核对 sha256 后安装到 GL Work 自己的目录，不需要管理员权限，也不改系统设置。') : null,
				gh.available ? h('div', { style: row },
					h(ui.StateDot, { state: gh.login ? 'done' : tools.signIn.state === 'waiting' ? 'ongoing' : 'idle' }),
					gh.login ? h('span', null, `已登录 GitHub：${gh.login}`) : h('span', null, '还没有登录 GitHub'),
					!gh.login && tools.signIn.state !== 'waiting' ? h(ui.Button, { size: 'sm', variant: 'primary', disabled: busy !== null, 'data-action': 'gh-login', onClick: () => act('tools/gh-login', 'login') }, '登录 GitHub') : null) : null,
				tools.signIn.state === 'waiting' ? h('div', { style: { ...card, gap: '6px' }, 'data-agent-work': 'gh-code' },
					h('div', null, '浏览器会打开 GitHub，在页面上输入这个代码：'),
					h('div', { style: row },
						h('code', { style: { ...mono, fontSize: '18px', letterSpacing: '2px' } }, tools.signIn.code ?? '…'),
						tools.signIn.code ? h(ui.Button, { size: 'sm', onClick: () => ui.writeClipboard(tools.signIn.code) }, '复制') : null,
						h('a', { href: tools.signIn.url, target: '_blank', rel: 'noreferrer' }, '打开 GitHub'),
						h(ui.Button, { size: 'sm', variant: 'ghost', onClick: () => act('tools/gh-login/cancel', 'cancel') }, '取消'))) : null,
				tools.signIn.state === 'failed' ? h('div', { style: danger }, `登录没有完成：${tools.signIn.message ?? ''}`) : null,
				gh.login && !compact ? h('div', { style: row },
					h(ui.StateDot, { state: gh.gitHelper ? 'done' : 'idle' }),
					gh.gitHelper ? h('span', null, 'git 已使用 GitHub 登录') : h('span', null, 'git 还没有使用 GitHub 登录'),
					!gh.gitHelper ? h(ui.Button, { size: 'sm', disabled: busy !== null, onClick: () => act('tools/gh-setup-git', 'git') }, '让 git 使用 GitHub 登录') : null) : null,
				gh.login && !gh.gitHelper && !compact ? h('div', { style: muted }, '会在 git 的全局配置里加上 gh 作为 github.com 的凭据助手，之后在终端里 git push / pull 公司仓库也用这个登录。不配置也能克隆。') : null,
				error ? h('div', { style: danger }, error) : null)
		}

		function GitHubCard(props) {
			if (props.view === 'summary') return '安装 GitHub CLI、登录 GitHub，用于从公司仓库新建工作区'
			const state = useTools()
			return h('div', { style: stack },
				h('div', { style: muted }, '新建工作区时可以从公司 GitHub 组织的仓库克隆，需要本机有 Git 和 GitHub CLI（gh），并用你自己的 GitHub 账号登录。登录信息只保存在这台电脑上。'),
				h(ToolsPanel, { state, compact: false }))
		}

		// --- New workspace ------------------------------------------------------------------

		function LocalTab({ pick, onPicked, onError }) {
			const [path, setPath] = React.useState(null)
			const [facts, setFacts] = React.useState(null)
			const [init, setInit] = React.useState(false)
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState(null)
			const choose = () => {
				setError(null)
				pick().then((picked) => {
					if (picked === null) return
					setPath(picked)
					setFacts(null)
					setInit(false)
					call(`info?path=${encodeURIComponent(picked)}`).then(setFacts, () => setFacts({ git: false }))
				}, e => onError(e instanceof Error ? e.message : String(e)))
			}
			const create = () => {
				setBusy(true)
				call('local', { path, init }).then(r => onPicked(r.path), (e) => { setError(e.message); setBusy(false) })
			}
			return h('div', { style: stack, 'data-agent-work': 'local' },
				h('div', { style: row }, h(ui.Button, { onClick: choose, 'data-action': 'pick-folder' }, path ? '重新选择' : '选择文件夹'), path ? h('code', { style: mono }, path) : null),
				path && facts ? (facts.git
					? h('div', { style: muted }, `已经是 Git 仓库${facts.branch ? `，当前分支 ${facts.branch}` : ''}`)
					: h(ui.Checkbox, { checked: init, onChange: setInit, label: '初始化为 Git 仓库（之后才能“复制为工作区”）' })) : null,
				error ? h('div', { style: danger }, error) : null,
				h('div', { style: { ...row, justifyContent: 'flex-end' } },
					h(ui.Button, { variant: 'primary', disabled: path === null || facts === null || busy, onClick: create, 'data-action': 'create-local' }, busy ? '正在创建…' : '创建工作区')))
		}

		function GitHubTab({ onPicked }) {
			const state = useTools()
			const ready = state.tools?.git.available && state.tools?.gh.available && state.tools?.gh.login
			const [repos, setRepos] = React.useState(null)
			const [query, setQuery] = React.useState('')
			const [plan, setPlan] = React.useState(null)
			const [mode, setMode] = React.useState('clone')
			const [name, setName] = React.useState('')
			const [branch, setBranch] = React.useState('')
			const [job, setJob] = React.useState(null)
			const [error, setError] = React.useState(null)
			React.useEffect(() => {
				if (!ready || repos !== null) return
				call('repos').then(setRepos, e => setError(e.message))
			}, [ready, repos])
			React.useEffect(() => {
				if (job?.state !== 'running') return undefined
				const timer = setInterval(() => call(`job?id=${job.id}`).then((next) => {
					setJob(next)
					if (next.state === 'done') onPicked(next.path)
				}, e => setError(e.message)), 500)
				return () => clearInterval(timer)
			}, [job?.id, job?.state])
			const choose = (repo) => {
				setError(null)
				call('plan', { repo }).then((p) => {
					setPlan(p)
					setMode(p.mode)
					setName(p.name)
					setBranch(p.branch)
				}, e => setError(e.message))
			}
			const start = () => {
				setError(null)
				const existing = plan.existing[0]
				call('create', { repo: plan.repo, mode, name, branch, ...existing ? { mainRoot: existing.mainRoot } : {} }).then(setJob, e => setError(e.message))
			}
			if (!ready) return h('div', { style: stack }, h('div', { style: muted }, '从 GitHub 克隆需要先安装 GitHub CLI 并登录：'), h(ToolsPanel, { state, compact: true }))
			if (job !== null) {
				return h('div', { style: stack, 'data-agent-work': 'job' },
					h('div', null, job.state === 'running' ? `${job.stage}…` : job.state === 'done' ? '完成，正在打开工作区…' : job.state === 'cancelled' ? '已取消' : '失败'),
					h('div', { style: { height: '6px', borderRadius: '3px', background: 'rgba(127,127,127,.2)', overflow: 'hidden' } },
						h('div', { style: { width: `${job.percent}%`, height: '100%', background: 'var(--primary, #037cf4)', transition: 'width .3s' } })),
					job.error ? h('div', { style: danger }, job.error) : null,
					h('div', { style: { ...row, justifyContent: 'flex-end' } },
						job.state === 'running' ? h(ui.Button, { onClick: () => call('job/cancel', { id: job.id }).then(setJob) }, '取消') : null,
						job.state === 'failed' || job.state === 'cancelled' ? h(ui.Button, { onClick: () => setJob(null) }, '返回') : null))
			}
			if (plan !== null) {
				const existing = plan.existing[0]
				return h('div', { style: stack, 'data-agent-work': 'plan' },
					h('div', { style: row }, h('strong', null, plan.repo), h(ui.Button, { size: 'sm', variant: 'ghost', onClick: () => setPlan(null) }, '换一个')),
					existing ? h('div', { style: row },
						h(ui.Pill, { active: mode === 'worktree', onClick: () => setMode('worktree') }, '创建为工作树（推荐）'),
						h(ui.Pill, { active: mode === 'clone', onClick: () => setMode('clone'), disabled: plan.cloneTargetExists }, '独立克隆')) : null,
					mode === 'worktree' && existing ? h('div', { style: stack },
						h('div', { style: muted }, `本地已有这个仓库：${existing.mainRoot}。工作树和它共用 git 数据，从远端默认分支新建一个分支。`),
						h('div', { style: row },
							field('工作区名字', h(ui.Input, { value: name, onChange: e => { setName(e.target.value); setBranch(branchFor(state.tools.gh.login, e.target.value)) }, 'aria-label': '工作区名字', style: { width: '180px' } })),
							field('新分支', h(ui.Input, { value: branch, onChange: e => setBranch(e.target.value), 'aria-label': '分支', style: { width: '220px' } })))) : h('div', { style: muted }, '克隆到 ', h('code', { style: mono }, plan.cloneTarget)),
					plan.cloneTargetExists && mode === 'clone' ? h('div', { style: danger }, '这个位置已经有文件夹了') : null,
					error ? h('div', { style: danger }, error) : null,
					h('div', { style: { ...row, justifyContent: 'flex-end' } },
						h(ui.Button, { variant: 'primary', 'data-action': 'start', disabled: mode === 'clone' && plan.cloneTargetExists, onClick: start }, mode === 'worktree' ? '创建工作树' : '开始克隆')))
			}
			const q = query.trim().toLowerCase()
			const shown = (repos ?? []).filter(r => q === '' || r.repo.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))
			return h('div', { style: stack, 'data-agent-work': 'repos' },
				h(ui.Input, { className: undefined, style: { width: '100%', boxSizing: 'border-box' }, placeholder: `搜索 ${state.tools.org} 的仓库`, value: query, onChange: e => setQuery(e.target.value), 'aria-label': '搜索仓库' }),
				repos === null && !error ? h('div', { style: muted }, '正在读取仓库列表…') : null,
				error ? h('div', { style: danger }, error) : null,
				h('div', { style: { maxHeight: '320px', overflow: 'auto', display: 'grid', gap: '4px' } },
					shown.map(r => h('button', {
						key: r.repo, type: 'button', 'data-repo': r.repo, onClick: () => choose(r.repo),
						style: { textAlign: 'left', border: '1px solid transparent', borderRadius: '8px', padding: '6px 8px', background: 'transparent', color: 'inherit', cursor: 'pointer' },
					},
					h('div', { style: row }, h('strong', null, r.repo.split('/')[1]), r.private ? h(ui.Tag, null, '私有') : null, r.local ? h(ui.Tag, null, '本地已有') : null),
					r.description ? h('div', { style: muted }, r.description) : null)),
					repos !== null && shown.length === 0 ? h('div', { style: muted }, '没有匹配的仓库') : null))
		}

		/** Occupant of the two directory-flow holes: the 新建工作区 dialog. */
		function makeFlow(pick) {
			return function WorkspaceFlow({ open, busy, onPicked, onCancel, onError }) {
				const [tab, setTab] = React.useState('local')
				if (!open) return null
				return h(ui.Modal, { open: true, onClose: () => { if (!busy) onCancel() }, title: '新建工作区', closeLabel: '关闭' },
					h('div', { style: { ...stack, width: 'min(460px, 72vw)', maxWidth: '100%' }, 'data-agent-work': 'new-workspace' },
						h('div', { style: row },
							h(ui.Pill, { active: tab === 'local', onClick: () => setTab('local'), 'data-tab': 'local' }, '本地文件夹'),
							h(ui.Pill, { active: tab === 'github', onClick: () => setTab('github'), 'data-tab': 'github' }, '从 GitHub 克隆')),
						busy ? h('div', { style: muted }, '正在打开工作区…') : null,
						tab === 'local' ? h(LocalTab, { pick, onPicked, onError }) : h(GitHubTab, { onPicked })))
			}
		}

		// --- Workspace menu: 复制为工作区, 删除工作树 ------------------------------------------

		/** The dialog a menu row opened; the overlay draws it after the menu has closed. */
		const dialog = { value: null, listeners: new Set() }
		const openDialog = (value) => { dialog.value = value; for (const listener of dialog.listeners) listener() }
		const useDialog = () => React.useSyncExternalStore(
			(listener) => { dialog.listeners.add(listener); return () => dialog.listeners.delete(listener) },
			() => dialog.value)

		function CopyMenuItem({ workspaceId, path, title, useMenuOpenState }) {
			const [, setMenuOpen] = useMenuOpenState()
			if (!path) return null
			return h(ui.MenuItemButton, { separatorBefore: true, onSelect: () => { setMenuOpen(false); openDialog({ kind: 'copy', workspaceId, path, title }) } }, '复制为工作区')
		}

		function RemoveMenuItem({ workspaceId, path, title, useMenuOpenState }) {
			const [, setMenuOpen] = useMenuOpenState()
			const [facts, setFacts] = React.useState(null)
			React.useEffect(() => { if (path) call(`info?path=${encodeURIComponent(path)}`).then(setFacts, () => {}) }, [path])
			if (!facts?.worktree) return null
			return h(ui.MenuItemButton, { danger: true, onSelect: () => { setMenuOpen(false); openDialog({ kind: 'remove', workspaceId, path, title }) } }, '删除工作树')
		}

		function CopyDialog({ target }) {
			const [facts, setFacts] = React.useState(null)
			const [login, setLogin] = React.useState(null)
			const [name, setName] = React.useState(`${target.title}-2`)
			const [branch, setBranch] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState(null)
			React.useEffect(() => {
				call(`info?path=${encodeURIComponent(target.path)}`).then(setFacts, e => setError(e.message))
				call('tools').then((t) => { setLogin(t.gh.login); setBranch(branchFor(t.gh.login, name)) }, () => setBranch(branchFor(null, name)))
			}, [target.path])
			const close = () => openDialog(null)
			const init = () => {
				setBusy(true)
				call('local', { path: target.path, init: true }).then(() => call(`info?path=${encodeURIComponent(target.path)}`)).then(setFacts, e => setError(e.message)).finally(() => setBusy(false))
			}
			const submit = () => {
				setBusy(true)
				setError(null)
				call('copy', { path: target.path, name, branch }).then(close, (e) => { setError(e.message); setBusy(false) })
			}
			const body = facts === null ? h('div', { style: muted }, '正在检查…')
				: !facts.git ? h('div', { style: stack },
					h('div', null, '这个工作区还不是 Git 仓库。复制为工作区需要先初始化为 Git 仓库，并至少提交一次。'),
					h('div', null, h(ui.Button, { onClick: init, disabled: busy }, '初始化为 Git 仓库')))
					: !facts.hasCommits ? h('div', null, '仓库还没有任何提交，先提交一次再复制。')
						: h('div', { style: stack },
							h('div', { style: row },
								field('工作区名字', h(ui.Input, { value: name, onChange: e => { setName(e.target.value); setBranch(branchFor(login, e.target.value)) }, 'aria-label': '工作区名字', style: { width: '180px' } })),
								field('新分支', h(ui.Input, { value: branch, onChange: e => setBranch(e.target.value), 'aria-label': '分支', style: { width: '220px' } }))),
							h('div', { style: muted }, `从当前分支${facts.branch ? ` ${facts.branch}` : ''}新建分支，放在仓库旁边的 ${facts.mainRoot.split(/[\\/]/).pop()}.worktrees/ 目录。没提交的文件和依赖（如 node_modules、.env）不会复制，需要在新工作区里重新准备。`))
			return h(ui.Modal, {
				open: true, onClose: close, title: '复制为工作区', closeLabel: '关闭', description: target.title,
				footer: h('div', { style: { ...row, justifyContent: 'flex-end' } },
					h(ui.Button, { onClick: close }, '取消'),
					h(ui.Button, { variant: 'primary', disabled: busy || !facts?.hasCommits, onClick: submit, 'data-action': 'copy' }, busy ? '正在创建…' : '创建')),
			}, h('div', { style: { ...stack, width: 'min(440px, 72vw)', maxWidth: '100%' }, 'data-agent-work': 'copy' }, body, error ? h('div', { style: danger }, error) : null))
		}

		function RemoveDialog({ target }) {
			const [dirty, setDirty] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState(null)
			const close = () => openDialog(null)
			const remove = (force) => {
				setBusy(true)
				setError(null)
				call('remove-worktree', { path: target.path, force }).then((r) => {
					if (r.dirty) { setDirty(r.changes); setBusy(false) } else close()
				}, (e) => { setError(e.message); setBusy(false) })
			}
			return h(ui.Modal, {
				open: true, onClose: close, title: '删除工作树', closeLabel: '关闭', description: target.title,
				footer: h('div', { style: { ...row, justifyContent: 'flex-end' } },
					h(ui.Button, { onClick: close }, '取消'),
					h(ui.Button, { variant: 'primary', disabled: busy, onClick: () => remove(dirty !== null), 'data-action': 'remove' }, dirty !== null ? '仍然删除' : '删除')),
			}, h('div', { style: { ...stack, width: 'min(420px, 72vw)', maxWidth: '100%' }, 'data-agent-work': 'remove' },
				h('div', null, '会删除文件夹 ', h('code', { style: mono }, target.path), '，并从工作区列表里移除。分支和已提交的内容保留在仓库里。'),
				dirty !== null ? h('div', { style: danger }, `这个工作树有 ${dirty} 处没有提交的改动，删除后无法恢复。`) : null,
				error ? h('div', { style: danger }, error) : null))
		}

		function Dialogs() {
			const value = useDialog()
			if (value === null) return null
			return value.kind === 'copy' ? h(CopyDialog, { key: value.path, target: value }) : h(RemoveDialog, { key: value.path, target: value })
		}

		const exports = {}
		exports.inject = ['slots', 'uiWorkspace']
		exports.apply = (ctx) => {
			const desktop = globalThis.__DSH_DIRECTORY_PICKER__
			const pick = desktop === undefined ? () => ctx.uiWorkspace.pickDirectory() : () => desktop.pick()
			const Flow = makeFlow(pick)
			ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item', id: 'agent-work-github', order: 7, label: () => 'GitHub CLI',
			}, GitHubCard)), 'agent-work: GitHub CLI page')
			ctx.effect(() => ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
				ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
					// Single slots held by the shipped picker at priority 0: the lower priority renders, so this
					// shadows it, and removing the plugin brings the shipped picker back.
					yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -1 }, Flow)
					yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -1 }, Flow)
				})), 'agent-work: new workspace flow')
			ctx.effect(() => ctx.slots.inject('sidebar.workspaces.workspace.menu.item', function* () {
				yield ctx.slots.register({ name: 'sidebar.workspaces.workspace.menu.item', id: 'agent-work-copy-workspace', order: 100 }, CopyMenuItem)
				yield ctx.slots.register({ name: 'sidebar.workspaces.workspace.menu.item', id: 'agent-work-remove-worktree', order: 110 }, RemoveMenuItem)
			}), 'agent-work: workspace menu rows')
			ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-work-workspace-dialogs' }, Dialogs)), 'agent-work: workspace dialogs')
		}
		return exports
	}
})
