// 内网穿透 and 手机远程, client half: two cards on the Plugins page, drawn from
// the Host half (index.js) at api/agent-work/tunnel.
//
// Hand-written in the client module format the Host serves (the shape tsdown's
// client preset emits): a factory receiving the loader's require.
window.__ModuleLoader__.load({
	id: '@agent-work/dsh-tunnel',
	factory: (require) => {
		const React = require('react')
		const ui = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const ENDPOINT = 'api/agent-work/tunnel'
		const url = (path) => new URL(path, document.baseURI)

		const muted = { opacity: 0.65, fontSize: '12px' }
		const card = { border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))', borderRadius: '12px', padding: '12px 14px', display: 'grid', gap: '8px' }
		const row = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
		const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12.5px' }
		const select = { height: '36px', borderRadius: '10px', padding: '0 8px', border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' }

		const STATE = {
			on: ['done', '运行中'], starting: ['ongoing', '正在连接'], off: ['idle', '已关闭'], error: ['error', '出错'],
			closed: ['warning', '管理员已关闭'], elsewhere: ['idle', '在另一台电脑上'],
		}

		function Copy({ text, label }) {
			const [done, setDone] = React.useState(false)
			return h('span', { style: { ...row, gap: '4px' } },
				h('code', { style: { ...mono, userSelect: 'all' } }, label ?? text),
				h(ui.Button, { size: 'sm', variant: 'ghost', title: '复制', 'aria-label': '复制', icon: h(ui.IconCopyOutlineRegular, { size: 14 }),
					onClick: () => { ui.writeClipboard(text); setDone(true); setTimeout(() => setDone(false), 1500) } }, done ? '已复制' : null))
		}

		function useTunnels() {
			const [state, setState] = React.useState({ loading: true })
			const load = React.useCallback((refresh) => fetch(url(refresh ? `${ENDPOINT}?refresh` : ENDPOINT), { credentials: 'same-origin' })
				.then(r => r.json()).then(body => setState({ loading: false, ...body }))
				.catch(() => setState(s => ({ ...s, loading: false, error: '读取隧道失败' }))), [])
			React.useEffect(() => {
				load(true)
				const timer = setInterval(() => load(false), 3000)
				return () => clearInterval(timer)
			}, [load])
			const act = React.useCallback((body) => fetch(url(`${ENDPOINT}/action`), {
				method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
			}).then(r => r.json().then(value => ({ ok: r.ok, value }))).then(({ ok, value }) => {
				if (!ok) throw new Error(value.error ?? '操作失败')
				setState({ loading: false, ...value })
				return value
			}), [])
			return [state, act, load]
		}

		function Status({ t }) {
			const [dot, label] = STATE[t.state] ?? STATE.off
			return h('span', { style: { ...row, gap: '6px', fontSize: '13px' }, title: t.message ?? undefined }, h(ui.StateDot, { state: dot }), label)
		}

		function CreateForm({ data, act, onDone }) {
			const canWeb = data.grants.tunnels && data.domains.length > 0
			const canSsh = data.grants.ssh && data.settings.ssh
			const [form, setForm] = React.useState({
				type: canWeb ? 'http' : 'ssh', name: '', localPort: '', domain: data.domains.find(d => d.isDefault)?.name ?? data.domains[0]?.name ?? '',
				// No password unless the member asks for one (or the company requires it).
				protection: data.settings.allowPublic ? 'public' : 'password', access: 'some', members: [], publicPort: false,
			})
			const [error, setError] = React.useState(null)
			const set = (patch) => setForm(f => ({ ...f, ...patch }))
			function submit(e) {
				e.preventDefault()
				setError(null)
				act({
					op: 'create', type: form.type, name: form.name.trim(), localPort: Number(form.localPort),
					...form.type === 'http' ? { domain: form.domain, protection: form.protection } : { sshAccess: form.access === 'all' ? 'all' : form.members, publicPort: form.publicPort },
				}).then(onDone, err => setError(err.message))
			}
			const preview = form.type === 'http' ? `${form.name || '名字'}-${data.member ?? '成员'}.${form.domain}` : null
			return h('form', { onSubmit: submit, 'data-agent-work': 'create', style: { ...card, gap: '12px' } },
				h('strong', null, '新建隧道'),
				h('div', { style: row },
					canWeb ? h(ui.Pill, { active: form.type === 'http', onClick: () => set({ type: 'http' }) }, '网页') : null,
					canSsh ? h(ui.Pill, { active: form.type === 'ssh', onClick: () => set({ type: 'ssh' }) }, 'SSH') : null),
				h('div', { style: row },
					h(ui.Input, { placeholder: '名字，如 preview', value: form.name, onChange: e => set({ name: e.target.value.toLowerCase() }), required: true, style: { width: '180px' }, 'aria-label': '名字' }),
					h(ui.Input, { placeholder: form.type === 'ssh' ? '本机端口，如 22' : '本机端口，如 5173', inputMode: 'numeric', value: form.localPort, onChange: e => set({ localPort: e.target.value.replace(/\D/g, '') }), required: true, style: { width: '160px' }, 'aria-label': '本机端口' }),
					form.type === 'http' && data.domains.length > 1
						? h('select', { value: form.domain, onChange: e => set({ domain: e.target.value }), style: select, 'aria-label': '域名' }, data.domains.map(d => h('option', { key: d.name, value: d.name }, d.name)))
						: null),
				form.type === 'http' ? h('div', { style: { display: 'grid', gap: '8px' } },
					h('div', { style: muted }, '地址：', h('code', { style: mono }, preview)),
					h('div', { style: muted }, 'Vite 开发服务器默认只接受本机域名：要在 vite.config 的 server.allowedHosts 里加上 ', h('code', { style: mono }, `.${form.domain}`), '，否则会返回 403。'),
					h(ui.Checkbox, { checked: form.protection === 'password', onChange: v => set({ protection: v ? 'password' : 'public' }), label: '需要密码才能访问（密码只保存在这台电脑上）', disabled: !data.settings.allowPublic })) : null,
				form.type === 'ssh' ? h('div', { style: { display: 'grid', gap: '8px' } },
					h('div', { style: row },
						h(ui.Pill, { active: form.access === 'some', onClick: () => set({ access: 'some' }) }, '指定同事'),
						h(ui.Pill, { active: form.access === 'all', onClick: () => set({ access: 'all' }) }, '全部成员')),
					form.access === 'some' ? h('div', { style: row }, data.colleagues.map(c => h(ui.Pill, {
						key: c.name, active: form.members.includes(c.name),
						onClick: () => set({ members: form.members.includes(c.name) ? form.members.filter(n => n !== c.name) : [...form.members, c.name] }),
					}, c.displayName))) : null,
					data.settings.publicTcp ? h(ui.Switch, { checked: form.publicPort, onChange: v => set({ publicPort: v }), label: '同时开放公网 TCP 端口（会被全网扫描，只在确实需要时打开）' }) : null,
					h('div', { style: muted }, '同事在 GL Work 里点“连接”，经他本机的端口转发到你电脑的这个端口；服务器不开公网端口。')) : null,
				error ? h('div', { style: { color: 'var(--dsw-alias-text-danger, #dc2626)', fontSize: '13px' }, 'data-agent-work': 'error' }, error) : null,
				h('div', { style: { ...row, justifyContent: 'flex-end' } },
					h(ui.Button, { onClick: onDone }, '取消'),
					h(ui.Button, { variant: 'primary', type: 'submit' }, '创建并打开')))
		}

		function PasswordEditor({ t, act, onDone }) {
			const [user, setUser] = React.useState(t.auth?.user ?? 'guest')
			const [password, setPassword] = React.useState('')
			const [error, setError] = React.useState(null)
			return h('form', { style: row, onSubmit: (e) => { e.preventDefault(); act({ op: 'password', id: t.id, user, password }).then(onDone, err => setError(err.message)) } },
				h(ui.Input, { value: user, onChange: e => setUser(e.target.value), style: { width: '120px' }, 'aria-label': '用户名' }),
				h(ui.Input, { value: password, onChange: e => setPassword(e.target.value), placeholder: '新密码（至少 6 位）', style: { width: '180px' }, 'aria-label': '密码' }),
				h(ui.Button, { size: 'sm', variant: 'primary', type: 'submit' }, '保存'),
				h(ui.Button, { size: 'sm', onClick: onDone }, '取消'),
				error ? h('span', { style: { color: 'var(--dsw-alias-text-danger, #dc2626)', fontSize: '12px' } }, error) : null)
		}

		function TunnelRow({ t, act, notify, allowPublic }) {
			const [editing, setEditing] = React.useState(false)
			const run = (body, done) => act(body).then(() => done && notify(done), err => notify(err.message, true))
			const address = t.host ? `https://${t.host}` : null
			return h('div', { style: card, 'data-tunnel': t.name },
				h('div', { style: row },
					h(ui.Switch, { checked: t.running, disabled: !t.here || t.closedBy !== null, label: t.running ? '关闭隧道' : '打开隧道', onChange: v => run({ op: v ? 'start' : 'stop', id: t.id }) }),
					h('strong', null, t.name),
					h(ui.Tag, null, t.type === 'ssh' ? 'SSH' : '网页'),
					t.type === 'http' ? h(ui.Tag, null, t.protection === 'password' ? '需要密码' : '公开') : h(ui.Tag, null, t.sshAccess === 'all' ? '全部成员可连' : `${(t.sshAccess ?? []).length} 位同事可连`),
					h('span', { style: { marginLeft: 'auto' } }, h(Status, { t })),
					h(ui.Button, { size: 'sm', variant: 'ghost', icon: h(ui.IconTrashOutlineRegular, { size: 14 }), 'aria-label': '删除', title: '删除',
						onClick: () => { if (confirm(`删除隧道 ${t.name}？`)) run({ op: 'delete', id: t.id }, '已删除') } })),
				t.type === 'http' ? h('div', { style: row },
					h(ui.Switch, {
						checked: t.protection === 'password', label: '需要密码才能访问',
						disabled: t.protection === 'password' && !allowPublic,
						onChange: v => run({ op: 'update', id: t.id, protection: v ? 'password' : 'public' }, v ? '已开启访问密码' : '已关闭访问密码，任何人都能打开这个地址'),
					}),
					t.protection === 'password' && !allowPublic ? h('span', { style: muted }, '管理员要求网页隧道都设置密码') : null) : null,
				h('div', { style: { ...row, ...muted } }, `本机端口 ${t.localPort}`,
					t.publicPort ? ` · 公网端口 ${t.publicPort}` : '',
					t.message && t.state !== 'on' ? h('span', { style: { color: t.state === 'error' ? 'var(--dsw-alias-text-danger, #dc2626)' : undefined } }, ` · ${t.message}`) : null),
				address ? h('div', { style: row }, h('a', { href: address, target: '_blank', rel: 'noreferrer', style: mono }, address), h(Copy, { text: address, label: '' })) : null,
				t.type === 'http' && t.here && t.protection === 'password'
					? (editing
						? h(PasswordEditor, { t, act, onDone: () => setEditing(false) })
						: h('div', { style: { ...row, ...muted } }, t.auth ? ['访问账号 ', h(Copy, { key: 'u', text: t.auth.user }), ' 密码 ', h(Copy, { key: 'p', text: t.auth.password })] : '还没有设置密码',
							h(ui.Button, { size: 'sm', variant: 'ghost', onClick: () => setEditing(true) }, '修改')))
					: null,
				t.type === 'ssh' ? h('div', { style: muted }, '同事连接后执行：', h('code', { style: mono }, 'ssh -p <他本机的端口> <你的用户名>@127.0.0.1')) : null)
		}

		function SharedRow({ s, act, notify }) {
			const command = s.port ? `ssh -p ${s.port} <用户名>@127.0.0.1` : null
			return h('div', { style: card, 'data-shared': `${s.owner}/${s.name}` },
				h('div', { style: row },
					h('strong', null, `${s.owner} / ${s.name}`),
					h('span', { style: { ...row, gap: '6px', fontSize: '13px' } }, h(ui.StateDot, { state: s.online ? 'done' : 'idle' }), s.online ? '对方在线' : '对方离线'),
					h('span', { style: { marginLeft: 'auto' } },
						s.port
							? h(ui.Button, { size: 'sm', onClick: () => act({ op: 'disconnect', id: s.id }).catch(err => notify(err.message, true)) }, '断开')
							: h(ui.Button, { size: 'sm', variant: 'primary', onClick: () => act({ op: 'connect', id: s.id }).catch(err => notify(err.message, true)) }, '连接'))),
				command ? h('div', { style: { ...row, ...muted } }, s.ready ? '已就绪，在终端执行：' : '正在准备本机端口…', h(Copy, { text: command })) : null,
				command && s.message ? h('div', { style: { ...muted, color: 'var(--dsw-alias-text-danger, #dc2626)' } }, `上次连接失败：${s.online ? s.message : '对方不在线'}`) : null)
		}

		function TunnelPage(props) {
			if (props.view === 'summary') return '把本机网页服务发布到公网，或让同事经 GL Work 连到你电脑的 SSH'
			const [data, act] = useTunnels()
			const [creating, setCreating] = React.useState(false)
			const [note, setNote] = React.useState(null)
			const notify = (text, error) => { setNote({ text, error }); setTimeout(() => setNote(null), 4000) }
			const frame = (...children) => h('div', { 'data-agent-work': 'tunnel', style: { display: 'grid', gap: '16px', alignContent: 'start' } },
				h('div', { style: row },
					data.frpc && !data.frpc.running && data.frpc.message ? h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-text-danger, #dc2626)' } }, data.frpc.message) : null,
					data.frpc?.running ? h('span', { style: { ...row, gap: '6px', fontSize: '13px' }, title: data.frpc.message ?? undefined },
						h(ui.StateDot, { state: data.frpc.connection === 'connected' ? 'done' : data.frpc.connection === 'refused' ? 'error' : 'ongoing' }),
						data.frpc.connection === 'connected' ? '已连接公司服务器' : data.frpc.connection === 'refused' ? `被拒绝：${data.frpc.message ?? ''}` : '正在连接公司服务器') : null),
				h('div', { style: muted }, '网页隧道把本机的开发服务发布成公网地址；SSH 隧道让你选的同事经 GL Work 连到这台电脑。GL Work 退出时隧道一起断开。'),
				note ? h('div', { style: { fontSize: '13px', color: note.error ? 'var(--dsw-alias-text-danger, #dc2626)' : 'var(--dsw-alias-text-success, #059669)' } }, note.text) : null,
				...children)
			if (data.loading) return frame(h('p', null, '正在读取…'))
			if (data.signedIn === false) return frame(h('p', null, data.error && data.error !== '请先登录公司账号' ? data.error : '登录公司账号后可以使用内网穿透。'))
			if (data.frpc?.available === false) return frame(h('p', null, '这个 GL Work 没有附带 frpc，暂时不能开隧道。请更新 GL Work。'))
			if (!data.enabled) return frame(h('p', null, '公司还没有开启内网穿透。'))
			const mine = data.tunnels ?? []
			const canCreate = (data.grants.tunnels && data.domains.length > 0) || (data.grants.ssh && data.settings.ssh)
			return frame(
				data.error ? h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-text-danger, #dc2626)' } }, data.error) : null,
				h('div', { style: row },
					h('h3', { style: { margin: 0, fontSize: '15px' } }, '我的隧道'),
					h('span', { style: muted }, `${mine.length}/${data.settings.perMember}`),
					canCreate && !creating ? h(ui.Button, { size: 'sm', variant: 'primary', style: { marginLeft: 'auto' }, icon: h(ui.IconPlusOutlineRegular, { size: 14 }), onClick: () => setCreating(true) }, '新建隧道') : null),
				!canCreate ? h('div', { style: muted }, '你还没有开通内网穿透，请联系管理员。') : null,
				creating ? h(CreateForm, { data, act, onDone: () => setCreating(false) }) : null,
				mine.length === 0 && !creating ? h('div', { style: muted }, '还没有隧道。') : null,
				...mine.map(t => h(TunnelRow, { key: t.id, t, act, notify, allowPublic: data.settings.allowPublic })),
				(data.shared ?? []).length > 0 ? h('h3', { style: { margin: '8px 0 0', fontSize: '15px' } }, '同事分享给我的 SSH') : null,
				...(data.shared ?? []).map(s => h(SharedRow, { key: s.id, s, act, notify })))
		}

		function PhonePage(props) {
			if (props.view === 'summary') return '用 iPhone 上的 GL Work 远程查看和继续这台电脑上的会话'
			const [data, act] = useTunnels()
			const [error, setError] = React.useState(null)
			const frame = (...children) => h('div', { 'data-agent-work': 'phone', style: { display: 'grid', gap: '16px', alignContent: 'start' } },
				h('div', { style: muted }, '开启后，在 iPhone 上的 GL Work 里用同一个公司账号登录，就能看到这台电脑：查看会话、发消息、回答 Agent 的提问和审批。连接经公司服务器中转，只有你自己登录的手机能连上；GL Work 退出或电脑睡眠时连不上。'),
				...children)
			if (data.loading) return frame(h('p', null, '正在读取…'))
			if (data.signedIn === false) return frame(h('p', null, data.error && data.error !== '请先登录公司账号' ? data.error : '登录公司账号后可以使用手机远程。'))
			if (data.frpc?.available === false) return frame(h('p', null, '这个 GL Work 没有附带 frpc，暂时不能使用手机远程。请更新 GL Work。'))
			if (!data.enabled || !data.phone?.allowed) return frame(h('p', null, data.phone?.message ?? '公司还没有开启手机远程。'))
			const phone = data.phone
			const toggle = (on) => {
				setError(null)
				if (on && !confirm('允许你的 iPhone 远程使用这台电脑？\n\n手机上的操作等同于在这台电脑上操作，Agent 拥有的权限（包括直连模式的全部权限）在手机上同样有效。')) return
				act({ op: on ? 'remote-on' : 'remote-off' }).catch(err => setError(err.message))
			}
			return frame(
				h('div', { style: card, 'data-agent-work': 'phone-card' },
					h('div', { style: row },
						h(ui.Switch, { checked: phone.enabled, label: '允许手机远程使用这台电脑', onChange: toggle }),
						phone.enabled ? h('span', { style: { marginLeft: 'auto' } }, h(Status, { t: phone })) : null),
					phone.enabled && phone.message && phone.state !== 'on' ? h('div', { style: { ...muted, color: phone.state === 'error' ? 'var(--dsw-alias-text-danger, #dc2626)' : undefined } }, phone.message) : null,
					phone.enabled && phone.state === 'on' ? h('div', { style: muted }, '已就绪：在 iPhone 上打开 GL Work，选择这台电脑。') : null),
				error ? h('div', { style: { color: 'var(--dsw-alias-text-danger, #dc2626)', fontSize: '13px' }, 'data-agent-work': 'error' }, error) : null)
		}

		const exports = {}
		exports.inject = ['slots']
		exports.apply = (ctx) => {
			// A card on the Plugins page, beside 公司插件.
			ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item', id: 'agent-work-tunnel', order: 6, label: () => '内网穿透',
			}, TunnelPage)), 'agent-work: tunnel page')
			ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item', id: 'agent-work-phone', order: 7, label: () => '手机远程',
			}, PhonePage)), 'agent-work: phone page')
		}
		return exports
	}
})
