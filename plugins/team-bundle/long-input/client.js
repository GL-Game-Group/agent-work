// 文本输入, client half: room for long prompts (product requirements) without a second input box.
// The Session's own composer grows to fill the conversation area, in two ways:
// - the 文本输入 view after 对话 and 轨迹 (it draws nothing itself; the composer below fills it);
// - the 展开 button in the composer's tool row, also in a new Session (whose view tabs are not
//   shown yet); pressing it again collapses.
// It stays the composer: @ references, attachments, the model and slash commands all work, and
// the draft is the Session's. While expanded, Enter starts a new line and ⌘/Ctrl+Enter sends (as
// plain Enter would; the configured busy delivery applies). After a send the view returns to 对话
// and the button collapses.
//
// The composer offers no size or key settings, so this leans on its markup: the
// [data-conversation-content][data-conversation-session] body, the [data-composer-seat] that
// declares --dsh-composer-text-max-height, the [data-composer-input] editable, the
// [data-chain-overlay-fallback] that hides it under a question or approval card, and the
// [data-trigger-menu] of an open @ or / menu (its listbox's aria-activedescendant marks a
// highlight). If an upstream update renames them, the composer just stays its normal size and
// keys (CLAUDE.md, 已知的坑).
//
// Hand-written in the client module format the Host serves: a factory receiving the loader's require.
window.__ModuleLoader__.load({
	id: '@agent-work/dsh-team-long-input',
	factory: (require) => {
		const React = require('react')
		const ui = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const VIEW = 'agent-work-long-input'
		const MARK = 'data-agent-work-long-input'
		const mac = /Mac|iPhone|iPad/u.test(navigator.platform)
		const HINT = `Enter 换行 · ${mac ? '⌘' : 'Ctrl'} + Enter 发送`

		// The cap (and the editable's floor) is the visible band less the composer's own chrome; a
		// new Session's hero keeps its brand row; an open @ or / menu gets room above.
		const STYLE = `
[${MARK}] [data-composer-seat] {
	--dsh-composer-text-max-height: max(160px, calc(var(--dsh-conversation-viewport-height, 80vh) - 150px));
}
[${MARK}]:not([data-content-phase="active"]) [data-composer-seat] {
	--dsh-composer-text-max-height: max(160px, calc(var(--dsh-conversation-viewport-height, 80vh) - 290px));
}
:root:has([data-trigger-menu]) [${MARK}] [data-composer-seat] {
	--dsh-composer-text-max-height: max(120px, calc(var(--dsh-conversation-viewport-height, 80vh) - 480px));
}
[${MARK}] [data-composer-seat] [data-composer-input] {
	min-height: var(--dsh-composer-text-max-height);
}
[${MARK}] [data-composer-seat]::after {
	content: attr(data-agent-work-hint);
	align-self: center;
	padding: 4px 0;
	font-size: 12px;
	color: var(--dsw-alias-label-tertiary, inherit);
}
[${MARK}] [data-composer-seat]:has([data-chain-overlay-fallback][style*="none"])::after {
	display: none;
}`

		// --- Which Sessions are expanded, and why --------------------------------------------

		/** sessionId → the reasons it is expanded ('view', 'button'). */
		const expanded = new Map()
		const listeners = new Set()

		/** Mark (or unmark) every conversation body of the Session; CSS and keys follow the mark. */
		function paint(sessionId) {
			const on = (expanded.get(sessionId)?.size ?? 0) > 0
			for (const body of document.querySelectorAll('[data-conversation-content]')) {
				if (body.getAttribute('data-conversation-session') !== sessionId) continue
				body.toggleAttribute(MARK, on)
				const seat = body.querySelector('[data-composer-seat]')
				if (seat !== null) {
					if (on) seat.setAttribute('data-agent-work-hint', HINT)
					else seat.removeAttribute('data-agent-work-hint')
				}
			}
		}

		function setReason(sessionId, reason, on) {
			const reasons = expanded.get(sessionId) ?? new Set()
			if (on) reasons.add(reason)
			else reasons.delete(reason)
			if (reasons.size === 0) expanded.delete(sessionId)
			else expanded.set(sessionId, reasons)
			paint(sessionId)
			for (const listener of listeners) listener()
		}

		function useReasons(sessionId) {
			return React.useSyncExternalStore(
				(listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
				() => [...(expanded.get(sessionId) ?? [])].sort().join(','))
		}

		/** Put the caret at the end of the Session's composer draft. */
		function focusComposer(sessionId) {
			requestAnimationFrame(() => {
				const body = document.querySelector(`[data-conversation-content][data-conversation-session="${CSS_escape(sessionId)}"]`)
				const input = body?.querySelector('[data-composer-seat] [data-composer-input]')
				if (!input) return
				input.focus()
				const range = document.createRange()
				range.selectNodeContents(input)
				range.collapse(false)
				const selection = window.getSelection()
				selection?.removeAllRanges()
				selection?.addRange(range)
			})
		}
		const CSS_escape = value => (window.CSS?.escape ? window.CSS.escape(value) : value)

		// --- Keys and send detection (document-wide, only inside a marked body) -----------------

		/** When the member last deleted text (any composer): a draft emptied by deleting is not a send. */
		let deletedAt = 0

		/** Enter → new line, ⌘/Ctrl+Enter → Enter, inside an expanded composer with no open menu. */
		function onKeyDown(event) {
			if (event.key === 'Backspace' || event.key === 'Delete') { deletedAt = Date.now(); return }
			if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || !event.isTrusted) return
			const target = event.target
			if (!(target instanceof Element) || target.closest(`[${MARK}] [data-composer-seat] [data-composer-input]`) === null) return
			// An @ or / menu with a highlighted row: Enter picks it. Without a highlight the
			// composer would send; here that becomes a new line too.
			if (document.querySelector('[data-trigger-menu] [role="listbox"][aria-activedescendant]') !== null) return
			const accelerated = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
			const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
			if (!plain && !(accelerated && !event.altKey && !event.shiftKey)) return
			event.preventDefault()
			event.stopPropagation()
			target.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: plain, bubbles: true, cancelable: true,
			}))
		}

		/** Deleting by keys, cut, or an input method's own delete. */
		function onBeforeInput(event) {
			if (event.type === 'cut' || (typeof event.inputType === 'string' && event.inputType.startsWith('delete'))) deletedAt = Date.now()
		}

		/** Run `onSent` when an expanded composer's draft empties by a send (not by deleting it). */
		function useSent(useInput, active, onSent) {
			const draft = useInput(s => s.draft)
			const previous = React.useRef(draft)
			React.useEffect(() => {
				const was = previous.current
				previous.current = draft
				if (active && was.trim() !== '' && draft === '' && Date.now() - deletedAt > 500) onSent()
			}, [draft, active, onSent])
		}

		// --- The view and the button ----------------------------------------------------------

		/** The 文本输入 view: expands the composer while selected; draws nothing itself. */
		function LongInputView({ sessionId, useInput, openView, viewRequest, completeViewRequest }) {
			React.useEffect(() => {
				setReason(sessionId, 'view', true)
				focusComposer(sessionId)
				return () => { setReason(sessionId, 'view', false) }
			}, [sessionId])
			React.useEffect(() => {
				if (viewRequest?.view === VIEW) completeViewRequest()
			}, [viewRequest])
			const back = React.useCallback(() => { openView('chat', VIEW) }, [openView])
			useSent(useInput, true, back)
			return null
		}

		const expandIcon = h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
			h('path', { d: 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9' }))
		const collapseIcon = h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
			h('path', { d: 'M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14' }))

		/** 展开 / 收起 in the composer's tool row; hidden on the 文本输入 view, which is expanded already. */
		function ExpandButton({ sessionId, useInput }) {
			const reasons = useReasons(sessionId)
			const onView = reasons.includes('view')
			const open = reasons.includes('button')
			const [hover, setHover] = React.useState(false)
			const collapse = React.useCallback(() => { setReason(sessionId, 'button', false) }, [sessionId])
			useSent(useInput, open, collapse)
			// The button's reason ends with the Session (switching away collapses).
			React.useEffect(() => () => { setReason(sessionId, 'button', false) }, [sessionId])
			if (onView) return null
			const label = open ? '收起输入框' : '展开输入框'
			return h(ui.Tooltip, { label: open ? label : `${label}（${HINT}）`, side: 'top', delayMs: 500 },
				h('button', {
					type: 'button',
					'aria-label': label,
					'aria-pressed': open,
					'data-action': 'long-input-expand',
					onMouseDown: event => event.preventDefault(),
					onClick: () => {
						setReason(sessionId, 'button', !open)
						focusComposer(sessionId)
					},
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					style: {
						display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
						width: '28px', height: '28px', padding: 0, border: 'none', cursor: 'pointer',
						borderRadius: 'var(--dsw-radius-sm, 8px)',
						background: hover || open ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' : 'transparent',
						color: 'var(--dsw-alias-label-secondary, inherit)',
					},
				}, open ? collapseIcon : expandIcon))
		}

		const exports = {}
		exports.inject = ['slots']
		exports.apply = (ctx) => {
			ctx.effect(() => {
				const style = document.createElement('style')
				style.textContent = STYLE
				document.head.append(style)
				document.addEventListener('keydown', onKeyDown, true)
				document.addEventListener('beforeinput', onBeforeInput, true)
				document.addEventListener('cut', onBeforeInput, true)
				return () => {
					style.remove()
					document.removeEventListener('keydown', onKeyDown, true)
					document.removeEventListener('beforeinput', onBeforeInput, true)
					document.removeEventListener('cut', onBeforeInput, true)
					for (const sessionId of [...expanded.keys()]) { expanded.delete(sessionId); paint(sessionId) }
				}
			}, 'agent-work: 文本输入 styles and keys')
			ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view', id: VIEW, order: 20, label: () => '文本输入',
			}, LongInputView)), 'agent-work: 文本输入 view')
			ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
				name: 'conversation.input.right', id: 'agent-work-long-input-expand', order: 100,
			}, ExpandButton)), 'agent-work: 文本输入 expand button')
		}
		return exports
	}
})
