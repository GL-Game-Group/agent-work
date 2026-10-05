// Company plugins, client half: a "公司插件" card on the Plugins page whose page lists
// the plugins the company published, from the Host half (index.js), and installs
// one when the member confirms what it may do.
//
// Hand-written in the client module format the Host serves (the shape tsdown's
// client preset emits): a factory receiving the loader's require.
window.__ModuleLoader__.load({
	id: '@agent-work/dsh-team-company-plugins',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement
		const ENDPOINT = 'api/agent-work/company-plugins'
		const url = (path) => new URL(path, document.baseURI)

		const muted = { opacity: 0.65, fontSize: '12px' }
		const button = (primary) => ({
			border: '1px solid var(--border, #d4d4d8)', borderRadius: '8px', padding: '4px 12px', fontSize: '13px', cursor: 'pointer',
			background: primary ? 'var(--primary, #037cf4)' : 'transparent', color: primary ? '#fff' : 'inherit', borderColor: primary ? 'transparent' : undefined,
		})

		function size(bytes) {
			return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`
		}

		function useCatalog() {
			const [state, setState] = React.useState({ loading: true })
			const load = React.useCallback(() => {
				return fetch(url(ENDPOINT), { credentials: 'same-origin' })
					.then(r => r.json())
					.then(body => setState({ loading: false, ...body }))
					.catch(() => setState({ loading: false, error: '读取插件列表失败' }))
			}, [])
			React.useEffect(() => { load() }, [load])
			return [state, load]
		}

		/** What the member can do with one plugin. */
		function action(p, canInstall) {
			if (p.preinstalled) return { label: null, note: p.installedVersion ? `随 GL Work 更新 · 已安装 ${p.installedVersion}` : '随 GL Work 安装' }
			if (!canInstall) return { label: null, note: p.installedVersion ? `已安装 ${p.installedVersion}` : '未安装' }
			if (p.installedVersion === null) return { label: '安装', note: '未安装' }
			if (p.installedVersion !== p.version) return { label: `更新到 ${p.version}`, note: `已安装 ${p.installedVersion}` }
			return { label: null, note: `已安装 ${p.installedVersion}，是最新版本` }
		}

		function PluginRow({ plugin: p, canInstall, onDone }) {
			const [phase, setPhase] = React.useState('idle') // idle | confirm | installing
			const [message, setMessage] = React.useState(null)
			const a = action(p, canInstall)

			function install() {
				setPhase('installing')
				setMessage(null)
				fetch(url(`${ENDPOINT}/install`), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: p.name }) })
					.then(r => r.json().then(body => ({ ok: r.ok, body })))
					.then(({ ok, body }) => {
						setPhase('idle')
						if (!ok) { setMessage({ error: true, text: body.error ?? '安装失败' }); return }
						setMessage({ error: false, text: body.restart ? `已安装 ${body.version}，重启 GL Work 后生效` : `已安装 ${body.version}` })
						onDone()
					})
					.catch(() => { setPhase('idle'); setMessage({ error: true, text: '安装失败，请稍后重试' }) })
			}

			return h('div', { 'data-plugin': p.name, style: { border: '1px solid var(--border, #e5e7eb)', borderRadius: '10px', padding: '12px 14px', display: 'grid', gap: '6px' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
					h('strong', null, p.displayName),
					h('code', { style: muted }, p.version),
					h('span', { style: { ...muted, marginLeft: 'auto' } }, a.note),
					a.label && phase === 'idle' ? h('button', { type: 'button', style: button(true), onClick: () => setPhase('confirm') }, a.label) : null),
				p.description ? h('div', { style: { fontSize: '13px', opacity: 0.8 } }, p.description) : null,
				phase === 'confirm' ? h('div', { 'data-agent-work': 'confirm', style: { background: 'var(--muted, rgba(127,127,127,.08))', borderRadius: '8px', padding: '10px 12px', display: 'grid', gap: '8px' } },
					h('div', { style: { fontSize: '13px', fontWeight: 600 } }, `安装后，${p.displayName} 可以：`),
					p.permissions.length
						? h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '13px' } }, p.permissions.map(perm => h('li', { key: perm }, perm)))
						: h('div', { style: { fontSize: '13px' } }, '（管理员没有填写权限说明）'),
					h('div', { style: muted }, `由公司发布 · ${size(p.size)} · 下载后会核对 sha512，和公司登记的一致才安装`),
					h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
						h('button', { type: 'button', style: button(false), onClick: () => setPhase('idle') }, '取消'),
						h('button', { type: 'button', style: button(true), onClick: install }, '确认安装'))) : null,
				phase === 'installing' ? h('div', { 'data-agent-work': 'installing', style: { fontSize: '13px' } }, '正在下载并安装…') : null,
				message ? h('div', { 'data-agent-work': message.error ? 'install-error' : 'installed', style: { fontSize: '13px', color: message.error ? '#dc2626' : '#059669' } }, message.text) : null,
				phase !== 'confirm' && p.permissions.length ? h('ul', { style: { margin: 0, paddingLeft: '18px', ...muted } }, p.permissions.map(perm => h('li', { key: perm }, perm))) : null,
				h('div', { style: muted }, `${p.name} · ${size(p.size)}`))
		}

		function CompanyPlugins(props) {
			if (props.view === 'summary') return '公司提供的插件，按需安装'
			const [state, reload] = useCatalog()
			if (state.loading) return h('p', { 'data-agent-work': 'loading' }, '正在读取公司插件…')
			if (state.signedIn === false) return h('p', null, '登录公司账号后可以看到公司插件。')
			if (state.error) return h('p', { 'data-agent-work': 'error' }, state.error)
			if (state.plugins.length === 0) return h('p', null, '公司还没有上架插件。')
			return h('div', { 'data-agent-work': 'company-plugins', style: { display: 'grid', gap: '12px' } },
				state.plugins.map(p => h(PluginRow, { key: p.name, plugin: p, canInstall: state.canInstall !== false, onDone: reload })))
		}

		const exports = {}
		exports.inject = ['slots']
		exports.apply = (ctx) => {
			ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item', id: 'agent-work-company-plugins', order: 5, label: () => '公司插件',
			}, CompanyPlugins)), 'agent-work: company plugins page')
		}
		return exports
	}
})
