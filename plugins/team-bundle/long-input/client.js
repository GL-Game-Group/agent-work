// 文本输入, client half: a third conversation view after 会话 and 轨迹, one full-size
// text area for long prompts (product requirements) that the composer is too small for.
//
// It edits the Session's composer draft itself, not a copy: what is typed here shows in
// the composer and back, survives reloads with the draft, and 发送 is the composer's own
// submission (model, attachments, queueing and steering unchanged). After a send it
// returns to 会话 to show the reply. The composer stays below: hiding it per view is not
// something the composer chain can select on, and approval or question cards take its place.
//
// Hand-written in the client module format the Host serves: a factory receiving the loader's require.
window.__ModuleLoader__.load({
	id: '@agent-work/dsh-team-long-input',
	factory: (require) => {
		const React = require('react')
		const ui = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const VIEW = 'agent-work-long-input'
		/** Typing reaches the composer after this pause: one draft write per burst, not per key. */
		const SYNC_MS = 200
		const mac = /Mac|iPhone|iPad/u.test(navigator.platform)

		const caption = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)', opacity: 0.9 }

		function LongInput({ useInput, inputActions, openView, viewRequest, completeViewRequest }) {
			const draft = useInput(s => s.draft)
			const attachments = useInput(s => s.attachmentIds.length)
			const busy = useInput(s => s.phase !== 'plain')
			const [text, setText] = React.useState(draft)
			const area = React.useRef(null)
			const latest = React.useRef(draft)
			const timer = React.useRef(undefined)
			/** Set by 发送 until the submission clears the draft. */
			const sending = React.useRef(false)

			const flush = React.useCallback(() => {
				if (timer.current === undefined) return
				clearTimeout(timer.current)
				timer.current = undefined
				inputActions.setDraft(latest.current)
			}, [inputActions])

			// Leaving the view (or the Session) keeps what was typed.
			React.useEffect(() => flush, [flush])

			// The draft changed elsewhere: typed in the composer, or cleared by a submission.
			// While the text area has focus its own text wins; the composer cannot be typed in then.
			React.useEffect(() => {
				if (sending.current && draft === '') {
					sending.current = false
					latest.current = ''
					setText('')
					openView('chat', VIEW)
					return
				}
				if (document.activeElement !== area.current && timer.current === undefined) {
					latest.current = draft
					setText(draft)
				}
			}, [draft, openView])

			// Opened on purpose (or by openView): take the caret, at the end.
			React.useEffect(() => {
				const el = area.current
				if (el === null) return
				el.focus()
				el.setSelectionRange(el.value.length, el.value.length)
				if (viewRequest?.view === VIEW) completeViewRequest()
			}, [viewRequest])

			function change(event) {
				const value = event.target.value
				latest.current = value
				sending.current = false
				setText(value)
				clearTimeout(timer.current)
				timer.current = setTimeout(flush, SYNC_MS)
			}

			const empty = text.trim() === '' && attachments === 0

			function send() {
				if (empty || busy) return
				clearTimeout(timer.current)
				timer.current = undefined
				inputActions.setDraft(latest.current)
				sending.current = true
				// Submit after the editor has taken the new draft (its updates commit in a microtask).
				setTimeout(() => { inputActions.submit() }, 0)
			}

			function keyDown(event) {
				if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
				if (mac ? event.metaKey : event.ctrlKey) {
					event.preventDefault()
					send()
				}
			}

			const notes = [`${[...text].length} 字`]
			if (attachments > 0) notes.push(`附件 ${attachments} 个，在下方会话框里管理`)

			return h('div', {
				'data-agent-work': 'long-input',
				style: {
					boxSizing: 'border-box',
					width: 'min(100% - 32px, var(--dsh-chat-content-width, 920px))',
					margin: '0 auto',
					padding: '12px 0',
					display: 'flex',
					flexDirection: 'column',
					gap: '8px',
					// The visible band above the composer, which stays below.
					height: 'calc(var(--dsh-conversation-viewport-height, 80vh) - var(--dsh-composer-height, 160px))',
					minHeight: '240px',
				},
			},
			h('textarea', {
				ref: area,
				value: text,
				onChange: change,
				onBlur: flush,
				onKeyDown: keyDown,
				placeholder: '在这里写较长的内容，比如产品需求：背景、目标、用户场景、验收标准……\n写完点“发送”，等同于在下方会话框里发送。',
				spellCheck: false,
				'aria-label': '文本输入',
				style: {
					flex: 1,
					minHeight: 0,
					resize: 'none',
					boxSizing: 'border-box',
					padding: '14px 16px',
					border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))',
					borderRadius: 'var(--dsw-radius-panel, 16px)',
					background: 'var(--dsw-specific-input-major, transparent)',
					color: 'var(--dsw-alias-label-primary, inherit)',
					font: 'inherit',
					fontFamily: 'var(--dsw-font-family, inherit)',
					fontSize: '14px',
					lineHeight: 1.7,
					outline: 'none',
				},
			}),
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
				h('span', { style: caption }, notes.join(' · ')),
				h('span', { style: { ...caption, marginLeft: 'auto' } }, `${mac ? '⌘' : 'Ctrl'} + Enter 发送`),
				h(ui.Button, { size: 'sm', variant: 'primary', disabled: empty || busy, 'data-action': 'long-input-send', onClick: send }, '发送')))
		}

		const exports = {}
		exports.inject = ['slots']
		exports.apply = (ctx) => {
			ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view', id: VIEW, order: 20, label: () => '文本输入',
			}, LongInput)), 'agent-work: 文本输入 view')
		}
		return exports
	}
})
