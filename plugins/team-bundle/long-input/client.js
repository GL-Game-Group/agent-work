// 文本输入, client half: one full-size text area for long prompts (product requirements)
// that the composer is too small for, in two places:
// - a third conversation view after 对话 and 轨迹;
// - a dialog from the 展开 button in the composer's tool row, which also works in a new
//   Session (the view tabs only show once a Session has messages). The button opens the
//   dialog rather than the view: only the views themselves are handed openView.
//
// Both edit the Session's composer draft itself, not a copy: what is typed shows in the
// composer and back, survives reloads with the draft, and 发送 is the composer's own
// submission (model, attachments, queueing and steering unchanged). After a send the view
// returns to 对话 and the dialog closes, to show the reply. The composer stays below the
// view: hiding it per view is not something the composer chain can select on, and approval
// or question cards take its place.
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

		/**
		 * The text area and its 发送 row over one Session's draft. `onSent` runs once the
		 * submission has cleared the draft; `focusKey` changing takes the caret to the end.
		 */
		function Editor({ useInput, inputActions, onSent, focusKey, style }) {
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

			// Leaving (the view, the dialog, the Session) keeps what was typed.
			React.useEffect(() => flush, [flush])

			// The draft changed elsewhere: typed in the composer, or cleared by a submission.
			// While the text area has focus its own text wins; the composer cannot be typed in then.
			React.useEffect(() => {
				if (sending.current && draft === '') {
					sending.current = false
					latest.current = ''
					setText('')
					onSent()
					return
				}
				if (document.activeElement !== area.current && timer.current === undefined) {
					latest.current = draft
					setText(draft)
				}
			}, [draft, onSent])

			React.useEffect(() => {
				const el = area.current
				if (el === null) return
				el.focus()
				el.setSelectionRange(el.value.length, el.value.length)
			}, [focusKey])

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
			if (attachments > 0) notes.push(`附件 ${attachments} 个，在会话框里管理`)

			return h('div', {
				'data-agent-work': 'long-input',
				style: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '8px', ...style },
			},
			h('textarea', {
				ref: area,
				value: text,
				onChange: change,
				onBlur: flush,
				onKeyDown: keyDown,
				placeholder: '在这里写较长的内容，比如产品需求：背景、目标、用户场景、验收标准……\n写完点“发送”，等同于在会话框里发送。',
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

		/** The 文本输入 view: the band above the composer, which stays below. */
		function LongInputView({ useInput, inputActions, openView, viewRequest, completeViewRequest }) {
			const back = React.useCallback(() => { openView('chat', VIEW) }, [openView])
			React.useEffect(() => {
				if (viewRequest?.view === VIEW) completeViewRequest()
			}, [viewRequest])
			return h(Editor, {
				useInput, inputActions, onSent: back, focusKey: viewRequest,
				style: {
					width: 'min(100% - 32px, var(--dsh-chat-content-width, 920px))',
					margin: '0 auto',
					padding: '12px 0',
					height: 'calc(var(--dsh-conversation-viewport-height, 80vh) - var(--dsh-composer-height, 160px))',
					minHeight: '240px',
				},
			})
		}

		const expandIcon = h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
			h('path', { d: 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9' }))

		/** 展开 in the composer's tool row: the same editor in a dialog. */
		function ExpandButton({ useInput, inputActions }) {
			const [open, setOpen] = React.useState(false)
			const [hover, setHover] = React.useState(false)
			const close = React.useCallback(() => { setOpen(false) }, [])
			return h(React.Fragment, null,
				h(ui.Tooltip, { label: '展开输入框', side: 'top', delayMs: 500 },
					h('button', {
						type: 'button',
						'aria-label': '展开输入框',
						'data-action': 'long-input-expand',
						onClick: () => setOpen(true),
						onMouseEnter: () => setHover(true),
						onMouseLeave: () => setHover(false),
						style: {
							display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
							width: '28px', height: '28px', padding: 0, border: 'none', cursor: 'pointer',
							borderRadius: 'var(--dsw-radius-sm, 8px)',
							background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' : 'transparent',
							color: 'var(--dsw-alias-label-secondary, inherit)',
						},
					}, expandIcon)),
				open ? h(ui.Modal, { open: true, onClose: close, title: '文本输入', closeLabel: '收起', className: DIALOG_CLASS },
					h(Editor, {
						useInput, inputActions, onSent: close, focusKey: open,
						style: { width: '100%', height: 'min(640px, 70vh)' },
					})) : null)
		}

		// The shared Modal is 380px wide and takes only a class: widen this one dialog.
		const DIALOG_CLASS = 'agent-work-long-input-dialog'
		const DIALOG_CSS = `.${DIALOG_CLASS}.${DIALOG_CLASS} { width: min(920px, calc(100vw - 48px)); }`

		const exports = {}
		exports.inject = ['slots']
		exports.apply = (ctx) => {
			ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view', id: VIEW, order: 20, label: () => '文本输入',
			}, LongInputView)), 'agent-work: 文本输入 view')
			ctx.effect(() => {
				const style = document.createElement('style')
				style.textContent = DIALOG_CSS
				document.head.append(style)
				return () => { style.remove() }
			}, 'agent-work: 文本输入 dialog width')
			ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
				name: 'conversation.input.right', id: 'agent-work-long-input-expand', order: 100,
			}, ExpandButton)), 'agent-work: 文本输入 expand button')
		}
		return exports
	}
})
